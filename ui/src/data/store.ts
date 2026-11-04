import { reactive } from 'vue';
import {
  addrOf,
  buildTree,
  defaultChanges,
  defaultIssues,
  events,
  failingUnder,
  groupNode,
  parseUrl,
  repoNode,
  rel,
  titleFor,
  trailOf,
  under,
  urlFor,
  type Change,
  type ForgeNode,
  type Issue,
  type IssueLog,
} from './forge';
import { labelOrigin, settingDefaults, type Settings } from './settings';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Mock state lives in memory, so a full page load starts from the sample data again.
export const store = reactive({
  // Null until the first client-side navigation, so hydration uses the page's own URL.
  pathname: null as string | null,
  banner: '',
  tree: buildTree(),
  issues: defaultIssues(),
  changes: defaultChanges(),
  merged: {} as Record<string, boolean>,
  rerun: {} as Record<string, boolean>,
  reviewed: {} as Record<string, Record<string, boolean>>,
  settingsSaved: settingDefaults(),
  settingsDraft: settingDefaults(),
});

export const syncTitle = () => {
  document.title = `${titleFor(parseUrl(location.pathname))} · t21`;
};

export const navigate = (url: string, banner = '') => {
  store.banner = banner;
  if (url !== location.pathname) history.pushState(null, '', url);
  store.pathname = location.pathname;
  syncTitle();
  window.scrollTo(0, 0);
};

export const replaceUrl = (url: string) => {
  history.replaceState(null, '', url);
  store.pathname = location.pathname;
  syncTitle();
};

export const trailAt = (addr: string) => trailOf(store.tree as ForgeNode, addr);

export const openChanges = () => store.changes.filter((c) => !store.merged[c.id]);

export const openIssues = (addr: string) => store.issues.filter((i) => !i.closed && under(i.where, addr));

export const changesAt = (node: ForgeNode, addr: string) =>
  node.kind === 'project'
    ? openChanges().filter((c) => c.repo === addr.split(':')[0] && c.touches.includes(node.name))
    : openChanges().filter((c) => under(c.repo, addr));

export const eventsAt = (node: ForgeNode, addr: string, limit: number) => {
  const repo = addr.split(':')[0];
  return events
    .filter((e) => (node.kind === 'project' ? e.repo === repo && e.projects.includes(node.name) : under(e.repo, addr)))
    .slice(0, limit)
    .map((e) => ({ ...e, place: node.kind === 'project' ? '' : rel(addr, e.repo), chips: node.kind === 'project' ? [] : e.projects }));
};

export const hasFailure = (node: ForgeNode) => failingUnder(node, []).length > 0;

// An issue that moved answers at its old address too.
export const findIssue = (where: string, n: number) =>
  store.issues.find((i) => (i.where === where && i.n === n) || i.past.some((p) => p.where === where && p.n === n));

export const issueUrl = (issue: Issue) => urlFor(issue.where, `issues/${issue.n}`);
export const changeUrl = (change: Change) => urlFor(change.repo, `changes/${change.n}`);

export const closingChange = (issue: Issue) => openChanges().find((c) => c.closes === issue.id);

export const logOnIssue = (issue: Issue, entry: IssueLog) => {
  issue.log.push(entry);
};

export const toggleClosed = (issue: Issue) => {
  logOnIssue(issue, { kind: 'status', text: issue.closed ? 'Reopened.' : 'Closed.' });
  issue.closed = !issue.closed;
};

export const toggleAffected = (issue: Issue, addr: string) => {
  issue.affected = issue.affected.includes(addr) ? issue.affected.filter((a) => a !== addr) : [...issue.affected, addr];
};

