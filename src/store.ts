import { DEFAULT_SETTINGS, type DecisionRecord, type Position, type Settings } from './types';

export interface Store {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  paperCash(): Promise<number>;
  setPaperCash(usd: number): Promise<void>;
  getPosition(key: string, mode: Position['mode']): Promise<Position | null>;
  findPosition(traderId: string | null, ticker: string, mode: Position['mode']): Promise<Position | null>;
  openPositions(mode: Position['mode']): Promise<Position[]>;
  upsertPosition(p: Position): Promise<void>;
  deletePosition(key: string, mode: Position['mode']): Promise<void>;
  record(d: DecisionRecord): Promise<void>;
  recentDecisions(limit: number): Promise<DecisionRecord[]>;
  realizedPnlSince(ts: number, mode: Position['mode']): Promise<number>;
  markSeen(postIds: string[]): Promise<string[]>; // returns the ids that were new
  seenCount(): Promise<number>;
}

/** Positions are keyed per mode, so paper copies never get "closed" with real orders. */
const pk = (key: string, mode: string) => `${mode}:${key}`;

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async getSettings(): Promise<Settings> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").first<{ value: string }>();
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify(next))
      .run();
    return next;
  }

  async paperCash(): Promise<number> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE key = 'paper_cash'").first<{ value: string }>();
    return row ? Number(row.value) : (await this.getSettings()).paper_balance_usd;
  }

  async setPaperCash(usd: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('paper_cash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(usd))
      .run();
  }

  private row(r: any): Position | null {
    return r ? { ...r, key: String(r.key).split(':').slice(1).join(':') } : null;
  }

  async getPosition(key: string, mode: Position['mode']) {
    return this.row(await this.db.prepare('SELECT * FROM positions WHERE key = ?').bind(pk(key, mode)).first());
  }

  async findPosition(traderId: string | null, ticker: string, mode: Position['mode']) {
    return this.row(
      await this.db
        .prepare('SELECT * FROM positions WHERE trader_id IS ? AND ticker = ? AND mode = ? ORDER BY opened_at LIMIT 1')
        .bind(traderId, ticker, mode)
        .first(),
    );
  }

  async openPositions(mode: Position['mode']) {
    const { results } = await this.db.prepare('SELECT * FROM positions WHERE mode = ? ORDER BY opened_at').bind(mode).all();
    return results.map((r) => this.row(r)!) as Position[];
  }

  async upsertPosition(p: Position) {
    await this.db
      .prepare(
        `INSERT INTO positions (key, mode, ticker, product_id, side, contracts, contract_size, entry_price, margin_usd, leverage, trader_id, trader_name, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET contracts = excluded.contracts, entry_price = excluded.entry_price,
           margin_usd = excluded.margin_usd, leverage = excluded.leverage`,
      )
      .bind(pk(p.key, p.mode), p.mode, p.ticker, p.product_id, p.side, p.contracts, p.contract_size, p.entry_price, p.margin_usd, p.leverage, p.trader_id, p.trader_name, p.opened_at)
      .run();
  }

  async deletePosition(key: string, mode: Position['mode']) {
    await this.db.prepare('DELETE FROM positions WHERE key = ?').bind(pk(key, mode)).run();
  }

  async record(d: DecisionRecord) {
    await this.db
      .prepare(
        `INSERT INTO decisions (ts, mode, post_id, trader_name, ticker, signal_action, signal_side, signal_leverage, decision, reason,
           product_id, side, contracts, price, notional_usd, pnl_usd, order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(d.ts, d.mode, d.post_id, d.trader_name, d.ticker, d.signal_action, d.signal_side, d.signal_leverage, d.decision, d.reason,
        d.product_id ?? null, d.side ?? null, d.contracts ?? null, d.price ?? null, d.notional_usd ?? null, d.pnl_usd ?? null, d.order_id ?? null)
      .run();
  }

  async recentDecisions(limit: number) {
    const { results } = await this.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').bind(limit).all();
    return results as unknown as DecisionRecord[];
  }

  async realizedPnlSince(ts: number, mode: Position['mode']) {
    const row = await this.db
      .prepare('SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM decisions WHERE ts >= ? AND mode = ? AND pnl_usd IS NOT NULL')
      .bind(ts, mode)
      .first<{ pnl: number }>();
    return row?.pnl ?? 0;
  }

  async markSeen(postIds: string[]) {
    if (!postIds.length) return [];
    const now = Date.now();
    const results = await this.db.batch(
      postIds.map((id) => this.db.prepare('INSERT OR IGNORE INTO seen_posts (post_id, ts) VALUES (?, ?)').bind(id, now)),
    );
    return postIds.filter((_, i) => (results[i].meta?.changes ?? 0) > 0);
  }

  async seenCount() {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM seen_posts').first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** How many posts from people you follow showed up since a time, and when the latest one did. */
  async feedActivity(since: number): Promise<{ posts: number; lastAt: number | null }> {
    const row = await this.db
      .prepare('SELECT SUM(ts >= ?) AS n, MAX(ts) AS last FROM seen_posts')
      .bind(since)
      .first<{ n: number | null; last: number | null }>();
    return { posts: row?.n ?? 0, lastAt: row?.last ?? null };
  }
}
