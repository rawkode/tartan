<script setup lang="ts">
import { computed } from 'vue';
import { line } from '../../../styled-system/recipes';
import { Badge, Status } from '../../design-system';
import { changeLabel, type Change, type ForgeNode } from '../../data/forge';
import { changeUrl } from '../../data/store';

const props = defineProps<{ change: Change; node: ForgeNode; scope: string; width: number }>();

const here = computed(() => (props.node.kind === 'project' ? props.node.name : ''));
const chips = computed(() => props.change.touches.filter((p) => p !== here.value));

const styles = line();
</script>

<template>
  <a :href="changeUrl(change)" :class="styles.root">
    <span :class="styles.id" :style="{ flex: `0 0 ${width + 1}ch` }">{{ changeLabel(scope, change) }}</span>
    <span :class="styles.title">{{ change.title }}</span>
    <span v-if="chips.length" :class="styles.chips">
      <template v-if="here">also</template>
      <Badge v-for="project in chips" :key="project">{{ project }}</Badge>
    </span>
    <Status v-if="change.fail.length" state="fail">Failing</Status>
    <Status v-else state="pass">Passing</Status>
    <span :class="styles.age">{{ change.age }}</span>
  </a>
</template>
