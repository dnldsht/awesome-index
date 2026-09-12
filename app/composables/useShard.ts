import type { ListShard } from "~~/src/lib/contracts";

/**
 * One list, fetched whole, once.
 *
 * There is no server and no second request: the shard is ~170 KB gzipped at
 * its worst and everything the page does afterwards — sort, filter, search,
 * scroll to a section — is an operation on the array it holds. See DESIGN.md,
 * "Architecture", for why this beats SQLite-over-Range and why it is not a
 * question of the dataset being small enough to get away with.
 *
 * `server: false` keeps the fetch off the prerender: the generated HTML is a
 * skeleton and the rows arrive in the browser. That is a deliberate deferral
 * with a stated cost (the 80 indexable pages currently hold nothing for a
 * crawler) and a cheap reversal — dropping this one option prerenders every
 * row into the HTML against the same component.
 */
export function useShard(slug: string) {
  return useAsyncData<ListShard>(
    () => `shard:${slug}`,
    () => $fetch<ListShard>(`/data/${slug}.json`),
    { server: false, watch: [] },
  );
}
