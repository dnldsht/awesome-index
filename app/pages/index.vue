<script setup lang="ts">
import type { FrontPage, Ref as FrontRef } from "~~/src/lib/contracts";
import { SITE } from "~/utils/site";

/*
 * The front page.
 *
 * DESIGN.md is explicit that this is a front page and not an index: what is
 * climbing, what has just entered a list, what has just been archived, and the
 * index of all eighty lists below. It is the only part of the site that changes
 * on its own every day, which is the whole difference between a reference
 * somebody consults once and a site they come back to, so it carries more
 * editorial weight than its size suggests, and the weight is spent on two
 * things that are easy to get wrong:
 *
 * 1. **The order has to be explained.** The rubrics are ordered by acceleration
 *    against each project's own history and that score is never rendered
 *    (`contracts.ts`, `Row`'s `trend`). The visible consequence is that the
 *    first row often carries a smaller figure than the second, which reads as a
 *    bug unless the page says otherwise. One standfirst under the band does it.
 * 2. **Empty has to look deliberate.** Two rubrics are empty until the schema
 *    records when an entry first appeared, and the year rubric is empty for
 *    every list the backfill has not gone three pages deep on. Three blank
 *    slots is the normal state of this page today and possibly for a while, so
 *    every rubric keeps its head, its rule and its place in the grid, and says
 *    in a sentence what is missing. A rubric that hid itself would leave a
 *    reader unable to tell a quiet week from a broken build.
 */

const { data: front, error } = useAsyncData<FrontPage>(
  "front-page",
  () => $fetch<FrontPage>("/data/front-page.json"),
  { server: false },
);

const description =
  "Eighty awesome lists, refreshed daily: which projects are gaining " +
  "stars, which were archived, and the lists themselves.";

useSeoMeta({
  title: "awesome index",
  description,
  ogTitle: "awesome index",
  ogDescription: description,
  ogUrl: `${SITE}/`,
});

/** mirrors `TOP` in `bin/shards.ts`: how many rows a full rubric carries */
const TOP = 20;

const lists = computed(() => front.value?.lists ?? []);

const totals = computed(() => ({
  lists: lists.value.length,
  entries: lists.value.reduce((sum, list) => sum + list.entries, 0),
  repos: lists.value.reduce((sum, list) => sum + list.repos, 0),
}));

const climbing = (period: FrontPage["climbing"][number]["period"]) =>
  computed(
    () => front.value?.climbing.find((c) => c.period === period)?.rows ?? [],
  );

const d7 = climbing("7d");
const d30 = climbing("30d");
const d365 = climbing("1y");

/*
 * Ten rows a rubric until asked for all twenty. One switch for the whole band
 * rather than one per rubric, so the three columns stay the same height and
 * their rows keep lining up across the page.
 */
const FOLD = 10;
const more = ref(false);
const fold = (rows: FrontRef[]) => (more.value ? rows : rows.slice(0, FOLD));
const folds = computed(() =>
  [d7, d30, d365].some((rows) => rows.value.length > FOLD),
);

/*
 * A rubric short of its twenty rows is not broken either. It means the window
 * asked for more history than the backfill holds behind most of the index, so
 * it says so rather than trailing off. Silent on a full block.
 */
const short = (rows: FrontRef[], why: string) =>
  rows.length > 0 && rows.length < TOP
    ? `Only ${rows.length} so far. ${why}`
    : "";

const BACKFILL = "Star history is still backfilling.";

const DEPTH =
  "A year needs 78 weeks of star history. Most lists have 60 so far.";
</script>

