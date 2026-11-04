<script setup lang="ts">
import { computed } from 'vue';
import { css } from '../../../styled-system/css';
import { detail, facts, heading, line, terminal, text } from '../../../styled-system/recipes';
import { Status } from '../../design-system';
import { addrOf, changeLabel, rel, urlFor, type ForgeNode } from '../../data/forge';
import { changesAt, openIssues, store } from '../../data/store';
import { levelsOf, settingValues, walkValue, type Settings, type ValueState } from '../../data/settings';
import ChangeRow from './ChangeRow.vue';
import IssueRow from './IssueRow.vue';

const props = defineProps<{ trail: ForgeNode[]; scope: string }>();

const node = computed(() => props.trail[props.trail.length - 1]);
const isProject = computed(() => node.value.kind === 'project');
const parent = computed(() => props.trail[props.trail.length - 2]);
const siblings = computed(() => (isProject.value ? parent.value.children : []));
const repoAddr = computed(() => addrOf(props.trail.slice(0, -1)));

const issues = computed(() => openIssues(props.scope).slice(0, 6));
const changes = computed(() => changesAt(node.value, props.scope));
const issueWidth = computed(() => issues.value.reduce((max, i) => Math.max(max, rel(props.scope, i.where).length + String(i.n).length + 1), 0));
const changeWidth = computed(() => changes.value.reduce((max, c) => Math.max(max, changeLabel(props.scope, c).length), 0));

const usedBy = computed(() => siblings.value.filter((k) => k.deps.includes(node.value.name)).map((k) => k.name));
const projectUrl = (name: string) => urlFor(`${repoAddr.value}:${name}`);

const tags = computed(() => {
  if (isProject.value && node.value.name === 'root') return '—';
  const meta = settingValues.find((m) => m.key === 'tags')!;
  const walked = walkValue(meta, (store.settingsDraft as Settings).tags as ValueState, levelsOf(props.trail));
  const step = walked[walked.length - 1];
  return step.na ? '—' : step.value.replace('{project}', node.value.name);
});

const command = computed(() => (isProject.value ? `forge clone ${props.scope}` : `git clone forge:${props.scope}`));
const note = computed(() => {
  if (!isProject.value) return 'Just the root project, so issues sit directly on the repo.';
  if (node.value.name === 'root') return 'Sparse checkout of files no other project claims.';
  const depPaths = siblings.value.filter((k) => node.value.deps.includes(k.name)).map((k) => k.path);
  return `Sparse checkout of ${[node.value.path, ...depPaths].join(' and ')}.`;
});
const push = computed(() => `git remote add forge forge:${props.scope}\ngit push forge main`);

const page = detail();
const rows = line();
const list = facts();
const label = heading({ size: 'rule' });
const muted = text({ tone: 'muted', size: 'sm' });
const mono = text({ mono: true, size: 'xs' });
const section = css({ display: 'flex', flexDirection: 'column' });
const stack = css({ display: 'flex', flexDirection: 'column', gap: '2.5' });
const release = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '3', minHeight: '11', paddingInline: '2.5', borderBlockEnd: 'hairline' });
</script>

<template>
  <div :class="page.columns">
    <div :class="page.main">
      <section v-if="node.empty" :class="stack">
        <h2 :class="label">Push to it</h2>
        <pre :class="terminal()">{{ push }}</pre>
        <p :class="muted">To split it into projects later, commit .forge/projects.cue.</p>
      </section>

      <section :class="section">
        <h2 :class="label">Open issues</h2>
        <IssueRow v-for="issue in issues" :key="issue.id" :issue="issue" :scope="scope" :width="issueWidth" />
        <p v-if="!issues.length" :class="rows.empty">No open issues here.</p>
      </section>

      <section :class="section">
        <h2 :class="label">Open changes</h2>
        <ChangeRow v-for="change in changes" :key="change.id" :change="change" :node="node" :scope="scope" :width="changeWidth" />
        <p v-if="!changes.length" :class="rows.empty">No open changes here.</p>
      </section>

      <section v-if="node.readme" :class="stack">
        <h2 :class="label">{{ node.path }}/README.md</h2>
        <p :style="{ maxWidth: '64ch' }">Speaks LSP over stdio. The vscode project wraps this binary. Any other editor can start it with <code>kiln-lsp --stdio</code>.</p>
        <pre :class="terminal()">kiln run lsp:build
kiln run lsp:test</pre>
      </section>
    </div>

    <aside aria-label="Details" :class="page.aside">
      <dl :class="list.root">
        <div :class="list.row">
          <dt :class="list.term">Path</dt>
          <dd :class="list.value">{{ isProject ? node.path : '.' }}</dd>
        </div>
        <div :class="list.row">
          <dt :class="list.term">Tags</dt>
          <dd :class="list.value">{{ tags }}</dd>
        </div>
        <div :class="list.row">
          <dt :class="list.term">CI on main</dt>
          <dd :class="list.value">
            <template v-if="node.fail"><Status state="fail">Failing</Status><span>{{ node.fail }}</span></template>
            <Status v-else state="pass">Passing</Status>
          </dd>
        </div>
        <template v-if="isProject">
          <div :class="list.row">
            <dt :class="list.term">Defined in</dt>
            <dd :class="list.value">{{ node.name === 'root' ? 'Implicit, not in the file' : '.forge/projects.cue' }}</dd>
          </div>
          <div :class="list.row">
            <dt :class="list.term">Depends on</dt>
            <dd :class="list.value">
              <a v-for="dep in node.deps" :key="dep" :href="projectUrl(dep)">{{ dep }}</a>
              <template v-if="!node.deps.length">—</template>
            </dd>
          </div>
          <div :class="list.row">
            <dt :class="list.term">Used by</dt>
            <dd :class="list.value">
              <a v-for="user in usedBy" :key="user" :href="projectUrl(user)">{{ user }}</a>
              <template v-if="!usedBy.length">—</template>
            </dd>
          </div>
        </template>
      </dl>

      <div :class="stack">
        <span :class="muted">Clone</span>
        <code :class="terminal()">{{ command }}</code>
        <span :class="muted">{{ note }}</span>
      </div>

      <section :class="section">
        <h2 :class="label">Releases</h2>
        <div v-for="[tag, age] in node.releases ?? []" :key="tag" :class="release">
          <span :class="mono">{{ tag }}</span>
          <span :class="rows.age" :style="{ flex: 'none' }">{{ age }}</span>
        </div>
        <p v-if="!node.releases?.length" :class="rows.empty">None yet.</p>
      </section>
    </aside>
  </div>
</template>
