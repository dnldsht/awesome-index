import type { ListShard } from "~~/src/lib/contracts";

/**
 * One list, fetched whole, once.
 *
 * There is no server and no second request: the shard is ~170 KB gzipped at
 * its worst and everything the page does afterwards (sort, filter, search,
 * scroll to a section) is an operation on the array it holds. See DESIGN.md,
 * "Architecture", for why this beats SQLite-over-Range and why it is not a
 * question of the dataset being small enough to get away with.
 *
 * It is read at prerender too, so every row is in the generated HTML (see
 * `useData`). Callers `await` it, or the HTML is written before it resolves.
 */
export function useShard(slug: string) {
  return useData<ListShard>(slug);
}
