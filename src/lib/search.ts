/**
 * The contract between the script that *writes* the search index and the island
 * that reads it.
 *
 * `bin/index-search.ts` builds a Pagefind record per project after the site is
 * built, and the island then asks for those exact keys and values at runtime.
 * The two live in different halves of the app (a node script, and a `.tsx`
 * island that only ever runs in the browser) so every key, every value and
 * every URL parameter name is named once, here, and imported by both. A typo
 * that would otherwise show up as a filter that silently matches nothing
 * becomes a type error instead.
 */

import { LIVENESS_LABEL, LIVENESS_ORDER } from "./format.ts";

/** the island's page; `trailingSlash: "always"`, hence the closing slash */
export const SEARCH_PATH = "/search/";

/**
 * Every facet value and how many projects carry it, written beside the index by
 * `bin/index-search.ts` and read by the island instead of Pagefind's own
 * `filters()`, which cannot answer the question without pulling down the whole
 * 728KB filter index. 15KB, and it is what lets the page draw a working sidebar
 * before a single byte of the search index is fetched.
 */
export const FACETS_FILE = "facets.json";

export const FACETS_PATH = `/pagefind/${FACETS_FILE}`;

export const QUERY_PARAM = "q";
export const SORT_PARAM = "sort";

/**
 * The filter keys, in the order the facets are stacked in the UI.
 *
 * `pulse` leads because the island lifts it out of the sidebar and renders it
 * as the row of buttons under the search box: it is the one axis this dataset
 * has that github.com does not, so it is the first thing offered rather than
 * the fourth heading down a column.
 *
 * `kind` comes last because it is the one a reader reaches for having already
 * noticed something: it separates the two populations (repositories, and
 * everything else a curator linked) and nobody arrives wanting to filter by it.
 * The axis they *do* arrive with is `pulse`, which is why the link statuses sit
 * there rather than in a facet of their own.
 *
 * `list` and `topic` are the multi-valued ones: a repository can be curated by
 * several lists and carry several GitHub topics, and a custom record takes a
 * `string[]` per key, so it holds one value per appearance without any of the
 * per-element tagging an HTML page needed.
 */
export const FILTER_KEYS = [
  "pulse",
  "list",
  "language",
  "topic",
  "license",
  "archived",
  "kind",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_LABEL: Record<FilterKey, string> = {
  pulse: "Pulse",
  kind: "Host",
  list: "In list",
  language: "Language",
  topic: "Topic",
  license: "Licence",
  archived: "Archived",
};

/**
 * The liveness axis, for both populations, in the order they are offered.
 *
 * The four pulse buckets describe a repository, whose liveness is a commit date.
 * The two after them describe everything else, whose liveness is whether the
 * link still answers. Two vocabularies in one row rather than two rows, because
 * to a reader it is one question — "is this thing still alive" — and every
 * record carries exactly one of the six, so the counts add up to the index.
 *
 * There is no third link state here on purpose. Inside the dataset there is one
 * (see `src/lib/liveness.ts`: a bot wall's 403 or a timeout means "we could not
 * tell", and must not count towards dead), but as a filter it would be a bucket
 * nobody wants to tick, so anything not known to be dead is offered as
 * reachable. The row itself is more careful and says nothing at all unless the
 * link is dead — a filter label may generalise, a row may not.
 */
export const PULSE_ORDER = [...LIVENESS_ORDER, "reachable", "dead"] as const;

/** what each of those six reads as on its button */
export const PULSE_LABEL: Record<string, string> = {
  ...LIVENESS_LABEL,
  reachable: "reachable",
  dead: "dead",
};

/** the target kinds, as the index writes them; see lib/targets.ts */
export const KIND_ORDER = ["github", "web"] as const;

export const KIND_LABEL: Record<string, string> = {
  github: "GitHub",
  web: "Web",
};

export const ARCHIVED_ORDER = ["no", "yes"] as const;

export const ARCHIVED_LABEL: Record<string, string> = {
  no: "Not archived",
  yes: "Archived",
};

export const SORT_KEYS = ["relevance", "stars", "pushed", "name"] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  relevance: "Best match",
  stars: "Most stars",
  pushed: "Recently pushed",
  name: "Name A–Z",
};

/**
 * What each option asks Pagefind for. `relevance` is the absence of a sort:
 * Pagefind then orders by score, which is only meaningful when there is a term
 * to score against, so the island substitutes the star sort for an empty query.
 */
export const SORT_QUERY: Record<SortKey, Record<string, "asc" | "desc">> = {
  relevance: {},
  stars: { stars: "desc" },
  pushed: { pushed: "desc" },
  name: { name: "asc" },
};

