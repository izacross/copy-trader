CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Our copies, keyed by the trader's position id (Invo baseShortId).
CREATE TABLE IF NOT EXISTS positions (
  key TEXT PRIMARY KEY,
  mode TEXT NOT NULL,              -- 'paper' | 'live'
  ticker TEXT NOT NULL,
  product_id TEXT NOT NULL,
  side TEXT NOT NULL,              -- 'LONG' | 'SHORT'
  contracts REAL NOT NULL,
  contract_size REAL NOT NULL,
  entry_price REAL NOT NULL,
  margin_usd REAL NOT NULL,
  leverage REAL NOT NULL,
  trader_id TEXT,
  trader_name TEXT,
  opened_at INTEGER NOT NULL
);

-- Every signal and what we did with it.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  post_id TEXT,
  trader_name TEXT,
  ticker TEXT,
  signal_action TEXT,
  signal_side TEXT,
  signal_leverage REAL,
  decision TEXT NOT NULL,          -- 'open' | 'add' | 'close' | 'skip' | 'error'
  reason TEXT NOT NULL,
  product_id TEXT,
  side TEXT,
  contracts REAL,
  price REAL,
  notional_usd REAL,
  pnl_usd REAL,
  order_id TEXT
);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions (ts);

CREATE TABLE IF NOT EXISTS seen_posts (post_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
