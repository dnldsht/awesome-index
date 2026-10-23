<script setup lang="ts">
import { ROW, type Row } from "~~/src/lib/contracts";
import { PERIOD_FIELD, type Period } from "~/utils/order";

/*
 * One entry of one list, in 32 pixels.
 *
 * The whole visual direction in DESIGN.md exists to make this component
 * possible: no card, no border, no shadow, one hairline underneath, and seven
 * columns that line up down the page because a monospace sets every figure.
 * Twenty-five of these fit on a screen. A card layout fits eight, on a list of
 * 2,829.
 *
 * Three things here are rules rather than choices, and each has a reason
 * recorded in DESIGN.md:
 *
 * 1. `Row[ROW.TREND]` is never rendered. It is the acceleration score, it has
 *    no unit a reader could interpret, and it exists to sort. What the row
 *    shows is `d7`/`d30`/`d365`, counts of actual stars. An ordering is a
 *    decision; a printed number is a claim. Sorting by `trending` therefore
 *    changes the *order* of these rows and nothing that appears on any of them.
 * 2. Null is not zero. A repository we have not measured and a repository that
 *    gained nothing are different statements and get different marks.
 * 3. A `web` row is not a degraded `github` row. It has no stars, no language,
 *    no licence and no pulse, and it never will: 260 of golang's 2,829 rows
 *    and 88% of the corpus's non-GitHub targets are permanently in this state.
 *    Its numeric columns stay empty and its host takes the tag column, because
 *    where a link points is the one durable fact we hold about it.
 */

const props = defineProps<{
  row: Row;
  open: boolean;
  /* which of the three windows the delta column is showing; follows `?period=`
   * and therefore only ever moves off 30d under the trending order */
  period: Period;
}>();
defineEmits<{ toggle: [] }>();

/* see the page: ages are measured from the crawl, so prerender and hydration agree */
const crawledAt = inject<number | undefined>("crawledAt", undefined);

const r = computed(() => props.row);
const isRepo = computed(() => r.value[ROW.KIND] === "github");

const ownerPrefix = computed(() =>
  owner(r.value[ROW.ID], r.value[ROW.KIND] as "github" | "web"),
);

/*
 * The delta column follows the window. It is 30 days everywhere except under
 * the trending order, where the reader has said which window they mean and it
 * would be incoherent to rank by one and print another.
 */
const d = computed(() => r.value[PERIOD_FIELD[props.period]] as number | null);

const isArchived = computed(() => r.value[ROW.ARCHIVED] === 1);

/*
 * The activity cell is the age since the last push (the fact), and the state
 * label, when we have one, is carried as a weight on it plus a title. Archived
 * is the exception and is marked with a dagger, because it is the one state
 * the author declared rather than one we inferred, and it belongs in a
 * different category from our three guesses. The expanded row spells both out
 * with the unrounded date beside them.
 */
const activityTitle = computed(() => {
  const at = isoDate(r.value[ROW.LAST_ACTIVITY]);
  if (isArchived.value) return at ? `archived · last push ${at}` : "archived";
  const state = r.value[ROW.STATE];
  return [state, at].filter(Boolean).join(" · ");
});
</script>

<template>
  <div class="row" :class="{ 'is-open': open }" @click="$emit('toggle')">
    <a
      class="nm"
      :href="r[ROW.URL]"
      rel="noopener nofollow"
      target="_blank"
      @click.stop
      ><span v-if="ownerPrefix" class="ow">{{ ownerPrefix }}</span
      ><span v-else-if="!isRepo" class="ow host">{{ host(r[ROW.URL]) }}</span
      >{{ r[ROW.TITLE] }}</a
    >

    <span class="nt">{{ r[ROW.NOTE] }}</span>

    <!-- stars: a number, a dim dash for "not measured", nothing for a link -->
    <span class="st" :class="{ nil: isRepo && r[ROW.STARS] == null }">{{
      !isRepo ? "" : r[ROW.STARS] == null ? "–" : stars(r[ROW.STARS]!)
    }}</span>

    <span
      class="dl"
      :class="{
        nil: isRepo && d == null,
        up: d != null && d > 0,
        down: d != null && d < 0,
      }"
      :title="
        isRepo && d != null ? `${delta(d)} stars over ${period}` : undefined
      "
      >{{ !isRepo ? "" : d == null ? "–" : delta(d) }}</span
    >

    <span
      class="ac"
      :class="isArchived ? 'archived' : r[ROW.STATE]"
      :title="activityTitle || undefined"
      >{{ isArchived ? "† " : ""
      }}{{ age(r[ROW.LAST_ACTIVITY], crawledAt) }}</span
    >
  </div>

  <RowPanel v-if="open" :row="row" />
</template>
