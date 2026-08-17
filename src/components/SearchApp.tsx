import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  compactNumber,
  LIVENESS_LABEL,
  relativeTime,
  type Liveness,
} from "../lib/format.ts";
import { githubUrl } from "../lib/urls.ts";
import {
  ARCHIVED_LABEL,
  ARCHIVED_ORDER,
  emptyFilters,
  FACETS_PATH,
  FILTER_KEYS,
  FILTER_LABEL,
  pagefindFilters,
  parseSearchUrl,
  PULSE_ORDER,
  searchUrl,
  SORT_KEYS,
  SORT_LABEL,
  SORT_QUERY,
  type FilterKey,
  type SearchState,
  type SortKey,
} from "../lib/search.ts";

/**
 * The site's only piece of client-side JavaScript.
 *
 * It talks to the Pagefind JS API rather than dropping in `pagefind-ui.js`:
 * the stock widget brings its own markup and its own stylesheet, and this site
 * has a visual language (the pulse stripe, the mono repository ids, the rules
 * instead of cards) that a widget cannot be talked into. Everything here is
 * built from the same design tokens as the static pages, so it inherits the
 * theme rather than fighting it.
 *
 * The searching, filtering and sorting all happen inside Pagefind, which loads
 * only the index chunks a query actually touches. Nothing about the dataset is
 * shipped up front.
 */

type FilterCounts = Record<string, Record<string, number>>;

type PagefindData = {
  url: string;
  meta: Record<string, string>;
  excerpt: string;
};

type PagefindResult = { id: string; data: () => Promise<PagefindData> };

type PagefindResponse = {
  results: PagefindResult[];
  unfilteredResultCount: number;
  filters: FilterCounts;
  totalFilters: FilterCounts;
};

type PagefindOptions = {
  /** `{ language: { any: [...] } }`; see pagefindFilters in lib/search.ts */
  filters?: Record<string, { any: string[] }>;
  sort?: Record<string, "asc" | "desc">;
};

type PagefindApi = {
  init: () => Promise<void>;
  filters: () => Promise<FilterCounts>;
  search: (
    term: string | null,
    options: PagefindOptions,
  ) => Promise<PagefindResponse>;
  debouncedSearch: (
    term: string | null,
    options: PagefindOptions,
    debounceMs: number,
  ) => Promise<PagefindResponse | null>;
};

/**
 * Pagefind is emitted by the `pagefind` CLI *after* `astro build`, so it does
 * not exist as far as the bundler is concerned. The specifier is held in a
 * variable so Vite leaves the import alone instead of trying to resolve a file
 * that only appears later, and the module is fetched once per page load.
 */
const PAGEFIND_URL: string = "/pagefind/pagefind.js";

let pagefind: Promise<PagefindApi> | undefined;

function loadPagefind(): Promise<PagefindApi> {
  pagefind ??= (async () => {
    const module = (await import(
      /* @vite-ignore */ PAGEFIND_URL
    )) as PagefindApi;
    await module.init();
    // A search only reports counts for the facets whose chunks are loaded, and
    // `filters()` is what loads them: without it, ticking a pulse leaves the
    // language and licence facets reporting nothing at all. It is the 420KB
    // filter index, which is why this is here and not on page load — a reader
    // who never searches never pays for it, and one who does pays once.
    await module.filters();
    return module;
  })();
  return pagefind;
}

/** how many results are rendered before "Show more", and per press after */
const RESULT_PAGE = 25;

/** how many values an open-ended facet shows before "Show all" */
const FACET_PREVIEW = 8;

export type ListOption = { slug: string; name: string; icon?: string };

/**
 * One of the projects the page shows before anybody has searched, rendered
 * from the build's own data rather than from the index.
 *
 * Shaped like the index's meta on purpose: the two paths end up in the same
 * `Card`, so the rows are the same rows whichever produced them.
 */
export type FeaturedRepo = {
  id: string;
  blurb: string;
  stars: number;
  /** `YYYY-MM-DD`, as the index stores it */
  pushed: string;
  pulse: Liveness;
  language: string;
  license: string;
  archived: boolean;
  lists: string;
};

