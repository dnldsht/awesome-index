<script setup lang="ts">
import { PERIODS, SORTS, type Sort } from "~/utils/order";

/*
 * The order, the window and the search — the page's entire control surface, in
 * one strip of the masthead.
 *
 * It is a row of words, not a toolbar. No select, no chevron, no pill: four
 * orders is few enough to state all four, and a `<select>` would hide three of
 * them behind a click and hide from the reader that "curator" — the default and
 * the point of the rewrite — is a choice somebody made. The same argument
 * DESIGN.md makes against a 4,350-value dropdown for categories, at a scale
 * where it happens to be easy to obey.
 *
 * ## The window
 *
 * `period` only bears on `trending`, so it only appears under `trending`. The
 * brief's alternative was to show it disabled; hiding wins because a disabled
 * control invites a click that does nothing, whereas a control that appears
 * beside the order it belongs to *teaches* that trending is windowed. It is
 * dropped from the URL on the same rule — see `useListQuery`.
 *
 * ## The count
 *
 * `shown` / `total` is not a progress indicator, it is the search's only
 * feedback. `rankable` is the honest one: under an order that most of the list
 * cannot be placed in — trending on a list the star-history backfill has not
 * reached is *zero of 432* — it says so, in the strip, rather than presenting
 * the curator's order under a heading that says "trending".
 *
 * ## What the window does
 *
 * Both things it appears to do: it reorders the list *and* it retitles the
 * delta column to the gain it is ordering by. The row carries an acceleration
 * score per window (`ROW.TREND7` / `ROW.TREND` / `ROW.TREND365`), each measured
 * against the whole history with its own floor, so 7d, 30d and 1y are three
 * different orderings rather than one ordering under three labels.
 *
 * It did not always. The first cut of this page shipped a single 30-day score
 * and a window that moved only the printed figure — a control doing half of
 * what it looked like it did — and the strip had to carry a sentence admitting
 * it. The sentence is gone because the cause is: `contracts.ts` grew two fields
 * and `bin/shards.ts` ships them. What remains is `unranked`, below, which is
 * not an apology but a fact that now *varies by window*: a year needs 78 weeks
 * of history to score at all, so 1y can rank far fewer rows than 7d on the same
 * list.
 */

const props = defineProps<{
  total: number;
  shown: number;
  rankable: number;
}>();

const { sort, period, q, set, replace } = useListQuery();

/*
 * The field writes the URL on every keystroke, with `replace` rather than
 * `push`.
 *
 * `replace` is the whole trick: the state still lives in the URL — reload it,
 * share it, and the search is there — but twenty keystrokes do not become
 * twenty entries in the reader's Back button.
 *
 * There is no debounce, and that is a correction rather than an omission. The
 * page filters on `q`, which is the URL; debouncing the write therefore
 * debounces the *results*, so a 200 ms timer does not "let the URL catch up"
 * as it appears to — it makes the list lag the reader's typing by 200 ms.
 * Measured on `avelino/awesome-go`, the worst case in the corpus, a keystroke
 * reaches paint in ~30 ms across 2,829 rows, so there is nothing to protect.
 *
 * The watch back onto `q` is what makes Back, a shared link and a reload land
 * in a field that agrees with the page.
 */
const text = ref(q.value);
watch(q, (v) => {
  if (needle(v) !== needle(text.value)) text.value = v;
});
watch(text, (v) => replace({ q: v }));

function clear() {
  text.value = "";
}

/*
 * Changing the order abandons the section: the heading is a position in the
 * curator's document, and there is no such position once the rows are ranked.
 * Leaving `?cat=` in the URL would leave the rail marking a heading the reader
 * can no longer be inside of.
 */
function choose(s: Sort) {
  set({ sort: s, cat: s === "curator" ? undefined : "" });
}

const SORT_TITLE: Record<Sort, string> = {
  curator: "the order the curator wrote the README in",
  stars:
    "most GitHub stars first; rows that cannot be starred keep the curator’s order at the foot",
  trending:
    "accelerating hardest against its own past over the chosen window, not merely biggest; unmeasured rows last",
  activity: "most recently pushed first",
};

const unranked = computed(() => props.shown - props.rankable);
</script>

<template>
  <div class="ctl">
    <div class="ctl-g">
      <span class="kicker ctl-l">order</span>
      <button
        v-for="s in SORTS"
        :key="s"
        class="opt"
        type="button"
        :class="{ on: sort === s }"
        :aria-pressed="sort === s"
        :title="SORT_TITLE[s]"
        @click="choose(s)"
      >
        {{ s }}
      </button>
    </div>

    <div v-if="sort === 'trending'" class="ctl-g">
      <span class="kicker ctl-l">window</span>
      <button
        v-for="p in PERIODS"
        :key="p"
        class="opt"
        type="button"
        :class="{ on: period === p }"
        :aria-pressed="period === p"
        @click="set({ period: p })"
      >
        {{ p }}
      </button>
    </div>

    <div class="ctl-g ctl-q">
      <label class="kicker ctl-l" for="q" aria-label="find">
        <span class="px" style="--px: var(--px-search)" />
      </label>
      <input
        id="q"
        v-model="text"
        class="q"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="name, owner, note, language"
      />
      <button
        v-if="text"
        class="opt ctl-x"
        type="button"
        aria-label="clear the search"
        title="clear the search"
        @click="clear"
      >
        <span class="px" style="--px: var(--px-close)" />
      </button>
    </div>

    <p class="ctl-n kicker">
      <template v-if="shown !== total"
        >{{ shown.toLocaleString("en-US") }} of
        {{ total.toLocaleString("en-US") }}</template
      >
      <template v-else>{{ total.toLocaleString("en-US") }} entries</template>
      <!--
        Said plainly and only when it is true. "1,204 unranked" under a stars
        sort is the list's link half declaring itself; under trending on a list
        the backfill has not reached it is the whole list, and the reader is
        entitled to know before they read the order as a ranking.
      -->
      <span v-if="sort !== 'curator' && unranked > 0" class="ctl-u">
        · {{ unranked.toLocaleString("en-US") }} unranked
      </span>
    </p>
  </div>
</template>
