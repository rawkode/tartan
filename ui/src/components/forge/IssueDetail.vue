<script setup lang="ts">
import { computed, ref } from 'vue';
import { css } from '../../../styled-system/css';
import { detail, diff, facts, field, heading, line, text } from '../../../styled-system/recipes';
import { Badge, Button, Status } from '../../design-system';
import { KILN, changeLabel, rel, short, splitAddr, under, urlFor, type ForgeNode, type Issue } from '../../data/forge';
import { changeUrl, closingChange, destinations, findIssue, issueUrl, logOnIssue, moveIssue, nextNumber, store, toggleAffected, toggleClosed } from '../../data/store';
import { labelOrigin, type Settings } from '../../data/settings';

const props = defineProps<{ issue: Issue; trail: ForgeNode[]; scope: string }>();

const owner = computed(() => props.trail[props.trail.length - 1]);
const parent = computed(() => props.trail[props.trail.length - 2]);
const isProject = computed(() => owner.value.kind === 'project');
const repoAddr = computed(() => props.issue.where.split(':')[0]);

const parts = computed(() => props.issue.where.replace(/:root$/, '').split(':'));
const repoName = computed(() => parts.value[0].split('/').pop()!);

const draft = ref('');
const moving = ref(false);
const dest = ref<string | null>(null);

const hasDest = computed(() => !!dest.value && dest.value !== props.issue.where);
const next = computed(() => (hasDest.value ? nextNumber(props.issue, dest.value!) : 0));
const settings = computed(() => store.settingsDraft as Settings);

const effects = computed(() => {
  if (!hasDest.value) return [];
  const target = dest.value!;
  const issue = props.issue;
  const out = [{ text: `${short(issue.where, issue.n)} will redirect to ${short(target, next.value)}.`, warn: false }];
  for (const name of issue.labels) {
    const origin = labelOrigin(settings.value, name);
    if (origin !== null && !under(target, origin)) {
      out.push({ text: `Drops the label ${name}, which only exists in ${splitAddr(origin).pop()}.`, warn: true });
    }
  }
  if (issue.found) out.push({ text: `Clears Found in ${issue.found}. Versions belong to a project.`, warn: true });
  if (change.value) {
    const label = `!${change.value.n}`;
    const destRepo = target.split(':')[0];
    const destName = target.split(':')[1] ?? '';
    if (destRepo !== change.value.repo) out.push({ text: `${label} can’t close this from another repo. It stays as a reference.`, warn: true });
    else if (change.value.touches.includes(destName)) out.push({ text: `Still closed by ${label}, which touches ${destName}.`, warn: false });
    else out.push({ text: `${label} doesn’t touch ${destName}, but it can still close this.`, warn: false });
  }
  return out;
});

const addrFor = (name: string) => `${repoAddr.value}:${name}`;

const related = computed(() => {
  const issue = props.issue;
  const depAddrs = isProject.value ? owner.value.deps.map(addrFor) : [];
  const usedBy = isProject.value ? parent.value.children.filter((k) => k.deps.includes(owner.value.name)).map((k) => addrFor(k.name)) : [];
  const extra = issue.affected.filter((a) => !depAddrs.includes(a) && !usedBy.includes(a));
  const row = (addr: string, why: string) => ({ addr, why, name: rel(issue.where, addr), on: issue.affected.includes(addr) });
  return [
    ...depAddrs.map((a) => row(a, `${owner.value.name} depends on it`)),
    ...usedBy.map((a) => row(a, `It depends on ${owner.value.name}`)),
    ...extra.map((a) => row(a, 'Marked by hand')),
  ];
});

const change = computed(() => closingChange(props.issue));
const sameRepo = computed(() => change.value?.repo === repoAddr.value);
const bump = computed(() => (change.value && sameRepo.value ? change.value.bumps?.[owner.value.name] : undefined));
const label = computed(() => (change.value ? changeLabel(props.issue.where, change.value) : '!412'));
const failing = computed(() => !!change.value && change.value.fail.length > 0 && !store.rerun[change.value.id]);

type Entry =
  | { age: string; note: string }
  | { age: string; lead: string; code: string; tail: string; fail?: boolean };

