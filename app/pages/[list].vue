<script setup lang="ts">
import { ROW } from "~~/src/lib/contracts";
import { haystack, needle, orderIndices, rankable } from "~/utils/order";
import { listCanonical } from "~/utils/site";

/*
 * One list, whole, in one document.
 *
 * Everything the site can do happens here, and all of it happens in the
 * browser against an array the page already holds: 80 documents that load
 * their own dataset and reorder it in memory, instead of ~4,000 precomputed
 * pages that bake one order in. That is the whole rewrite (DESIGN.md, "The one
 * change everything else follows from"), and this file is where it either
 * pays off or does not.
 *
 * The four pieces of state live in the query string and nowhere else (no
 * refs mirroring the URL, no `localStorage`, no scroll restoration hack), so
 * every state survives a reload, a share and the back button because the URL
 * is the only copy of it. See `useListQuery`.
 *
 * ## The document and the run
 *
 * The page has two shapes, and which one it takes is decided by the order.
 *
 * In the **curator's order**, the default and the one order the site this
 * replaces could not produce, the page is the README: headings in the
 * curator's sequence, rows under them, a contents rail beside it that follows
 * the reader down. `q` narrows it without destroying it, because a search
 * inside a document hides the lines that do not match and the headings left
 * with nothing, and what is left is still the document.
 *
 * Under **any other order** the headings are gone. A ranked run draws its rows
 * from all over the README, and there is no heading any of them is under any
 * more; pretending otherwise by sorting inside each of 134 sections would
 * answer a question nobody asked. So the page becomes one continuous band
 * (`ListRun`), and the rail says plainly that it now leads back to the
 * curator's order rather than pointing at where the reader is.
 *
 * ## Indices, everywhere
 *
 * Nothing below copies a row. Filtering and sorting produce `number[]` into
 * `shard.rows`, which stays in curator order for the whole life of the page.
 * The index is also a row's identity. A row is an *appearance*, not a project,
 * so the same target can appear twice under two headings and nothing else about
 * it is unique, which is why the open row is held as an index and why it
 * survives every reorder.
 */

const route = useRoute();
const slug = String(route.params.list);
const { data: shard, error } = useShard(slug);
const fixtures = useRuntimeConfig().public.usingFixtures;

const { sort, period, cat, q, set } = useListQuery();

/* ---- filter, then order ------------------------------------------------- */

const rows = computed(() => shard.value?.rows ?? []);

/* built once per shard and reused for every keystroke; see `haystack` */
const hay = computed(() => haystack(rows.value));
const find = computed(() => needle(q.value));

/** Whether the page is the curator's document or a ranked run. */
const document_ = computed(() => sort.value === "curator");

/**
 * The sections that survive `q`, each with the indices of its surviving rows.
 *
 * A section is a contiguous slice of `rows` (the shard is built in curator
 * order precisely so that it is), so this is a walk over `[from, to)` and not a
 * grouping pass. Sections left empty by the search are dropped: on `golang` a
 * search for "kafka" leaves 11 rows under 5 headings out of 134, and listing the
 * other 129 at zero would bury the answer in its own table of contents.
 *
 * Non-contiguous headings are already resolved in the shard: three (list, slug)
 * pairs in the corpus repeat a heading later in the README, and the builder
 * groups them so that a slug appears once. `shell` is the test: `uncategorized`
 * at rows 0–5, and `javascript`, on the list of the same name, spanning 31–1105.
 */
const groups = computed(() => {
  const s = shard.value;
  if (!s) return [];
  const n = find.value;
  const h = hay.value;
  const out: { section: (typeof s.sections)[number]; indices: number[] }[] = [];
  for (const section of s.sections) {
    const indices: number[] = [];
    for (let i = section.from; i < section.to; i++) {
      if (!n || h[i]!.includes(n)) indices.push(i);
    }
    if (indices.length) out.push({ section, indices });
  }
  return out;
});

/** Every surviving row, in curator order, for the ranked shapes. */
const kept = computed(() => {
  const n = find.value;
  const h = hay.value;
  const out: number[] = [];
  for (let i = 0; i < h.length; i++) if (!n || h[i]!.includes(n)) out.push(i);
  return out;
});

