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
 *    shows is `d7`/`d30`/`d365` — counts of actual stars. An ordering is a
 *    decision; a printed number is a claim. Sorting by `trending` therefore
 *    changes the *order* of these rows and nothing that appears on any of them.
 * 2. Null is not zero. A repository we have not measured and a repository that
 *    gained nothing are different statements and get different marks.
 * 3. A `web` row is not a degraded `github` row. It has no stars, no language,
 *    no licence and no pulse, and it never will — 260 of golang's 2,829 rows
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
 * The activity cell is the age since the last push — the fact — and the state
 * label, when we have one, is carried as a colour on it plus a title. Archived
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

/* ---- the star curve ---------------------------------------------------- */

/*
 * The full history, from star-history.com's SVG (MIT, CORS-open, 24-hour edge
 * cache), and the three rules around it are not negotiable:
 *
 * - **On demand only.** The `<img>` exists only while the row is open, which is
 *   what makes the request happen on the click and not before. It is 64 KB
 *   against somebody else's service; 2,829 of them on one page load would be
 *   indefensible, and it is the reason DESIGN.md rules out an inline sparkline
 *   on the row.
 * - **Never for a `web` row.** There is no repository to ask about.
 * - **It is allowed to fail.** It 500s on some repositories. A broken image
 *   icon in the middle of an expanded row would read as the page being broken,
 *   so the failure is caught and stated in one line, with the link out still
 *   offered — the reader can go and look, which is all the image was doing.
 *
 * The 14 months of history the site holds never appear here. They exist only at
 * build time, to compute the four integers the row carries; this curve goes
 * back to 2012 and we store none of it.
 */
const { dark } = useTheme();

const chart = computed(
  () =>
    `https://api.star-history.com/svg?repos=${encodeURIComponent(
      r.value[ROW.ID],
    )}&type=Date${dark.value ? "&theme=dark" : ""}`,
);

const failed = ref(false);
/* the component is reused across rows as the list reorders, and a failure
 * belongs to the repository, not to the slot it was rendered in */
watch(
  () => r.value[ROW.ID],
  () => (failed.value = false),
);
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
      :class="{ archived: isArchived }"
      :title="activityTitle || undefined"
      >{{ isArchived ? "† " : "" }}{{ age(r[ROW.LAST_ACTIVITY]) }}</span
    >
  </div>

  <!--
    Expansion. Everything the 32px band had to drop: the note in full, the
    licence and language spelled out, the unrounded date, all three windows,
    the URL — and, for a repository, the whole star curve.
  -->
  <div v-if="open" class="open">
    <!--
      Only when the band clipped it. Roughly 90 characters fit in the note
      column at a usual width, and repeating a note the reader can already see
      one line above is noise — the panel exists for what the 32px band could
      not hold, not for a second copy of what it could.
    -->
    <p v-if="(r[ROW.NOTE]?.length ?? 0) > 90" class="open-note">
      {{ r[ROW.NOTE] }}
    </p>
    <div class="open-grid">
      <span v-if="isRepo"
        >stars
        <b>{{
          r[ROW.STARS] == null ? "not measured" : stars(r[ROW.STARS]!)
        }}</b></span
      >
      <span v-if="isRepo"
        >7d <b>{{ r[ROW.D7] == null ? "—" : delta(r[ROW.D7]!) }}</b> · 30d
        <b>{{ r[ROW.D30] == null ? "—" : delta(r[ROW.D30]!) }}</b> · 1y
        <b>{{ r[ROW.D365] == null ? "—" : delta(r[ROW.D365]!) }}</b></span
      >
      <span v-if="r[ROW.LANGUAGE]"
        >language <b>{{ r[ROW.LANGUAGE] }}</b></span
      >
      <span v-if="r[ROW.LICENSE]"
        >licence <b>{{ r[ROW.LICENSE] }}</b></span
      >
      <span v-if="r[ROW.LAST_ACTIVITY]"
        >{{
          isArchived ? "archived, last push" : (r[ROW.STATE] ?? "last push")
        }}
        <b>{{ isoDate(r[ROW.LAST_ACTIVITY]) }}</b></span
      >
      <span v-if="!isRepo"
        >link <b>{{ host(r[ROW.URL]) }}</b> · no stars, no pulse, and never will
        have</span
      >
      <span
        >curator’s position <b>#{{ r[ROW.POSITION] + 1 }}</b></span
      >
    </div>
    <a
      class="open-url"
      :href="r[ROW.URL]"
      rel="noopener nofollow"
      target="_blank"
      >{{ r[ROW.URL] }}</a
    >

    <figure v-if="isRepo" class="chart">
      <img
        v-if="!failed"
        class="chart-img"
        :src="chart"
        :alt="`star history of ${r[ROW.ID]}`"
        width="800"
        height="533"
        decoding="async"
        @error="failed = true"
      />
      <figcaption class="chart-cap">
        <template v-if="failed"
          >no star history for this repository —
          <a
            :href="`https://star-history.com/#${r[ROW.ID]}&Date`"
            rel="noopener nofollow"
            target="_blank"
            >try star-history.com</a
          ></template
        >
        <template v-else>star history · star-history.com</template>
      </figcaption>
    </figure>
  </div>
</template>
