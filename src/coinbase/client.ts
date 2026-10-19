import { buildJwt, loadSigner, type CoinbaseSigner } from './auth';

const BASE = 'https://api.coinbase.com';
const V3 = '/api/v3/brokerage';

export interface PerpProduct {
  productId: string; // e.g. "BIP-20DEC30-CDE"
  root: string; // underlying coin, e.g. "BTC"
  contractSize: number; // coins per contract
  price: number;
}

export interface Quote {
  bid: number;
  ask: number;
}

/** Coinbase Advanced Trade REST. Market data uses the public endpoints, so dry run needs no keys. */
export class CoinbaseClient {
  private signer: Promise<CoinbaseSigner> | null;
  private perps: { at: number; list: PerpProduct[] } | null = null;

  constructor(keyName?: string, privateKey?: string, private fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.signer = keyName && privateKey ? loadSigner(keyName, privateKey) : null;
  }

  get hasKeys() {
    return this.signer !== null;
  }

  private async request(method: 'GET' | 'POST', path: string, query = '', body?: unknown, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!this.signer) throw new Error('Coinbase API key not configured');
      headers.Authorization = `Bearer ${await buildJwt(await this.signer, method, path)}`;
    }
    const r = await this.fetcher(`${BASE}${path}${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status >= 400) throw new Error(`Coinbase ${method} ${path} ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  /** All perpetual-style futures, cached for 10 minutes. */
  async perpetuals(): Promise<PerpProduct[]> {
    if (this.perps && Date.now() - this.perps.at < 600_000) return this.perps.list;
    const data = await this.request(
      'GET',
      `${V3}/market/products`,
      '?product_type=FUTURE&contract_expiry_type=PERPETUAL',
      undefined,
      false,
    );
    const list: PerpProduct[] = (data.products ?? [])
      .filter((p: any) => !p.trading_disabled && !p.is_disabled)
      .map((p: any) => ({
        productId: p.product_id,
        root: String(p.future_product_details?.contract_root_unit ?? p.base_currency_id ?? '').toUpperCase(),
        contractSize: Number(p.future_product_details?.contract_size ?? 0),
        price: Number(p.price ?? 0),
      }))
      .filter((p: PerpProduct) => p.root && p.contractSize > 0);
    this.perps = { at: Date.now(), list };
    return list;
  }

  async findPerp(ticker: string): Promise<PerpProduct | null> {
    return (await this.perpetuals()).find((p) => p.root === ticker.toUpperCase()) ?? null;
  }

  async quote(productId: string): Promise<Quote> {
    const data = await this.request('GET', `${V3}/market/product_book`, `?product_id=${encodeURIComponent(productId)}&limit=1`, undefined, false);
    const book = data.pricebook ?? {};
    const bid = Number(book.bids?.[0]?.price ?? 0);
    const ask = Number(book.asks?.[0]?.price ?? 0);
    if (!bid || !ask) throw new Error(`No quote for ${productId}`);
    return { bid, ask };
  }

  /** USD available to open futures positions. */
  async futuresBuyingPower(): Promise<number> {
    const data = await this.request('GET', `${V3}/cfm/balance_summary`);
    return Number(data.balance_summary?.futures_buying_power?.value ?? 0);
  }

  async futuresPositions(): Promise<any[]> {
    return (await this.request('GET', `${V3}/cfm/positions`)).positions ?? [];
  }

  /** Market order for a number of contracts. Returns Coinbase's order id. */
  async marketOrder(productId: string, side: 'BUY' | 'SELL', contracts: number, clientOrderId: string): Promise<string> {
    const data = await this.request('POST', `${V3}/orders`, '', {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: { market_market_ioc: { base_size: String(contracts) } },
    });
    if (!data.success) {
      const e = data.error_response ?? {};
      throw new Error(`Coinbase rejected order: ${e.error ?? ''} ${e.message ?? e.preview_failure_reason ?? JSON.stringify(data).slice(0, 200)}`);
    }
    return data.success_response?.order_id ?? data.order_id ?? '';
  }
}
