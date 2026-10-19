import { beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../src/broker';
import { Engine } from '../src/engine';
import { parsePost } from '../src/signals';
import type { Signal } from '../src/types';
import { MemoryStore } from './memory-store';

const NOW = Date.parse('2026-10-19T18:00:00Z');

function post(id: string, o: Partial<{ ticker: string; long: boolean; lev: number; open: boolean; closing: number | null; added: boolean; base: string; wr: number; entry: number; at: string }> = {}) {
  return {
    id,
    createdAt: o.at ?? new Date(NOW - 3000).toISOString(),
    update: {
      ticker: o.ticker ?? 'BTC', verifiedTrade: true, directionLong: o.long ?? true, leverage: o.lev ?? 10,
      entryPrice: o.entry ?? 100_000, closingPrice: o.closing ?? null, isOpen: o.open ?? true,
      changes: { isAdded: o.added ?? true }, baseShortId: o.base ?? 'pos1',
      owner: { id: 't1', username: 'alice' }, portfolio: { winRate: o.wr ?? 85 },
    },
  };
}
const sig = (p: any) => parsePost(p) as Signal;

class FakeBroker implements Broker {
  orders: [string, string, number][] = [];
  bid = 99_900;
  ask = 100_100;
  constructor(public mode: 'paper' | 'live' = 'paper', public margin = 1000) {}
  async findPerp(t: string) {
    return t === 'BTC' ? { productId: 'BIP-20DEC30-CDE', root: 'BTC', contractSize: 0.01, price: 100_000 }
      : t === 'ETH' ? { productId: 'ETP-20DEC30-CDE', root: 'ETH', contractSize: 0.1, price: 4000 } : null;
  }
  async quote() { return { bid: this.bid, ask: this.ask }; }
  async availableMargin() { return this.margin; }
  async marketOrder(p: string, side: 'BUY' | 'SELL', n: number) { this.orders.push([p, side, n]); return `o${this.orders.length}`; }
}

let store: MemoryStore;
let broker: FakeBroker;
let engine: Engine;
beforeEach(() => {
  store = new MemoryStore();
  store.settings.max_order_usd = 500;
  store.settings.max_position_pct = 50;
  broker = new FakeBroker();
  engine = new Engine(store, broker, () => 'id');
});

describe('opening', () => {
  it('sizes contracts from margin x capped leverage and buys a long', async () => {
    const d = await engine.handle(sig(post('1')), NOW);
    // budget min(500, 1000*50%) = 500; leverage min(10, 3) = 3; 1500 / (100,100 * 0.01) = 1.49 -> 1 contract
    expect(d).toMatchObject({ decision: 'open', side: 'BUY', contracts: 1, price: 100_100 });
    expect(broker.orders).toEqual([['BIP-20DEC30-CDE', 'BUY', 1]]);
    const pos = await store.getPosition('pos1', 'paper');
    expect(pos).toMatchObject({ side: 'LONG', contracts: 1, leverage: 3 });
    expect(store.cash).toBeCloseTo(1000 - 1001 / 3, 2);
  });

  it('sells contracts to copy a short', async () => {
    const d = await engine.handle(sig(post('1', { long: false })), NOW);
    expect(d).toMatchObject({ decision: 'open', side: 'SELL', price: 99_900 });
    expect((await store.getPosition('pos1', 'paper'))!.side).toBe('SHORT');
  });

  it.each([
    ['kill switch', () => { store.settings.kill_switch = true; }, post('1'), 'kill switch'],
    ['paused', () => { store.settings.paused_reason = 'x'; }, post('1'), 'paused'],
    ['coin not allowed', () => {}, post('1', { ticker: 'DOGE' }), 'not in allowed'],
    ['no perp on Coinbase', () => { store.settings.allowed_symbols = []; }, post('1', { ticker: 'XYZ' }), 'no perpetual'],
    ['shorts off', () => { store.settings.copy_shorts = false; }, post('1', { long: false }), 'shorts is off'],
    ['low win rate', () => {}, post('1', { wr: 60 }), 'win rate'],
    ['stale signal', () => {}, post('1', { at: new Date(NOW - 120_000).toISOString() }), 'old'],
    ['price moved', () => {}, post('1', { entry: 95_000 }), 'price moved'],
    ['too small', () => { store.settings.max_order_usd = 100; }, post('1'), 'less than one contract'],
    ['add without copy', () => {}, post('1', { added: false }), 'never copied'],
  ])('skips: %s', async (_name, setup, p, reason) => {
    setup();
    const d = await engine.handle(sig(p), NOW);
    expect(d.decision).toBe('skip');
    expect(d.reason).toContain(reason);
    expect(broker.orders).toEqual([]);
  });

  it('never copies the same position twice', async () => {
    await engine.handle(sig(post('1')), NOW);
    const d = await engine.handle(sig(post('2')), NOW);
    expect(d.reason).toBe('already copied this position');
    expect(broker.orders).toHaveLength(1);
  });

  it('stops at max open positions', async () => {
    store.settings.max_open_positions = 1;
    await engine.handle(sig(post('1')), NOW);
    const d = await engine.handle(sig(post('2', { ticker: 'ETH', base: 'pos2', entry: 4000 })), NOW);
    expect(d.reason).toContain('open positions');
  });

  it('adds to a copied position', async () => {
    await engine.handle(sig(post('1')), NOW);
    const d = await engine.handle(sig(post('2', { added: false })), NOW);
    expect(d.decision).toBe('add');
    expect((await store.getPosition('pos1', 'paper'))!.contracts).toBe(2);
  });
});

describe('closing', () => {
  it('closes exactly our contracts on the opposite side and books P&L', async () => {
    await engine.handle(sig(post('1')), NOW);
    broker.bid = 102_000;
    const d = await engine.handle(sig(post('2', { open: false, closing: 102_000 })), NOW);
    expect(d).toMatchObject({ decision: 'close', side: 'SELL', contracts: 1 });
    expect(d.pnl_usd).toBeCloseTo((102_000 - 100_100) * 0.01, 2);
    expect(await store.getPosition('pos1', 'paper')).toBeNull();
    expect(store.cash).toBeCloseTo(1000 + 19, 2);
  });

  it('closes a short by buying back, still allowed when the kill switch is on', async () => {
    await engine.handle(sig(post('1', { long: false })), NOW);
    store.settings.kill_switch = true;
    broker.ask = 98_000;
    const d = await engine.handle(sig(post('2', { long: false, open: false, closing: 98_000 })), NOW);
    expect(d).toMatchObject({ decision: 'close', side: 'BUY' });
    expect(d.pnl_usd).toBeCloseTo((99_900 - 98_000) * 0.01, 2);
  });

  it('ignores closes for positions we never copied', async () => {
    const d = await engine.handle(sig(post('9', { open: false, closing: 1 })), NOW);
    expect(d.reason).toContain('never copied');
    expect(broker.orders).toEqual([]);
  });

  it('keeps paper and live copies apart', async () => {
    await engine.handle(sig(post('1')), NOW);
    const live = new Engine(store, new FakeBroker('live'), () => 'id');
    const d = await live.handle(sig(post('2', { open: false, closing: 1 })), NOW);
    expect(d.reason).toContain('never copied');
  });
});

describe('auto-pause', () => {
  it('pauses after 3 errors in a row', async () => {
    broker.marketOrder = async () => { throw new Error('boom'); };
    for (const id of ['1', '2', '3']) await engine.handle(sig(post(id, { base: `p${id}` })), NOW);
    expect(store.settings.paused_reason).toBe('3 errors in a row');
  });

  it('pauses when the daily loss passes the limit', async () => {
    store.settings.max_daily_loss_usd = 10;
    await engine.handle(sig(post('1')), NOW);
    broker.bid = 98_000; // -21 on 1 contract
    await engine.handle(sig(post('2', { open: false, closing: 98_000 })), NOW);
    expect(store.settings.paused_reason).toContain('daily loss');
  });
});

describe('catch-up close', () => {
  it('closes our copy when the position check finds the trader closed', async () => {
    await engine.handle(sig(post('1')), NOW);
    const d = await engine.handle({ ...sig(post('x', { open: false, closing: 1 })), postId: 'catch-up:pos1', source: 'catch-up' }, NOW);
    expect(d).toMatchObject({ decision: 'close', side: 'SELL', contracts: 1 });
    expect(d.reason).toContain('caught up');
  });
});
