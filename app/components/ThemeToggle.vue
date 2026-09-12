<script setup lang="ts">
const { theme, toggle } = useTheme();
</script>

<template>
  <button
    class="btn"
    type="button"
    :aria-label="`switch theme (currently ${theme})`"
    @click="toggle()"
  >
    {{ theme === "auto" ? "theme" : theme }}
  </button>
</template>
