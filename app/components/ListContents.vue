<script setup lang="ts">
import type { ListShard } from "~~/src/lib/contracts";

/*
 * The curator's table of contents, beside the document.
 *
 * The measurement this component exists to obey: 4,350 categories across the
 * corpus, **median 6 entries**, only 80 over 60. That is not a taxonomy and it
 * cannot be a facet: a dropdown of 4,350 values would be useless and a page per
 * category is the combinatorial problem the whole rewrite was undertaken to
 * escape. It is a table of contents, and a table of contents is a column of
 * short headings beside a long document that you scroll.
 *
 * So every entry here is a **position**, not a filter. Clicking one scrolls the
 * document to that heading and records it in `?cat=` so the position survives a
 * reload and a share; the rows on the page do not change. The rail tracks the
 * reader as they scroll, which is the difference between a menu and a contents
 * column.
 *
 * ## When the order is not the curator's
 *
 * A ranked page has no headings to be inside of (the rows come from all over
 * the README), so the rail cannot tell the reader where they are. It says so,
 * goes quiet, and each entry becomes a way back: clicking one restores the
 * curator's order *and* goes to that heading. That is stated in the rail rather
 * than left to be discovered, because a control that silently changes meaning is
 * worse than one that explains itself in six words.
 *
 * ## Nesting
 *
 * `path` is the full heading path, so a rail entry knows its depth. Indenting by
 * it costs one multiplication and is most of what makes 134 entries readable;
 * the parent names are not repeated, because the indent already says it and the
 * column is 13rem wide.
 */

const props = defineProps<{
  sections: ListShard["sections"];
  /* how many rows of each section survive `q`, keyed by slug; empty when no
     search is running, in which case the section's own count is the truth */
  counts: Map<string, number> | null;
  current: string | null;
  /* the rail can point at where the reader is only while the document is in
     the curator's order and therefore actually has headings in it */
  live: boolean;
}>();

defineEmits<{ select: [slug: string] }>();

/* The leaf, and how deep it sits. `path` is ["Command-Line Productivity",
 * "Directory Navigation"]; the rail shows the second, indented once. */
function leaf(path: string[]): string {
  return path[path.length - 1] ?? "";
}

/*
 * Folded shut on a phone.
 *
 * Above the document rather than beside it, 134 headings are 250 px of table of
 * contents before the reader sees a single row, which is the wrong trade on
 * the screen with the least of it. It is set after mount rather than bound,
 * because the prerendered HTML has to agree with the first client render and
 * the viewport is not known until there is one.
 */
const el = ref<HTMLDetailsElement>();
onMounted(() => {
  if (window.matchMedia("(max-width: 72rem)").matches && el.value) {
    el.value.open = false;
  }
});

const visible = computed(() =>
  props.sections
    .map((s) => ({
      s,
      n: props.counts ? (props.counts.get(s.slug) ?? 0) : s.to - s.from,
    }))
    /* a search empties most sections; listing them at zero would make the rail
       longer than the results it describes */
    .filter((e) => e.n > 0),
);
</script>

<template>
  <nav class="toc" :class="{ cold: !live }" aria-label="contents">
    <details ref="el" class="toc-d" open>
      <summary class="kicker toc-h">
        contents<span class="toc-n">{{ visible.length }}</span>
      </summary>

      <p v-if="!live" class="toc-note">
        headings belong to the curator’s order; choosing one returns to it
      </p>

      <ol class="toc-l">
        <li v-for="e in visible" :key="e.s.slug">
          <a
            class="toc-a"
            :class="{ on: live && current === e.s.slug }"
            :href="`?cat=${encodeURIComponent(e.s.slug)}`"
            :style="{ '--d': Math.min(e.s.path.length - 1, 3) }"
            @click.prevent="$emit('select', e.s.slug)"
            ><span class="toc-t">{{ leaf(e.s.path) }}</span
            ><span class="toc-c">{{ e.n }}</span></a
          >
        </li>
      </ol>
    </details>
  </nav>
</template>
