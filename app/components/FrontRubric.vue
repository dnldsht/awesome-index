<script setup lang="ts">
import { ROW, type Ref as FrontRef } from "~~/src/lib/contracts";

/**
 * One rubric: a head, the ordering's terms, and up to twenty rows, or the
 * stated reason there are none.
 *
 * The empty state is the part that had to be designed rather than handled.
 * Three of the five rubrics are empty right now and two of them will stay empty
 * until the schema grows a first-seen date, so a blank slot is the normal
 * condition of this page and not an incident. It gets the same rule and the
 * same head as a full one, and a sentence in the editorial voice saying what is
 * missing and why: an absence reported is a fact like any other. What it must
 * never do is disappear: a rubric that hides itself when it has nothing leaves
 * a reader unable to tell a quiet week from a broken build.
 *
 * `value` is a count of real stars and is the only figure rendered. The
 * acceleration score that put these rows in this order is deliberately not
 * here, not even as a tooltip; see `Row`'s `trend` in `contracts.ts`. The
 * consequence is visible and has to be handled rather than hidden: the row
 * ordered first often carries a smaller figure than the row below it, because
 * +253 against a normal week of +1 is a larger event than +529 against +41.
 * The standfirst above the band is where that gets explained, once, in the
 * reader's terms. A page that prints an order it refuses to justify is worse
 * than one that prints the score.
 */
const props = withDefaults(
  defineProps<{
    /** the rubric's name, e.g. "Seven days" */
    title: string;
    /** the exact window, spelled out, because "30 days" is really four weeks */
    window?: string;
    rows: FrontRef[];
    /** `delta` signs the figure (+412); `stars` prints a total */
    figure?: "delta" | "stars";
    /** what to say when there are none: always a reason, never "no data" */
    empty: string;
    /** the lead rubric is set larger; the flanking two are set quieter */
    lead?: boolean;
    /** shown when the rubric is short of its twenty rows */
    short?: string;
  }>(),
  { figure: "delta", window: "", lead: false, short: "" },
);

/** a repository id is `owner/name`; anything else is a normalised URL */
const owner = (id: string) => {
  if (id.includes("://")) return "";
  const cut = id.indexOf("/");
  return cut < 0 ? "" : id.slice(0, cut + 1);
};

/*
 * The row opens in place, onto the panel a list row opens onto, so a reader can
 * see what is climbing without leaving the page. The one way out is the list's
 * name, which goes to that list: a project reaches this page through a list,
 * and a reader deserves to know which door that was. One open row per rubric;
 * reset when the rows change under it, because the index is a position in this
 * rubric and not a project.
 */
const open = ref(-1);
watch(
  () => props.rows,
  () => (open.value = -1),
);
const toggle = (i: number) => (open.value = open.value === i ? -1 : i);
</script>

<template>
  <section class="ru" :class="{ lead }">
    <h2 class="ru-head">
      {{ title }}
      <span v-if="window" class="ru-window mono">{{ window }}</span>
    </h2>

    <ol v-if="rows.length" class="ru-rows">
      <li v-for="(ref, i) in rows" :key="ref.listSlug + ref.row[ROW.ID]">
        <div
          class="ru-row"
          :class="{ 'is-open': open === i }"
          :aria-expanded="open === i"
          @click="toggle(i)"
        >
          <span class="ru-rank mono">{{ i + 1 }}</span>
          <span class="ru-name">
            <span v-if="owner(ref.row[ROW.ID])" class="ru-owner">{{
              owner(ref.row[ROW.ID])
            }}</span
            >{{ ref.row[ROW.TITLE] }}
          </span>
          <NuxtLink :to="`/${ref.listSlug}`" class="ru-list mono" @click.stop>{{
            ref.listSlug
          }}</NuxtLink>
          <span class="ru-fig mono" :class="{ up: figure === 'delta' }">
            {{ figure === "delta" ? delta(ref.value) : stars(ref.value) }}
          </span>
          <span v-if="ref.row[ROW.NOTE]" class="ru-note">{{
            ref.row[ROW.NOTE]
          }}</span>
        </div>
        <RowPanel v-if="open === i" :row="ref.row" />
      </li>
    </ol>

    <p v-else class="empty ru-empty">{{ empty }}</p>

    <p v-if="rows.length && short" class="ru-short mono">{{ short }}</p>
  </section>
