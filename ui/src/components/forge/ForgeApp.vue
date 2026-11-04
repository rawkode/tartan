<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SplitPane } from '../../design-system';
import { pageHead, panel, shell, tabs as tabsRecipe } from '../../../styled-system/recipes';
import { addrOf, named, parseUrl, plural, projectsUnder, urlFor, type ForgeNode, type Tab } from '../../data/forge';
import { changesAt, findIssue, issueUrl, navigate, openIssues, replaceUrl, store, syncTitle, trailAt } from '../../data/store';
import ActivityList from './ActivityList.vue';
import ChangeDetail from './ChangeDetail.vue';
import ChangeList from './ChangeList.vue';
import GroupOverview from './GroupOverview.vue';
import IssueDetail from './IssueDetail.vue';
import IssueList from './IssueList.vue';
import JumpBox from './JumpBox.vue';
import LeafOverview from './LeafOverview.vue';
import MonoOverview from './MonoOverview.vue';
import NewNode from './NewNode.vue';
import NewWork from './NewWork.vue';
import ProjectList from './ProjectList.vue';
import SettingsMatrix from './SettingsMatrix.vue';
import TreeNav from './TreeNav.vue';

const props = defineProps<{ url: string }>();

const pathname = computed(() => store.pathname ?? props.url);
const route = computed(() => parseUrl(pathname.value));
const trail = computed(() => trailAt(route.value.addr));
const scope = computed(() => (trail.value ? addrOf(trail.value) : ''));
const last = computed(() => trail.value?.[trail.value.length - 1] as ForgeNode | undefined);

const issue = computed(() => {
  const detail = route.value.detail;
  return detail?.type === 'issue' ? findIssue(scope.value, detail.n) : undefined;
});
const change = computed(() => {
  const detail = route.value.detail;
  return detail?.type === 'change' ? store.changes.find((c) => c.repo === scope.value && c.n === detail.n) : undefined;
});

const missing = computed(() => {
  const detail = route.value.detail;
  if (!trail.value || route.value.unknown) return true;
  if (route.value.tab === 'projects' && last.value?.kind !== 'group') return true;
  if (detail?.type === 'issue') return !issue.value;
  if (detail?.type === 'change') return !change.value;
  return false;
});

// The old address of a moved issue keeps working, and the bar shows where it lives now.
watch([issue, pathname], ([found]) => {
  if (found && issueUrl(found) !== pathname.value) replaceUrl(issueUrl(found));
});

const crumbs = computed(() => {
  const nodes = trail.value ?? (store.tree ? [store.tree as ForgeNode] : []);
  const detail = route.value.detail;
  const out = nodes.map((node, i) => ({
    name: node.name,
    sep: i === 0 ? '' : node.kind === 'project' ? ':' : '/',
    href: urlFor(addrOf(nodes.slice(0, i + 1))),
  }));
  if (detail?.type === 'issue') {
    if (last.value?.name === 'root') out.pop();
    out.push({ name: String(detail.n), sep: '#', href: '' });
  }
  if (detail?.type === 'change') out.push({ name: String(detail.n), sep: '!', href: '' });
  if (detail?.type === 'new-node') out.push({ name: '…', sep: '/', href: '' });
  return out;
});

const tabDefs = computed(() => {
  const node = last.value;
  if (!node) return [];
  const defs: { key: Tab; label: string; count?: number; ownerOnly?: boolean }[] = [
    { key: 'overview', label: 'Overview' },
    ...(node.kind === 'group' ? [{ key: 'projects' as const, label: 'Projects', count: projectsUnder(node, trail.value!.slice(0, -1)).length }] : []),
    { key: 'issues', label: 'Issues', count: openIssues(scope.value).length },
    { key: 'changes', label: 'Changes', count: changesAt(node, scope.value).length },
    { key: 'activity', label: 'Activity' },
    { key: 'settings', label: 'Settings', ownerOnly: true },
  ];
  return defs;
});

const head = computed(() => {
  const node = last.value!;
  const parent = trail.value![trail.value!.length - 2];
  let kind = 'Root';
  if (node.kind === 'group' && parent) {
    const groups = node.children.filter((k) => k.kind === 'group').length;
    const repos = node.children.filter((k) => k.kind === 'repo').length;
    const parts = [groups && plural(groups, 'group'), repos && plural(repos, 'repo')].filter(Boolean);
    kind = `Group · ${parts.join(', ') || 'empty'}`;
  } else if (node.kind === 'repo') {
    kind = node.children.length ? `Monorepo · ${plural(named(node), 'project')}` : 'Repo';
  } else if (node.kind === 'project') {
    kind = node.name === 'root' ? 'Root project · files no other project claims' : `Project · ${node.path}`;
  }
  return { kind, repo: node.kind === 'project' ? parent.name : '', name: node.name, description: node.description };
});

