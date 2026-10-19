import { D1Store } from './store';
import { isLive, Trader } from './trader';
import { DEFAULT_SETTINGS, type Env, type Settings } from './types';

export { Trader };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// One poller for the whole account, placed in eastern North America (near Coinbase's US venue).
const trader = (env: Env) => env.TRADER.get(env.TRADER.idFromName('main'), { locationHint: 'enam' });

/**
 * Cloudflare Access sits in front of the whole hostname and adds the signed-in email to every request.
 * We also check it here, so the API refuses anyone but the owner even if Access is misconfigured.
 */
function authorized(req: Request, env: Env): boolean {
  if (env.DEV_ALLOW_UNAUTHENTICATED === 'true') return true;
  const email = req.headers.get('cf-access-authenticated-user-email');
  return !!env.OWNER_EMAIL && !!email && email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
}

const NUMERIC: (keyof Settings)[] = [
  'max_order_usd', 'max_position_pct', 'max_leverage', 'max_open_positions', 'max_daily_loss_usd',
  'min_win_rate', 'max_slippage_pct', 'max_signal_age_sec', 'paper_balance_usd',
];

/** Accept only known settings with sane values. */
function cleanSettings(body: any): Partial<Settings> | string {
  const out: Partial<Settings> = {};
  for (const k of NUMERIC) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) return `${k} must be a number of 0 or more`;
    (out as any)[k] = n;
  }
  if (out.max_position_pct !== undefined && out.max_position_pct > 100) return 'max_position_pct can be at most 100';
  if (out.max_leverage !== undefined && out.max_leverage < 1) return 'max_leverage must be at least 1';
  if (body.copy_shorts !== undefined) out.copy_shorts = !!body.copy_shorts;
  if (body.allowed_symbols !== undefined) {
    const list = Array.isArray(body.allowed_symbols) ? body.allowed_symbols : String(body.allowed_symbols).split(',');
    out.allowed_symbols = list.map((s: string) => String(s).trim().toUpperCase()).filter(Boolean);
  }
  return out;
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  if (!authorized(req, env)) return json({ error: 'not authorized' }, 403);
  const store = new D1Store(env.DB);
  const stub = trader(env);

  if (req.method === 'GET' && path === '/api/state') {
    await stub.ensureRunning();
    const [status, settings, decisions] = await Promise.all([stub.status(), store.getSettings(), store.recentDecisions(200)]);
    const mode = status.mode as 'paper' | 'live';
    const dayStart = Date.now() - (Date.now() % 86_400_000);
    return json({
      status,
      settings,
      positions: await store.openPositions(mode),
      paperCash: await store.paperCash(),
      pnlToday: await store.realizedPnlSince(dayStart, mode),
      decisions,
    });
  }

  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const body: any = await req.json().catch(() => ({}));

  switch (path) {
    case '/api/settings': {
      const patch = cleanSettings(body);
      if (typeof patch === 'string') return json({ error: patch }, 400);
      return json(await store.saveSettings(patch));
    }
    case '/api/live': {
      const on = !!body.on;
      if (on && env.LIVE_TRADING !== 'true')
        return json({ error: 'Live trading is locked. Set LIVE_TRADING to "true" in wrangler.jsonc and redeploy first.' }, 400);
      if (on && !env.COINBASE_API_KEY_NAME) return json({ error: 'Add the Coinbase API key secrets first.' }, 400);
      if (on && (await store.openPositions('paper')).length)
        return json({ error: 'Close the paper positions first, so dry-run copies are never mixed with real ones.' }, 400);
      return json(await store.saveSettings({ live_enabled: on }));
    }
    case '/api/kill':
      return json(await store.saveSettings({ kill_switch: !!body.on }));
    case '/api/resume':
      return json(await store.saveSettings({ paused_reason: null }));
    case '/api/close-all':
      return json({ closed: await stub.closeAll() });
    case '/api/paper-reset': {
      const s = await store.getSettings();
      if (isLive(env, s.live_enabled)) return json({ error: 'Switch to dry run first.' }, 400);
      if ((await store.openPositions('paper')).length) return json({ error: 'Close the paper positions first.' }, 400);
      await store.setPaperCash(s.paper_balance_usd ?? DEFAULT_SETTINGS.paper_balance_usd);
      return json({ paperCash: await store.paperCash() });
    }
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/')) return api(req, env, path);
    return env.ASSETS.fetch(req);
  },

  // Watchdog, every minute: restart the poller if its alarm loop ever stopped.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(trader(env).ensureRunning());
  },
} satisfies ExportedHandler<Env>;
