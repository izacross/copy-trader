/**
 * Turns one signal into at most one Coinbase futures order.
 *   open/add long  -> BUY contracts      open/add short -> SELL contracts
 *   close          -> the opposite side, for exactly the contracts we opened for that trader position
 * Leverage = the trader's, capped by max_leverage; we size contracts so margin x leverage = position size.
 */
import type { Broker } from './broker';
import { positionKey } from './signals';
import type { Store } from './store';
import type { DecisionRecord, Position, Settings, Signal } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const startOfUtcDay = (now: number) => now - (now % 86_400_000);

export class Engine {
  constructor(private store: Store, private broker: Broker, private newId: () => string = () => crypto.randomUUID()) {}

  async handle(sig: Signal, now = Date.now()): Promise<DecisionRecord> {
    const base: DecisionRecord = {
      ts: now,
      mode: this.broker.mode,
      post_id: sig.postId,
      trader_name: sig.traderName,
      ticker: sig.ticker,
      signal_action: sig.action,
      signal_side: sig.side,
      signal_leverage: sig.leverage,
      decision: 'skip',
      reason: '',
    };
    let rec: DecisionRecord;
    try {
      const settings = await this.store.getSettings();
      rec = sig.action === 'close' ? await this.close(sig, base) : await this.open(sig, settings, base, now);
    } catch (e: any) {
      rec = { ...base, decision: 'error', reason: String(e?.message ?? e).slice(0, 500) };
    }
    await this.store.record(rec);
    await this.autoPause(now);
    return rec;
  }

  private async open(sig: Signal, s: Settings, base: DecisionRecord, now: number): Promise<DecisionRecord> {
    const skip = (reason: string) => ({ ...base, decision: 'skip' as const, reason });
    const mode = this.broker.mode;

    if (s.kill_switch) return skip('kill switch is on');
    if (s.paused_reason) return skip(`paused: ${s.paused_reason}`);
    if (s.allowed_symbols.length && !s.allowed_symbols.includes(sig.ticker)) return skip(`${sig.ticker} is not in allowed coins`);
    if (sig.side === 'short' && !s.copy_shorts) return skip('copying shorts is off');
    if (s.min_win_rate > 0 && (sig.winRate ?? 0) < s.min_win_rate)
      return skip(`trader win rate ${sig.winRate ?? 'unknown'} is below ${s.min_win_rate}`);
    if (sig.postedAt && now - sig.postedAt > s.max_signal_age_sec * 1000)
      return skip(`signal is ${Math.round((now - sig.postedAt) / 1000)}s old`);

    const key = positionKey(sig);
    const existing = await this.store.getPosition(key, mode);
    if (sig.action === 'open' && existing) return skip('already copied this position');
    if (sig.action === 'increase' && !existing) return skip('add to a position we never copied');
    if (sig.action === 'open' && (await this.store.openPositions(mode)).length >= s.max_open_positions)
      return skip(`already at ${s.max_open_positions} open positions`);

    const perp = await this.broker.findPerp(sig.ticker);
    if (!perp) return skip(`Coinbase has no perpetual future for ${sig.ticker}`);

    const long = sig.side === 'long';
    if (existing && existing.side !== (long ? 'LONG' : 'SHORT')) return skip('add is on the opposite side of our copy');
    const q = await this.broker.quote(perp.productId);
    const price = long ? q.ask : q.bid;
    if (sig.action === 'open' && sig.entryPrice) {
      const slip = (Math.abs(price - sig.entryPrice) / sig.entryPrice) * 100;
      if (slip > s.max_slippage_pct) return skip(`price moved ${slip.toFixed(2)}% from the trader's entry`);
    }

    const leverage = Math.max(1, Math.min(sig.leverage || 1, s.max_leverage));
    const available = await this.broker.availableMargin();
    const budget = Math.min(s.max_order_usd, (available * s.max_position_pct) / 100);
    const contractValue = price * perp.contractSize;
    const contracts = Math.floor((budget * leverage) / contractValue);
    if (contracts < 1)
      return skip(`$${round2(budget)} margin at ${leverage}x is less than one contract ($${round2(contractValue)})`);

    const side = long ? 'BUY' : 'SELL';
    const orderId = await this.broker.marketOrder(perp.productId, side, contracts, this.newId());
    const notional = contracts * contractValue;
    const margin = notional / leverage;

    const pos: Position = existing
      ? {
          ...existing,
          contracts: existing.contracts + contracts,
          entry_price: (existing.entry_price * existing.contracts + price * contracts) / (existing.contracts + contracts),
          margin_usd: existing.margin_usd + margin,
        }
      : {
          key,
          mode,
          ticker: sig.ticker,
          product_id: perp.productId,
          side: long ? 'LONG' : 'SHORT',
          contracts,
          contract_size: perp.contractSize,
          entry_price: price,
          margin_usd: margin,
          leverage,
          trader_id: sig.traderId,
          trader_name: sig.traderName,
          opened_at: Date.now(),
        };
    await this.store.upsertPosition(pos);
    if (mode === 'paper') await this.store.setPaperCash((await this.store.paperCash()) - margin);

    return {
      ...base,
      decision: existing ? 'add' : 'open',
      reason: `${existing ? 'added to' : 'opened'} ${long ? 'long' : 'short'} at ${leverage}x`,
      product_id: perp.productId,
      side,
      contracts,
      price,
      notional_usd: round2(notional),
      order_id: orderId,
    };
  }

