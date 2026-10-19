/** Invo REST client (signal source). Port of the original invo-client.ts. Reverse-engineered, undocumented API. */
const BASE = 'https://api.invoapp.com';
const APP_HEADERS = { 'x-app-version': '0.0.75', 'x-platform': 'web' };

function jwtExpiry(token: string): number {
  try {
    const part = token.replace('Bearer ', '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).expires ?? 0;
  } catch {
    return 0;
  }
}

export class InvoClient {
  private token = '';

  constructor(private refreshToken: string, private fetcher: typeof fetch = fetch) {}

  private async refresh(): Promise<void> {
    const r = await this.fetcher(`${BASE}/v1_0/auth/refresh_token`, {
      headers: { Authorization: `Bearer ${this.refreshToken}`, ...APP_HEADERS },
    });
    if (r.status !== 200) throw new Error(`Invo token refresh failed: HTTP ${r.status}`);
    const data: any = await r.json();
    if (!data.accessToken) throw new Error('Invo token refresh returned no accessToken');
    this.token = `Bearer ${data.accessToken}`;
  }

  async ensureToken(): Promise<void> {
    if (this.token && jwtExpiry(this.token) - Date.now() / 1000 > 30) return;
    await this.refresh();
  }

  refreshTokenDaysLeft(): number {
    return Math.floor((jwtExpiry(this.refreshToken) - Date.now() / 1000) / 86400);
  }

  private async post(path: string, body: unknown, retried = false): Promise<any> {
    await this.ensureToken();
    const r = await this.fetcher(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: this.token, 'Content-Type': 'application/json', ...APP_HEADERS },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && !retried) {
      this.token = '';
      return this.post(path, body, true);
    }
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      try {
        data = JSON.parse(atob(text)); // some responses are base64 JSON
      } catch {
        data = text;
      }
    }
    if (r.status >= 400) throw new Error(`Invo ${path} ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  getFeed(filter = 'following', itemLimit = 20, lastPostId: string | null = null) {
    return this.post('/v1_0/posts/get_feed', {
      filter: { filter, assetTypes: [] },
      params: { lastPostId, itemLimit },
    });
  }

  /** Current state of specific trader positions, by their baseShortId. */
  getTradeUpdates(investments: { baseShortId: string; mimicStartedAt: string }[]) {
    return this.post('/dex/trade', { investments });
  }
}
