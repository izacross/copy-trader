/**
 * Catch-up, so a close is never lost while the poller wasn't looking.
 *
 * 1. Feed backfill: when every post on the first page is new, more posts may have arrived than one
 *    page holds (after an outage, or a burst of trades). Page back until we reach posts we've seen.
 * 2. Position check: every minute, ask Invo about each trader position we hold a copy of. If Invo
 *    says it's closed, close ours, even if we never saw the close post.
 */

export interface FeedPage {
  (lastPostId: string | null, limit: number): Promise<any[]>;
}

export interface NewPosts {
  posts: any[]; // new posts, newest first (as Invo returns them)
  pages: number;
  truncated: boolean; // stopped at maxPages while still finding only new posts
}

export async function readNewPosts(
  getPage: FeedPage,
  markSeen: (ids: string[]) => Promise<string[]>,
  firstPageSize = 20,
  pageSize = 50,
  maxPages = 6,
): Promise<NewPosts> {
  const fresh: any[] = [];
  let lastId: string | null = null;
  let limit = firstPageSize;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await getPage(lastId, limit);
    if (!page.length) return { posts: fresh, pages, truncated: false };
    const newIds = new Set(await markSeen(page.map((p) => String(p.id))));
    fresh.push(...page.filter((p) => newIds.has(String(p.id))));
    if (newIds.size < page.length) return { posts: fresh, pages, truncated: false }; // reached posts we'd seen
    lastId = String(page[page.length - 1].id);
    limit = pageSize;
  }
  return { posts: fresh, pages: maxPages, truncated: true };
}

/** From Invo's /dex/trade response, the position ids Invo reports as closed. Only an explicit isOpen: false counts. */
export function closedPositionIds(data: any, ids: string[]): string[] {
  const items: any[] = data?.investments ?? data?.items ?? data?.data ?? (Array.isArray(data) ? data : []);
  const wanted = new Set(ids);
  const closed = new Set<string>();
  for (const item of items) {
    const id = item?.baseShortId ?? item?.update?.baseShortId ?? item?.id;
    const open = item?.isOpen ?? item?.update?.isOpen;
    if (id && wanted.has(String(id)) && open === false) closed.add(String(id));
  }
  return [...closed];
}
