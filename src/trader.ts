import { DurableObject } from 'cloudflare:workers';
import { LiveBroker, PaperBroker, type Broker } from './broker';
import { CoinbaseClient } from './coinbase/client';
import { Engine } from './engine';
import { InvoClient } from './invo';
import { Notifier } from './notify';
import { closedPositionIds, readNewPosts } from './catchup';
import { parsePost } from './signals';
import { D1Store } from './store';
import type { Env, Signal } from './types';

export function isLive(env: Env, liveEnabled: boolean) {
  return env.LIVE_TRADING === 'true' && liveEnabled;
}

/**
 * The poller. One instance (named "main"), pinned near Coinbase in US East. It wakes itself with a
 * Durable Object alarm every POLL_SECONDS, reads the Invo following feed and hands new signals to the engine.
 */
export class Trader extends DurableObject<Env> {
  private invo: InvoClient | null = null;
  private cb: CoinbaseClient;
  private store: D1Store;
  private lastPoll: { at: number; ok: boolean; error?: string; signals: number } | null = null;
  private lastReconcile = 0;
  private reconcileError: string | null = null;
  private notifier: Notifier;
  private feedAlerted = false; // so a failing feed alerts once, not every 5 seconds

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cb = new CoinbaseClient(env.COINBASE_API_KEY_NAME, env.COINBASE_API_PRIVATE_KEY);
    this.store = new D1Store(env.DB);
    this.notifier = new Notifier(env.SLACK_WEBHOOK_URL);
    if (env.INVO_REFRESH_TOKEN) this.invo = new InvoClient(env.INVO_REFRESH_TOKEN);
  }

  private intervalMs() {
    return Math.max(1, Number(this.env.POLL_SECONDS) || 5) * 1000;
  }

  /** Called by the cron watchdog and the dashboard. Starts the alarm loop if it isn't running. */
  async ensureRunning(): Promise<void> {
    const next = await this.ctx.storage.getAlarm();
    if (next === null || next < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    // Schedule the next run first, so a slow or failing poll never stops the loop.
    await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
    await this.poll();
  }

  private async broker(): Promise<Broker> {
    const s = await this.store.getSettings();
    if (isLive(this.env, s.live_enabled)) {
      if (!this.cb.hasKeys) throw new Error('live trading is on but the Coinbase API key is missing');
      return new LiveBroker(this.cb);
    }
    return new PaperBroker(this.cb, this.store);
  }

  async poll(): Promise<void> {
    if (!this.invo) {
      this.lastPoll = { at: Date.now(), ok: false, error: 'INVO_REFRESH_TOKEN secret is not set', signals: 0 };
      return;
    }
    const invo = this.invo;
    const pausedBefore = (await this.store.getSettings()).paused_reason;
    try {
      const getPage = async (lastPostId: string | null, limit: number) =>
        ((await invo.getFeed('following', limit, lastPostId)).items ?? []) as any[];
      const markSeen = (ids: string[]) => this.store.markSeen(ids);

      let signals: Signal[] = [];
      if ((await this.store.seenCount()) === 0) {
        // The very first read only records what's already there, so old posts never trigger trades.
        await markSeen((await getPage(null, 20)).map((p) => String(p.id)));
      } else {
        // Pages back if everything on the first page is new, so a burst or an outage can't hide a close.
        const { posts } = await readNewPosts(getPage, markSeen);
        signals = posts.map(parsePost).filter((s): s is Signal => s !== null);
      }
      if (signals.length) {
        const engine = new Engine(this.store, await this.broker());
        // Oldest first, so an open is handled before its close.
        for (const sig of signals.reverse()) await this.notifier.decision(await engine.handle(sig));
      }
      // A failed position check shouldn't mark the feed as failing; it retries next minute.
      this.reconcileError = await this.reconcile(invo).then(() => null, (e) => String(e?.message ?? e).slice(0, 300));
      this.lastPoll = { at: Date.now(), ok: true, signals: signals.length };
      if (this.feedAlerted) {
        this.feedAlerted = false;
        await this.notifier.send('Invo feed is working again.');
      }
    } catch (e: any) {
      this.lastPoll = { at: Date.now(), ok: false, error: String(e?.message ?? e).slice(0, 300), signals: 0 };
      if (!this.feedAlerted) {
        this.feedAlerted = true;
        await this.notifier.send(`Invo feed check is failing, so no trades are being copied: ${this.lastPoll.error}`);
      }
    }
    const pausedAfter = (await this.store.getSettings()).paused_reason;
    if (pausedAfter && pausedAfter !== pausedBefore)
      await this.notifier.send(`Paused new copies: ${pausedAfter}. Press Resume on the dashboard to continue.`);
  }

  /** Once a minute: close any copy whose trader position Invo now reports as closed. */
  private async reconcile(invo: InvoClient): Promise<void> {
    if (Date.now() - this.lastReconcile < 60_000) return;
    this.lastReconcile = Date.now();
    const broker = await this.broker();
    // Only copies filed under a real Invo position id can be looked up.
    const held = (await this.store.openPositions(broker.mode)).filter((p) => !p.key.includes(':'));
    if (!held.length) return;
    const data = await invo.getTradeUpdates(held.map((p) => ({ baseShortId: p.key, mimicStartedAt: new Date(p.opened_at).toISOString() })));
    const closed = new Set(closedPositionIds(data, held.map((p) => p.key)));
    const engine = new Engine(this.store, broker);
    for (const p of held.filter((h) => closed.has(h.key))) {
      await engine.handle({
        postId: `catch-up:${p.key}`, action: 'close', ticker: p.ticker, side: p.side === 'LONG' ? 'long' : 'short',
        leverage: p.leverage, entryPrice: null, closingPrice: null, traderId: p.trader_id, traderName: p.trader_name,
        winRate: null, positionId: p.key, postedAt: null, source: 'catch-up',
      }).then((d) => this.notifier.decision(d));
    }
  }

  async status() {
    const s = await this.store.getSettings();
    return {
      mode: isLive(this.env, s.live_enabled) ? 'live' : 'paper',
      liveLockOpen: this.env.LIVE_TRADING === 'true',
      coinbaseKeys: this.cb.hasKeys,
      invoToken: !!this.invo,
      invoTokenDaysLeft: this.invo?.refreshTokenDaysLeft() ?? null,
      nextAlarm: await this.ctx.storage.getAlarm(),
      lastPoll: this.lastPoll,
      reconcileError: this.reconcileError,
      pollSeconds: this.intervalMs() / 1000,
      slack: this.notifier.enabled,
    };
  }

  /** Dashboard button: sends a test message so you can check the webhook. */
  async slackTest(): Promise<boolean> {
    return this.notifier.send('Copy trader is connected to Slack. You will get a message here for every copy, close, error and pause.');
  }

  /** Dashboard button: close every copy in the current mode at market. */
  async closeAll(): Promise<number> {
    const broker = await this.broker();
    const engine = new Engine(this.store, broker);
    const positions = await this.store.openPositions(broker.mode);
    for (const pos of positions) {
      const base = {
        ts: Date.now(), mode: broker.mode, post_id: null, trader_name: pos.trader_name, ticker: pos.ticker,
        signal_action: 'close_all', signal_side: null, signal_leverage: null, decision: 'skip' as const, reason: '',
      };
      let rec;
      try {
        rec = await engine.closePosition(pos, base, 'closed from the dashboard');
      } catch (e: any) {
        rec = { ...base, decision: 'error' as const, reason: String(e?.message ?? e).slice(0, 500) };
      }
      await this.store.record(rec);
      await this.notifier.decision(rec);
    }
    return positions.length;
  }
}
