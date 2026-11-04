<script setup lang="ts">
import { computed } from 'vue';
import { css } from '../../../styled-system/css';
import { heading, line, shell, stats, text } from '../../../styled-system/recipes';
import { Status } from '../../design-system';
import { changeLabel, failingUnder, projectsUnder, rel, repoCount, under, urlFor, type ForgeNode } from '../../data/forge';
import { changeUrl, changesAt, eventsAt, openChanges, openIssues } from '../../data/store';
import IssueRow from './IssueRow.vue';

const props = defineProps<{ trail: ForgeNode[]; scope: string }>();

const node = computed(() => props.trail[props.trail.length - 1]);
const open = computed(() => openIssues(props.scope));
const recent = computed(() => open.value.slice(0, 5));
const repos = computed(() => repoCount(node.value));
const projects = computed(() => projectsUnder(node.value, props.trail.slice(0, -1)).length);
const changes = computed(() => changesAt(node.value, props.scope));
const activity = computed(() => eventsAt(node.value, props.scope, 5));

const attention = computed(() => [
  ...openChanges()
    .filter((c) => c.fail.length && under(c.repo, props.scope))
    .map((c) => ({ key: c.id, address: changeLabel(props.scope, c), text: `${c.fail.join(', ')} failing on ${c.title}`, href: changeUrl(c) })),
  ...failingUnder(node.value, props.trail.slice(0, -1)).map((f) => ({
    key: f.addr,
    address: rel(props.scope, f.addr),
    text: f.node.fail!,
    href: urlFor(f.addr),
  })),
]);

const page = shell();
const number = stats();
const rows = line();
const label = heading({ size: 'rule' });
const columns = css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '8' });
const column = css({ display: 'flex', flexDirection: 'column', minWidth: '0' });
const place = text({ tone: 'muted', mono: true, size: 'xs' });
</script>

<template>
  <div :class="page.pad">
    <div :class="number.root">
      <a :href="urlFor(scope, 'issues')" :class="number.stat">
        <span :class="number.numeral">{{ open.length }}</span>
        <span :class="number.unit">Open issues</span>
      </a>
      <a :href="urlFor(scope, 'changes')" :class="number.stat">
        <span :class="number.numeral">{{ changes.length }}</span>
        <span :class="number.unit">Open changes</span>
      </a>
      <a :href="urlFor(scope, 'projects')" :class="number.stat">
        <span :class="number.numeral">{{ projects }}</span>
        <span :class="number.unit">{{ projects === 1 ? 'Project' : 'Projects' }}</span>
      </a>
      <div :class="number.stat">
        <span :class="number.numeral">{{ repos }}</span>
        <span :class="number.unit">{{ repos === 1 ? 'Repo' : 'Repos' }}</span>
      </div>
    </div>

    <section v-if="attention.length" :class="column">
      <h2 :class="label">Needs attention</h2>
      <a v-for="item in attention" :key="item.key" :href="item.href" :class="rows.root">
        <Status state="fail">Failing</Status>
        <span :class="rows.id">{{ item.address }}</span>
        <span :class="rows.title" :style="{ fontWeight: 400 }">{{ item.text }}</span>
      </a>
    </section>

    <div :class="columns">
      <section :class="column">
        <h2 :class="label">Recently updated issues</h2>
        <IssueRow v-for="issue in recent" :key="issue.id" :issue="issue" :scope="scope" stacked />
        <p v-if="!recent.length" :class="rows.empty">No open issues here.</p>
      </section>
      <section :class="column">
        <h2 :class="label">Recent activity</h2>
        <div v-for="event in activity" :key="event.sha" :class="rows.root">
          <span :class="place" :style="{ flex: '1 1 100%', overflowWrap: 'anywhere' }">{{ event.place }}</span>
          <span :class="rows.title" :style="{ fontWeight: 400 }">{{ event.subject }}</span>
          <span :class="rows.age">{{ event.age }}</span>
        </div>
        <p v-if="!activity.length" :class="rows.empty">Nothing has happened here yet.</p>
      </section>
    </div>
  </div>
</template>
