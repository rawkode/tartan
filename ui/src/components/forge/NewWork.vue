<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { detail, form, panel, text } from '../../../styled-system/recipes';
import { Button, Field, Select } from '../../design-system';
import type { ForgeNode } from '../../data/forge';
import { createChange, createIssue } from '../../data/store';

// Opening an issue or a change is what a contributor can do. A monorepo asks which project it belongs to.
const props = defineProps<{ work: 'issue' | 'change'; node: ForgeNode; scope: string }>();

const isMono = computed(() => props.node.kind === 'repo' && props.node.children.length > 0);
const projects = computed(() => props.node.children.map((k) => ({ label: k.name, value: k.name })));
const project = ref(props.node.children[0]?.name ?? '');

const submit = (event: Event) => {
  const data = new FormData(event.target as HTMLFormElement);
  const title = String(data.get('title') ?? '').trim();
  if (!title) return;
  if (props.work === 'issue') {
    const where = isMono.value ? `${props.scope}:${project.value}` : props.scope;
    createIssue(where, title, String(data.get('body') ?? ''));
    return;
  }
  const repo = props.scope.split(':')[0];
  const touches = isMono.value ? [project.value] : props.node.kind === 'project' ? [props.node.name] : [];
  createChange(repo, title, String(data.get('branch') ?? ''), touches);
};

const page = detail();
const denied = panel();
const box = css({ paddingInline: '7', paddingBlockStart: '3', paddingBlockEnd: '12' });
const stack = css({ display: 'grid', gap: '4' });
</script>

<template>
  <div :class="[box, 'anon-only']">
    <div :class="[denied.root, denied.empty]"><a href="/register">Register</a> or <a href="/login">sign in</a> to contribute.</div>
  </div>
  <div :class="[box, stack, 'member-only']">
    <h1 :class="page.title">New {{ work }} in {{ node.name }}</h1>
    <form :class="form()" @submit.prevent="submit">
      <Select v-if="isMono" v-model="project" label="Project" name="project" :items="projects" />
      <Field v-if="work === 'change'" label="Source branch" name="branch" mono required />
      <Field label="Title" name="title" required />
      <Field v-if="work === 'issue'" label="Description" name="body" :rows="6" />
      <Button variant="solid">Open {{ work }}</Button>
      <p :class="text({ tone: 'muted', size: 'sm' })">This is a mockup, so it disappears when you reload.</p>
    </form>
  </div>
</template>
