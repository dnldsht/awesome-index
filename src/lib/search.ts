/**
 * The contract between the page that *writes* the search index and the island
 * that reads it.
 *
 * Pagefind builds its filters and sorts from `data-pagefind-*` attributes at
 * build time, and the island then asks for those exact keys and values at
 * runtime. The two live in different halves of the app — a `.astro` page that
 * only ever runs in node, a `.tsx` island that only ever runs in the browser —
 * so every key, every value and every URL parameter name is named once, here,
 * and imported by both. A typo that would otherwise show up as a filter that
 * silently matches nothing becomes a type error instead.
 */

import type { Liveness } from "./format.ts";

/** the island's page; `trailingSlash: "always"`, hence the closing slash */
export const SEARCH_PATH = "/search/";

export const QUERY_PARAM = "q";
export const SORT_PARAM = "sort";

/**
 * The filter keys, in the order the facets are stacked in the UI.
 *
 * `list` is the multi-valued one: a repository can be curated by several lists,
 * and Pagefind collects a filter value per tagged element rather than per page,
 * so the repository page emits one tagged element per appearance.
 */
export const FILTER_KEYS = [
  "list",
  "language",
  "license",
  "pulse",
  "archived",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_LABEL: Record<FilterKey, string> = {
  list: "In list",
  language: "Language",
  license: "Licence",
  pulse: "Pulse",
  archived: "Archived",
};

/** the values of the two closed filters, in the order they should be shown */
export const PULSE_ORDER: Liveness[] = [
  "active",
  "steady",
  "slowing",
  "dormant",
];

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
 * What each option asks Pagefind for. `relevance` is the absence of a sort —
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
 * Pagefind compares sort values as strings. Left to itself "9000" sorts above
 * "59710" and the "most starred" sort quietly lists the wrong repositories
 * first; padded to a fixed width, string order and numeric order are the same
 * order. Nine digits is four more than the largest repository on GitHub has
 * ever had, so the width will not need to change.
 */
export const STARS_DIGITS = 9;

export function starsSortValue(stars: number): string {
  const max = 10 ** STARS_DIGITS - 1;
  const n = Math.min(Math.max(Math.round(stars), 0), max);
  return String(n).padStart(STARS_DIGITS, "0");
}

/**
 * Dates sort as `YYYY-MM-DD`, which is already lexicographically ordered — the
 * one date format that needs no padding. Passed as a date and not a full
 * timestamp on purpose: a colon in the value would collide with the `key:value`
 * syntax below.
 */
export function pushedSortValue(pushedAt: Date): string {
  return pushedAt.toISOString().slice(0, 10);
}

/** the whole `owner/name`, because that is the form the site displays */
export function nameSortValue(repoId: string): string {
  return repoId.toLowerCase();
}

/**
 * Pagefind reads `key:value` pairs out of a single attribute and splits the
 * pairs on commas, so a value carrying a comma would silently become a second,
 * bogus pair — and a colon would move the boundary between key and value. No
 * licence or language in the dataset contains either today, but the crawler
 * re-reads GitHub every night and nothing upstream promises it will stay that
 * way.
 */
export function inlineValue(value: string): string {
  return value.replace(/[,:]/g, " ").replace(/\s+/g, " ").trim();
}

/** `data-pagefind-filter` / `-meta` / `-sort` attribute text for one pair */
export function inlinePair(key: string, value: string | number): string {
  return `${key}:${inlineValue(String(value))}`;
}

export type SearchState = {
  q: string;
  sort: SortKey;
  filters: Record<FilterKey, string[]>;
};

export function emptyFilters(): Record<FilterKey, string[]> {
  return { list: [], language: [], license: [], pulse: [], archived: [] };
}

/**
 * A search as a URL. Every state the island can be in is expressible here, so a
 * filtered search can be linked to — which is what the list and category pages
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