<template>
  <div>
    <div class="wrap">
      <FrontNameplate
        :lists="totals.lists"
        :entries="totals.entries"
        :repos="totals.repos"
        :generated-at="front?.generatedAt ?? null"
      />
    </div>
    <div class="mast-rule" />

    <main class="wrap">
      <p v-if="error" class="empty">
        Couldn't load <code>/data/front-page.json</code>. The list pages still
        work.
      </p>

      <template v-else>
        <section class="band">
          <h2 class="band-head kicker">Climbing</h2>
          <p class="standfirst">
            Each project is ranked against its own usual week, so a small repo
            having a big week can sit above a large one having a normal week.
            The number is stars gained in the window.
          </p>

          <!--
            Seven, thirty, a year: in that order, with the thirty-day block
            set as the lead in the middle column. Thirty days is the window the
            site defaults to (DESIGN.md, "Trending"): seven days is the only
            window that means *now* and is noise as a default, because nobody
            visits an index of awesome lists weekly, and a year answers the
            other question: whether a thing is still growing or has stalled.
          -->
          <div class="climb">
            <FrontRubric
              title="Seven days"
              window="1 week"
              :rows="fold(d7)"
              :short="short(d7, BACKFILL)"
              :empty="`Nothing here yet. ${BACKFILL}`"
            />
            <FrontRubric
              lead
              title="Thirty days"
              window="4 weeks"
              :rows="fold(d30)"
              :short="short(d30, BACKFILL)"
              :empty="`Nothing here yet. ${BACKFILL}`"
            />
            <FrontRubric
              title="One year"
              window="52 weeks"
              :rows="fold(d365)"
              :short="short(d365, DEPTH)"
              :empty="DEPTH"
            />
          </div>
          <button
            v-if="folds"
            class="btn more"
            type="button"
            :aria-expanded="more"
            @click="more = !more"
          >
            {{ more ? "show ten" : "show all twenty" }}
          </button>
        </section>

        <section class="band">
          <h2 class="band-head kicker">Changed</h2>
          <div class="two">
            <FrontRubric
              title="Just entered"
              figure="stars"
              :rows="front?.entered ?? []"
              empty="Empty for now. The index doesn't record when an entry
                was added to a list yet."
            />
            <FrontRubric
              title="Just archived"
              figure="stars"
              :rows="front?.archived ?? []"
              empty="Empty for now. The index knows which projects are
                archived, but not when."
            />
          </div>
        </section>

        <section class="band">
          <FrontIndex :lists="lists" />
        </section>

        <footer class="colophon">
          <p>
            Stars, languages and activity come from GitHub and refresh daily.
            The climbing order uses fourteen months of weekly star history.
            Visits are counted by a self-hosted
            <a href="https://umami.is" rel="noopener">Umami</a>: the page, where
            you came from, the country. No cookie, nothing that identifies you.
          </p>
          <p class="made kicker">
            Made with <span class="heart" aria-hidden="true">♥</span
            ><span class="sr">love</span> by
            <a href="https://donld.me" rel="me">Donald</a> and Opus
          </p>
        </footer>
      </template>
    </main>
  </div>
</template>

<style scoped>
/* the credit at the far end of the rule, set as the list pages set it */
.colophon .made {
  font-size: var(--t-micro);
  margin-left: auto;
  max-width: none;
  white-space: nowrap;
}

.band {
  margin-block: 1.9rem 2.6rem;
}

/*
 * The band's label, above the three heads it governs. A kicker rather than a
 * heading because the rubric heads below it are the headlines; this is the
 * page's structure showing through, which is what the rule under it is for.
 */
.band-head {
  margin: 0 0 0.55rem;
  color: var(--ink);
}

.more {
  margin-top: 0.8rem;
}

.standfirst {
  font-size: var(--t-lede);
  line-height: 1.55;
  color: var(--ink-2);
  max-width: 68ch;
  margin: 0 0 1.4rem;
}

/*
 * Three columns, the lead in the middle and wider. A broadsheet sets its lead
 * larger rather than in its own box (no cards, rules instead of borders), so
 * the hierarchy here is column width and type size and nothing else.
 */
.climb {
  display: grid;
  grid-template-columns: 1fr 1.35fr 1fr;
  gap: 0 2.5rem;
}

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 2.5rem;
}

/* the rule runs the full measure; the prose sits on a readable one inside it */
.colophon {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.9rem 1.5rem;
  margin: 2.4rem 0 3.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--rule-2);
}

.colophon p {
  font-size: var(--t-note);
  color: var(--ink-3);
  line-height: 1.65;
  max-width: 64ch;
  margin: 0;
}

/* two columns, then one; the lead keeps its size at every width */
@media (max-width: 62rem) {
  .climb {
    grid-template-columns: 1fr 1fr;
    gap: 1.8rem 2.2rem;
  }
}

@media (max-width: 44rem) {
  .climb,
  .two {
    grid-template-columns: 1fr;
    gap: 1.8rem;
  }

  .standfirst {
    font-size: var(--t-note);
  }
}
</style>
