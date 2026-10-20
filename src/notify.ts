/**
 * Slack alerts through an incoming webhook (SLACK_WEBHOOK_URL secret). Optional: with no webhook set, nothing is sent.
 * Copies, adds, closes and errors are sent; skips are not, since most signals are skipped and that would be noise.
 */
import type { DecisionRecord } from './types';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

export function formatDecision(d: DecisionRecord): string | null {
  const tag = d.mode === 'live' ? '[LIVE]' : '[dry run]';
  const who = d.trader_name ? ` (copying @${d.trader_name})` : '';
  const at = d.price != null ? ` at ${d.price}` : '';
  switch (d.decision) {
    case 'open':
    case 'add': {
      const dir = d.side === 'BUY' ? 'long' : 'short';
      const verb = d.decision === 'open' ? 'Opened' : 'Added to';
      const lev = d.signal_leverage != null ? `, trader at ${d.signal_leverage}x` : '';
      const size = d.notional_usd != null ? `, ${money(d.notional_usd)} position` : '';
      return `${tag} ${verb} ${d.ticker} ${dir}: ${d.contracts} contracts${at}${size}${lev}${who}`;
    }
    case 'close': {
      const pnl = d.pnl_usd != null ? `, P&L ${money(d.pnl_usd)}` : '';
      return `${tag} Closed ${d.ticker}: ${d.contracts} contracts${at}${pnl}${who}. ${d.reason}`;
    }
    case 'error':
      return `${tag} Error on ${d.ticker ?? 'a signal'}${who}: ${d.reason}`;
    default:
      return null;
  }
}

export class Notifier {
  constructor(private url: string | undefined, private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  get enabled() {
    return !!this.url;
  }

  /** Never throws: a Slack outage must not break trading. Returns whether Slack accepted it. */
  async send(text: string): Promise<boolean> {
    if (!this.url) return false;
    try {
      const r = await this.fetcher(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async decision(d: DecisionRecord): Promise<void> {
    const text = formatDecision(d);
    if (text) await this.send(text);
  }
}
