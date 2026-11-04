<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { line, shell, table, terminal, text, ticks as ticksRecipe, diff } from '../../../styled-system/recipes';
import { Badge, Button, Segmented, Status } from '../../design-system';
import { commitsFor, named, plural, urlFor, type ForgeNode } from '../../data/forge';
import { changesAt, openIssues, store } from '../../data/store';
import { cueFile, type Settings } from '../../data/settings';

const props = defineProps<{ node: ForgeNode; scope: string }>();

const commits = commitsFor(props.scope);
const selected = ref(Math.max(0, commits.length - 3));
const cloneMode = ref('repo');

// The example for a sparse checkout: the first project that depends on another.
const example = computed(() => props.node.children.find((k) => k.deps.length) ?? props.node.children[0]);

const command = computed(() =>
  cloneMode.value === 'repo' ? `git clone forge:${props.scope}` : `forge clone ${props.scope}:${example.value.name}`,
);
const note = computed(() =>
  cloneMode.value === 'repo'
    ? `All ${plural(named(props.node), 'project')} and the root.`
    : `Sparse checkout of one project and what it depends on. Here, ${[example.value.name, ...example.value.deps].join(' and ')}.`,
);

const rows = computed(() =>
  props.node.children.map((k) => {
    const addr = `${props.scope}:${k.name}`;
    return {
      node: k,
      addr,
      release: k.releases?.[0]?.[0] ?? '—',
      issues: openIssues(addr).length,
      changes: changesAt(k, addr).length,
    };
  }),
);

const commit = computed(() => commits[selected.value]);
const cue = computed(() => cueFile(props.node, props.scope, store.settingsSaved as Settings));
const headSha = commits[commits.length - 1].sha;

const page = shell();
const grid = table({ columns: 'projects' });
const tick = ticksRecipe();
const rule = line();
const file = diff();
const muted = text({ tone: 'muted', size: 'sm' });
const mono = text({ mono: true, size: 'xs' });
const monoMuted = text({ mono: true, tone: 'muted', size: 'xs' });
const clone = css({ display: 'flex', flexDirection: 'column', gap: '2', maxWidth: '[620px]' });
const commitBar = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '3.5', rowGap: '2', paddingBlock: '2', borderBlockEnd: 'rule' });
const stepper = css({ display: 'flex', gap: '1' });
const cueBlock = css({ display: 'flex', flexDirection: 'column', gap: '2.5', maxWidth: '[720px]' });
const cueSource = css({ margin: '0', padding: '3', fontFamily: 'academy-mono', fontSize: 'xs', lineHeight: 'academy-reading', overflowX: 'auto', tabSize: '2' });
</script>

<template>
  <div :class="page.pad">
    <div :class="clone">
      <Segmented
        v-model="cloneMode"
        label="Clone"
        :items="[{ label: 'Whole repo', value: 'repo' }, { label: 'One project', value: 'project' }]"
      />
      <code :class="terminal()">{{ command }}</code>
      <span :class="muted">{{ note }}</span>
    </div>

    <section>
      <p :class="monoMuted" :style="{ paddingBlockEnd: '12px' }">Read from .forge/projects.cue at {{ headSha }}</p>
      <div :class="grid.scroll">
        <div :class="grid.head">
          <span :style="{ paddingInlineStart: '10px' }">Project</span>
          <span>Release</span>
          <span>Issues</span>
          <span>Changes</span>
          <span>CI</span>
          <span>Depends</span>
          <span>Last {{ commits.length }} commits</span>
        </div>
        <a v-for="row in rows" :key="row.addr" :href="urlFor(row.addr)" :class="grid.row">
          <span :class="grid.cell">
            <span :class="grid.name">{{ row.node.name }}</span>
            <span :class="grid.sub">{{ row.node.path }}</span>
          </span>
          <span :class="grid.num">{{ row.release }}</span>
          <span :class="grid.num">{{ row.issues }}</span>
          <span :class="grid.num">{{ row.changes }}</span>
          <span><Status v-if="row.node.fail" state="fail">Failing</Status><Status v-else state="pass">Pass</Status></span>
          <span :class="monoMuted">{{ row.node.deps.join(', ') || '—' }}</span>
          <span aria-hidden="true" :class="tick.root">
            <span v-for="(c, i) in commits" :key="c.sha" :class="tick.cell" @mouseenter="selected = i">
              <span :class="tick.bar" :data-on="c.projects.includes(row.node.name) ? '' : undefined" :data-selected="i === selected ? '' : undefined"></span>
            </span>
          </span>
        </a>
      </div>
      <div :class="commitBar">
        <span :class="muted">Commit</span>
        <span :class="mono">{{ commit.sha }}</span>
        <span :class="rule.title">{{ commit.subject }}</span>
        <span :class="rule.chips"><Badge v-for="project in commit.projects" :key="project">{{ project }}</Badge></span>
        <span :class="monoMuted">{{ commit.age }}</span>
        <div :class="stepper">
          <Button type="button" aria-label="Older commit" :disabled="selected === 0" @click="selected = Math.max(0, selected - 1)">‹</Button>
          <Button type="button" aria-label="Newer commit" :disabled="selected === commits.length - 1" @click="selected = Math.min(commits.length - 1, selected + 1)">›</Button>
        </div>
      </div>
    </section>

    <section :class="cueBlock">
      <div :class="file.root">
        <div :class="file.file">.forge/projects.cue</div>
        <pre :class="cueSource">{{ cue }}</pre>
      </div>
      <p :class="muted">To add, rename or remove a project, commit a change to this file. The forge re-reads it on every push to main.</p>
    </section>
  </div>
</template>