const timeline = computed<Entry[]>(() => {
  const issue = props.issue;
  const base: Entry[] = issue.rich
    ? [
        { age: '6d', lead: 'Opened against', code: 'lsp/v0.9.2', tail: '' },
        { age: '3d', note: 'Needs a member lookup that doesn’t depend on the open file. Blocked on the index in core.' },
        { age: '3d', lead: 'Referenced by commit', code: 'b70c2a9', tail: 'Member index data structure' },
        { age: '2d', lead: 'Referenced by', code: `${rel(issue.where, 'oss/devtools/build/kiln-examples')}#3`, tail: 'Add a multi-member fixture' },
        { age: '1d', lead: 'Linked to change', code: label.value, tail: sameRepo.value ? 'Closes this on merge.' : '' },
        { age: '2h', lead: '', code: 'goto_definition_across_members', tail: `on ${label.value}`, fail: true },
      ]
    : [{ age: issue.age, lead: 'Opened', code: '', tail: '' }];
  return [
    ...base,
    ...issue.log.map((entry): Entry => {
      if (entry.kind === 'note') return { age: 'now', note: entry.text };
      if (entry.kind === 'moved') return { age: 'now', lead: 'Moved from', code: `${rel(issue.where, entry.where)}#${entry.n}`, tail: 'The old address redirects here.' };
      return { age: 'now', lead: entry.text, code: '', tail: '' };
    }),
  ];
});

const lastMove = computed(() => [...props.issue.log].reverse().find((e) => e.kind === 'moved') as { where: string; n: number } | undefined);

const addNote = () => {
  const value = draft.value.trim();
  if (!value) return;
  logOnIssue(props.issue, { kind: 'note', text: value });
  draft.value = '';
};

const confirmMove = () => {
  if (!hasDest.value) return;
  const target = dest.value!;
  moving.value = false;
  dest.value = null;
  moveIssue(props.issue, target);
};

const linkTo = (where: string, n: number) => {
  const target = findIssue(where, n);
  return target ? issueUrl(target) : urlFor(where, 'issues');
};

const parallel = computed(() => ({ text: `${rel(props.issue.where, `${KILN}:core`)}#298`, href: linkTo(`${KILN}:core`, 298) }));
const stale = computed(() => ({ text: `${rel(props.issue.where, `${KILN}:lsp`)}#131`, href: linkTo(`${KILN}:lsp`, 131) }));

const originLabel = (name: string) => {
  const origin = labelOrigin(settings.value, name);
  return origin === null ? 'from this project' : `from ${origin ? splitAddr(origin).pop() : '~'}`;
};

const page = detail();
const code = diff();
const list = facts();
const rows = line();
const input = field();
const ruleLabel = heading({ size: 'rule' });
const muted = text({ tone: 'muted', size: 'sm' });
const soft = text({ tone: 'soft', size: 'sm' });
const section = css({ display: 'flex', flexDirection: 'column' });
const gapped = css({ display: 'flex', flexDirection: 'column', gap: '2.5' });
const statusLine = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '4', rowGap: '1.5' });
const ownerRow = css({ display: 'flex', alignItems: 'center', gap: '2.5' });
const stretch = css({ flex: '[1 1 auto]', minWidth: '0', display: 'flex', flexDirection: 'column' });
const ownerName = css({ fontFamily: 'academy-mono', fontSize: 'sm', fontWeight: 'extrabold', overflowWrap: 'anywhere' });
const ownerPath = css({ color: 'academy.textMuted', fontFamily: 'academy-mono', fontSize: 'xs', overflowWrap: 'anywhere' });
const mover = css({ display: 'flex', flexDirection: 'column', gap: '3', padding: '3.5', border: 'rule', borderRadius: 'academy-s' });
const choices = css({ display: 'flex', flexWrap: 'wrap', gap: '1' });
const preview = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '2.5', rowGap: '2', padding: '3', backgroundColor: 'academy.ink', borderRadius: 'academy-s', color: 'academy.inkText', fontFamily: 'academy-mono', overflowWrap: 'anywhere' });
const previewTo = css({ fontSize: 'lg', fontWeight: 'extrabold' });
const previewArrow = css({ color: 'academy.inkAccent' });
const effect = css({ fontSize: 'sm', textWrap: 'pretty', '&[data-warn]': { color: 'academy.statusRust', fontWeight: 'semibold' } });
const relatedRow = css({ display: 'flex', alignItems: 'center', gap: '2.5', minHeight: '[52px]', borderBlockEnd: 'hairline' });
const relatedName = css({ fontFamily: 'academy-mono', fontSize: 'xs', fontWeight: 'bold', overflowWrap: 'anywhere' });
const changeLink = css({ display: 'flex', flexDirection: 'column', gap: '1', paddingBlock: '2.5', borderBlockEnd: 'hairline', color: 'academy.text', _hover: { backgroundColor: 'academy.ground', textDecoration: 'none' } });
const changeHead = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '2.5', rowGap: '1' });
const labelRow = css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '3', minHeight: '11', borderBlockEnd: 'hairline' });
const noteForm = css({ display: 'flex', flexDirection: 'column', gap: '2', maxWidth: 'academy-copy' });
const noteActions = css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '2' });
const pairs = css({ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: '3.5', rowGap: '1', alignItems: 'baseline', '& dd': { fontFamily: 'academy-mono', fontSize: 'xs', overflowWrap: 'anywhere' } });
</script>

