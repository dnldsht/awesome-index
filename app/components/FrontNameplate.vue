<script setup lang="ts">
/**
 * The nameplate.
 *
 * A newspaper puts its date under its name because the date is the claim: this
 * is today's paper, not the paper. It is the one thing on this site that says
 * the page is worth returning to, so it is set as large as the totals beside
 * it and not hidden in a colophon. Null until the JSON lands — the figures
 * render as an em dash rather than as zeros, because zero lists is a fact and
 * "not loaded yet" is not.
 */
const props = defineProps<{
  lists: number;
  entries: number;
  repos: number;
  generatedAt: number | null;
}>();

const n = new Intl.NumberFormat("en-US");
const num = (value: number) => (value ? n.format(value) : "—");

const dated = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const when = computed(() =>
  props.generatedAt ? dated.format(new Date(props.generatedAt * 1000)) : "",
);
</script>

<template>
  <header class="np">
    <div class="np-line">
      <h1 class="np-title">awesome index</h1>
      <a
        class="btn src-link"
        href="https://github.com/dnldsht/awesome-index"
        rel="noopener"
        aria-label="source on GitHub"
        title="source on GitHub"
        ><span class="px" style="--px: var(--px-github)"
      /></a>
      <ThemeToggle />
    </div>
    <p class="np-deck">
      <span class="mono">{{ num(lists) }}</span> curated lists ·
      <span class="mono">{{ num(entries) }}</span> entries ·
      <span class="mono">{{ num(repos) }}</span> repositories
    </p>
    <p v-if="when" class="np-date kicker">{{ when }}</p>
  </header>
</template>

<style scoped>
.np {
  padding-block: 1.7rem 0.65rem;
}

.np-line {
  display: flex;
  align-items: baseline;
  gap: 1rem;
}

.np-title {
  font-size: var(--t-mast);
  font-weight: var(--w-mast);
  letter-spacing: -0.024em;
  line-height: 1;
  margin: 0;
  margin-right: auto;
}

.np-deck {
  font-size: var(--t-lede);
  color: var(--ink-2);
  margin: 0.55rem 0 0;
}

.np-deck .mono {
  font-size: var(--t-note);
  color: var(--ink);
}

.np-date {
  margin: 0.15rem 0 0;
}
</style>
