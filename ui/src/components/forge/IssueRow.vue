<script setup lang="ts">
import { computed } from 'vue';
import { line } from '../../../styled-system/recipes';
import { Badge } from '../../design-system';
import { rel, under, type Issue } from '../../data/forge';
import { issueUrl } from '../../data/store';

const props = defineProps<{ issue: Issue; scope: string; grouped?: boolean; width?: number; stacked?: boolean }>();

const where = computed(() => (props.grouped ? '' : rel(props.scope, props.issue.where)));
const also = computed(() => !under(props.issue.where, props.scope));

const styles = line();
</script>

<template>
  <a :href="issueUrl(issue)" :class="styles.root">
    <svg v-if="!stacked" :class="styles.icon" :data-closed="issue.closed ? '' : undefined" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" :aria-label="issue.closed ? 'Closed' : 'Open'" role="img">
      <circle cx="8" cy="8" r="6.2" />
    </svg>
    <span :class="styles.id" :data-full="stacked ? '' : undefined" :style="stacked ? undefined : { flex: `0 0 ${(width ?? 0) + 1}ch` }"><span :class="styles.where">{{ where }}</span>#{{ issue.n }}</span>
    <span :class="styles.title">{{ issue.title }}</span>
    <span v-if="also" :class="styles.chips">Also affects this</span>
    <Badge v-if="!stacked">{{ issue.tag }}</Badge>
    <span :class="styles.age">{{ issue.age }}</span>
  </a>
</template>
