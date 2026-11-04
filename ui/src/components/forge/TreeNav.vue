<script setup lang="ts">
import { tree } from '../../../styled-system/recipes';
import { Button } from '../../design-system';
import { urlFor, type ForgeNode, type Route } from '../../data/forge';
import { openIssues, store } from '../../data/store';
import TreeLevel from './TreeLevel.vue';

defineProps<{ scope: string; route: Route }>();

const styles = tree();
</script>

<template>
  <nav aria-label="Tree">
    <div :class="styles.head"><span>Tree</span><span :style="{ marginInlineEnd: '2.75rem' }">Issues</span></div>
    <div :class="styles.row" :data-current="scope === '' && !route.detail ? '' : undefined">
      <a href="/" :aria-current="scope === '' && !route.detail ? 'page' : undefined" :class="styles.link">
        <span :class="styles.text"><span :class="styles.name">~</span></span>
        <span :class="styles.count" data-dim>{{ openIssues('').length }}</span>
      </a>
      <span :class="styles.spacer"></span>
    </div>
    <TreeLevel :node="store.tree as ForgeNode" addr="" :scope="scope" :route="route" />
    <div v-if="scope === ''" :class="[styles.actions, 'owner-only']">
      <Button :href="urlFor('', 'new/group')">New group</Button>
      <Button :href="urlFor('', 'new/repo')">New repo</Button>
    </div>
    <p :class="styles.foot"><a href="/design-system">Design system</a></p>
  </nav>
</template>