// Where an issue can move: its repo's other projects, and the repos beside that repo.
export const destinations = (issue: Issue) => {
  const repoAddr = issue.where.split(':')[0];
  const repoTrail = trailAt(repoAddr);
  if (!repoTrail) return [];
  const repo = repoTrail[repoTrail.length - 1];
  const parent = repoTrail[repoTrail.length - 2];
  const parentAddr = addrOf(repoTrail.slice(0, -1));
  const own = repo.children.map((k) => `${repoAddr}:${k.name}`).filter((w) => w !== issue.where);
  const beside = parent.children
    .filter((k) => k.kind === 'repo' && k !== repo)
    .map((k) => {
      const addr = `${parentAddr ? `${parentAddr}/` : ''}${k.name}`;
      return k.children.length ? `${addr}:root` : addr;
    });
  return [...own, ...beside];
};

// Moving back to a project reuses the number the issue had there.
export const nextNumber = (issue: Issue, dest: string) =>
  issue.past.find((p) => p.where === dest)?.n ??
  store.issues.filter((i) => i.where === dest).reduce((max, i) => Math.max(max, i.n), 0) + 1;

export const moveIssue = (issue: Issue, dest: string) => {
  const n = nextNumber(issue, dest);
  const from = { where: issue.where, n: issue.n };
  issue.labels = issue.labels.filter((name) => {
    const origin = labelOrigin(store.settingsDraft as Settings, name);
    return origin === null || under(dest, origin);
  });
  issue.affected = [...issue.affected.filter((a) => a !== dest), ...(issue.affected.includes(from.where) ? [] : [from.where])];
  issue.past.push(from);
  issue.log.push({ kind: 'moved', ...from });
  issue.found = null;
  issue.where = dest;
  issue.n = n;
  navigate(issueUrl(issue));
};

export const createIssue = (where: string, title: string, body: string) => {
  const n = store.issues.filter((i) => i.where === where).reduce((max, i) => Math.max(max, i.n), 0) + 1;
  const issue: Issue = { id: `${where}#${n}`, where, n, title, tag: 'new', age: 'now', closed: false, labels: [], affected: [], log: [], past: [], body };
  store.issues.unshift(issue);
  navigate(issueUrl(issue), 'Issue opened.');
};

export const createChange = (repo: string, title: string, branch: string, touches: string[]) => {
  const n = store.changes.filter((c) => c.repo === repo).reduce((max, c) => Math.max(max, c.n), 0) + 1;
  const change: Change = { id: `${repo}!${n}`, repo, n, title, branch, touches, fail: [], age: 'now' };
  store.changes.unshift(change);
  navigate(changeUrl(change), 'Change opened.');
};

export const createNode = (parentAddr: string, kind: 'group' | 'repo', name: string, description: string) => {
  const trail = trailAt(parentAddr);
  if (!trail) return;
  const children = trail[trail.length - 1].children;
  if (kind === 'group') {
    const firstRepo = children.findIndex((k) => k.kind === 'repo');
    children.splice(firstRepo === -1 ? children.length : firstRepo, 0, groupNode(name, description));
  } else {
    children.push(repoNode(name, description, { releases: [], empty: true }));
  }
  navigate(`/${parentAddr ? `${parentAddr}/` : ''}${name}`, `${kind === 'group' ? 'Group' : 'Repo'} created.`);
};

export const mergeChange = (change: Change, closing?: Issue) => {
  store.merged[change.id] = true;
  if (closing) {
    closing.closed = true;
    closing.log.push({ kind: 'status', text: `Closed by !${change.n}.` });
  }
};

export const toggleReviewed = (change: Change, key: string) => {
  const current = store.reviewed[change.id] ?? (change.rich ? { core: true } : {});
  store.reviewed[change.id] = { ...current, [key]: !current[key] };
};

export const updateSettings = (fn: (draft: Settings) => void) => {
  const next = clone(store.settingsDraft) as Settings;
  fn(next);
  store.settingsDraft = next;
};

export const saveSettings = () => {
  store.settingsSaved = clone(store.settingsDraft);
};

export const discardSettings = () => {
  store.settingsDraft = clone(store.settingsSaved);
};
