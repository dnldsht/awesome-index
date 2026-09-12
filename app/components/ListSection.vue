<script setup lang="ts">
import type { Row, ListShard } from "~~/src/lib/contracts";

/*
 * One heading from the curator's README and the contiguous run of rows under
 * it. `from`/`to` index into `shard.rows`, which is stored in curator order
 * precisely so a section is a slice and not a filter.
 *
 * This component is the unit `content-visibility: auto` is applied to, and the
 * reason that works is a measurement: 4,350 sections across the corpus at a
 * median of 6 entries. Small enough that skipping one is cheap and that the
 * ones on screen are genuinely on screen; numerous enough that skipping them
 * is most of the page. On golang it is 134 sections over 2,829 rows.
 */

const props = defineProps<{
  section: ListShard["sections"][number];
  rows: Row[];
  open: number;
}>();
defineEmits<{ toggle: [index: number] }>();

const count = computed(() => props.section.to - props.section.from);

/*
 * The exact height the section will occupy, handed to
 * `contain-intrinsic-size` so a skipped section reserves the right space and
 * the scrollbar does not lurch as the reader passes it: the 32px head plus a
 * 32px band per row, plus the two hairlines. `auto` in the CSS means the
 * browser replaces this estimate with the real measurement the first time it
 * renders the section, which is what absorbs an expanded row.
 */
const intrinsic = computed(() => `${34 + count.value * 32}px`);

const path = computed(() => props.section.path);
</script>

<template>
  <section
    :id="`s-${section.slug}`"
    class="section"
    :style="{ '--sh': intrinsic }"
  >
    <div class="section-head">
      <h2>
        <span v-for="p in path.slice(0, -1)" :key="p" class="up"
          >{{ p }} / </span
        >{{ path[path.length - 1] }}
      </h2>
      <span class="n">{{ count }}</span>
    </div>
    <div class="rows">
      <ListRow
        v-for="(row, i) in rows"
        :key="section.from + i"
        :row="row"
        :open="open === section.from + i"
        @toggle="$emit('toggle', section.from + i)"
      />
    </div>
  </section>
</template>
