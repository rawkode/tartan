<script setup lang="ts">
import { computed } from 'vue';
import { css } from '../../../styled-system/css';
import { line } from '../../../styled-system/recipes';
import { Button } from '../../design-system';
import { changeLabel, urlFor, type Change, type ForgeNode } from '../../data/forge';
import { changesAt } from '../../data/store';
import ChangeRow from './ChangeRow.vue';

const props = defineProps<{ node: ForgeNode; scope: string }>();

const list = computed(() => changesAt(props.node, props.scope) as Change[]);
const width = computed(() => list.value.reduce((max, c) => Math.max(max, changeLabel(props.scope, c).length), 0));

const rows = line();
const page = css({ display: 'flex', flexDirection: 'column', paddingInline: '7', paddingBlockStart: '3.5', paddingBlockEnd: '12' });
const bar = css({ display: 'flex', justifyContent: 'flex-end', paddingBlockEnd: '3', borderBlockEnd: 'rule', _empty: { display: 'none' } });
</script>

<template>
  <div :class="page">
    <div v-if="node.kind !== 'group'" :class="bar">
      <Button class="member-only" variant="solid" :href="urlFor(scope, 'changes/new')">New change</Button>
      <Button class="anon-only" href="/register">Register to contribute</Button>
    </div>
    <ChangeRow v-for="change in list" :key="change.id" :change="change" :node="node" :scope="scope" :width="width" />
    <p v-if="!list.length" :class="rows.empty">No open changes here.</p>
  </div>
</template>