const run = computed(() =>
  document_.value
    ? []
    : orderIndices(rows.value, kept.value, sort.value, period.value),
);

const shown = computed(() =>
  document_.value
    ? groups.value.reduce((a, g) => a + g.indices.length, 0)
    : run.value.length,
);

const ranked = computed(() =>
  rankable(rows.value, kept.value, sort.value, period.value),
);

/* the rail shows the shard's own counts until a search makes them wrong */
const counts = computed(() =>
  find.value
    ? new Map(groups.value.map((g) => [g.section.slug, g.indices.length]))
    : null,
);

/* ---- the contents rail -------------------------------------------------- */

const keys = computed(() => groups.value.map((g) => g.section.slug));
const { current, jump } = useScrollSpy(keys, document_);

/**
 * Going to a heading.
 *
 * From a ranked run this also restores the curator's order, because that is the
 * only state in which the heading exists to be gone to. The rail says so above
 * its entries rather than leaving it to be discovered.
 *
 * The scroll itself is left to the effect below, so that a click, a reload and
 * a shared link all take the same path. The click has no shard to wait for,
 * but the other two do, and one code path for three cases is the difference
 * between "it works" and "it works when I click it".
 */
function goTo(section: string) {
  set(document_.value ? { cat: section } : { sort: "curator", cat: section });
}

/*
 * `?cat=` means "the document, at this heading", so honouring it is a scroll,
 * and it has to wait for the rows to exist. The prerendered HTML is a skeleton
 * and the shard arrives afterwards, which is also the reason the section is a
 * query parameter and not a fragment: at the moment the browser would honour a
 * `#hash` there is nothing under it.
 *
 * `jumped` stops the effect from re-scrolling every time the reader types a
 * character or the spy moves. The first landing is instant and later ones
 * animate: arriving at a shared link should look like the page loaded there,
 * and clicking the rail should look like travel.
 */
let jumped = "";
watchEffect(() => {
  const target = cat.value;
  const ready = document_.value && groups.value.length > 0;
  if (!target) {
    jumped = "";
    return;
  }
  if (!import.meta.client || !ready || jumped === target) return;
  const smooth = jumped !== "";
  nextTick(() => {
    if (jump(target, smooth)) jumped = target;
  });
});

/* ---- the open row ------------------------------------------------------- */

/*
 * One open row at a time, held by index into `shard.rows`. An index rather than
 * an id because a row is an appearance, not a project: the same target can be
 * filed under two headings of one list, and two rows would open at once. Because
 * it is the index into the *unsorted* array it also survives every reorder: the
 * row the reader opened is still open after they sort, wherever it has moved to.
 */
const open = ref(-1);
function toggle(i: number) {
  open.value = open.value === i ? -1 : i;
}

const repos = computed(
  () => shard.value?.rows.filter((r) => r[ROW.KIND] === "github").length ?? 0,
);

const n = new Intl.NumberFormat("en-US");

/*
 * The canonical is the bare list URL on every single variant, and it is the
 * load-bearing line of this file.
 *
 * There are four state parameters and 4,350 headings; the URLs they can spell
 * are effectively unbounded, and the entire reason the v2 site can offer
 * ordering at all is that none of them is a page. One canonical, eighty
 * documents. DESIGN.md, "Product": eighty-seven substantial pages are easier to
 * defend than four thousand thin ones.
 *
 * The title is left bare for the same reason. A tab that renamed itself per
 * sort would be four thousand titles pointing at one canonical, which is the
 * shape of thing that makes a crawler distrust the canonical.
 */
useHead({
  title: () => `${shard.value?.name ?? slug} · awesome index`,
  link: [{ rel: "canonical", href: listCanonical(slug) }],
});
useSeoMeta({
  ogTitle: () => `${shard.value?.name ?? slug} · awesome index`,
  ogUrl: listCanonical(slug),
});
</script>

