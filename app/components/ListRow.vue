<script setup lang="ts">
import { ROW, type Row } from "~~/src/lib/contracts";

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
 *    decision; a printed number is a claim.
 * 2. Null is not zero. A repository we have not measured and a repository that
 *    gained nothing are different statements and get different marks.
 * 3. A `web` row is not a degraded `github` row. It has no stars, no language,
 *    no licence and no pulse, and it never will — 260 of golang's 2,829 rows
 *    and 88% of the corpus's non-GitHub targets are permanently in this state.
 *    Its numeric columns stay empty and its host takes the tag column, because
 *    where a link points is the one durable fact we hold about it.
 */

const props = defineProps<{ row: Row; open: boolean }>();
defineEmits<{ toggle: [] }>();

const r = computed(() => props.row);
const isRepo = computed(() => r.value[ROW.KIND] === "github");

const ownerPrefix = computed(() =>
  owner(r.value[ROW.ID], r.value[ROW.KIND] as "github" | "web"),
);

/*
 * The default window is 30 days — seven days is the only window that means
 * *now* and is noise as a default, because nobody visits an index of awesome
 * lists weekly. Wave 2 E makes this follow `?period=`.
 */
const d = computed(() => r.value[ROW.D30]);

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
      >{{ r[ROW.TITLE] }}</a
    >

    <span class="nt">{{ r[ROW.NOTE] }}</span>

    <!-- language for a repository; the host for a link, which is all it has -->
    <span v-if="isRepo" class="tg">{{ r[ROW.LANGUAGE] }}</span>
    <span v-else class="tg host">{{ host(r[ROW.URL]) }}</span>

    <span class="lc">{{ license(r[ROW.LICENSE]) }}</span>

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
    and the URL. Wave 2 E hangs the star-history SVG here, on demand and never
    for a `web` row.
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
  </div>
</template>
