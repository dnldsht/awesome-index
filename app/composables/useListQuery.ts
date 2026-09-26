import type { ComputedRef } from "vue";
import {
  DEFAULT_PERIOD,
  DEFAULT_SORT,
  parsePeriod,
  parseSort,
  type Period,
  type Sort,
} from "~/utils/order";

/**
 * The whole state of the list page, which lives in the query string.
 *
 * `?sort=` `?period=` `?cat=` `?q=` and nothing else: a closed set, settled in
 * DESIGN.md. Query strings rather than paths because a static host 404s on a
 * path it did not prerender, and there are 4,350 category states; this way there
 * is nothing to 404 and nothing to prerender. Every variant carries a canonical
 * pointing at the bare list URL, which is what stops those states competing with
 * the page meant to rank.
 *
 * Reading is a computed over `route.query`, so the state survives a reload, a
 * share and the back button by construction rather than by being restored: the
 * URL is the only copy.
 *
 * ## Two kinds of write
 *
 * `set` **pushes**. Choosing an order or a section is a navigation the reader
 * meant, and Back should undo exactly one of them.
 *
 * `replace` is for typing. A search box that pushed a history entry per
 * keystroke would make Back useless for twenty presses, so `q` is written with
 * `replace` and debounced by its control. The state still survives a reload and
 * a share, since it is in the URL either way; it simply does not leave a trail.
 *
 * ## What is not written
 *
 * Defaults are stripped, so the bare `/golang` is what a reader lands on, links
 * to, and gets back to by clicking the masthead: `?sort=curator&period=30d` is
 * the same page and should not be a different URL.
 *
 * `period` is stripped whenever the order is not `trending`, because outside
 * that order it changes nothing. Carrying `?period=1y` on a stars-sorted URL
 * would be a claim the page does not honour, and a shared link is exactly where
 * that claim would be believed.
 */
export type ListQuery = {
  sort: ComputedRef<Sort>;
  period: ComputedRef<Period>;
  cat: ComputedRef<string>;
  q: ComputedRef<string>;
  set: (patch: Patch) => void;
  replace: (patch: Patch) => void;
};

type Patch = Partial<{
  sort: Sort;
  period: Period;
  cat: string;
  q: string;
}>;

export function useListQuery(): ListQuery {
  const route = useRoute();
  const router = useRouter();

  const sort = computed(() => parseSort(route.query.sort));

  /*
   * The window is only read under the order it belongs to.
   *
   * Stripping it on write is not enough: anybody can type
   * `?sort=stars&period=7d`, and honouring it there would retitle the delta
   * column to a window the reader has no control to change back, because the
   * control is not on the page under that order. Resolving it to the default
   * outside `trending` is what makes the hidden control and the URL agree.
   */
  const period = computed(() =>
    parseSort(route.query.sort) === "climbing"
      ? parsePeriod(route.query.period)
      : DEFAULT_PERIOD,
  );
  const cat = computed(() => String(route.query.cat ?? ""));
  const q = computed(() => String(route.query.q ?? ""));

  function next(patch: Patch) {
    const s = patch.sort ?? sort.value;
    const p = patch.period ?? period.value;
    const c = patch.cat ?? cat.value;
    const text = patch.q ?? q.value;
    const query: Record<string, string> = {};
    if (s !== DEFAULT_SORT) query.sort = s;
    if (s === "climbing" && p !== DEFAULT_PERIOD) query.period = p;
    if (c) query.cat = c;
    if (text.trim()) query.q = text;
    return { query };
  }

  return {
    sort,
    period,
    cat,
    q,
    set: (patch) => void router.push(next(patch)),
    replace: (patch) => void router.replace(next(patch)),
  };
}