<template>
  <div>
    <header class="mast">
      <div class="wrap">
        <div class="mast-in">
          <h1 class="mast-title">
            <!-- the masthead is the way back to the bare document: one click
                 clears the order, the window, the heading and the search -->
            <NuxtLink :to="`/${slug}`" class="mast-home">
              <span v-if="shard" class="mast-icon">{{ shard.icon }}</span
              >{{ shard?.name ?? slug }}
            </NuxtLink>
          </h1>
          <div class="mast-meta">
            <NuxtLink to="/" class="kicker mast-up"
              ><span class="px" style="--px: var(--px-arrow-left)" />all
              lists</NuxtLink
            >
            <a
              v-for="s in shard?.sources ?? []"
              :key="s.id"
              class="kicker src"
              :href="s.url"
              rel="noopener"
              target="_blank"
              >{{ s.id }}</a
            >
            <a
              class="btn src-link"
              href="https://github.com/dnldsht/awesome-index"
              rel="noopener"
              aria-label="source on GitHub"
              title="source on GitHub"
              ><span class="px" style="--px: var(--px-github)"
            /></a>
            <ThemeToggle />
          </div>
        </div>

        <ListControls
          v-if="shard"
          :total="shard.rows.length"
          :shown="shown"
          :rankable="ranked"
        />

        <div class="cols">
          <div class="cols-in kicker">
            <span>project</span>
            <span>note</span>
            <span class="r">stars</span>
            <!-- the delta column names its own window; it only ever moves off
                 30d under the trending order, where the reader chose it -->
            <span class="r">{{ period }}</span>
            <span class="r">pushed</span>
          </div>
        </div>
      </div>
      <div class="mast-rule" />
    </header>

    <div class="wrap list-page">
      <!--
        Branch on the data, never on `status`. With `server: false` the fetch
        has not started when the prerendered HTML is written, so the server
        sees `idle` and the client's first tick sees `pending`: the same page
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
        <ListContents
          :sections="shard.sections"
          :counts="counts"
          :current="current"
          :live="document_"
          @select="goTo"
        />

        <main class="list-doc">
          <p v-if="shown === 0" class="empty">
            nothing in {{ shard.name }} matches <b>{{ q }}</b
            >. This search covers this list only, which is the whole of the
            search on this site
          </p>

          <template v-else-if="document_">
            <ListSection
              v-for="g in groups"
              :key="g.section.slug"
              :section="g.section"
              :rows="shard.rows"
              :indices="g.indices"
              :open="open"
              :marked="cat === g.section.slug"
              :period="period"
              @toggle="toggle"
            />
          </template>

          <ListRun
            v-else
            :class="{
              'by-gain': sort === 'trending',
              'by-push': sort === 'activity',
            }"
            :rows="shard.rows"
            :indices="run"
            :open="open"
            :period="period"
            @toggle="toggle"
          />

          <footer class="colophon kicker">
            {{ n.format(shard.rows.length) }} entries ·
            {{ n.format(repos) }} repositories ·
            {{ n.format(shard.rows.length - repos) }} links ·
            {{ shard.sections.length }} sections · crawled
            {{ isoDate(shard.crawledAt) }}
            <span class="made"
              >Made with <span class="heart" aria-hidden="true">♥</span
              ><span class="sr">love</span> by
              <a href="https://donld.me" rel="me">Donald</a> and Opus</span
            >
          </footer>
        </main>
      </template>

      <p v-else class="empty">loading {{ slug }}…</p>
    </div>
  </div>
</template>

<style>
.cols-in .r {
  text-align: right;
}

.mast .src:hover {
  color: var(--accent);
}

/* the way back. First in the meta row, because leaving is a likelier want than
   opening the source README, and it is the only exit the page had none of */
.mast-up {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  color: var(--ink-3);
}

.mast-up:hover {
  color: var(--accent);
}

.mast-home:hover {
  color: var(--accent);
}

.colophon {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.5rem;
  border-top: 1px solid var(--rule-2);
  padding: 0.9rem 0 3rem;
}

/* pushed to the far end of the rule, so the counts stay the first thing read */
.made {
  margin-left: auto;
}
</style>
