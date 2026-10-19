/**
 * Coinbase Developer Platform (CDP) API key auth for the Advanced Trade API.
 * Each request carries `Authorization: Bearer <JWT>`, signed with the API key's private key and
 * bound to one method + host + path, valid for 2 minutes.
 *
 * Supports both CDP key types:
 *  - ECDSA: PEM ("-----BEGIN EC PRIVATE KEY-----" or PKCS#8 "BEGIN PRIVATE KEY"), signed ES256
 *  - Ed25519: base64 of the 64-byte secret (seed + public key) or the 32-byte seed, signed EdDSA
 */

const HOST = 'api.coinbase.com';
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array | ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const b64decode = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

const der = (tag: number, body: Uint8Array) => new Uint8Array([tag, ...derLength(body.length), ...body]);

/** Wrap a SEC1 "EC PRIVATE KEY" (P-256) in PKCS#8 so WebCrypto can import it. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algId = new Uint8Array([
    0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07,
  ]);
  return der(0x30, new Uint8Array([...version, ...algId, ...der(0x04, sec1)]));
}

const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export interface CoinbaseSigner {
  alg: 'ES256' | 'EdDSA';
  key: CryptoKey;
  keyName: string;
}

export async function loadSigner(keyName: string, privateKey: string): Promise<CoinbaseSigner> {
  const pem = privateKey.replace(/\\n/g, '\n').trim();
  if (pem.includes('BEGIN')) {
    const body = b64decode(pem.replace(/-----[^-]+-----/g, ''));
    const pkcs8 = pem.includes('BEGIN EC PRIVATE KEY') ? sec1ToPkcs8(body) : body;
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { alg: 'ES256', key, keyName };
  }
  const raw = b64decode(pem);
  if (raw.length !== 32 && raw.length !== 64) throw new Error('Coinbase Ed25519 key must be 32 or 64 bytes (base64)');
  const pkcs8 = new Uint8Array([...ED25519_PKCS8_PREFIX, ...raw.slice(0, 32)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return { alg: 'EdDSA', key, keyName };
}

/** Build the JWT for one request. `path` excludes the query string. */
export async function buildJwt(signer: CoinbaseSigner, method: string, path: string, nowSec = Math.floor(Date.now() / 1000)) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const header = { alg: signer.alg, kid: signer.keyName, nonce, typ: 'JWT' };
  const payload = { iss: 'cdp', sub: signer.keyName, nbf: nowSec, exp: nowSec + 120, uri: `${method} ${HOST}${path}` };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const algo = signer.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' };
  const sig = await crypto.subtle.sign(algo, signer.key, enc.encode(input)); // ECDSA output is raw r||s, as JWS wants
  return `${input}.${b64url(sig)}`;
}
