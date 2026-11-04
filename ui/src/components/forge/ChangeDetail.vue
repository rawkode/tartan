<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { button, detail, diff, heading, table, text } from '../../../styled-system/recipes';
import { Button, Segmented, Status } from '../../design-system';
import { diffFor, short, urlFor, type Change, type ForgeNode } from '../../data/forge';
import { issueUrl, mergeChange, store, toggleReviewed } from '../../data/store';

const props = defineProps<{ change: Change; trail: ForgeNode[]; scope: string }>();

const repo = computed(() => props.trail[props.trail.length - 1]);
const merged = computed(() => !!store.merged[props.change.id]);
const edited = computed(() => (props.change.touches.length ? props.change.touches : [repo.value.name]));
const reviewed = computed(() => store.reviewed[props.change.id] ?? (props.change.rich ? { core: true } : ({} as Record<string, boolean>)));
const failing = computed(() => (store.rerun[props.change.id] ? [] : props.change.fail));
const diffData = computed(() => diffFor(props.change.id));

const focus = ref('all');

const lineCount = (key: string) => {
  const found = diffData.value.find((d) => d.key === key);
  if (!found) return '—';
  return `+${found.lines.filter((l) => l[0] === '+').length} −${found.lines.filter((l) => l[0] === '-').length}`;
};

const closing = computed(() => (props.change.closes ? store.issues.find((i) => i.id === props.change.closes) : undefined));
const closesHere = computed(() => !!closing.value && closing.value.where.split(':')[0] === props.change.repo);
const closesLabel = computed(() => (closing.value ? short(closing.value.where, closing.value.n) : ''));

const projectUrl = (name: string) => (repo.value.children.length ? urlFor(`${props.scope}:${name}`) : urlFor(props.scope));

const ledger = computed(() => [
  ...edited.value.map((key) => {
    const kid = repo.value.children.find((k) => k.name === key);
    const bump = props.change.bumps?.[key];
    return {
      key,
      path: kid?.path ?? '.',
      role: 'Edited',
      strong: true,
      lines: lineCount(key),
      closes: closing.value && closesHere.value && closing.value.where.split(':')[1] === key ? closesLabel.value : '—',
      failing: failing.value.includes(key),
      version: bump ? `${bump[0]} → ${bump[1]}` : '—',
      canReview: true,
    };
  }),
  ...repo.value.children
    .filter((k) => !edited.value.includes(k.name) && k.deps.some((d) => edited.value.includes(d)))
    .map((k) => ({
      key: k.name,
      path: k.path,
      role: `Rebuilt via ${k.deps.filter((d) => edited.value.includes(d)).join(', ')}`,
      strong: false,
      lines: '—',
      closes: '—',
      failing: false,
      version: '—',
      canReview: false,
    })),
]);

const left = computed(() => edited.value.filter((key) => !reviewed.value[key]));
const blocked = computed(() => failing.value.length > 0 || left.value.length > 0);

const blockers = computed(() => {
  if (merged.value) return [{ text: 'Merged into main', state: 'merged' as const }];
  const out: { text: string; state: 'fail' | 'neutral' | 'pass' }[] = [];
  if (failing.value.length) out.push({ text: `${failing.value.join(', ')} tests failing`, state: 'fail' });
  if (left.value.length) out.push({ text: `Still to review: ${left.value.join(', ')}`, state: 'neutral' });
  return out.length ? out : [{ text: 'All projects reviewed and passing', state: 'pass' as const }];
});

const tags = computed(() =>
  props.change.bumps ? Object.entries(props.change.bumps).map(([key, bump]) => `${key}/v${bump[1]}`).join(', ') : '',
);

const merge = () => {
  if (blocked.value || merged.value) return;
  mergeChange(props.change, closesHere.value ? closing.value : undefined);
};

const rerun = () => {
  store.rerun[props.change.id] = true;
};

const visibleDiffs = computed(() => diffData.value.filter((d) => focus.value === 'all' || focus.value === d.key));
const focusItems = computed(() => [{ label: 'All projects', value: 'all' }, ...diffData.value.map((d) => ({ label: d.key, value: d.key }))]);

const page = detail();
const grid = table({ columns: 'change' });
const code = diff();
const muted = text({ tone: 'muted', size: 'sm' });
const monoMuted = text({ mono: true, tone: 'muted', size: 'xs' });
const headRow = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: '10', rowGap: '5', paddingInline: '7', paddingBlockStart: '3', paddingBlockEnd: '6' });
const headMain = css({ flex: '[999 1 460px]', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2.5' });
const headSide = css({ flex: '[1 1 300px]', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '3' });
const blockList = css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1' });
const outcome = css({ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: '3', rowGap: '1.5', paddingBlockStart: '2.5', borderBlockStart: 'hairline', '& dd': { fontFamily: 'academy-mono', fontSize: 'xs', lineHeight: 'academy-reading', overflowWrap: 'anywhere' } });
const scroller = css({ paddingInline: '7' });
const diffs = css({ display: 'flex', flexDirection: 'column', gap: '7', paddingInline: '7', paddingBlockStart: '6', paddingBlockEnd: '12' });
const diffSection = css({ display: 'flex', flexDirection: 'column', gap: '2.5' });
const diffHead = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '3.5', rowGap: '1', paddingBlockEnd: '2', borderBlockEnd: 'rule' });
const diffName = heading({ size: 'md' });
const pushRight = css({ marginInlineStart: 'auto' });
const failBox = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '5', rowGap: '3', padding: '3.5', backgroundColor: 'academy.ink', borderRadius: 'academy-s', color: 'academy.inkText' });
const failText = css({ flex: '[999 1 340px]', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '1', fontFamily: 'academy-mono', fontSize: 'xs', lineHeight: 'academy-reading', overflowWrap: 'anywhere' });
const failDim = css({ color: 'academy.inkTextSoft' });
const empty = css({ paddingInline: '7', paddingBlockStart: '5', paddingBlockEnd: '12', color: 'academy.textMuted' });
const inkFail = css({ color: 'academy.inkAccent', fontWeight: 'bold' });
</script>