export type Props = {
  lists: ListOption[];
  featured: FeaturedRepo[];
  /** every project in the index, i.e. what the empty state is a window onto */
  total: number;
};

/** one result, as this component renders it */
type Card = {
  url: string;
  owner: string;
  name: string;
  blurb: string;
  stars: number;
  pushedAt: Date | undefined;
  pulse: Liveness | undefined;
  language: string;
  license: string;
  archived: boolean;
  lists: string;
};

function toCard(data: PagefindData): Card {
  const meta = data.meta ?? {};
  // `title` is the repository id, set by bin/index-search.ts; the url is the
  // github.com link and is only ever followed, never parsed
  const title = meta["title"] ?? "";
  const [owner = "", name = ""] = title.split("/");
  const stars = Number.parseInt(meta["stars"] ?? "", 10);
  const pushed = meta["pushed"];
  const pulse = meta["pulse"];

  return {
    url: data.url,
    owner,
    name: name || title,
    blurb: meta["blurb"] ?? "",
    stars: Number.isFinite(stars) ? stars : 0,
    // the meta carries a date, not a timestamp; parsed as UTC midnight, which
    // is all "3 months ago" needs
    pushedAt: pushed ? new Date(`${pushed}T00:00:00Z`) : undefined,
    pulse: PULSE_ORDER.includes(pulse as Liveness)
      ? (pulse as Liveness)
      : undefined,
    language: meta["language"] ?? "",
    license: meta["license"] ?? "",
    archived: meta["archived"] === "yes",
    lists: meta["lists"] ?? "",
  };
}

function featuredCard(repo: FeaturedRepo): Card {
  const [owner = "", name = ""] = repo.id.split("/");
  return {
    url: githubUrl(repo.id),
    owner,
    name: name || repo.id,
    blurb: repo.blurb,
    stars: repo.stars,
    pushedAt: new Date(`${repo.pushed}T00:00:00Z`),
    pulse: repo.pulse,
    language: repo.language,
    license: repo.license,
    archived: repo.archived,
    lists: repo.lists,
  };
}

/**
 * A stable string for the whole search, so the effects can depend on it. It is
 * the shareable URL, which means a change that does not alter the URL, such as
 * typing a trailing space, does not re-run the search either.
 */
const stateKey = (state: SearchState) => searchUrl(state);

/**
 * Whether the page is showing its own top-starred list rather than a search.
 *
 * "Best match" with no term already fell back to the star order, so an empty
 * query under either of those two sorts *is* the featured list, and asking
 * Pagefind for it would be asking it to re-derive, in seven seconds, a list
 * the build already knows. Anything else — a term, a ticked facet, a different
 * sort — is a real search.
 */
const isIdle = (state: SearchState) =>
  state.q.trim() === "" &&
  (state.sort === "relevance" || state.sort === "stars") &&
  FILTER_KEYS.every((filterKey) => state.filters[filterKey].length === 0);