  private async close(sig: Signal, base: DecisionRecord): Promise<DecisionRecord> {
    const mode = this.broker.mode;
    const pos =
      (await this.store.getPosition(positionKey(sig), mode)) ?? (await this.store.findPosition(sig.traderId, sig.ticker, mode));
    if (!pos) return { ...base, decision: 'skip', reason: 'close for a position we never copied' };
    const reason = sig.source === 'catch-up' ? "trader closed while we weren't watching; caught up" : 'trader closed; mirrored the exit';
    return this.closePosition(pos, base, reason);
  }

  /** Closes one of our copies at market. Also used by the dashboard's close-all button. */
  async closePosition(pos: Position, base: DecisionRecord, reason: string): Promise<DecisionRecord> {
    const long = pos.side === 'LONG';
    const side = long ? 'SELL' : 'BUY';
    const q = await this.broker.quote(pos.product_id);
    const price = long ? q.bid : q.ask;
    const orderId = await this.broker.marketOrder(pos.product_id, side, pos.contracts, this.newId());
    const pnl = (price - pos.entry_price) * pos.contracts * pos.contract_size * (long ? 1 : -1);
    await this.store.deletePosition(pos.key, pos.mode);
    if (pos.mode === 'paper') await this.store.setPaperCash((await this.store.paperCash()) + pos.margin_usd + pnl);
    return {
      ...base,
      decision: 'close',
      reason,
      product_id: pos.product_id,
      side,
      contracts: pos.contracts,
      price,
      notional_usd: round2(pos.contracts * pos.contract_size * price),
      pnl_usd: round2(pnl),
      order_id: orderId,
    };
  }

  /** Pause new opens after 3 errors in a row or when today's realized loss passes the limit. */
  private async autoPause(now: number) {
    const s = await this.store.getSettings();
    if (s.paused_reason) return;
    const last = await this.store.recentDecisions(3);
    if (last.length === 3 && last.every((d) => d.decision === 'error')) {
      await this.store.saveSettings({ paused_reason: '3 errors in a row' });
      return;
    }
    const pnl = await this.store.realizedPnlSince(startOfUtcDay(now), this.broker.mode);
    if (pnl < -s.max_daily_loss_usd) await this.store.saveSettings({ paused_reason: `daily loss $${round2(-pnl)} passed the limit` });
  }
}
