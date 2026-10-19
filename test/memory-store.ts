import type { Store } from '../src/store';
import { DEFAULT_SETTINGS, type DecisionRecord, type Position, type Settings } from '../src/types';

/** In-memory Store with the same behaviour as D1Store, for tests. */
export class MemoryStore implements Store {
  settings: Settings = { ...DEFAULT_SETTINGS, allowed_symbols: [...DEFAULT_SETTINGS.allowed_symbols] };
  cash = DEFAULT_SETTINGS.paper_balance_usd;
  positions = new Map<string, Position>();
  decisions: DecisionRecord[] = [];
  seen = new Set<string>();

  async getSettings() { return { ...this.settings }; }
  async saveSettings(p: Partial<Settings>) { this.settings = { ...this.settings, ...p }; return { ...this.settings }; }
  async paperCash() { return this.cash; }
  async setPaperCash(n: number) { this.cash = n; }
  async getPosition(key: string, mode: Position['mode']) { return this.positions.get(`${mode}:${key}`) ?? null; }
  async findPosition(traderId: string | null, ticker: string, mode: Position['mode']) {
    return [...this.positions.values()].find((p) => p.trader_id === traderId && p.ticker === ticker && p.mode === mode) ?? null;
  }
  async openPositions(mode: Position['mode']) { return [...this.positions.values()].filter((p) => p.mode === mode); }
  async upsertPosition(p: Position) { this.positions.set(`${p.mode}:${p.key}`, { ...p }); }
  async deletePosition(key: string, mode: Position['mode']) { this.positions.delete(`${mode}:${key}`); }
  async record(d: DecisionRecord) { this.decisions.push(d); }
  async recentDecisions(limit: number) { return this.decisions.slice(-limit).reverse(); }
  async realizedPnlSince(ts: number, mode: Position['mode']) {
    return this.decisions.filter((d) => d.ts >= ts && d.mode === mode && d.pnl_usd != null).reduce((a, d) => a + (d.pnl_usd ?? 0), 0);
  }
  async markSeen(ids: string[]) { const fresh = ids.filter((id) => !this.seen.has(id)); fresh.forEach((id) => this.seen.add(id)); return fresh; }
  async seenCount() { return this.seen.size; }
}
