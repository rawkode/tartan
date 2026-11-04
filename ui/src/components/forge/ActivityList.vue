<script setup lang="ts">
import { computed } from 'vue';
import { css } from '../../../styled-system/css';
import { line, text } from '../../../styled-system/recipes';
import { Badge } from '../../design-system';
import type { ForgeNode } from '../../data/forge';
import { eventsAt } from '../../data/store';

const props = defineProps<{ node: ForgeNode; scope: string }>();

const activity = computed(() => eventsAt(props.node, props.scope, 24));

const rows = line();
const page = css({ display: 'flex', flexDirection: 'column', paddingInline: '7', paddingBlockStart: '3.5', paddingBlockEnd: '12' });
const monoMuted = text({ mono: true, tone: 'muted', size: 'xs' });
</script>

<template>
  <div :class="page">
    <div v-for="event in activity" :key="event.sha" :class="rows.root">
      <span :class="monoMuted" :style="{ flex: '0 0 4ch' }">{{ event.age }}</span>
      <span :class="monoMuted">{{ event.sha }}</span>
      <span :class="rows.title">{{ event.subject }}</span>
      <span v-if="event.place" :class="monoMuted" :style="{ overflowWrap: 'anywhere' }">{{ event.place }}</span>
      <span :class="rows.chips"><Badge v-for="project in event.chips" :key="project">{{ project }}</Badge></span>
    </div>
    <p v-if="!activity.length" :class="rows.empty">Nothing has happened here yet.</p>
  </div>
</template>