</template>

<style scoped>
.ru {
  min-width: 0;
}

/*
 * Serif head, because these are the page's five headlines and the two families
 * divide by job: prose is the serif, every figure is the mono. The window sits
 * beside it in the mono as a label rather than as part of the sentence. It is
 * a measurement, and it is there because "Thirty days" is a name for a window
 * that is actually four week buckets.
 */
.ru-head {
  font-family: var(--font-serif);
  font-size: var(--t-lede);
  font-weight: var(--w-mast);
  letter-spacing: -0.01em;
  margin: 0 0 0.3rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--rule-3);
  display: flex;
  gap: 0.5rem;
  /*
   * Bottom-aligned inside a fixed height so that the rule under the lead head
   * lands on the same line as the rule under the two beside it, even though
   * the lead is set four points larger. Three columns whose rules disagree by
   * six pixels is the sort of thing a broadsheet never does and a grid of
   * independent components does by default.
   */
  min-height: 1.9rem;
  align-items: flex-end;
  /* tight, so the lead's larger line box still fits inside the shared height */
  line-height: 1.2;
}

.lead .ru-head {
  font-size: var(--t-head);
}

.ru-window {
  margin-left: auto;
  font-size: var(--t-micro);
  font-weight: 400;
  color: var(--ink-3);
  letter-spacing: 0.06em;
}

.ru-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

/*
 * Two lines rather than the site's 32px band: twenty rows is not three
 * thousand, and a name with nothing under it says little about why it is
 * climbing. Four columns on the first line: the rank, the project, the list it
 * was found in, and the only figure this page prints. The curator's note runs
 * under the name on the second.
 */
.ru-row {
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr) auto 4.25rem;
  column-gap: 0.6rem;
  row-gap: 1px;
  align-items: baseline;
  padding: 5px 0 6px;
  border-bottom: 1px solid var(--rule);
  line-height: 1.25;
  overflow: hidden;
  cursor: pointer;
}

.ru-row:hover,
.ru-row.is-open {
  background: var(--sunk);
}

.ru-rank {
  font-size: var(--t-micro);
  color: var(--ink-3);
  text-align: right;
}

.ru-name {
  font-size: var(--t-note);
  font-weight: var(--w-name);
  letter-spacing: -0.004em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lead .ru-name {
  font-size: var(--t-name);
}

.ru-list:hover {
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}

/* one line of it; the panel holds the rest when the band clips it */
.ru-note {
  grid-column: 2 / -1;
  font-size: var(--t-meta);
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* the owner is provenance, the repository is the name; see `format.ts` */
.ru-owner {
  font-weight: var(--w-body);
  color: var(--ink-3);
}

/*
 * Which list this was found in, and the row's one link: it goes to that list.
 * Subordinate to the project and to the figure.
 */
.ru-list {
  font-size: var(--t-micro);
  color: var(--ink-3);
  max-width: 6.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ru-fig {
  font-size: var(--t-meta);
  text-align: right;
  color: var(--ink);
  white-space: nowrap;
}

.ru-fig.up {
  color: var(--pos);
}

.ru-empty {
  max-width: 46ch;
  line-height: 1.65;
  font-family: var(--font-serif);
  font-size: var(--t-note);
  border-top: 0;
  padding-top: 0.55rem;
}

/*
 * A rubric with eleven rows instead of twenty is not broken either, and the
 * reason is worth one line: the window asks for history the backfill may not
 * hold yet.
 */
.ru-short {
  font-size: var(--t-micro);
  color: var(--ink-3);
  line-height: 1.5;
  margin: 0.5rem 0 0;
  max-width: 40ch;
}

/* no room for a column, so the list takes the line under the name and the
   note the one under that, rather than disappearing: the door still matters */
@media (max-width: 44rem) {
  .ru-row {
    grid-template-columns: 1.5rem minmax(0, 1fr) 4.25rem;
  }

  .ru-list {
    grid-area: 2 / 2 / 3 / -1;
    justify-self: start;
    max-width: none;
  }

  .ru-note {
    grid-row: 3;
  }
}
</style>
