<script setup lang="ts">
/*
 * Sun or moon by the *resolved* theme, not the stored one.
 *
 * The button cycles auto → light → dark, and the icon can only show two states,
 * so it shows what the reader is actually looking at while `title` and
 * `aria-label` carry the third — including whether the current look is a choice
 * or the system's. An icon that lied about which of three states it was in
 * would be worse than the word it replaced.
 */
const { theme, dark, toggle } = useTheme();

const label = computed(() =>
  theme.value === "auto" ? `auto (${dark.value ? "dark" : "light"})` : theme.value,
);
</script>

<template>
  <button
    class="btn theme-b"
    type="button"
    :aria-label="`switch theme — currently ${label}`"
    :title="`theme: ${label}`"
    @click="toggle()"
  >
    <span
      class="px"
      :style="{ '--px': dark ? 'var(--px-moon)' : 'var(--px-sun)' }"
    />
  </button>
</template>
