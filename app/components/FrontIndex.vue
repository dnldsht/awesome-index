<script setup lang="ts">
import type { FrontPage } from "~~/src/lib/contracts";

/**
 * The index of every list.
 *
 * Not an afterthought under the rubrics: there is no global cross-list search
 * (DESIGN.md, "Architecture" — `q` filters within a loaded list, and a global
 * index is a later addition), so for most readers this is the way in. Eighty
 * rows is small enough to scan and too many to read, which is what multiple
 * columns are for; they also flow down rather than across, so the ranking by
 * size survives the layout.
 *
 * Two figures per row, and the gap between them is the point. `entries` is
 * every row the list holds and `repos` is how many of those are repositories —
 * on `awesome-mac` half the entries are neither starred nor starrable, and a
 * single "1,929 entries" would quietly promise a list of ranked projects that
 * the page cannot deliver. Both numbers are counted off the shards themselves,
 * so the index cannot promise a figure the page then contradicts.
 */
defineProps<{ lists: FrontPage["lists"] }>();

const n = new Intl.NumberFormat("en-US");
</script>

<template>
  <section class="ix">
    <h2 class="ix-head">
      The lists
      <span class="ix-labels mono">entries · repositories</span>
    </h2>

    <ul class="ix-rows">
      <li v-for="list in lists" :key="list.slug">
        <NuxtLink :to="`/${list.slug}`" class="ix-row">
          <span class="ix-icon" aria-hidden="true">{{ list.icon }}</span>
          <span class="ix-name">{{ list.name }}</span>
          <span class="ix-n mono">{{ n.format(list.entries) }}</span>
          <span class="ix-r mono">{{ n.format(list.repos) }}</span>
        </NuxtLink>
      </li>
    </ul>

    <p class="ix-foot">
      Ordered by size. The second figure is how many of a list's entries are
      GitHub repositories; the rest are sites, papers, videos and books that
      carry no popularity signal at all, and they keep the curator's order
      because it is the only honest information anybody holds about them.
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

/*
 * Multi-column rather than one long column: eighty rows in a single file is a
 * screen and a half of scrolling for something a reader means to scan. The
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
