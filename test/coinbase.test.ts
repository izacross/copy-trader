import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildJwt, loadSigner } from '../src/coinbase/auth';
import { CoinbaseClient } from '../src/coinbase/client';

const b64urlDecode = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'));

async function verify(jwt: string, publicKey: CryptoKey, algo: AlgorithmIdentifier | EcdsaParams) {
  const [h, p, s] = jwt.split('.');
  return crypto.subtle.verify(algo, publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
}

describe('Coinbase JWT', () => {
  it('signs ES256 with a SEC1 "EC PRIVATE KEY" PEM and binds method + path', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    const signer = await loadSigner('organizations/o/apiKeys/k', pem.replace(/\n/g, '\\n')); // as pasted into a secret
    const jwt = await buildJwt(signer, 'POST', '/api/v3/brokerage/orders', 1_800_000_000);
    const [h, p] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
    expect(h).toMatchObject({ alg: 'ES256', kid: 'organizations/o/apiKeys/k', typ: 'JWT' });
    expect(p).toMatchObject({ iss: 'cdp', sub: 'organizations/o/apiKeys/k', nbf: 1_800_000_000, exp: 1_800_000_120, uri: 'POST api.coinbase.com/api/v3/brokerage/orders' });
    const pub = await crypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await verify(jwt, pub, { name: 'ECDSA', hash: 'SHA-256' })).toBe(true);
  });

  it('signs EdDSA with a base64 Ed25519 key (64-byte seed + public key)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const signer = await loadSigner('kid', Buffer.concat([seed, pubRaw]).toString('base64'));
    const jwt = await buildJwt(signer, 'GET', '/api/v3/brokerage/cfm/balance_summary');
    const pub = await crypto.subtle.importKey('raw', pubRaw, { name: 'Ed25519' }, false, ['verify']);
    expect(await verify(jwt, pub, { name: 'Ed25519' })).toBe(true);
  });
});

describe('CoinbaseClient', () => {
  const fakeFetch = (routes: Record<string, unknown>, calls: any[] = []) =>
    (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : { error: 'nope' }), { status: hit ? 200 : 404 });
    }) as unknown as typeof fetch;

  it('finds perpetuals by underlying coin from public market data, without keys', async () => {
    const calls: any[] = [];
    const cb = new CoinbaseClient(undefined, undefined, fakeFetch({
      '/market/products': { products: [
        { product_id: 'BIP-20DEC30-CDE', price: '100000', future_product_details: { contract_root_unit: 'BTC', contract_size: '0.01' } },
        { product_id: 'OLD', trading_disabled: true, future_product_details: { contract_root_unit: 'ETH', contract_size: '0.1' } },
      ] },
      '/market/product_book': { pricebook: { bids: [{ price: '99990' }], asks: [{ price: '100010' }] } },
    }, calls));
    expect(await cb.findPerp('btc')).toMatchObject({ productId: 'BIP-20DEC30-CDE', contractSize: 0.01 });
    expect(await cb.findPerp('ETH')).toBeNull();
    expect(await cb.quote('BIP-20DEC30-CDE')).toEqual({ bid: 99_990, ask: 100_010 });
    expect(calls.every(([, init]) => !init.headers.Authorization)).toBe(true);
  });

  it('sends a signed market order for whole contracts', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const calls: any[] = [];
    const cb = new CoinbaseClient('kid', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fakeFetch({ '/orders': { success: true, success_response: { order_id: 'abc' } } }, calls));
    expect(await cb.marketOrder('BIP-20DEC30-CDE', 'SELL', 2, 'cid')).toBe('abc');
    const [url, init] = calls[0];
    expect(url).toBe('https://api.coinbase.com/api/v3/brokerage/orders');
    expect(init.headers.Authorization).toMatch(/^Bearer ey/);
    expect(JSON.parse(init.body)).toEqual({
      client_order_id: 'cid', product_id: 'BIP-20DEC30-CDE', side: 'SELL',
      order_configuration: { market_market_ioc: { base_size: '2' } },
    });
  });

  it('surfaces order rejections as errors', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cb = new CoinbaseClient('kid', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fakeFetch({ '/orders': { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'no money' } } }));
    await expect(cb.marketOrder('X', 'BUY', 1, 'c')).rejects.toThrow('INSUFFICIENT_FUND');
  });
});
