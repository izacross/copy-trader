export interface Env {
  TRADER: DurableObjectNamespace<import('./trader').Trader>;
  DB: D1Database;
  ASSETS: Fetcher;
  LIVE_TRADING: string;
  POLL_SECONDS: string;
  OWNER_EMAIL: string;
  DEV_ALLOW_UNAUTHENTICATED?: string;
  INVO_REFRESH_TOKEN?: string;
  COINBASE_API_KEY_NAME?: string;
  COINBASE_API_PRIVATE_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
}

export interface Signal {
  postId: string;
  action: 'open' | 'increase' | 'close';
  ticker: string;
  side: 'long' | 'short';
  leverage: number;
  entryPrice: number | null;
  closingPrice: number | null;
  traderId: string | null;
  traderName: string | null;
  winRate: number | null;
  positionId: string | null; // the trader's Invo baseShortId
  postedAt: number | null; // ms epoch, when Invo provides it
  source?: 'feed' | 'catch-up';
}

export interface Settings {
  live_enabled: boolean; // dashboard switch; only matters when LIVE_TRADING=true
  kill_switch: boolean; // stops new opens/adds; closes still go through
  paused_reason: string | null; // set by the auto-pause rules
  max_order_usd: number;
  max_position_pct: number;
  max_leverage: number;
  max_open_positions: number;
  max_daily_loss_usd: number;
  min_win_rate: number;
  allowed_symbols: string[]; // empty = any
  copy_shorts: boolean;
  max_slippage_pct: number;
  max_signal_age_sec: number;
  paper_balance_usd: number;
}

export const DEFAULT_SETTINGS: Settings = {
  live_enabled: false,
  kill_switch: false,
  paused_reason: null,
  max_order_usd: 25,
  max_position_pct: 10,
  max_leverage: 3,
  max_open_positions: 5,
  max_daily_loss_usd: 50,
  min_win_rate: 75,
  allowed_symbols: ['BTC', 'ETH', 'SOL'],
  copy_shorts: true,
  max_slippage_pct: 1.5,
  max_signal_age_sec: 60,
  paper_balance_usd: 1000,
};

export interface Position {
  key: string;
  mode: 'paper' | 'live';
  ticker: string;
  product_id: string;
  side: 'LONG' | 'SHORT';
  contracts: number;
  contract_size: number;
  entry_price: number;
  margin_usd: number;
  leverage: number;
  trader_id: string | null;
  trader_name: string | null;
  opened_at: number;
}

export interface DecisionRecord {
  ts: number;
  mode: 'paper' | 'live';
  post_id: string | null;
  trader_name: string | null;
  ticker: string | null;
  signal_action: string | null;
  signal_side: string | null;
  signal_leverage: number | null;
  decision: 'open' | 'add' | 'close' | 'skip' | 'error';
  reason: string;
  product_id?: string | null;
  side?: string | null;
  contracts?: number | null;
  price?: number | null;
  notional_usd?: number | null;
  pnl_usd?: number | null;
  order_id?: string | null;
}
