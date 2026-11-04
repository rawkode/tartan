<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { field, matrix, panel, terminal, text } from '../../../styled-system/recipes';
import { Button } from '../../design-system';
import { named, plural, rel, repoCount, under, urlFor, type ForgeNode } from '../../data/forge';
import { discardSettings, saveSettings, store, updateSettings } from '../../data/store';
import {
  cueLine,
  levelsOf,
  settingLists,
  settingValues,
  walkList,
  walkValue,
  type ListMeta,
  type ListState,
  type ListStep,
  type Settings,
  type ValueMeta,
  type ValueState,
  type ValueStep,
} from '../../data/settings';

const props = defineProps<{ trail: ForgeNode[]; scope: string }>();

const openRow = ref<string | null>('merge');
const entry = ref('');

const saved = computed(() => store.settingsSaved as Settings);
const draft = computed(() => store.settingsDraft as Settings);
const levels = computed(() => levelsOf(props.trail));
const names = computed(() => levels.value.map((l) => l.node.name));
const lastIndex = computed(() => levels.value.length - 1);
const last = computed(() => props.trail[props.trail.length - 1]);
const isProject = computed(() => last.value.kind === 'project');

const columns = computed(() => `170px repeat(${levels.value.length}, minmax(0, 1fr))`);
const minWidth = computed(() => `${170 + levels.value.length * 110}px`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const changed = computed(() => Object.keys(draft.value).filter((key) => !same(draft.value[key], saved.value[key])).length);

const columnHeads = computed(() =>
  levels.value.map((level, i) => ({
    name: level.node.name,
    addr: level.addr,
    sep: i === 0 ? '' : level.node.kind === 'project' ? ':' : '/',
    current: i === lastIndex.value,
    type: level.node.kind === 'project' ? 'Project' : level.node.kind === 'repo' ? (level.node.children.length ? 'Monorepo' : 'Repo') : i === 0 ? 'Root' : 'Group',
  })),
);

type Cell = {
  here: boolean;
  na: boolean;
  title: string;
  wire?: { left: number; right: number; height: number };
  chip?: { text: string; mode: 'solid' | 'hollow' | 'ignored'; pending: boolean; locked: boolean };
};

const valueCells = (meta: ValueMeta, walked: ValueStep[]): Cell[] => {
  const state = draft.value[meta.key] as ValueState;
  const before = saved.value[meta.key] as ValueState;
  let limit = lastIndex.value;
  while (limit > 0 && walked[limit].na) limit -= 1;
  return walked.map((step, i) => {
    const here = i === lastIndex.value;
    if (step.na) return { here, na: true, title: 'Not available here' };
    const addr = levels.value[i].addr;
    const pending = !same(state.set[addr], before.set[addr]) || (state.lock === addr) !== (before.lock === addr);
    let chip: Cell['chip'];
    let title = '';
    if (step.has && step.ignored) {
      chip = { text: step.own!, mode: 'ignored', pending, locked: false };
      title = `Ignored: locked at ${names.value[step.lockedAt!]}`;
    } else if (step.has) {
      chip = { text: step.own!, mode: 'solid', pending, locked: step.lockedAt !== null };
    } else if (here) {
      chip = { text: step.value, mode: 'hollow', pending, locked: step.lockedAt !== null };
      title = `Inherited from ${names.value[step.origin]}`;
    }
    return {
      here,
      na: false,
      title,
      chip,
      wire: limit > 0 ? { left: i === 0 ? 50 : 0, right: i === limit ? 50 : 0, height: step.lockedAt !== null ? 4 : 2 } : undefined,
    };
  });
};

const listCells = (meta: ListMeta, walked: ListStep[]): Cell[] => {
  const state = draft.value[meta.key] as ListState;
  const before = saved.value[meta.key] as ListState;
  return walked.map((step, i) => {
    const here = i === lastIndex.value;
    const addr = levels.value[i].addr;
    const pending = !same(state.add[addr], before.add[addr]) || !same(state.drop[addr], before.drop[addr]);
    let chipText = '';
    if (here) chipText = plural(step.count, meta.noun);
    else if (step.has) chipText = [step.add.length && `+${step.add.length}`, step.drop.length && `−${step.drop.length}`].filter(Boolean).join(' ');
    return {
      here,
      na: false,
      title: '',
      chip: chipText ? { text: chipText, mode: step.has ? ('solid' as const) : ('hollow' as const), pending, locked: false } : undefined,
      wire: lastIndex.value > 0 ? { left: i === 0 ? 50 : 0, right: i === lastIndex.value ? 50 : 0, height: Math.min(7, Math.max(2, step.count)) } : undefined,
    };
  });
};

const reach = (meta?: ValueMeta) => {
  const node = last.value;
  if (node.kind === 'group') return `Reaches ${props.trail.length === 1 ? 'all ' : ''}${plural(repoCount(node), 'repo')}.`;
  if (node.kind === 'project') return 'Applies to this project only.';
  if (!node.children.length) return 'Applies to this repo.';
  if (meta?.repoOnly) return 'Applies to the whole repo.';
  return `Reaches all ${plural(named(node), 'project')} and the root.`;
};

const valueRows = computed(() =>
  settingValues.map((meta) => {
    const walked = walkValue(meta, draft.value[meta.key] as ValueState, levels.value);
    return { kind: 'value' as const, meta, walked, cells: valueCells(meta, walked) };
  }),
);

const listRows = computed(() =>
  settingLists.map((meta) => {
    const walked = walkList(draft.value[meta.key] as ListState, levels.value);
    return { kind: 'list' as const, meta, walked, cells: listCells(meta, walked) };
  }),
);

const valueEditor = (meta: ValueMeta, walked: ValueStep[]) => {
  const step = walked[walked.length - 1];
  if (step.na) return { effective: '—', trace: meta.why, options: [], canLock: false, lockedHere: false };
  const here = walked.length - 1;
  const state = draft.value[meta.key] as ValueState;
  const lockedAbove = step.lockedAt !== null && step.lockedAt < here;
  const lockedHere = state.lock === props.scope && step.has && !step.ignored;

  // A project's settings live in the repo, so this level is read-only here.
  if (isProject.value) {
    const trace = lockedAbove
      ? `Locked at ${names.value[step.lockedAt!]}. Nothing below can change it.`
      : step.has && !step.ignored
        ? 'Set in .forge/projects.cue.'
        : `Inherited from ${names.value[step.origin]}. To override it, set it in .forge/projects.cue.`;
    return {
      effective: step.value,
      trace,
      options: [],
      canLock: false,
      lockedHere: false,
      cue: lockedAbove ? undefined : cueLine(last.value.name, meta.key, step.value),
    };
  }

  let trace: string;
  if (lockedAbove) trace = `Locked at ${names.value[step.lockedAt!]}. Nothing below can change it.`;
  else if (lockedHere) trace = 'Set and locked here. Nothing below can change it.';
  else if (step.has && here === 0) trace = 'Set here at the root. Everything starts from this value.';
  else if (step.has) trace = `Set here. Replaces ${step.prevValue} from ${names.value[step.prevOrigin]}.`;
  else trace = `Inherited from ${names.value[step.origin]}.`;

  const options = lockedAbove
    ? []
    : [
        ...(here > 0 ? [{ label: `Inherit ${step.prevValue} from ${names.value[step.prevOrigin]}`, value: null as string | null, on: !step.has }] : []),
        ...meta.options.map((value) => ({ label: value, value: value as string | null, on: step.has && step.own === value })),
      ];

  const below = Object.keys(state.set)
    .filter((a) => a !== props.scope && under(a, props.scope))
    .map((a) => rel(props.scope, a));
  const stops = !below.length ? '' : lockedHere ? `Ignored while locked: ${below.join(', ')}.` : `Overridden below at ${below.join(', ')}.`;

  return {
    effective: step.value,
    trace,
    options,
    canLock: !lockedAbove && step.has && !(last.value.kind === 'repo' && meta.repoOnly),
    lockedHere,
    reach: lockedAbove ? undefined : reach(meta),
    stops,
  };
};

const pick = (key: string, value: string | null) =>
  updateSettings((next) => {
    const state = next[key] as ValueState;
    if (value === null) {
      delete state.set[props.scope];
      if (state.lock === props.scope) state.lock = null;
    } else {
      state.set[props.scope] = value;
    }
  });

const toggleLock = (key: string) =>
  updateSettings((next) => {
    const state = next[key] as ValueState;
    state.lock = state.lock === props.scope ? null : props.scope;
  });

const editList = (key: string, field: 'add' | 'drop', fn: (list: string[]) => string[]) =>
  updateSettings((next) => {
    const state = next[key] as ListState;
    const result = fn(state[field][props.scope] ?? []);
    if (result.length) state[field][props.scope] = result;
    else delete state[field][props.scope];
  });

const addEntry = (meta: ListMeta, step: ListStep) => {
  const value = entry.value.trim();
  if (!value || step.items.some((item) => item.name === value)) return;
  editList(meta.key, 'add', (list) => [...list, value]);
  entry.value = '';
};

const styles = matrix();
const input = field({ mono: true });
const denied = panel();
const page = css({ display: 'flex', flexDirection: 'column', gap: '3.5', paddingInline: '7', paddingBlockStart: '3.5', paddingBlockEnd: '12' });
const topRow = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: '6', rowGap: '2', minHeight: '11' });
const actions = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '3', rowGap: '2', fontSize: 'sm', fontWeight: 'semibold' });
const chipSample = css({ paddingInline: '1.5', backgroundColor: 'academy.text', borderRadius: 'academy-s', color: 'academy.canvas', fontFamily: 'academy-mono', fontSize: 'academy-caption', fontWeight: 'bold' });
const cueNote = css({ fontSize: 'sm', fontWeight: 'semibold' });
const muted = text({ tone: 'muted', size: 'sm' });
const strong = css({ fontSize: 'sm', fontWeight: 'semibold' });
const options = css({ display: 'flex', flexWrap: 'wrap', gap: '1', '& button': { fontFamily: 'academy-mono', fontSize: 'xs', fontWeight: 'normal', whiteSpace: 'normal', _pressed: { fontWeight: 'bold' } } });
const addRow = css({ display: 'flex', gap: '1' });
const lockButton = css({ alignSelf: 'flex-start' });
const linkButton = css({ minHeight: '11', paddingInline: '1', fontSize: 'sm', fontWeight: 'semibold', textDecoration: 'underline', cursor: 'pointer' });
const inputGrow = css({ flex: '[1 1 auto]', minWidth: '0' });
</script>

