# TODO

## Sorting on the listing pages

The list and category pages (`src/components/ListPage.astro`,
`src/pages/[list]/[...category].astro`) are ordered by stars, full stop. The
order is baked into `reposForList()` / `reposForCategory()` and pagination cuts
that order into 60-row slices. Three orders are wanted:

- **original**: the order the README writes the entries in. `awesome_item`
  already stores `position` (and is selected in both queries, unused), so this
  is `order by list_id, position` for a single-source entry; a merged entry
  (JavaScript = sorrycc + uhub, MacOS = awesome-mac + open-source-mac-os-apps)
  has two positions for the same repo and needs a rule, source order first and
  then position being the obvious one.
- **most stars**: today's order.
- **active**: `pushed_at` descending.

Deliberately not built yet. Four ways to do it, none free:

1. **Client-side, current page only.** An inline script reorders the 60 rows on
   screen. No new URLs, no build cost, no SEO surface. Honest on the ~3,400
   category pages, nearly all of which hold one page of rows, so sorting the
   page _is_ sorting the category. Dishonest on the 80 list pages, which are all
   multi-page: it would be sorting a window that was itself cut by stars, and
   the control would have to say so.
2. **Static sorted variants** (`/golang/original/`, `/golang/active/`, and so on).
   Correct across pagination and linkable, but roughly triples the ~4,000
   listing pages, and every alternate needs a canonical back to the star order
   plus `noindex`, or it competes with it. Also touches `sitemap.ts` and
   `pagination.ts`.
3. **Hand it to the search page.** `/search/?list=golang&sort=pushed` already
   sorts the whole list properly through Pagefind, so the control becomes three
   links, which is what `listSearchUrl()` and the "Search N projects →" link
   already are, minus the sort. Zero new pages, but it navigates away, and
   _original_ order needs a sort key that does not exist yet (see (4)).
4. **Mount `SearchApp` on the list page itself**, with the `list` facet locked
   to that list, as an enhancement layer over the static rows: the 60-row markup
   and its pagination stay exactly as they are and remain what a crawler and a
   reader without JavaScript get; the first input (query, facet, sort) swaps
   the rows for Pagefind results over the _whole_ list, and a reset puts the
   static view back. This is (3) without the navigation, and it is the only one
   of the four that also brings filtering, which is the half of the question
   this file did not ask: language, licence, pulse and archived, with live
   counts, all of it already built in `SearchApp.tsx`.

   What it costs beyond wiring the island in:

   - **The page stops being JavaScript-free.** That is a stated choice, with a
     comment saying so in `ListPage.astro`, `[...category].astro` and
     `search.astro`. Progressive enhancement softens it; it does not undo it.
   - **The curator's note and the section are not in the index.** `RepoCard`
     renders `repo.note`; the island's cards cannot, and there is no category
     facet. Both are fixable from `r/[owner]/[repo].astro`, with a per-list
     `note_<slug>` meta and a `section:golang/web-frameworks` filter, but that
     is N more tagged values per repository page, and it is what turns this from
     a small change into a medium one.
   - **Original order is expressible after all**, contra (3): Pagefind sort keys
     are arbitrary strings and a page may carry several, so the repository page
     can emit one per appearance (`data-pagefind-sort="pos_golang:000042"`
     beside the `list:golang` filter it already writes) and the island asks for
     `{ pos_golang: "asc" }`. Zero-pad it the way `starsSortValue()` does, for
     the same reason. Two things to check before trusting it: what Pagefind does
     with pages that lack the requested sort key, and how much the `pf_meta`
     file grows, since it is fetched on every page that loads the index. The
     total is one entry per (repo, list) pair, ~25k, i.e. the same order as the
     three sort keys already emitted over ~20k pages. But measure it.

Category pages are a different calculation from list pages, and the answer need
not be the same for both: nearly all of the ~3,400 hold a single page of rows,
so (1) is honest there and costs an inline script, while every one of the 80
list pages is multi-page and (1) is misleading on all of them.

If it gets built: (4) on the list pages, (1) on the category pages, and the
`pos_<slug>` sort key only once the `pf_meta` growth has been measured.

