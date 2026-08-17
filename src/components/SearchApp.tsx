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
import {
  ARCHIVED_LABEL,
  ARCHIVED_ORDER,
  emptyFilters,
  FILTER_KEYS,
  FILTER_LABEL,
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
 * has a visual language — the pulse stripe, the mono repository ids, the rules
 * instead of cards — that a widget cannot be talked into. Everything here is
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
  filters?: Record<string, string[]>;
  sort?: Record<string, "asc" | "desc">;
};

type PagefindApi = {
  init: () => Promise<void>;
  filters: () => Promise<FilterCounts>;
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
    return module;
  })();
  return pagefind;
}

/** how many results are rendered before "Show more", and per press after */
const RESULT_PAGE = 25;

/** how many values an open-ended facet shows before "Show all" */
const FACET_PREVIEW = 8;

export type ListOption = { slug: string; name: string; icon?: string };

export type Props = { lists: ListOption[] };

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

/**
 * A stable string for the whole search, so the effects can depend on it. It is
 * the shareable URL, which means a change that does not alter the URL — typing
 * a trailing space — does not re-run the search either.
 */
const stateKey = (state: SearchState) => searchUrl(state);

export default function SearchApp({ lists }: Props) {
  const [state, setState] = useState<SearchState>(() =>
    parseSearchUrl(window.location.search),
  );
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState("");
  const [hits, setHits] = useState<PagefindResult[]>([]);
  const [counts, setCounts] = useState<FilterCounts>({});
  const [universe, setUniverse] = useState<FilterCounts>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [shown, setShown] = useState(RESULT_PAGE);
  const inputRef = useRef<HTMLInputElement>(null);

  const key = stateKey(state);
  const term = state.q.trim();

  /** every value the index holds, so a closed facet can show its empty rows */
  useEffect(() => {
    let live = true;
    loadPagefind()
      .then((api) => api.filters())
      .then((all) => {
        if (live) setUniverse(all);
      })
      .catch(() => {
        /* the search effect reports the failure; one message is enough */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;

    (async () => {
      const api = await loadPagefind();
      const filters: Record<string, string[]> = {};
      for (const filterKey of FILTER_KEYS) {
        const values = state.filters[filterKey];
        if (values.length > 0) filters[filterKey] = values;
      }

      // "Best match" means relevance, and relevance is meaningless without a
      // term to be relevant to — so an empty query falls back to the star
      // order, which is the order every other page on this site uses
      const sort =
        state.sort === "relevance" && !term
          ? SORT_QUERY.stars
          : SORT_QUERY[state.sort];

      const response = await api.debouncedSearch(
        term || null,
        {
          filters,
          sort,
        },
        140,
      );

      // null means a newer keystroke superseded this search
      if (!live || response === null) return;
      setHits(response.results);
      setCounts(response.filters);
      setShown(RESULT_PAGE);
      setPhase("ready");
    })().catch((error: unknown) => {
      if (!live) return;
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
  }, [hits, shown]);

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

  const facets = FILTER_KEYS.map((filterKey) =>
    buildFacet(filterKey, {
      counts: counts[filterKey] ?? {},
      universe: universe[filterKey] ?? {},
      selected: state.filters[filterKey],
      lists,
    }),
  );

  const total = hits.length;
  const summary =
    phase === "loading"
      ? "Searching…"
      : phase === "error"
        ? "Search is unavailable."
        : total === 0
          ? "No projects match."
          : `${compactNumber(total)} ${total === 1 ? "project" : "projects"}`;

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
          onInput={(event) => {
            const value = event.currentTarget.value;
            setState((current) => ({ ...current, q: value }));
          }}
          class="mt-2 w-full border border-rule bg-paper px-3 py-2.5 font-mono text-base text-ink placeholder:text-mute focus:border-accent"
        />
      </form>

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

          {facets.map((facet) => (
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
              {phase === "ready" && total > 0 && activeCount > 0 && " filtered"}
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

          {phase === "ready" && total === 0 && (
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

          {shown < total && (
            <p class="mt-6">
              <button
                type="button"
                onClick={() => setShown((count) => count + RESULT_PAGE)}
                class="border border-rule px-4 py-2 text-sm text-ink-soft hover:border-accent hover:text-accent"
              >
                Show {Math.min(RESULT_PAGE, total - shown)} more
              </button>
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

type FacetValue = { value: string; count: number; selected: boolean };

type FacetModel = { key: FilterKey; values: FacetValue[] };

/**
 * The rows of one facet.
 *
 * `counts` is what Pagefind reports for the search as it currently stands, so
 * the numbers describe what clicking would actually give you. The two closed
 * facets — pulse and archived — additionally list every value they have, even
 * at zero, because a scale with a rung missing reads as a bug; the open-ended
 * ones (language, licence) list only what the current results contain.
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
  // the only order a list of 49 languages can usefully have
  for (const value of always) push(value);
  const rest = Object.keys({ ...universe, ...counts })
    .filter((value) => !seen.has(value))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  for (const value of rest) push(value);

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

  const closed = facet.key === "pulse" || facet.key === "archived";
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
                {facet.key === "pulse" ? (
                  <span data-pulse={row.value} class="min-w-0 pl-2">
                    {LIVENESS_LABEL[row.value as Liveness]}
                  </span>
                ) : (
                  <span class="min-w-0 break-words">
                    {list?.icon ? `${list.icon} ` : ""}
                    {label}
                  </span>
                )}
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
