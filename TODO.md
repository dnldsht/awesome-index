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