## Links that are not GitHub repositories

Built. What is left of the memo that used to be here:

- **The homepage index, which is nearly free.** 14,212 crawled repositories carry
  a `homepage_url`. Canonicalise both sides the way `targets.ts` does and 14.9%
  of the `web` targets (304 of 2,044 in a 15-list sample) turn out to be a
  repository already in the dataset — hugo via gohugo.io, consul, nsq, Gogs,
  Wails, tsuru — which would give those rows stars, a language and a pulse for
  zero extra API calls. Two guards it needs, from the false positives the same
  sample threw: a YouTube playlist matched `reduxjs/redux-devtools` and a Google
  Groups forum matched `lidgren/lidgren-network-gen3`, because some repository
  lists those as its homepage. So: only when exactly one repository claims that
  canonical URL, and never on an aggregator host.
- **Other hosts' APIs.** One GitLab adapter covers gitlab.com _and_ every
  self-hosted GitLab (invent.kde.org, salsa.debian.org, framagit.org) with the
  same code, for stars and last activity. Registries are one adapter each
  (crates.io, CRAN, hex.pm, PyPI) and return a last _release_, which is a
  different axis from a push and would have to be labelled as one. Both are the
  tail — 326 of 2,301 in the sample — and both are now one file plus one entry in
  `PROVIDERS`, so they cost what they are worth and no more.
- **Read a full crawl before trusting the parser.** `looksLikeEntry` in
  `readme.ts` is what stands where `normalizeRepoId` returning undefined used to
  stand, and it was written against 5 lists. The other 83 will have shapes it
  gets wrong in both directions. `pnpm crawl --only=<slug> --dry-run` prints the
  counts; what nobody has done yet is read a few hundred of the new rows.
- **Notes still keep their licence tags** on the lists that write them in square
  brackets ("A very compact compression library for data streams. [zlib]"),
  because `dropTrailingTags` only knows the backticked form. Pre-existing, more
  visible now that awesome-cpp contributes 338 rows instead of none.

## A host facet, and what a host is worth knowing

The `Host` filter on `/search/` has two values, GitHub and Web, which answers
"is this a repository" and nothing else. The second value covers **11,491
targets across 6,524 distinct hosts**, and the tail is what a facet would be
for: the top 20 hosts alone are 22% of them (youtube.com 555, metacpan.org 300,
twitter.com 177, cran.r-project.org 166, medium.com 164, manning.com 135,
gitlab.com 123, hackage.haskell.org 122, meetup.com 121, codeberg.org 84,
crates.io 81), and 164 hosts with five or more cover 38%.

What makes it worth building is that those hosts are _kinds_ of entry, which is
the classification this dataset deliberately does not store: metacpan/hackage/
crates/CRAN are registries, gitlab/codeberg are code, youtube/medium/manning are
reading and watching, meetup/twitter are people. A reader who wants "libraries,
not talks" has no way to say so today, and the curator's heading only sometimes
says it ("Podcasts" does, "Miscellaneous" does not.)

Three things to settle first:

- **Where the values come from.** One facet value per host is 6,524 of them in
  `facets.json`, which is fetched on every search page load; today the whole file
  is 8KB. A threshold like `TOPIC_MIN_REPOS` (five, say) cuts it to 164 values
  and still covers 38%, with the rest matching nothing — the same trade the topic
  facet already makes, and the same reason.
- **Whether to group.** A hand-written map from host to kind (registry / code /
  reading / social) is a dozen lines for the top 20 and wrong forever after, in
  the way every such list is: `ladigitale.dev` is 16 entries of one person's
  tools, `spring.io` is a framework. If it gets built, the honest shape is the
  host itself as the value, ordered by count, and no invented taxonomy above it.
- **Registries are a provider, not a host.** crates.io, metacpan, hackage, CRAN
  and pkg.go.dev are 800-odd targets that a provider adapter would turn into rows
  with a real last-release date (see the note above). Doing that first shrinks
  the facet and makes it more honest, so the order is: adapters, then the facet
  over whatever is left.
