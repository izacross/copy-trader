import type { CoinbaseClient, PerpProduct, Quote } from './coinbase/client';
import type { Store } from './store';

/** What the engine needs from an exchange. Paper and live share Coinbase's real market data. */
export interface Broker {
  mode: 'paper' | 'live';
  findPerp(ticker: string): Promise<PerpProduct | null>;
  quote(productId: string): Promise<Quote>;
  availableMargin(): Promise<number>;
  marketOrder(productId: string, side: 'BUY' | 'SELL', contracts: number, clientOrderId: string): Promise<string>;
}

/** Real orders on Coinbase. Only constructed when both live locks are open. */
export class LiveBroker implements Broker {
  mode = 'live' as const;
  constructor(private cb: CoinbaseClient) {}
  findPerp(t: string) {
    return this.cb.findPerp(t);
  }
  quote(p: string) {
    return this.cb.quote(p);
  }
  availableMargin() {
    return this.cb.futuresBuyingPower();
  }
  marketOrder(p: string, side: 'BUY' | 'SELL', n: number, id: string) {
    return this.cb.marketOrder(p, side, n, id);
  }
}

/** Dry run: live Coinbase prices, simulated fills, a virtual balance kept in D1. Sends nothing. */
export class PaperBroker implements Broker {
  mode = 'paper' as const;
  constructor(private cb: CoinbaseClient, private store: Store) {}
  findPerp(t: string) {
    return this.cb.findPerp(t);
  }
  quote(p: string) {
    return this.cb.quote(p);
  }
  availableMargin() {
    return this.store.paperCash();
  }
  async marketOrder(_p: string, _s: 'BUY' | 'SELL', _n: number, id: string) {
    return `paper-${id}`;
  }
}