export default function SearchApp({ lists, featured, total }: Props) {
  const [state, setState] = useState<SearchState>(() =>
    parseSearchUrl(window.location.search),
  );
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  /** a search is in flight; the rows on screen are the previous answer */
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [hits, setHits] = useState<PagefindResult[]>([]);
  const [counts, setCounts] = useState<FilterCounts>({});
  const [universe, setUniverse] = useState<FilterCounts>({});
  // the same values, reachable from the search effect, which must not re-run
  // when they arrive
  const universeRef = useRef<FilterCounts>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [shown, setShown] = useState(RESULT_PAGE);
  const inputRef = useRef<HTMLInputElement>(null);

  const key = stateKey(state);
  const term = state.q.trim();
  const idle = isIdle(state);

  const featuredCards = useMemo(() => featured.map(featuredCard), [featured]);

  /**
   * Every value the index holds and how many projects carry it.
   *
   * 8KB written next to the index by the same script that builds it, rather
   * than Pagefind's `filters()`, which cannot answer without downloading the
   * whole 420KB filter index. It is what lets the sidebar be correct on a page
   * that has not loaded Pagefind at all.
   */
  useEffect(() => {
    let live = true;
    fetch(FACETS_PATH)
      .then((response) => (response.ok ? response.json() : {}))
      .then((all: FilterCounts) => {
        if (!live) return;
        universeRef.current = all;
        setUniverse(all);
      })
      .catch(() => {
        /* a facet with no counts still lists its values; nothing to report */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;

    // the featured list needs no index, no worker and no request: this is the
    // state the page opens in, and it is why it opens instantly
    if (idle) {
      setHits([]);
      setShown(RESULT_PAGE);
      setPending(false);
      setPhase("ready");
      return;
    }

    // held from here until the results land, so the page can tell "found
    // nothing" apart from "has not looked yet" — the first search of a session
    // waits on the index, and announcing "No projects match" while it does is
    // a wrong answer, not a slow one
    setPending(true);

    (async () => {
      const api = await loadPagefind();

      // "Best match" means relevance, and relevance is meaningless without a
      // term to be relevant to, so an empty query falls back to the star
      // order, which is the order every other page on this site uses
      const sort =
        state.sort === "relevance" && !term
          ? SORT_QUERY.stars
          : SORT_QUERY[state.sort];

      const response = await api.debouncedSearch(
        term || null,
        {
          filters: pagefindFilters(state.filters),
          sort,
        },
        140,
      );

      // null means a newer keystroke superseded this search
      if (!live || response === null) return;
      setHits(response.results);
      setShown(RESULT_PAGE);
      setPending(false);
      setPhase("ready");

      /*
       * `response.filters` counts what you would get if a value were *added*
       * to the filters as they stand. For a facet nothing is ticked in that
       * is exactly the number a row should show. For one that has a tick it
       * is wrong in the way that would break this UI: with pulse=active held,
       * "steady" would report zero, be drawn disabled, and the or-ing the
       * facet exists to offer could never be reached.
       *
       * So a ticked facet is counted again with its own selection dropped and
       * every other facet kept, which is what a row in an or-ed facet means:
       * how many projects this value would add to the ones already showing.
       * (`response.totalFilters` looks like it would answer this for free, but
       * it is all zeroes whenever the query is empty, which is the state this
       * page opens in.)
       *
       * That second query takes a moment, and a facet showing zeroes in the
       * meantime is a facet that cannot be clicked, so until it lands the
       * ticked facet keeps whatever counts it had — the numbers from before
       * the tick, which are the right ones for every value the reader did not
       * just click — falling back to the whole-index counts on a cold load.
       */
      const ticked = FILTER_KEYS.filter(
        (filterKey) => state.filters[filterKey].length > 0,
      );

      setCounts((previous) => {
        const held: FilterCounts = { ...response.filters };
        for (const filterKey of ticked) {
          held[filterKey] =
            previous[filterKey] ?? universeRef.current[filterKey] ?? {};
        }
        return held;
      });

      // With no term and a single ticked facet, dropping that facet's own
      // selection drops every filter there is, so the counts wanted are the
      // whole-index ones the page already loaded. That is the common case —
      // one facet, no query — and it now costs nothing.
      if (ticked.length === 0) return;
      if (!term && ticked.length === 1) {
        const only = ticked[0]!;
        const whole = universeRef.current[only];
        if (whole) {
          setCounts({ ...response.filters, [only]: whole });
          return;
        }
      }

      const recounted = await Promise.all(
        ticked.map(async (filterKey) => {
          const others = { ...state.filters, [filterKey]: [] };
          const view = await api.search(term || null, {
            filters: pagefindFilters(others),
          });
          return [filterKey, view?.filters[filterKey] ?? {}] as const;
        }),
      );

      if (!live) return;
      setCounts({ ...response.filters, ...Object.fromEntries(recounted) });
    })().catch((error: unknown) => {
      if (!live) return;
      setPending(false);
      setFailure(error instanceof Error ? error.message : String(error));
      setPhase("error");
    });

    return () => {
      live = false;
    };
  }, [key]);

  /** the fragment for a result is only fetched when the result is rendered */
  useEffect(() => {
    let live = true;
    if (idle) {
      setCards(featuredCards.slice(0, shown));
      return;
    }
    const page = hits.slice(0, shown);
    if (page.length === 0) {
      setCards([]);
      return;
    }
    Promise.all(page.map((hit) => hit.data()))
      .then((data) => {
        if (live) setCards(data.map(toCard));
      })
      .catch(() => {
        if (live) setCards([]);
      });
    return () => {
      live = false;
    };
  }, [hits, shown, idle, featuredCards]);

  /** the address bar always describes what is on screen, and can be pasted */
  useEffect(() => {
    window.history.replaceState(null, "", searchUrl(state));
  }, [key]);

  const toggle = useCallback((filterKey: FilterKey, value: string) => {
    setState((current) => {
      const active = current.filters[filterKey];
      const next = active.includes(value)
        ? active.filter((held) => held !== value)
        : [...active, value];
      return {
        ...current,
        filters: { ...current.filters, [filterKey]: next },
      };
    });
  }, []);

  const clear = useCallback(() => {
    setState((current) => ({ ...current, filters: emptyFilters() }));
  }, []);

  const activeCount = FILTER_KEYS.reduce(
    (sum, filterKey) => sum + state.filters[filterKey].length,
    0,
  );

  const listName = useMemo(() => {
    const byslug = new Map<string, ListOption>();
    for (const list of lists) byslug.set(list.slug, list);
    return byslug;
  }, [lists]);

  // With nothing searched for, what a facet row would give you is what the
  // whole index holds, which is the file already loaded. Those same numbers
  // stand in for a facet the current search has not reported yet — the first
  // interaction has to wait for Pagefind to load, and a sidebar that empties
  // itself for a second reads as breakage.
  const shownCounts: FilterCounts = idle
    ? universe
    : { ...universe, ...counts };

  const facets = FILTER_KEYS.map((filterKey) =>
    buildFacet(filterKey, {
      counts: shownCounts[filterKey] ?? {},
      universe: universe[filterKey] ?? {},
      selected: state.filters[filterKey],
      lists,
    }),
  );

  // pulse is the one facet that is not a row in the sidebar: it has four
  // values, it is the axis this site exists for, and it now sits where the
  // page header used to
  const pulseFacet = facets.find((facet) => facet.key === "pulse");
  const sidebarFacets = facets.filter((facet) => facet.key !== "pulse");

  // in the featured state the count is the whole index, of which the page
  // renders the most starred few; the "show more" button counts those instead
  const found = idle ? total : hits.length;
  const rendered = idle ? featuredCards.length : hits.length;

  const summary =
    phase === "error"
      ? "Search is unavailable."
      : phase === "loading" || (pending && cards.length === 0)
        ? "Searching…"
        : found === 0
          ? "No projects match."
          : `${compactNumber(found)} ${found === 1 ? "project" : "projects"}`;

  return (
    <div>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          inputRef.current?.blur();
        }}
      >
        <label
          for="search-q"
          class="font-mono text-xs tracking-widest text-mute uppercase"
        >
          Search every project
        </label>
        <input
          id="search-q"
          ref={inputRef}
          type="search"
          value={state.q}
          autocomplete="off"
          spellcheck={false}
          placeholder="http client, orm, terminal…"
          // intent, and the earliest signal of it there is
          onFocus={() => void loadPagefind().catch(() => {})}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setState((current) => ({ ...current, q: value }));
          }}
          class="mt-2 w-full border border-rule bg-paper px-3 py-2.5 font-mono text-base text-ink placeholder:text-mute focus:border-accent"
        />
      </form>

      {pulseFacet && <PulseFilter facet={pulseFacet} onToggle={toggle} />}

      <div class="mt-8 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <aside class="border-b border-rule pb-6 lg:sticky lg:top-8 lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-y-auto lg:border-b-0 lg:pb-0">
          <div class="flex items-baseline justify-between gap-3">
            <h2 class="font-mono text-xs tracking-widest text-mute uppercase">
              Filters
            </h2>
            {activeCount > 0 && (
              <button
                type="button"
                onClick={clear}
                class="text-xs text-accent underline-offset-4 hover:underline"
              >
                Clear {activeCount}
              </button>
            )}
          </div>

          {sidebarFacets.map((facet) => (
            <Facet
              key={facet.key}
              facet={facet}
              onToggle={toggle}
              listName={listName}
            />
          ))}
        </aside>

        <section class="mt-8 lg:mt-0">
          <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-rule pb-3">
            <p
              aria-live="polite"
              class="font-mono text-xs tracking-widest text-mute uppercase"
            >
              {summary}
              {phase === "ready" && found > 0 && activeCount > 0 && " filtered"}
              {idle && ", most starred first"}
            </p>

            <div class="flex items-baseline gap-2">
              <label
                for="search-sort"
                class="font-mono text-xs tracking-widest text-mute uppercase"
              >
                Sort
              </label>
              <select
                id="search-sort"
                value={state.sort}
                onChange={(event) => {
                  const value = event.currentTarget.value as SortKey;
                  setState((current) => ({ ...current, sort: value }));
                }}
                class="border border-rule bg-paper px-2 py-1 text-sm text-ink"
              >
                {SORT_KEYS.map((sortKey) => (
                  <option key={sortKey} value={sortKey}>
                    {SORT_LABEL[sortKey]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {phase === "error" && (
            <p class="mt-6 max-w-prose text-ink-soft">
              The search index could not be loaded
              {failure ? `: ${failure}` : "."} It is generated when the site is
              built, so it is missing from the dev server. Every project is
              still reachable through the{" "}
              <a
                class="text-accent underline-offset-4 hover:underline"
                href="/"
              >
                lists and their categories
              </a>
              .
            </p>
          )}

          {phase === "ready" && !pending && found === 0 && (
            <p class="mt-6 max-w-prose text-ink-soft">
              Nothing matches
              {term ? ` “${term}”` : ""}
              {activeCount > 0 ? " with these filters" : ""}. Try a broader term
              {activeCount > 0 ? ", or " : "."}
              {activeCount > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  class="text-accent underline-offset-4 hover:underline"
                >
                  clear the filters
                </button>
              )}
              {activeCount > 0 ? "." : ""}
            </p>
          )}

          {/* -mx-4 keeps the row text on the column's edge while the hover
              fill runs past it, same as the list and category pages */}
          <ul class="-mx-4 border-t border-rule">
            {cards.map((card) => (
              <li key={card.url} class="border-b border-rule">
                <Result card={card} />
              </li>
            ))}
          </ul>

          {shown < rendered && (
            <p class="mt-6">
              <button
                type="button"
                onClick={() => setShown((count) => count + RESULT_PAGE)}
                class="border border-rule px-4 py-2 text-sm text-ink-soft hover:border-accent hover:text-accent"
              >
                Show {Math.min(RESULT_PAGE, rendered - shown)} more
              </button>
            </p>
          )}

          {/* the featured list is a doorway, not a listing: it ends, and says
              so, rather than paginating 30,000 rows nobody asked for */}
          {idle && shown >= rendered && (
            <p class="mt-6 max-w-prose text-sm text-mute">
              The {rendered} most starred, of {compactNumber(found)}. Search, or
              tick a filter, to reach the rest — or browse them by list from{" "}
              <a
                class="text-accent underline-offset-4 hover:underline"
                href="/"
              >
                the front page
              </a>
              .
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** the same card as `RepoCard.astro`, rebuilt from the index's metadata */
function Result({ card }: { card: Card }) {
  return (
    <article
      data-pulse={card.pulse}
      class="p-4 transition-colors hover:bg-sunk"
    >
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="min-w-0 font-mono text-[0.95rem] leading-tight">
          {/* a new tab, like every project link on the site: see RepoCard.astro */}
          <a
            href={card.url}
            target="_blank"
            rel="noopener"
            class="text-ink decoration-accent underline-offset-4 hover:underline"
          >
            <span class="text-mute">{card.owner}/</span>
            <span class="font-medium">{card.name}</span>
            <span class="sr-only"> on GitHub, opens in a new tab</span>
          </a>
        </h3>

        <div class="flex shrink-0 items-center gap-3">
          <span class="flex items-center gap-1 font-mono text-sm font-medium text-ink-soft tabular-nums">
            <svg
              class="size-4 shrink-0 fill-current text-mute"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94L12 2.5z" />
            </svg>
            {compactNumber(card.stars)}
            <span class="sr-only">stars</span>
          </span>

          {/* no second github.com link beside the heading: the heading *is*
              the github.com link, exactly as in RepoCard.astro */}
        </div>
      </div>

      {card.blurb && (
        <p class="mt-1 max-w-prose text-[0.925rem] text-ink-soft">
          {card.blurb}
        </p>
      )}

      <p class="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-mute">
        {card.language && <span>{card.language}</span>}
        {card.language && card.license && <span aria-hidden="true">·</span>}
        {card.license && <span>{card.license}</span>}
        {(card.language || card.license) && <span aria-hidden="true">·</span>}

        {/* the status is stated in words, never by the stripe colour alone */}
        {card.pulse && (
          <span style="color: var(--pulse)">{LIVENESS_LABEL[card.pulse]}</span>
        )}
        {card.pushedAt && <span aria-hidden="true">·</span>}
        {card.pushedAt && (
          <time datetime={card.pushedAt.toISOString()}>
            {relativeTime(card.pushedAt)}
          </time>
        )}
        {card.lists && <span aria-hidden="true">·</span>}
        {card.lists && <span>{card.lists}</span>}

        {card.archived && (
          <span class="ml-1 border border-rule px-1.5 py-0.5 font-medium text-ink-soft uppercase">
            archived
          </span>
        )}
      </p>
    </article>
  );
}

/**
 * The pulse scale as a row of toggles, directly under the query box.
 *
 * The four values are the site's signature and they fit on one line, so they
 * are offered rather than filed: this is where somebody who came to find
 * projects that are still alive starts, and it costs them one click instead of
 * a trip down the sidebar. The dot repeats the colour used by the stripe and
 * the pulse bar, and the word beside it carries the meaning on its own, same
 * rule as everywhere else.
 */
function PulseFilter({
  facet,
  onToggle,
}: {
  facet: FacetModel;
  onToggle: (key: FilterKey, value: string) => void;
}) {
  if (facet.values.length === 0) return null;

  return (
    <div class="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2">
      <h2 class="mr-1 font-mono text-xs tracking-widest text-mute uppercase">
        {FILTER_LABEL[facet.key]}
      </h2>

      {facet.values.map((row) => (
        <button
          key={row.value}
          type="button"
          // a toggle, not a link: pressed is the state, and it is announced
          aria-pressed={row.selected}
          disabled={row.count === 0 && !row.selected}
          onClick={() => onToggle(facet.key, row.value)}
          class={`flex items-center gap-2 border px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
            row.selected
              ? "border-accent bg-sunk font-medium text-ink"
              : "border-rule text-ink-soft hover:border-accent hover:text-ink"
          }`}
        >
          <span
            class="size-2 shrink-0 rounded-full"
            style={`background: var(--pulse-${row.value})`}
            aria-hidden="true"
          />
          {LIVENESS_LABEL[row.value as Liveness]}
          <span class="font-mono text-xs text-mute tabular-nums">
            {compactNumber(row.count)}
          </span>
        </button>
      ))}
    </div>
  );
}

type FacetValue = { value: string; count: number; selected: boolean };

type FacetModel = { key: FilterKey; values: FacetValue[] };

/**
 * The rows of one facet.
 *
 * `counts` is what the search effect worked out for this facet, so the numbers
 * describe what clicking would actually give you — including inside a facet
 * that already has a tick, where the value or-s onto the selection rather than
 * narrowing it. The closed facets (pulse, archived, and the lists, which are a
 * known set) additionally list every value they have, even at zero, because a
 * scale with a rung missing reads as a bug; the open-ended ones (language,
 * licence, topic) list only what the current results contain.
 */
function buildFacet(
  key: FilterKey,
  input: {
    counts: Record<string, number>;
    universe: Record<string, number>;
    selected: string[];
    lists: ListOption[];
  },
): FacetModel {
  const { counts, universe, selected } = input;
  const always =
    key === "pulse"
      ? [...PULSE_ORDER]
      : key === "archived"
        ? [...ARCHIVED_ORDER]
        : key === "list"
          ? input.lists.map((list) => list.slug)
          : [];

  const seen = new Set<string>();
  const values: FacetValue[] = [];
  const push = (value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    const count = counts[value] ?? 0;
    if (count === 0 && !selected.includes(value) && !always.includes(value)) {
      return;
    }
    values.push({ value, count, selected: selected.includes(value) });
  };

  // the closed facets keep their own order; the open ones go by size, which is
  // the only order a list of 49 languages, or 346 topics, can usefully have
  for (const value of always) push(value);
  const rest = Object.keys({ ...universe, ...counts })
    .filter((value) => !seen.has(value))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  for (const value of rest) push(value);

  // A ticked value is pinned to the top of its facet, because otherwise the
  // one row a reader is most likely to want back — the topic they just
  // ticked, sitting 200 rows down a facet ordered by size — is the one row
  // behind "Show 338 more". Pulse and archived are exempt: their order is a
  // scale, and a scale that reorders itself when you touch it is unreadable.
  if (key !== "pulse" && key !== "archived") {
    values.sort((a, b) => Number(b.selected) - Number(a.selected));
  }

  return { key, values };
}

function Facet({
  facet,
  onToggle,
  listName,
}: {
  // every value already carries its own `selected`, set by buildFacet from the
  // same state, so passing the selection in again would be a second copy to
  // keep in step with the first
  facet: FacetModel;
  onToggle: (key: FilterKey, value: string) => void;
  listName: Map<string, ListOption>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (facet.values.length === 0) return null;

  // pulse is drawn by PulseFilter, above the results, not as a row here
  const closed = facet.key === "archived";
  const visible =
    expanded || closed ? facet.values : facet.values.slice(0, FACET_PREVIEW);
  const hidden = facet.values.length - visible.length;

  return (
    <fieldset class="mt-6 border-t border-rule pt-3">
      <legend class="font-mono text-xs tracking-widest text-ink-soft uppercase">
        {FILTER_LABEL[facet.key]}
      </legend>

      <ul class="mt-1">
        {visible.map((row) => {
          const id = `facet-${facet.key}-${row.value.replace(/[^a-z0-9]+/gi, "-")}`;
          const list =
            facet.key === "list" ? listName.get(row.value) : undefined;
          const label =
            facet.key === "archived"
              ? (ARCHIVED_LABEL[row.value] ?? row.value)
              : (list?.name ?? row.value);

          return (
            <li key={row.value}>
              <label
                for={id}
                class="flex cursor-pointer items-baseline gap-2 py-1 text-sm text-ink-soft hover:text-ink"
              >
                <input
                  id={id}
                  type="checkbox"
                  class="accent-accent"
                  checked={row.selected}
                  disabled={row.count === 0 && !row.selected}
                  onChange={() => onToggle(facet.key, row.value)}
                />
                <span class="min-w-0 break-words">
                  {list?.icon ? `${list.icon} ` : ""}
                  {label}
                </span>
                <span class="ml-auto shrink-0 font-mono text-xs text-mute tabular-nums">
                  {compactNumber(row.count)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          class="mt-1 text-xs text-accent underline-offset-4 hover:underline"
        >
          Show {hidden} more
        </button>
      )}
    </fieldset>
  );
}
