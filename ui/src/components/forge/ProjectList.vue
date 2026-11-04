<script setup lang="ts">
import { computed } from 'vue';
import { css } from '../../../styled-system/css';
import { line, table } from '../../../styled-system/recipes';
import { Status } from '../../design-system';
import { projectsUnder, rel, urlFor, type ForgeNode } from '../../data/forge';
import { changesAt, openIssues } from '../../data/store';

const props = defineProps<{ trail: ForgeNode[]; scope: string }>();

const rows = computed(() =>
  projectsUnder(props.trail[props.trail.length - 1], props.trail.slice(0, -1)).map(({ addr, node }) => ({
    addr,
    node,
    // Long addresses wrap after a separator, not in the middle of a name.
    parts: rel(props.scope, addr).split(/(?<=[/:])/),
    release: node.releases?.[0]?.[0] ?? '—',
    issues: openIssues(addr).length,
    changes: changesAt(node, addr).length,
  })),
);

const grid = table({ columns: 'list' });
const lines = line();
const page = css({ display: 'flex', flexDirection: 'column', paddingInline: '7', paddingBlockStart: '3.5', paddingBlockEnd: '12' });
</script>

<template>
  <div :class="page">
    <div v-if="rows.length" :class="grid.scroll">
      <div :class="grid.head">
        <span :style="{ paddingInlineStart: '10px' }">Project</span>
        <span>Release</span>
        <span>Issues</span>
        <span>Changes</span>
        <span>CI</span>
      </div>
      <a v-for="row in rows" :key="row.addr" :href="urlFor(row.addr)" :class="grid.row">
        <span :class="grid.cell">
          <span :class="grid.name"><template v-for="(part, i) in row.parts" :key="i">{{ part }}<wbr /></template></span>
          <span :class="grid.sub">{{ row.node.path ?? 'Whole repo' }}</span>
        </span>
        <span :class="grid.num">{{ row.release }}</span>
        <span :class="grid.num">{{ row.issues }}</span>
        <span :class="grid.num">{{ row.changes }}</span>
        <span>
          <template v-if="row.node.empty">—</template>
          <Status v-else-if="row.node.fail" state="fail">Failing</Status>
          <Status v-else state="pass">Pass</Status>
        </span>
      </a>
    </div>
    <p v-else :class="lines.empty">No projects here yet.</p>
  </div>
</template>
