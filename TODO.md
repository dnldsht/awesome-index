# TODO

## Sorting on the listing pages

The list and category pages (`src/components/ListPage.astro`,
`src/pages/[list]/[...category].astro`) are ordered by stars, full stop — the
order is baked into `reposForList()` / `reposForCategory()` and pagination cuts
that order into 60-row slices. Three orders are wanted:

- **original** — the order the README writes the entries in. `awesome_item`
  already stores `position` (and is selected in both queries, unused), so this
  is `order by list_id, position` for a single-source entry; a merged entry
  (JavaScript = sorrycc + uhub, MacOS = awesome-mac + open-source-mac-os-apps)
  has two positions for the same repo and needs a rule — source order first,
  then position, is the obvious one.
- **most stars** — today's order.
- **active** — `pushed_at` descending.

Deliberately not built yet. Three ways to do it, none free:

1. **Client-side, current page only.** An inline script reorders the 60 rows on
   screen. No new URLs, no build cost, no SEO surface. Honest on the ~3,400
   category pages, nearly all of which hold one page of rows, so sorting the
   page *is* sorting the category. Dishonest on the 80 list pages, which are all
   multi-page: it would be sorting a window that was itself cut by stars, and
   the control would have to say so.
2. **Static sorted variants** (`/golang/original/`, `/golang/active/`, …).
   Correct across pagination and linkable, but roughly triples the ~4,000
   listing pages, and every alternate needs a canonical back to the star order
   plus `noindex`, or it competes with it. Also touches `sitemap.ts` and
   `pagination.ts`.
3. **Hand it to the search page.** `/search/?list=golang&sort=pushed` already
   sorts the whole list properly through Pagefind, so the control becomes three
   links. Zero new pages, but it navigates away, and *original* order cannot be
   expressed: Pagefind sort values are per page and a repo's position differs
   per list, so the repository page has no single value to emit.

If it gets built, (1) plus a "sort the whole list →" link into (3) is probably
the cheapest thing that is not misleading.
