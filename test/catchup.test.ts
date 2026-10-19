import { describe, expect, it } from 'vitest';
import { closedPositionIds, readNewPosts } from '../src/catchup';

function feed(total: number) {
  // Newest first: ids total..1. Pages continue after lastPostId.
  const all = Array.from({ length: total }, (_, i) => ({ id: String(total - i) }));
  const calls: [string | null, number][] = [];
  const getPage = async (lastPostId: string | null, limit: number) => {
    calls.push([lastPostId, limit]);
    const start = lastPostId ? all.findIndex((p) => p.id === lastPostId) + 1 : 0;
    return all.slice(start, start + limit);
  };
  return { getPage, calls };
}

function seenStore(ids: string[]) {
  const seen = new Set(ids);
  return async (batch: string[]) => batch.filter((id) => !seen.has(id) && (seen.add(id), true));
}

describe('readNewPosts', () => {
  it('reads one page when it reaches posts already seen', async () => {
    const { getPage, calls } = feed(100);
    const r = await readNewPosts(getPage, seenStore(Array.from({ length: 95 }, (_, i) => String(i + 1))));
    expect(r.posts.map((p) => p.id)).toEqual(['100', '99', '98', '97', '96']);
    expect(calls).toHaveLength(1);
  });

  it('pages back after an outage until it finds a seen post', async () => {
    const { getPage, calls } = feed(200);
    const r = await readNewPosts(getPage, seenStore(Array.from({ length: 120 }, (_, i) => String(i + 1))));
    expect(r.posts).toHaveLength(80); // 200..121
    expect(r.posts.at(-1).id).toBe('121');
    expect(calls).toEqual([[null, 20], ['181', 50], ['131', 50]]);
    expect(r.truncated).toBe(false);
  });

  it('stops at the page limit and says so', async () => {
    const { getPage } = feed(1000);
    const r = await readNewPosts(getPage, seenStore(['1']), 20, 50, 3);
    expect(r.posts).toHaveLength(120);
    expect(r.truncated).toBe(true);
  });
});

describe('closedPositionIds', () => {
  it('returns only held ids that Invo explicitly reports closed', () => {
    const data = { investments: [
      { baseShortId: 'a', isOpen: false },
      { baseShortId: 'b', isOpen: true },
      { baseShortId: 'c' },
      { baseShortId: 'z', isOpen: false },
      { update: { baseShortId: 'd', isOpen: false } },
    ] };
    expect(closedPositionIds(data, ['a', 'b', 'c', 'd'])).toEqual(['a', 'd']);
    expect(closedPositionIds({ unexpected: true }, ['a'])).toEqual([]);
  });
});
