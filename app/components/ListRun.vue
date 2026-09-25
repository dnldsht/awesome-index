<script setup lang="ts">
import type { Row } from "~~/src/lib/contracts";
import type { Period } from "~/utils/order";

/*
 * The list when it is no longer a document.
 *
 * Under any order but the curator's the headings are gone (a ranked run draws
 * its rows from all over the README and there is no heading it is under), so
 * this renders one continuous band of rows instead of `ListSection`'s grouped
 * ones.
 *
 * The reason it is not simply `v-for` over the whole array is the property the
 * whole page rests on. `content-visibility: auto` is applied *per section*, and
 * a section is the right unit because the corpus has 4,350 of them at a median
 * of 6 entries: small enough that skipping one is cheap, numerous enough that
 * skipping them is most of the page. Flattening 2,829 rows into one container
 * would put every one of them in a single containment block, the browser would
 * lay out all of them at once, and the ~600 ms Wave 1 D moved off page load
 * would come straight back, on *every sort*, not once.
 *
 * So the run is cut into fixed blocks that stand in for the sections. Fifty
 * rows gives `avelino/awesome-go` 57 blocks against its 134 sections: the same
 * order of granularity, arrived at from the other direction. The blocks are
 * invisible (no heading, no rule, nothing to see), and every row stays in the
 * DOM, so `Ctrl+F` still reaches the bottom of a sorted list exactly as it does
 * an unsorted one.
 */

const props = defineProps<{
  rows: Row[];
  indices: number[];
  open: number;
  period: Period;
}>();
defineEmits<{ toggle: [index: number] }>();

const CHUNK = 50;

const chunks = computed(() => {
  const out: { at: number; indices: number[] }[] = [];
  for (let i = 0; i < props.indices.length; i += CHUNK) {
    out.push({ at: i, indices: props.indices.slice(i, i + CHUNK) });
  }
  return out;
});
</script>

<template>
  <div class="list-run">
    <div
      v-for="c in chunks"
      :key="c.at"
      class="section"
      :style="{ '--sh': `${c.indices.length * 32}px` }"
    >
      <div class="rows">
        <ListRow
          v-for="i in c.indices"
          :key="i"
          :row="rows[i]!"
          :open="open === i"
          :period="period"
          @toggle="$emit('toggle', i)"
        />
      </div>
    </div>
  </div>
</template>
