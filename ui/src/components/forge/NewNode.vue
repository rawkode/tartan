<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { button, detail, facts, field, heading, panel, text } from '../../../styled-system/recipes';
import type { ForgeNode } from '../../data/forge';
import { plural } from '../../data/forge';
import { createNode, store } from '../../data/store';
import { levelsOf, settingLists, settingValues, walkList, walkValue, type ListState, type Settings, type ValueState } from '../../data/settings';

// Only groups and repos are created here. Projects come from .forge/projects.cue.
const props = defineProps<{ kind: 'group' | 'repo'; trail: ForgeNode[]; scope: string }>();

const parent = computed(() => props.trail[props.trail.length - 1]);
const isGroup = computed(() => props.kind === 'group');
const name = ref('');
const description = ref('');

const error = computed(() => {
  if (name.value && !/^[a-z0-9][a-z0-9._-]*$/.test(name.value)) return 'Use lowercase letters, numbers, dots, hyphens and underscores.';
  if (parent.value.children.some((k) => k.name === name.value)) return `${parent.value.name} already has something called ${name.value}.`;
  return '';
});
const blocked = computed(() => !name.value || !!error.value);

const levels = computed(() => levelsOf(props.trail));
const settings = computed(() => store.settingsDraft as Settings);

const inherits = computed(() => [
  ...settingValues.map((meta) => {
    const walked = walkValue(meta, settings.value[meta.key] as ValueState, levels.value);
    const step = walked[walked.length - 1];
    if (step.na) return { name: meta.name, value: '—', from: '' };
    return {
      name: meta.name,
      value: step.value,
      from: step.lockedAt !== null ? `Locked at ${levels.value[step.lockedAt].node.name}` : `from ${levels.value[step.origin].node.name}`,
    };
  }),
  ...settingLists.map((meta) => {
    const walked = walkList(settings.value[meta.key] as ListState, levels.value);
    return { name: meta.name, value: plural(walked[walked.length - 1].count, meta.noun), from: 'Added up from every level' };
  }),
]);

const create = () => {
  if (!blocked.value) createNode(props.scope, props.kind, name.value, description.value);
};

const page = detail();
const list = facts();
const input = field({ mono: true });
const plain = field();
const denied = panel();
const label = heading({ size: 'rule' });
const muted = text({ tone: 'muted', size: 'sm' });
const headBox = css({ display: 'flex', flexDirection: 'column', gap: '2', paddingInline: '7', paddingBlockStart: '3', paddingBlockEnd: '5' });
const formBox = css({ flex: '[999 1 420px]', minWidth: '0', maxWidth: '[620px]', display: 'flex', flexDirection: 'column', gap: '4.5' });
const address = css({ fontFamily: 'academy-mono', fontSize: '2xl', fontWeight: 'extrabold', letterSpacing: 'academy-tight', lineHeight: 'academy-title', overflowWrap: 'anywhere' });
const stack = css({ display: 'flex', flexDirection: 'column', gap: '2.5' });
const inherit = css({ display: 'flex', flexDirection: 'column', fontFamily: 'academy-mono' });
const submit = css({ alignSelf: 'flex-start' });
const deniedBox = css({ paddingInline: '7', paddingBlockEnd: '12' });
</script>

<template>
  <div :class="[deniedBox, 'not-owner']">
    <div :class="[denied.root, denied.empty]">Only the owner can create groups and repos.</div>
  </div>
  <div class="owner-only">
    <section :class="headBox">
      <h1 :class="page.title">New {{ kind }} in {{ parent.name }}</h1>
      <p :class="text({ tone: 'soft' })">{{ isGroup
        ? 'Groups hold other groups and repos, and pass their settings down to everything inside.'
        : 'A new repo starts empty and as a single project. To split it into projects, commit .forge/projects.cue to it.' }}</p>
    </section>
    <div :class="page.columns">
      <form :class="formBox" @submit.prevent="create">
        <div :class="input.root">
          <label for="new-name" :class="input.label">Name</label>
          <input id="new-name" v-model="name" type="text" autocomplete="off" :aria-invalid="error ? true : undefined" :class="input.input" />
          <span v-if="error" role="alert" :class="input.error">{{ error }}</span>
        </div>
        <div :class="plain.root">
          <label for="new-description" :class="plain.label">Description</label>
          <input id="new-description" v-model="description" type="text" autocomplete="off" :class="plain.input" />
        </div>
        <div :class="address"><span :class="page.dim">{{ scope ? `~/${scope}` : '~' }}</span><span :class="page.mark">/</span>{{ name || '…' }}</div>
        <button type="submit" :disabled="blocked" :class="[button({ variant: 'solid' }), submit]">Create {{ kind }}</button>
      </form>
      <aside aria-label="Inherited settings" :class="[page.aside, stack]" :style="{ paddingBlockStart: 0 }">
        <h2 :class="label">Inherits</h2>
        <dl>
          <div v-for="item in inherits" :key="item.name" :class="list.row" :style="{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }">
            <dt :class="list.term">{{ item.name }}</dt>
            <dd :class="inherit">
              <strong :class="text({ size: 'xs' })">{{ item.value }}</strong>
              <span :class="text({ size: 'xs', tone: 'muted' })">{{ item.from }}</span>
            </dd>
          </div>
        </dl>
        <p :class="muted">Change any of these in Settings once it exists.</p>
      </aside>
    </div>
  </div>
</template>
