import type { Signal } from './types';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Turn an Invo feed post into a Signal. Same rules as the original monitor.ts. */
export function parsePost(post: any): Signal | null {
  const u = post?.update;
  if (!u?.ticker || !u.verifiedTrade) return null;

  const isOpen = u.isOpen === true;
  const isClosed = u.isOpen === false && u.closingPrice != null;
  let action: Signal['action'];
  if (isClosed) action = 'close';
  else if (u.changes?.isAdded !== false) action = 'open';
  else if (isOpen) action = 'increase';
  else return null; // partial decrease: ignored

  const owner = u.owner ?? post.owner ?? {};
  const posted = Date.parse(post.createdAt ?? u.createdAt ?? u.updatedAt ?? '');
  return {
    postId: String(post.id),
    action,
    ticker: String(u.ticker).toUpperCase(),
    side: u.directionLong ? 'long' : 'short',
    leverage: num(u.leverage) ?? 1,
    entryPrice: num(u.entryPrice),
    closingPrice: num(u.closingPrice),
    traderId: owner.id ?? null,
    traderName: owner.username ?? null,
    winRate: num(u.portfolio?.winRate),
    positionId: u.baseShortId ?? null,
    postedAt: Number.isFinite(posted) ? posted : null,
  };
}

/** Key we file a copy under: the trader's position id, or trader+ticker when Invo omits it. */
export const positionKey = (s: Signal) => s.positionId ?? `${s.traderId}:${s.ticker}`;