<template>
  <section :class="page.head">
    <div :class="statusLine">
      <span :class="page.id"><template v-if="parts[1]"><span :class="page.dim">{{ repoName }}</span><span :class="page.mark">:</span></template>{{ parts[1] || repoName }}<span :class="page.mark">#</span>{{ issue.n }}</span>
      <Status :state="issue.closed ? 'closed' : 'open'">{{ issue.closed ? 'Closed' : 'Open' }}</Status>
      <span v-if="lastMove" :class="muted">Was <code>{{ short(lastMove.where, lastMove.n) }}</code>, which redirects here.</span>
    </div>
    <h1 :class="page.title">{{ issue.title }}</h1>
  </section>

  <div :class="page.columns" :style="{ borderBlockStart: '1px solid var(--colors-academy-text)' }">
    <div :class="page.main">
      <article v-if="issue.rich" :class="page.prose">
        <p>Go-to-definition on a task reference only works when the task is declared in the member you have open. If another workspace member declares it, the server returns no location.</p>
        <ol>
          <li>Open <code>crates/cli/kiln.toml</code>.</li>
          <li>Go to definition on <code>core:build</code>.</li>
        </ol>
        <dl :class="pairs">
          <dt :class="muted">Expected</dt>
          <dd>crates/core/kiln.toml</dd>
          <dt :class="muted">Got</dt>
          <dd>null</dd>
        </dl>
        <figure :class="code.root">
          <figcaption :class="code.file"><span>crates/lsp/src/definition.rs</span><span :class="muted">pinned at a41c9e2</span></figcaption>
          <div :class="code.lines">
            <div :class="code.line"><span :class="code.number">18</span><span :class="code.text">    let task = ws.task_at(at)?;</span></div>
            <div :class="code.line" data-sign="-"><span :class="code.number">19</span><span :class="code.text">    let member = ws.current_member()?;</span></div>
            <div :class="code.line"><span :class="code.number">20</span><span :class="code.text">    member.find_task(&amp;task.name).map(Location::from)</span></div>
          </div>
        </figure>
        <p><code>current_member</code> is the member you have open, not the one that declares the task. Probably related to <a :href="parallel.href" :class="page.ref">{{ parallel.text }}</a>, and <a :href="stale.href" :class="page.ref">{{ stale.text }}</a> might share the cause.</p>
      </article>
      <p v-else-if="issue.body" :class="page.note">{{ issue.body }}</p>
      <p v-else :class="muted">No description yet.</p>

      <section :class="section">
        <h2 :class="ruleLabel">Activity</h2>
        <div v-for="(entry, i) in timeline" :key="i" :class="page.event">
          <span :class="page.age">{{ entry.age }}</span>
          <p v-if="'note' in entry" :class="page.note">{{ entry.note }}</p>
          <div v-else :class="page.eventText">
            <Status v-if="entry.fail" state="fail">Failing</Status>
            {{ entry.lead }} <code v-if="entry.code">{{ entry.code }}</code> {{ entry.tail }}
          </div>
        </div>
      </section>

      <form :class="[noteForm, 'member-only']" @submit.prevent="addNote">
        <label for="note" :class="input.label">Add a note</label>
        <textarea id="note" v-model="draft" rows="3" :class="input.input"></textarea>
        <div :class="noteActions">
          <Button class="owner-only" type="button" @click="toggleClosed(issue)">{{ issue.closed ? 'Reopen issue' : 'Close issue' }}</Button>
          <Button variant="solid">Add note</Button>
        </div>
      </form>
      <p :class="[soft, 'anon-only']"><a href="/register">Register</a> or <a href="/login">sign in</a> to add a note.</p>
    </div>

    <aside aria-label="Issue details" :class="page.aside">
      <section :class="gapped">
        <h2 :class="ruleLabel">{{ isProject ? 'Project' : 'Repo' }}</h2>
        <div :class="ownerRow">
          <a :href="urlFor(scope)" :class="stretch">
            <span :class="ownerName">{{ owner.name }}</span>
            <span :class="ownerPath">{{ isProject ? owner.path : repoAddr }}</span>
          </a>
          <Button v-if="!moving" class="owner-only" type="button" @click="moving = true">Move</Button>
        </div>
        <div v-if="moving" :class="[mover, 'owner-only']">
          <span :class="muted">Move to</span>
          <div role="group" aria-label="Destination" :class="choices">
            <Button
              v-for="target in destinations(issue)"
              :key="target"
              type="button"
              size="sm"
              :pressed="target === dest"
              @click="dest = target"
            >{{ rel(issue.where, target) || splitAddr(target).pop() }}</Button>
          </div>
          <template v-if="hasDest">
            <div :class="preview">
              <span>{{ short(issue.where, issue.n) }}</span>
              <span aria-label="becomes" :class="previewArrow">→</span>
              <span :class="previewTo">{{ short(dest!, next) }}</span>
            </div>
            <p v-for="item in effects" :key="item.text" :class="effect" :data-warn="item.warn ? '' : undefined">{{ item.text }}</p>
            <Button variant="solid" type="button" @click="confirmMove">Move to {{ splitAddr(dest!).pop() }}</Button>
          </template>
          <Button type="button" @click="moving = false; dest = null">Cancel</Button>
        </div>
      </section>

      <section :class="section">
        <h2 :class="ruleLabel">Also affects</h2>
        <div v-for="row in related" :key="row.addr" :class="relatedRow">
          <span :class="stretch">
            <span :class="relatedName">{{ row.name }}</span>
            <span :class="muted">{{ row.why }}</span>
          </span>
          <Button class="owner-only" type="button" size="sm" :pressed="row.on" @click="toggleAffected(issue, row.addr)">{{ row.on ? 'Affected' : 'Mark affected' }}</Button>
          <span v-if="row.on" :class="[muted, 'not-owner']">Affected</span>
        </div>
        <p v-if="!related.length" :class="rows.empty" :style="{ paddingInline: 0 }">No related projects.</p>
      </section>

      <section v-if="change" :class="section">
        <h2 :class="ruleLabel">Change</h2>
        <a :href="changeUrl(change)" :class="changeLink">
          <span :class="changeHead">
            <span :class="relatedName">{{ label }}</span>
            <Status v-if="failing" state="fail">{{ change.fail.join(', ') }} tests failing</Status>
          </span>
          <strong>{{ change.title }}</strong>
          <span :class="muted">{{ sameRepo ? 'Closes this on merge.' : 'Reference only. It’s in another repo.' }}</span>
        </a>
      </section>

      <dl :class="list.root">
        <div :class="list.row">
          <dt :class="list.term">Found in</dt>
          <dd :class="list.value">{{ issue.found || '—' }}</dd>
        </div>
        <div :class="list.row">
          <dt :class="list.term">Ships in</dt>
          <dd :class="list.value">{{ bump ? `${owner.name}/v${bump[1]}` : '—' }}</dd>
        </div>
      </dl>

      <section :class="section">
        <h2 :class="ruleLabel">Labels</h2>
        <div v-for="name in issue.labels" :key="name" :class="labelRow">
          <Badge>{{ name }}</Badge>
          <a class="owner-only" :class="muted" :href="urlFor(scope, 'settings')">{{ originLabel(name) }}</a>
          <span class="not-owner" :class="muted">{{ originLabel(name) }}</span>
        </div>
        <p v-if="!issue.labels.length" :class="rows.empty" :style="{ paddingInline: 0 }">No labels.</p>
      </section>
    </aside>
  </div>
</template>
