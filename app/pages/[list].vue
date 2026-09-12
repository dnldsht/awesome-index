<script setup lang="ts">
import { ROW } from "~~/src/lib/contracts";

/*
 * One list, whole, in one document.
 *
 * This is the scaffold for the page, not the page: sorting, filtering,
 * `?sort=`/`?period=`/`?cat=`/`?q=`, the section navigation and the canonicals
 * are Wave 2 E. What is here is what proves the two decisions the visual
 * direction rests on — that a 32px row holds everything a reader needs, and
 * that `content-visibility: auto` per section keeps 2,829 rows in the DOM
 * without paying to lay them all out.
 *
 * The order is the curator's, which is the order the array already has.
 * Nothing on this page sorts.
 */

const route = useRoute();
const slug = String(route.params.list);
const { data: shard, error } = useShard(slug);
const fixtures = useRuntimeConfig().public.usingFixtures;

const repos = computed(
  () => shard.value?.rows.filter((r) => r[ROW.KIND] === "github").length ?? 0,
);

/*
 * One open row at a time, held by index into `shard.rows`. An index rather
 * than an id because a row is an appearance, not a project: the same target
 * can be filed under two headings of one list, and two rows would open at once.
 */
const open = ref(-1);
function toggle(i: number) {
  open.value = open.value === i ? -1 : i;
}

const n = new Intl.NumberFormat("en-US");

/* the shard is not loaded when the HTML is written, so the slug is the title
 * a crawler and a browser tab see until it is; Wave 2 E owns the canonicals */
useHead({
  title: () => `${shard.value?.name ?? slug} — awesome index`,
});
</script>

<template>
  <div>
    <header class="mast">
      <div class="wrap">
        <div class="mast-in">
          <h1 class="mast-title">
            <span v-if="shard" class="mast-icon">{{ shard.icon }}</span
            >{{ shard?.name ?? slug }}
          </h1>
          <span v-if="shard" class="kicker"
            >{{ n.format(shard.rows.length) }} entries</span
          >
          <div class="mast-meta">
            <a
              v-for="s in shard?.sources ?? []"
              :key="s.id"
              class="kicker src"
              :href="s.url"
              rel="noopener"
              target="_blank"
              >{{ s.id }}</a
            >
            <ThemeToggle />
          </div>
        </div>

        <div class="cols">
          <div class="cols-in kicker">
            <span>project</span>
            <span>note</span>
            <span>lang · host</span>
            <span>licence</span>
            <span class="r">stars</span>
            <span class="r">30d</span>
            <span>pushed</span>
          </div>
        </div>
      </div>
      <div class="mast-rule" />
    </header>

    <main class="wrap">
      <!--
        Branch on the data, never on `status`. With `server: false` the fetch
        has not started when the prerendered HTML is written, so the server
        sees `idle` and the client's first tick sees `pending` — the same page
        by every other measure, and a hydration mismatch by that one. `shard`
        and `error` are both null on both sides at hydration, which is what
        makes the skeleton agree with itself.
      -->
      <p v-if="error" class="empty">
        No shard for <b>{{ slug }}</b> at
        <code>/data/{{ slug }}.json</code>.<template v-if="fixtures">
          The site is running against <code>fixtures/</code>, which holds
          <code>golang</code> only; the rest arrive when the shard builder
          does.</template
        >
      </p>

      <template v-else-if="shard">
        <ListSection
          v-for="s in shard.sections"
          :key="s.slug"
          :section="s"
          :rows="shard.rows.slice(s.from, s.to)"
          :open="open"
          @toggle="toggle"
        />

        <footer class="colophon kicker">
          {{ n.format(shard.rows.length) }} entries ·
          {{ n.format(repos) }} repositories ·
          {{ n.format(shard.rows.length - repos) }} links ·
          {{ shard.sections.length }} sections · crawled
          {{ isoDate(shard.crawledAt) }}
        </footer>
      </template>

      <p v-else class="empty">loading {{ slug }}…</p>
    </main>
  </div>
</template>

<style>
.cols-in .r {
  text-align: right;
}

.mast .src:hover {
  color: var(--accent);
}

.colophon {
  border-top: 1px solid var(--rule-3);
  padding: 0.9rem 0 3rem;
}
</style>