<template>
  <section :class="headRow">
    <div :class="headMain">
      <span :class="muted">Change !{{ change.n }} in {{ repo.name }} · {{ merged ? 'Merged' : 'Open' }}</span>
      <h1 :class="page.title">{{ change.title }}</h1>
      <span :class="monoMuted">{{ change.branch }} → main</span>
    </div>
    <div :class="headSide">
      <button
        type="button"
        :class="[button({ variant: 'solid' }), 'owner-only']"
        :disabled="blocked || merged"
        @click="merge"
      >{{ merged ? 'Merged' : 'Merge' }}</button>
      <div :class="blockList">
        <Status v-for="item in blockers" :key="item.text" :state="item.state">{{ item.text }}</Status>
      </div>
      <dl v-if="tags || closesHere" :class="outcome">
        <template v-if="tags">
          <dt :class="muted">{{ merged ? 'Tagged' : 'Tags' }}</dt>
          <dd>{{ tags }}</dd>
        </template>
        <template v-if="closesHere">
          <dt :class="muted">{{ merged ? 'Closed' : 'Closes' }}</dt>
          <dd><a :href="issueUrl(closing!)" :class="page.ref">{{ closesLabel }}</a></dd>
        </template>
      </dl>
    </div>
  </section>

  <div :class="scroller">
    <div :class="grid.scroll">
      <div role="table" aria-label="Projects in this change">
        <div role="row" :class="grid.head">
          <span role="columnheader" :style="{ paddingInlineStart: '10px' }">Project</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">Lines</span>
          <span role="columnheader">Closes</span>
          <span role="columnheader">CI</span>
          <span role="columnheader">Version</span>
          <span role="columnheader">Review</span>
        </div>
        <div v-for="row in ledger" :key="row.key" role="row" :class="grid.row">
          <span role="cell" :class="grid.cell">
            <a :href="projectUrl(row.key)" :class="grid.name">{{ row.key }}</a>
            <span :class="grid.sub">{{ row.path }}</span>
          </span>
          <span role="cell" :style="{ fontSize: '0.875rem', fontWeight: row.strong ? 650 : 400 }">{{ row.role }}</span>
          <span role="cell" :class="grid.num">{{ row.lines }}</span>
          <span role="cell" :class="grid.num">{{ row.closes }}</span>
          <span role="cell"><Status v-if="row.failing" state="fail">Fail</Status><Status v-else state="pass">Pass</Status></span>
          <span role="cell" :class="grid.num">{{ row.version }}</span>
          <span role="cell">
            <template v-if="row.canReview">
              <Button class="owner-only" type="button" size="sm" :pressed="!!reviewed[row.key]" :disabled="merged" @click="toggleReviewed(change, row.key)">{{ reviewed[row.key] ? 'Reviewed' : 'Mark reviewed' }}</Button>
              <span :class="[muted, 'not-owner']">{{ reviewed[row.key] ? 'Reviewed' : 'Not reviewed' }}</span>
            </template>
            <span v-else :class="muted">No edits</span>
          </span>
        </div>
      </div>
    </div>
  </div>

  <div v-if="diffData.length" :class="diffs">
    <Segmented v-model="focus" label="Diff" :items="focusItems" />
    <section v-for="d in visibleDiffs" :key="d.key" :aria-label="`${d.key} diff`" :class="diffSection">
      <div :class="diffHead">
        <h2 :class="diffName">{{ d.key }}</h2>
        <span :class="monoMuted">{{ lineCount(d.key) }}</span>
        <span :class="[pushRight, 'owner-only']">
          <Button type="button" size="sm" :pressed="!!reviewed[d.key]" :disabled="merged" @click="toggleReviewed(change, d.key)">{{ reviewed[d.key] ? 'Reviewed' : 'Mark reviewed' }}</Button>
        </span>
      </div>
      <div v-if="failing.includes(d.key)" :class="failBox">
        <div :class="failText">
          <span><span :class="inkFail">Failing</span> definition::goto_definition_across_members</span>
          <span :class="failDim">timed out after 5s waiting for workspace index</span>
        </div>
        <Button class="owner-only" variant="ink" type="button" @click="rerun">Re-run {{ d.key }}</Button>
      </div>
      <div :class="code.root">
        <div :class="code.file">{{ d.file }}</div>
        <div :class="code.lines">
          <div v-for="(l, i) in d.lines" :key="i" :class="code.line" :data-sign="l[0] === '+' || l[0] === '-' ? l[0] : undefined">
            <span :class="code.sign">{{ l[0] === '+' ? '+' : l[0] === '-' ? '−' : ' ' }}</span>
            <span :class="code.text">{{ l.slice(1) }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
  <p v-else :class="empty">This sample change has no diff to show.</p>
</template>
