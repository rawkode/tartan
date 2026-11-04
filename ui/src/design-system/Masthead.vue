<script setup lang="ts">
import { masthead } from '../../styled-system/recipes';

defineProps<{ title: string; description?: string }>();

const styles = masthead();
</script>

<template>
  <header :class="styles.root">
    <div :class="styles.copy">
      <h1 :class="styles.title">{{ title }}</h1>
      <p v-if="description || $slots.description" :class="styles.lede">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
  </header>
</template>