/**
 * Star counts, zero-padded so they sort as numbers.
 *
 * A record with no stars to sort by still gets a value, all zeros, which puts it
 * at the bottom of the descending sort and the top of the ascending one. The
 * alternative is to leave the key off the record, and what Pagefind does with a
 * sort key some records lack is undocumented; a value we chose beats behaviour
 * we would be guessing at. It is a sort key and not a display value: the card
 * shows no star count for those rows, because there is none to show.
 *
 * Pagefind compares sort values as strings. Left to itself "9000" sorts above
 * "59710" and the "most starred" sort quietly lists the wrong repositories
 * first; padded to a fixed width, string order and numeric order are the same
 * order. Nine digits is four more than the largest repository on GitHub has
 * ever had, so the width will not need to change.
 */
export const STARS_DIGITS = 9;

export function starsSortValue(stars: number | null): string {
  const max = 10 ** STARS_DIGITS - 1;
  const n = Math.min(Math.max(Math.round(stars ?? 0), 0), max);
  return String(n).padStart(STARS_DIGITS, "0");
}

/**
 * Dates sort as `YYYY-MM-DD`, which is already lexicographically ordered, the
 * one date format that needs no padding. A date and not a full timestamp because
 * the same value is the one the result card renders as "3 months ago", and the
 * hours never showed there.
 */
export function pushedSortValue(lastActivityAt: Date | null): string {
  // same reasoning as the zero star count above: a row with no activity date
  // sorts last rather than being left out of the key
  if (!lastActivityAt) return "0000-00-00";
  return lastActivityAt.toISOString().slice(0, 10);
}

/** whatever the row is named by: `owner/name`, or the curator's own title */
export function nameSortValue(name: string): string {
  return name.toLowerCase();
}

export type SearchState = {
  q: string;
  sort: SortKey;
  filters: Record<FilterKey, string[]>;
};

export function emptyFilters(): Record<FilterKey, string[]> {
  return {
    pulse: [],
    kind: [],
    list: [],
    language: [],
    topic: [],
    license: [],
    archived: [],
  };
}

/**
 * The selection as Pagefind's search API wants it.
 *
 * Within one facet the values are OR-ed, between facets they are AND-ed: two
 * ticked languages means "Rust or Go", because the set of repositories written
 * in both is empty and nobody ticking two boxes was asking for it, while a
 * language plus a pulse means "Rust and still moving", which is the whole point
 * of having two facets. Pagefind reads a bare array as AND, so the `any`
 * wrapper is the behaviour, not decoration.
 *
 * Keys with nothing ticked are left out entirely; an empty `any` matches
 * nothing.
 */
export function pagefindFilters(
  filters: Record<FilterKey, string[]>,
): Record<string, { any: string[] }> {
  const query: Record<string, { any: string[] }> = {};
  for (const key of FILTER_KEYS) {
    const values = filters[key];
    if (values.length > 0) query[key] = { any: values };
  }
  return query;
}

/**
 * A search as a URL. Every state the island can be in is expressible here, so a
 * filtered search can be linked to, which is what the list and category pages
 * do to reach a pre-filtered search without shipping any JavaScript of their
 * own.
 */
export function searchUrl(state: Partial<SearchState> = {}): string {
  const params = new URLSearchParams();
  const q = state.q?.trim();
  if (q) params.set(QUERY_PARAM, q);

  for (const key of FILTER_KEYS) {
    for (const value of state.filters?.[key] ?? []) {
      if (value) params.append(key, value);
    }
  }

  if (state.sort && state.sort !== "relevance") {
    params.set(SORT_PARAM, state.sort);
  }

  const query = params.toString();
  return query ? `${SEARCH_PATH}?${query}` : SEARCH_PATH;
}

/** the pre-filtered search a list or category page links to */
export const listSearchUrl = (listSlug: string) =>
  searchUrl({ filters: { ...emptyFilters(), list: [listSlug] } });

const isSortKey = (value: string): value is SortKey =>
  (SORT_KEYS as readonly string[]).includes(value);

/**
 * The inverse of `searchUrl`, so the island's initial state comes from the
 * address bar. Repeated parameters (`?list=rust&list=golang`) are what the
 * writer emits; comma-separated ones (`?list=rust,golang`) are accepted too,
 * because they are what a person editing the URL by hand tends to write.
 */
export function parseSearchUrl(search: string): SearchState {
  const params = new URLSearchParams(search);
  const filters = emptyFilters();

  for (const key of FILTER_KEYS) {
    const seen = new Set<string>();
    for (const raw of params.getAll(key)) {
      for (const value of raw.split(",")) {
        const trimmed = value.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          filters[key].push(trimmed);
        }
      }
    }
  }

  const sort = params.get(SORT_PARAM) ?? "";

  return {
    q: params.get(QUERY_PARAM) ?? "",
    sort: isSortKey(sort) ? sort : "relevance",
    filters,
  };
}
