import { describe, expect, it } from 'vitest';
import { formatDecision, Notifier } from '../src/notify';
import type { DecisionRecord } from '../src/types';

const base: DecisionRecord = {
  ts: 0, mode: 'paper', post_id: '1', trader_name: 'alice', ticker: 'BTC', signal_action: 'open',
  signal_side: 'long', signal_leverage: 10, decision: 'skip', reason: '',
};

describe('formatDecision', () => {
  it('describes an open', () => {
    const t = formatDecision({ ...base, decision: 'open', side: 'BUY', contracts: 1, price: 100100, notional_usd: 1001 });
    expect(t).toBe('[dry run] Opened BTC long: 1 contracts at 100100, $1001.00 position, trader at 10x (copying @alice)');
  });

  it('describes a live close with P&L', () => {
    const t = formatDecision({ ...base, mode: 'live', decision: 'close', side: 'SELL', contracts: 1, price: 98000, pnl_usd: -21, reason: 'trader closed; mirrored the exit' });
    expect(t).toBe('[LIVE] Closed BTC: 1 contracts at 98000, P&L -$21.00 (copying @alice). trader closed; mirrored the exit');
  });

  it('describes errors and stays quiet on skips', () => {
    expect(formatDecision({ ...base, decision: 'error', reason: 'boom' })).toContain('Error on BTC (copying @alice): boom');
    expect(formatDecision({ ...base, reason: 'win rate too low' })).toBeNull();
  });
});

describe('Notifier', () => {
  it('posts JSON text to the webhook', async () => {
    const calls: [string, RequestInit][] = [];
    const n = new Notifier('https://hooks.slack.com/x', (async (u: string, i: RequestInit) => { calls.push([u, i]); return new Response('ok'); }) as any);
    expect(await n.send('hi')).toBe(true);
    expect(calls[0][0]).toBe('https://hooks.slack.com/x');
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ text: 'hi' });
  });

  it('does nothing without a webhook and never throws', async () => {
    expect(await new Notifier(undefined).send('hi')).toBe(false);
    const broken = new Notifier('https://x', (async () => { throw new Error('down'); }) as any);
    expect(await broken.send('hi')).toBe(false);
  });
});