<template>
  <div :class="[page, 'not-owner']">
    <div :class="[denied.root, denied.empty]">Only the owner can see settings.</div>
  </div>
  <div :class="[page, 'owner-only']">
    <div :class="topRow">
      <div :class="styles.legend">
        <span :class="styles.legendItem"><span :class="chipSample">value</span>Set at this level</span>
        <span :class="styles.legendItem"><span :class="styles.swatch" :style="{ height: '2px' }"></span>Inherited</span>
        <span :class="styles.legendItem"><span :class="styles.swatch" :style="{ height: '4px' }"></span>Locked</span>
        <span :class="styles.legendItem"><span :class="styles.na">—</span>Not available here</span>
      </div>
      <span v-if="isProject" :class="cueNote">This project’s settings are read from <code>.forge/projects.cue</code>.</span>
      <div v-if="changed" :class="actions">
        <span role="status">{{ changed === 1 ? '1 setting changed' : `${changed} settings changed` }}</span>
        <Button type="button" @click="discardSettings">Discard</Button>
        <Button type="button" variant="solid" @click="saveSettings">Save</Button>
      </div>
    </div>

    <div :class="styles.scroll">
      <div :style="{ minWidth }">
        <div :class="styles.head" :style="{ gridTemplateColumns: columns }">
          <span :class="styles.name" :style="{ color: 'var(--colors-academy-text-muted)' }">Setting</span>
          <a
            v-for="column in columnHeads"
            :key="column.addr"
            :href="urlFor(column.addr, 'settings')"
            :aria-current="column.current ? 'page' : undefined"
            :class="styles.column"
          >
            <span :class="styles.columnName"><span data-sep>{{ column.sep }}</span>{{ column.name }}</span>
            <span :class="styles.columnType">{{ column.type }}</span>
          </a>
        </div>

        <template v-for="section in [{ title: 'Nearest level wins', rows: valueRows }, { title: 'Each level adds', rows: listRows }]" :key="section.title">
          <div :class="styles.section">{{ section.title }}</div>
          <template v-for="row in section.rows" :key="row.meta.key">
            <button
              type="button"
              :class="styles.row"
              :aria-expanded="openRow === row.meta.key"
              :style="{ gridTemplateColumns: columns }"
              @click="openRow = openRow === row.meta.key ? null : row.meta.key; entry = ''"
            >
              <span :class="styles.name">{{ row.meta.name }}</span>
              <span v-for="(cell, i) in row.cells" :key="i" :title="cell.title" :class="styles.cell" :data-here="cell.here ? '' : undefined">
                <span v-if="cell.wire" aria-hidden="true" :class="styles.wire" :style="{ left: `${cell.wire.left}%`, right: `${cell.wire.right}%`, height: `${cell.wire.height}px`, marginTop: `${-cell.wire.height / 2}px` }"></span>
                <span v-if="cell.chip" :class="styles.chip" :data-mode="cell.chip.mode" :data-pending="cell.chip.pending ? '' : undefined">
                  <svg v-if="cell.chip.locked" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" role="img" aria-label="Locked"><rect x="3" y="7" width="10" height="7" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>
                  {{ cell.chip.text }}
                </span>
                <span v-if="cell.na" :class="styles.na">—</span>
              </span>
            </button>

            <template v-if="openRow === row.meta.key">
              <!-- A value: nearest level wins. -->
              <div v-if="row.kind === 'value'" :class="styles.editor">
                <div>
                  <span :class="muted">At {{ last.name }}</span>
                  <p :class="muted">{{ row.meta.hint }}</p>
                  <div :class="styles.effective">{{ valueEditor(row.meta, row.walked).effective }}</div>
                  <p>{{ valueEditor(row.meta, row.walked).trace }}</p>
                  <span v-if="valueEditor(row.meta, row.walked).reach" :class="muted">{{ valueEditor(row.meta, row.walked).reach }}</span>
                  <span v-if="valueEditor(row.meta, row.walked).stops" :class="strong">{{ valueEditor(row.meta, row.walked).stops }}</span>
                </div>
                <div>
                  <template v-if="valueEditor(row.meta, row.walked).cue">
                    <span :class="muted">.forge/projects.cue</span>
                    <code :class="terminal()">{{ valueEditor(row.meta, row.walked).cue }}</code>
                  </template>
                  <div v-if="valueEditor(row.meta, row.walked).options.length" role="group" aria-label="Value at this level" :class="options">
                    <Button
                      v-for="option in valueEditor(row.meta, row.walked).options"
                      :key="option.label"
                      type="button"
                      :pressed="option.on"
                      @click="pick(row.meta.key, option.value)"
                    >{{ option.label }}</Button>
                  </div>
                  <span v-if="valueEditor(row.meta, row.walked).canLock" :class="lockButton">
                    <Button type="button" :pressed="valueEditor(row.meta, row.walked).lockedHere" @click="toggleLock(row.meta.key)">
                      {{ valueEditor(row.meta, row.walked).lockedHere ? 'Locked for everything below' : 'Lock for everything below' }}
                    </Button>
                  </span>
                </div>
              </div>

              <!-- A list: each level adds. -->
              <div v-else :class="styles.editor">
                <div>
                  <span :class="muted">At {{ last.name }}</span>
                  <p :class="muted">{{ row.meta.hint }}</p>
                  <div :class="styles.effective">{{ plural(row.walked[lastIndex].count, (row.meta as ListMeta).noun) }}</div>
                  <p v-if="isProject">{{ row.meta.key === 'secrets'
                    ? 'Name them in the file. Set their values on the repo or a group, so they never enter git.'
                    : 'Adds to what it inherits. To change it, edit .forge/projects.cue.' }}</p>
                  <p v-else>Each level adds to what it inherits, and can drop entries it doesn’t want.</p>
                  <span v-if="!isProject" :class="muted">{{ reach() }}</span>
                </div>
                <div>
                  <template v-if="isProject">
                    <span :class="muted">.forge/projects.cue</span>
                    <code :class="terminal()">{{ cueLine(last.name, row.meta.key, row.walked[lastIndex].add) }}</code>
                  </template>
                  <div :style="{ borderBlockStart: '1px solid var(--colors-academy-text)' }">
                    <div v-for="item in row.walked[lastIndex].items" :key="item.name" :class="styles.item">
                      <span :class="styles.itemName" :data-own="item.origin === lastIndex ? '' : undefined">{{ item.name }}
                        <span :class="text({ tone: 'muted', size: 'xs' })">{{ item.origin === lastIndex ? (isProject ? 'Set in .forge/projects.cue' : 'Added here') : `From ${names[item.origin]}` }}</span>
                      </span>
                      <template v-if="!isProject">
                        <button v-if="item.origin === lastIndex" type="button" :class="linkButton" @click="editList(row.meta.key, 'add', (l) => l.filter((n) => n !== item.name))">Remove</button>
                        <button v-else type="button" :class="linkButton" @click="editList(row.meta.key, 'drop', (l) => [...l, item.name])">Drop</button>
                      </template>
                    </div>
                    <template v-if="!isProject">
                      <div v-for="name in row.walked[lastIndex].drop" :key="`drop-${name}`" :class="styles.item">
                        <span :class="styles.itemName" data-dropped>{{ name }} <span :class="text({ size: 'xs' })">Dropped here</span></span>
                        <button type="button" :class="linkButton" @click="editList(row.meta.key, 'drop', (l) => l.filter((n) => n !== name))">Restore</button>
                      </div>
                    </template>
                  </div>
                  <form v-if="!isProject" @submit.prevent="addEntry(row.meta as ListMeta, row.walked[lastIndex])">
                    <label :for="`add-${row.meta.key}`" :class="input.label">Add at {{ last.name }}</label>
                    <div :class="addRow">
                      <input :id="`add-${row.meta.key}`" v-model="entry" type="text" autocomplete="off" :class="[input.input, inputGrow]" />
                      <Button variant="solid">Add</Button>
                    </div>
                  </form>
                </div>
              </div>
            </template>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
