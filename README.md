# Copy Trader (Cloudflare + Coinbase)

Watches the Invo traders you follow and copies their trades onto **Coinbase perpetual-style futures**,
longs and shorts, with leverage capped by your limits. It runs on Cloudflare around the clock, and a
private dashboard lets you watch it and stop it.

**It starts in dry run.** Every copy is simulated with live Coinbase prices against a $1,000 paper
balance. Real orders need two locks opened by you: `LIVE_TRADING` set to `"true"` in `wrangler.jsonc`
(and redeployed), *and* the live switch turned on in the dashboard.

Plan and reasoning: the [PRD](https://claude.ai/code/artifact/3662ceda-b4b5-426c-be6b-64a8e4f5b927).

## How it works

```
Invo following feed ──(every 5 s)──► Poller (Durable Object, US East) ──► Risk engine ──► Coinbase futures
                                            │                                   │
                                            └────────── D1: copies, decision log, settings ──► Dashboard (behind Cloudflare Access)
Cron, every minute: restarts the poller if it ever stops.
```

| Trader does        | We do on Coinbase                                                        |
|--------------------|--------------------------------------------------------------------------|
| Opens a long       | Buys contracts                                                           |
| Opens a short      | Sells contracts (if "Copy short trades" is on)                           |
| Uses leverage      | Copied, capped at your max leverage (default 3x)                         |
| Adds to a position | Adds contracts, if we copied the original                                |
| Closes             | Closes exactly the contracts we opened for that position                 |

**Sizing:** margin = the smaller of "margin per trade ($)" and "% of balance". Position size = margin ×
leverage, converted to whole contracts and rounded down. Too small for one contract = skipped.

**A copy is skipped** (and the reason logged) when: the kill switch is on, the bot is paused, the coin
isn't in your allowed list, Coinbase has no perpetual for it, the trader's win rate is under your
minimum, the signal is older than 60 s, the price has moved more than 1.5% from the trader's entry, or
you're at your max open copies. Closes always go through, even with the kill switch on.

**Catch-up:** closes that happen during downtime or a burst of posts still get mirrored. If every post on the first feed
page is new, the poller pages back (up to about 270 posts) until it reaches ones it has seen. And once
a minute it asks Invo about each trader position we hold a copy of, and closes ours if Invo says the
trader has closed. Missed opens are not copied late: they're skipped as stale.

**Auto-pause:** new opens stop after 3 errors in a row or when today's realized loss passes your
limit. Press Resume on the dashboard to continue.

## Set up (about 20 minutes)

You need a Cloudflare account with a domain on it, and Node 20+.

```bash
npm install
npx wrangler login
npx wrangler d1 create copy-trader        # paste the database_id it prints into wrangler.jsonc
npm run db:migrate
npx wrangler secret put INVO_REFRESH_TOKEN   # same token as invo-copy-trader (see its README)
```

1. In `wrangler.jsonc`, set `OWNER_EMAIL` to the email you'll log in with, and add your hostname:
   `"routes": [{ "pattern": "trader.yourdomain.com", "custom_domain": true }]`.
2. In the Cloudflare dashboard, open **Zero Trust > Access > Applications**, add a self-hosted app for
   `trader.yourdomain.com`, and allow only your email. The API also checks that email itself.
3. `npm run deploy`, then open `https://trader.yourdomain.com`. The poller starts within a minute.

The first feed read only records existing posts, so nothing old gets copied. From then on, new trades
from people you follow show up in the Decisions table.

## Going live

1. Let it run in dry run for a couple of weeks and read the Decisions table.
2. Enable futures trading on your Coinbase account.
3. Create an API key at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) with **View and Trade
   only** (never Transfer). ECDSA and Ed25519 keys both work.
   ```bash
   npx wrangler secret put COINBASE_API_KEY_NAME     # organizations/.../apiKeys/...
   npx wrangler secret put COINBASE_API_PRIVATE_KEY  # the PEM, or the base64 Ed25519 secret
   ```
4. Close any paper copies and reset limits to small numbers.
5. Set `"LIVE_TRADING": "true"` in `wrangler.jsonc`, `npm run deploy`, then press **Turn on live
   trading** on the dashboard. The badge turns red and says LIVE.

To stop: **Stop new trades** blocks new copies (exits still mirror). **Close all copies** closes
everything at market. **Switch back to dry run** returns to paper.

## Develop

```bash
cp .dev.vars.example .dev.vars   # add your Invo token
npm run db:migrate:local
npm run dev                      # http://localhost:8787, login check off locally
npm test                         # engine, sizing, skips, closes, auto-pause, Coinbase signing
npm run typecheck
```

| File | What it does |
|---|---|
| `src/trader.ts` | The poller: alarm every 5 s, reads Invo, runs the engine |
| `src/engine.ts` | Risk checks, sizing, open/add/close, auto-pause |
| `src/catchup.ts` | Feed backfill and the once-a-minute position check |
| `src/coinbase/` | Coinbase API: JWT signing, products, quotes, balance, orders |
| `src/broker.ts` | Live broker and paper broker (same prices, simulated fills) |
| `src/invo.ts`, `src/signals.ts` | Invo feed and signal parsing, ported from invo-copy-trader |
| `src/store.ts`, `migrations/` | D1 storage |
| `src/index.ts` | Dashboard API, cron watchdog |
| `public/index.html` | The dashboard |

## Known gaps

- Not yet checked against the live Invo and Coinbase APIs: the build sandbox can't reach either. The
  first deploy in dry run is the test.
- The position check relies on Invo's `/dex/trade` endpoint reporting `isOpen: false`. It only acts on
  that exact answer, so if Invo's format differs it does nothing rather than closing by mistake.
- Fill prices are estimated from the quote at order time, not read back from Coinbase.

Not financial advice. Leveraged futures can lose more than a trade's margin in fast markets. The Invo
API is reverse-engineered and can change at any time.
