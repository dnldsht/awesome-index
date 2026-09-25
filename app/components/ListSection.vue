<script setup lang="ts">
import type { Row, ListShard } from "~~/src/lib/contracts";
import type { Period } from "~/utils/order";

/*
 * One heading from the curator's README and the rows filed under it.
 *
 * This component is the unit `content-visibility: auto` is applied to, and the
 * reason that works is a measurement: 4,350 sections across the corpus at a
 * median of 6 entries. Small enough that skipping one is cheap and that the ones
 * on screen are genuinely on screen; numerous enough that skipping them is most
 * of the page. On golang it is 134 sections over 2,829 rows.
 *
 * It takes `indices` into `shard.rows` rather than a slice of rows. `from`/`to`
 * are still what a section *is* in the shard (rows are stored in curator order
 * precisely so a section is a contiguous slice), but `q` filters within a
 * section, and after that the section is a subset rather than a slice. Passing
 * indices covers both without the page having to build a second array of rows:
 * the index is also the row's identity (a row is an appearance, not a project,
 * so nothing else is unique), which is what the open row and Vue's key both use.
 */

const props = defineProps<{
  section: ListShard["sections"][number];
  rows: Row[];
  indices: number[];
  open: number;
  /* the reader arrived here from the contents rail, or shared a link that did */
  marked: boolean;
  /* which window the delta column of every row below is reporting */
  period: Period;
}>();
defineEmits<{ toggle: [index: number] }>();

/*
 * The exact height the section will occupy, handed to `contain-intrinsic-size`
 * so a skipped section reserves the right space and the scrollbar does not
 * lurch as the reader passes it: the 32px head plus a 32px band per row, plus
 * the two hairlines. `auto` in the CSS means the browser replaces this estimate
 * with the real measurement the first time it renders the section, which is
 * what absorbs an expanded row.
 *
 * It counts `indices`, not `to - from`: under a search the section holds fewer
 * rows than the shard says it does, and an estimate from the unfiltered count
 * would reserve six times the height the section now needs.
 */
const intrinsic = computed(() => `${34 + props.indices.length * 32}px`);

const path = computed(() => props.section.path);
</script>

<template>
  <section
    :id="`s-${section.slug}`"
    class="section"
    :class="{ marked }"
    :data-spy="section.slug"
    :style="{ '--sh': intrinsic }"
  >
    <div class="section-head">
      <h2>
        <span v-for="p in path.slice(0, -1)" :key="p" class="up"
          >{{ p }} / </span
        >{{ path[path.length - 1] }}
      </h2>
      <span class="n">{{ indices.length }}</span>
    </div>
    <div class="rows">
      <ListRow
        v-for="i in indices"
        :key="i"
        :row="rows[i]!"
        :open="open === i"
        :period="period"
        @toggle="$emit('toggle', i)"
      />
    </div>
  </section>
</template>
