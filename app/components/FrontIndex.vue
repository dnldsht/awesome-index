<script setup lang="ts">
import type { FrontPage } from "~~/src/lib/contracts";

/**
 * The index of every list.
 *
 * Not an afterthought under the rubrics: there is no global cross-list search
 * (DESIGN.md, "Architecture": `q` filters within a loaded list, and a global
 * index is a later addition), so for most readers this is the way in. Eighty
 * rows sorted only by size was a wall a reader could not see into, so they are
 * filed under shelves (`LIST_GROUPS` in `config.ts`) and ranked by size within
 * each. The rows arrive already in that order; this only cuts them where the
 * group changes.
 *
 * Two figures per row, and the gap between them is the point. `entries` is
 * every row the list holds and `repos` is how many of those are repositories:
 * on `awesome-mac` half the entries are neither starred nor starrable, and a
 * single "1,929 entries" would quietly promise a list of ranked projects that
 * the page cannot deliver. Both numbers are counted off the shards themselves,
 * so the index cannot promise a figure the page then contradicts.
 */
const props = defineProps<{ lists: FrontPage["lists"] }>();

const shelves = computed(() => {
  const out: { name: string; id: string; lists: FrontPage["lists"] }[] = [];
  for (const list of props.lists) {
    if (out.at(-1)?.name !== list.group) {
      const id = `shelf-${list.group.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      out.push({ name: list.group, id, lists: [] });
    }
    out.at(-1)!.lists.push(list);
  }
  return out;
});

const n = new Intl.NumberFormat("en-US");

/*
 * A shelf this short is one column tall, so it takes one cell of the grid and
 * the short shelves pack side by side; a longer one runs the full measure in
 * columns of its own. Without this, three rows of Hardware would sit alone
 * across the whole page.
 */
const SHORT = 7;
</script>

<template>
  <section class="ix">
    <h2 class="ix-head">
      The lists
      <span class="ix-labels mono">entries · repositories</span>
    </h2>

    <nav class="ix-jump kicker" aria-label="Shelves">
      <a v-for="shelf in shelves" :key="shelf.id" :href="`#${shelf.id}`">{{
        shelf.name
      }}</a>
    </nav>

    <div class="ix-shelves">
      <section
        v-for="shelf in shelves"
        :id="shelf.id"
        :key="shelf.id"
        class="ix-shelf"
        :class="{ wide: shelf.lists.length > SHORT }"
      >
        <h3 class="ix-shelf-head kicker">
          {{ shelf.name }} <span class="mono">{{ shelf.lists.length }}</span>
        </h3>
        <ul class="ix-rows">
          <li v-for="list in shelf.lists" :key="list.slug">
            <NuxtLink :to="`/${list.slug}`" class="ix-row">
              <span class="ix-icon" aria-hidden="true">{{ list.icon }}</span>
              <span class="ix-name">{{ list.name }}</span>
              <span class="ix-n mono">{{ n.format(list.entries) }}</span>
              <span class="ix-r mono">{{ n.format(list.repos) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>

    <p class="ix-foot">
      Sorted by size within each shelf. The second number counts GitHub
      repositories; the other entries are sites, papers and books.
    </p>
  </section>
</template>

<style scoped>
.ix-head {
  font-family: var(--font-serif);
  font-size: var(--t-head);
  font-weight: var(--w-mast);
  letter-spacing: -0.01em;
  margin: 0 0 0.35rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--rule-3);
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.ix-labels {
  margin-left: auto;
  font-size: var(--t-micro);
  font-weight: 400;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.ix-jump {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 1.1rem;
  margin: 0.6rem 0 1.4rem;
}

.ix-jump a:hover {
  color: var(--ink);
}

/*
 * `dense` lets the short shelves fill the cells left beside one another even
 * when a wide shelf sits between them in the order, which is what keeps the
 * tail of the index to a row or two instead of one ragged row per shelf.
 */
.ix-shelves {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  grid-auto-flow: dense;
  gap: 1.6rem 2.5rem;
}

.ix-shelf.wide {
  grid-column: 1 / -1;
}

.ix-shelf-head {
  margin: 0 0 0.2rem;
  color: var(--ink);
}

.ix-shelf-head .mono {
  color: var(--ink-3);
  margin-left: 0.3rem;
}

/*
 * Multi-column rather than one long column: a shelf of twenty-four in a single
 * file is a screen of scrolling for something a reader means to scan. The
 * rows stay on the 32px band so this page and the list pages keep one rhythm.
 */
.ix-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  columns: 17rem;
  column-gap: 2.5rem;
}

.ix-rows li {
  break-inside: avoid;
}

.ix-row {
  display: grid;
  grid-template-columns: 1.4rem minmax(0, 1fr) 3.4rem 3.4rem;
  align-items: baseline;
  column-gap: 0.4rem;
  height: var(--row-h);
  padding-top: 5px;
  border-bottom: 1px solid var(--rule);
  line-height: 1.25;
  overflow: hidden;
}

.ix-row:hover {
  background: var(--sunk);
}

.ix-row:hover .ix-name {
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}

.ix-icon {
  font-size: 0.9em;
}

.ix-name {
  font-size: var(--t-name);
  font-weight: var(--w-name);
  letter-spacing: -0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ix-n,
.ix-r {
  font-size: var(--t-meta);
  text-align: right;
}

.ix-n {
  color: var(--ink-2);
}

/* the smaller of the two, and the one that says what the list is made of */
.ix-r {
  color: var(--ink-3);
}

.ix-foot {
  font-size: var(--t-note);
  color: var(--ink-2);
  line-height: 1.6;
  max-width: 60ch;
  margin: 1.1rem 0 0;
}

@media (max-width: 44rem) {
  .ix-rows {
    columns: auto;
  }
}
</style>