const back = computed(() => {
  const detail = route.value.detail;
  if (!detail || !last.value) return null;
  const name = last.value.name;
  if (detail.type === 'issue' || detail.type === 'new-issue') return { label: `All issues in ${name}`, href: urlFor(scope.value, 'issues') };
  if (detail.type === 'change' || detail.type === 'new-change') return { label: `All changes in ${name}`, href: urlFor(scope.value, 'changes') };
  return { label: `Back to ${name}`, href: urlFor(scope.value) };
});

const main = ref<HTMLElement>();

// Forge pages swap in place so mock state survives. Everything else is a normal page load.
const outside = ['/login', '/register', '/design-system'];
const onClick = (event: MouseEvent) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element).closest?.('a[href^="/"]') as HTMLAnchorElement | null;
  if (!link || link.target || outside.includes(link.getAttribute('href')!)) return;
  event.preventDefault();
  navigate(link.getAttribute('href')!);
  nextTick(() => main.value?.focus({ preventScroll: true }));
};

const onPop = () => {
  store.pathname = location.pathname;
  store.banner = '';
  syncTitle();
};

onMounted(() => window.addEventListener('popstate', onPop));
onBeforeUnmount(() => window.removeEventListener('popstate', onPop));

const styles = shell();
const headStyles = pageHead();
const tabStyles = tabsRecipe();
const empty = panel();
</script>

<template>
  <div :class="styles.root" @click="onClick">
    <header :class="styles.bar">
      <a :class="styles.logo" href="/">t21</a>
      <nav aria-label="Current address" :class="styles.crumbs">
        <template v-for="(crumb, i) in crumbs" :key="i">
          <span v-if="crumb.sep" aria-hidden="true" :class="styles.sep">{{ crumb.sep }}</span>
          <a v-if="crumb.href" :href="crumb.href" :class="styles.crumb" :aria-current="i === crumbs.length - 1 ? 'page' : undefined">{{ crumb.name }}</a>
          <span v-else :class="styles.crumb" aria-current="page">{{ crumb.name }}</span>
        </template>
      </nav>
      <JumpBox />
      <div :class="styles.account"><slot /></div>
    </header>

    <SplitPane label="tree" storage-key="tree-width" :default-width="272" :min-width="200" :max-width="560">
      <template #side><TreeNav :scope="trail ? scope : '~missing'" :route="route" /></template>

      <main ref="main" tabindex="-1" :class="styles.main">
        <div v-if="missing" :class="styles.pad">
          <div :class="[empty.root, empty.empty]">Nothing at that address.</div>
        </div>

        <template v-else-if="last">
          <section v-if="!route.detail" :class="headStyles.root">
            <span :class="headStyles.kind">{{ head.kind }}</span>
            <h1 :class="headStyles.title"><template v-if="head.repo"><span :class="headStyles.dim">{{ head.repo }}</span><span :class="headStyles.mark">:</span></template>{{ head.name }}</h1>
            <p :class="headStyles.lede">{{ head.description }}</p>
          </section>

          <nav aria-label="Views" :class="tabStyles.root">
            <a
              v-for="tab in tabDefs"
              :key="tab.key"
              :href="urlFor(scope, tab.key === 'overview' ? '' : tab.key)"
              :aria-current="route.tab === tab.key ? 'page' : undefined"
              :class="[tabStyles.tab, tab.ownerOnly && 'owner-only']"
            >
              {{ tab.label }}
              <span v-if="tab.count !== undefined" :class="tabStyles.count">{{ tab.count }}</span>
            </a>
          </nav>

          <div v-if="store.banner" role="status" :class="styles.banner">{{ store.banner }}</div>
          <div v-if="back" :class="styles.back"><a :href="back.href">← {{ back.label }}</a></div>

          <IssueDetail v-if="issue" :key="issue.id" :issue="issue" :trail="trail!" :scope="scope" />
          <ChangeDetail v-else-if="change" :key="change.id" :change="change" :trail="trail!" :scope="scope" />
          <NewNode v-else-if="route.detail?.type === 'new-node'" :key="pathname" :kind="route.detail.kind" :trail="trail!" :scope="scope" />
          <NewWork v-else-if="route.detail?.type === 'new-issue'" :key="pathname" work="issue" :node="last" :scope="scope" />
          <NewWork v-else-if="route.detail?.type === 'new-change'" :key="pathname" work="change" :node="last" :scope="scope" />
          <ProjectList v-else-if="route.tab === 'projects'" :trail="trail!" :scope="scope" />
          <IssueList v-else-if="route.tab === 'issues'" :key="pathname" :node="last" :scope="scope" />
          <ChangeList v-else-if="route.tab === 'changes'" :node="last" :scope="scope" />
          <ActivityList v-else-if="route.tab === 'activity'" :node="last" :scope="scope" />
          <SettingsMatrix v-else-if="route.tab === 'settings'" :key="pathname" :trail="trail!" :scope="scope" />
          <GroupOverview v-else-if="last.kind === 'group'" :trail="trail!" :scope="scope" />
          <MonoOverview v-else-if="last.kind === 'repo' && last.children.length" :key="pathname" :node="last" :scope="scope" />
          <LeafOverview v-else :trail="trail!" :scope="scope" />
        </template>
      </main>
    </SplitPane>
  </div>
</template>
