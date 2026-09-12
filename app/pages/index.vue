<script setup lang="ts">
import type { FrontPage } from "~~/src/lib/contracts";

/*
 * The front page, scaffolded.
 *
 * Wave 2 F owns this. What is here is the frame and, more to the point, the
 * treatment of nothing: `front-page.json` currently carries three empty rubric
 * arrays because the star-history fetcher is being built in parallel, and an
 * empty rubric has to read as a stated fact — "we have not measured this yet" —
 * rather than as a page that failed to load. Everything below the rubrics is
 * already real: 80 lists, with the gap between entries and repositories stated
 * rather than hidden, because on some lists half the entries cannot be ranked
 * at all and pretending otherwise is what the rest of this project avoids.
 */

const { data: front, error } = useAsyncData<FrontPage>(
  "front-page",
  () => $fetch<FrontPage>("/data/front-page.json"),
  { server: false },
);

const n = new Intl.NumberFormat("en-US");

const totals = computed(() => {
  const lists = front.value?.lists ?? [];
  return {
    lists: lists.length,
    entries: lists.reduce((a, l) => a + l.entries, 0),
    repos: lists.reduce((a, l) => a + l.repos, 0),
  };
});

/* 30d is the default window; 7d means *now* and is noise as a default. */
const climbing = computed(
  () => front.value?.climbing.find((c) => c.period === "30d")?.rows ?? [],
);

useHead({ title: "awesome index" });
</script>

<template>
  <div>
    <header class="wrap nameplate">
      <h1 class="np-title">awesome index</h1>
      <p class="np-deck kicker">
        {{ totals.lists ? n.format(totals.lists) : "—" }} curated lists ·
        {{ totals.entries ? n.format(totals.entries) : "—" }} entries ·
        {{ totals.repos ? n.format(totals.repos) : "—" }} repositories
      </p>
      <div class="np-tools"><ThemeToggle /></div>
    </header>
    <div class="mast-rule" />

    <main class="wrap">
      <p v-if="error" class="empty">No <code>/data/front-page.json</code>.</p>

      <template v-else>
        <section class="rubric">
          <h2 class="kicker">Climbing · 30 days</h2>
          <ol v-if="climbing.length" class="refs">
            <li v-for="r in climbing" :key="r.listSlug + r.id">
              <NuxtLink :to="`/${r.listSlug}`">{{ r.title }}</NuxtLink>
              <span class="mono">{{ delta(r.value) }}</span>
            </li>
          </ol>
          <p v-else class="empty">
            Not measured yet. Star history is fetched per repository and the
            backfill has not run; until it does there is no honest way to say
            what is climbing, so this says nothing.
          </p>
        </section>

        <div class="two">
          <section class="rubric">
            <h2 class="kicker">Just entered</h2>
            <p v-if="!front?.entered?.length" class="empty">
              Nothing new since the previous crawl.
            </p>
          </section>

          <section class="rubric">
            <h2 class="kicker">Just archived</h2>
            <p v-if="!front?.archived?.length" class="empty">
              No project declared itself finished since the previous crawl.
            </p>
          </section>
        </div>

        <section class="rubric">
          <h2 class="kicker">The lists</h2>
          <ul v-if="front" class="index">
            <li v-for="l in front.lists" :key="l.slug">
              <NuxtLink :to="`/${l.slug}`">
                <span class="ix-icon">{{ l.icon }}</span>
                <span class="ix-name">{{ l.name }}</span>
                <span class="ix-n mono">{{ n.format(l.entries) }}</span>
                <span class="ix-r mono">{{ n.format(l.repos) }}</span>
              </NuxtLink>
            </li>
          </ul>
          <p class="foot kicker">
            entries · repositories. The gap between the two is the part of a
            list that has no stars and no pulse — half of some lists — and it is
            stated rather than hidden.
          </p>
        </section>
      </template>
    </main>
  </div>
</template>

<style>
.nameplate {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding-block: 1.6rem 0.7rem;
}

.np-title {
  font-size: var(--t-mast);
  font-weight: var(--w-mast);
  letter-spacing: -0.022em;
  line-height: 1;
  margin: 0;
}

.np-deck {
  margin: 0;
}

.np-tools {
  margin-left: auto;
}

.rubric {
  margin-block: 1.5rem 2.2rem;
}

/* the rubric already has its rule; the empty state must not draw a second */
.rubric .empty {
  border-top: 0;
  padding-top: 0.7rem;
  max-width: 70ch;
  line-height: 1.6;
}

.rubric > h2 {
  font-size: var(--t-micro);
  margin: 0 0 0.55rem;
  color: var(--ink);
  border-bottom: 1px solid var(--rule-3);
  padding-bottom: 0.3rem;
}

/* two rubrics side by side, and stacked when there is no room for columns */
.two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0 2.5rem;
}

.refs {
  list-style: none;
  margin: 0;
  padding: 0;
}

.refs li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  height: var(--row-h);
  align-items: baseline;
  padding-top: 5px;
  border-bottom: 1px solid var(--rule);
  font-size: var(--t-name);
}

/*
 * The index. Multi-column because 80 lists in one column is a page of scroll
 * for something a reader wants to scan; the rows stay on the 32px band so the
 * front page and the list pages share one rhythm.
 */
.index {
  list-style: none;
  margin: 0;
  padding: 0;
  columns: 16rem;
  column-gap: 2.5rem;
}

.index li {
  break-inside: avoid;
}

.index a {
  display: grid;
  grid-template-columns: 1.4rem minmax(0, 1fr) 3.5rem 3.5rem;
  align-items: baseline;
  height: var(--row-h);
  padding-top: 5px;
  border-bottom: 1px solid var(--rule);
  font-size: var(--t-name);
  line-height: 1.25;
}

.index a:hover {
  background: var(--sunk);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}

.ix-name {
  font-weight: var(--w-name);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ix-n,
.ix-r {
  text-align: right;
  font-size: var(--t-meta);
}

.ix-n {
  color: var(--ink-2);
}

.ix-r {
  color: var(--ink-3);
}

.foot {
  max-width: 46ch;
  margin: 1rem 0 3rem;
  letter-spacing: 0.04em;
  text-transform: none;
  line-height: 1.6;
}
</style>
