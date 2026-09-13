<script setup lang="ts">
import type { FrontPage, Ref as FrontRef } from "~~/src/lib/contracts";

/*
 * The front page.
 *
 * DESIGN.md is explicit that this is a front page and not an index: what is
 * climbing, what has just entered a list, what has just been archived, and the
 * index of all eighty lists below. It is the only part of the site that changes
 * on its own every day, which is the whole difference between a reference
 * somebody consults once and a site they come back to — so it carries more
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

useHead({
  title: "awesome index",
  meta: [
    {
      name: "description",
      content:
        "Eighty curated awesome lists, indexed and kept current: what is " +
        "climbing this week, what has just been archived, and every list.",
    },
  ],
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
 * A rubric short of its twenty rows is not broken either — it means the window
 * asked for more history than the backfill holds behind most of the index — so
 * it says so rather than trailing off. Silent on a full block.
 */
const short = (rows: FrontRef[], why: string) =>
  rows.length > 0 && rows.length < TOP
    ? `Only ${rows.length} ${rows.length === 1 ? "project clears" : "projects clear"} this window today. ${why}`
    : "";

const BACKFILL =
  "The star-history backfill is still working through the index; this fills " +
  "in on its own as it reaches more of it.";

const DEPTH =
  "A year-long comparison needs seventy-eight weeks of history — a year to " +
  "measure, and half a year to measure it against — and most of the index " +
  "holds sixty. Nothing is claimed about a year until the backfill goes deeper.";
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
        <code>/data/front-page.json</code> did not load, so this page has
        nothing to report. The lists themselves are unaffected.
      </p>

      <template v-else>
        <section class="band">
          <h2 class="band-head kicker">Climbing</h2>
          <p class="standfirst">
            Ordered by how far each project's recent weeks sit above its own
            normal week — not by size, so the figure beside the first row is
            often smaller than the one below it. A project that usually gains
            three stars a week and gained forty has moved; one that gains four
            hundred every week and gained four hundred has not. The figure is
            the stars it actually gained.
          </p>

          <!--
            Seven, thirty, a year — in that order, with the thirty-day block
            set as the lead in the middle column. Thirty days is the window the
            site defaults to (DESIGN.md, "Trending"): seven days is the only
            window that means *now* and is noise as a default, because nobody
            visits an index of awesome lists weekly, and a year answers the
            other question — whether a thing is still growing or has stalled.
          -->
          <div class="climb">
            <FrontRubric
              title="Seven days"
              window="1 week"
              :rows="d7"
              :short="short(d7, BACKFILL)"
              :empty="`Nothing has both the history this window needs and a week worth reporting. ${BACKFILL}`"
            />
            <FrontRubric
              lead
              title="Thirty days"
              window="4 weeks"
              :rows="d30"
              :short="short(d30, BACKFILL)"
              :empty="`Nothing has both the history this window needs and a month worth reporting. ${BACKFILL}`"
            />
            <FrontRubric
              title="One year"
              window="52 weeks"
              :rows="d365"
              :short="short(d365, DEPTH)"
              :empty="DEPTH"
            />
          </div>
        </section>

        <section class="band">
          <h2 class="band-head kicker">Changed</h2>
          <div class="two">
            <FrontRubric
              title="Just entered"
              figure="stars"
              :rows="front?.entered ?? []"
              empty="Nothing yet: the index does not record when an entry first
                appeared in a list, so there is no honest way to say which of
                them are new. The date is being added. Until it exists this
                says nothing rather than guessing, because a front page that
                invents a difference lies every day until somebody notices."
            />
            <FrontRubric
              title="Just archived"
              figure="stars"
              :rows="front?.archived ?? []"
              empty="Nothing yet, and for the same reason: the index knows that
                a project's author has declared it finished, but not when they
                did, so it cannot tell this week's from last year's. An author
                archiving their own work is the one abandonment nobody has to
                guess at, and it is worth reporting properly or not at all."
            />
          </div>
        </section>

        <section class="band">
          <FrontIndex :lists="lists" />
        </section>

        <footer class="colophon">
          <p>
            Stars, languages and activity come from GitHub and are refreshed
            daily. The weekly star history behind the three climbing rubrics
            reaches back fourteen months and never leaves the build — the page
            carries the counts, not the curve. The score that produces the order
            is deliberately not shown: an ordering is a decision, and a printed
            number is a claim.
          </p>
        </footer>
      </template>
    </main>
  </div>
</template>

<style scoped>
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

.standfirst {
  font-size: var(--t-lede);
  line-height: 1.55;
  color: var(--ink-2);
  max-width: 68ch;
  margin: 0 0 1.4rem;
}

/*
 * Three columns, the lead in the middle and wider. A broadsheet sets its lead
 * larger rather than in its own box — no cards, rules instead of borders — so
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
