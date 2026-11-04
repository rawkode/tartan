import { KILN, PLATFORM, addrOf, type ForgeNode } from './forge';

export type ValueMeta = {
  key: string;
  name: string;
  hint: string;
  repoOnly: boolean;
  options: string[];
  why: string;
};

export type ListMeta = { key: string; name: string; noun: string; hint: string };

export type ValueState = { set: Record<string, string>; lock: string | null };
export type ListState = { add: Record<string, string[]>; drop: Record<string, string[]> };
export type Settings = Record<string, ValueState | ListState>;

export const settingValues: ValueMeta[] = [
  { key: 'visibility', name: 'Visibility', hint: 'Who can see the repo without signing in.', repoOnly: true, options: ['Private', 'Unlisted', 'Public'], why: 'Every project in a repo shares the same git data, so visibility stops at the repo.' },
  { key: 'branch', name: 'Default branch', hint: 'The merge target, and the first branch in new repos.', repoOnly: true, options: ['main', 'trunk'], why: 'A repo has one default branch, shared by all its projects.' },
  { key: 'merge', name: 'Merge method', hint: 'How a change lands on the default branch.', repoOnly: true, options: ['Merge', 'Squash', 'Rebase'], why: 'Changes belong to the repo, so a project can’t choose its own method.' },
  { key: 'force', name: 'Force push', hint: 'Whether the default branch can be rewritten.', repoOnly: true, options: ['Blocked', 'Allowed'], why: 'Branches belong to the repo, not to a project.' },
  { key: 'signing', name: 'Signed commits', hint: 'Reject pushes that contain unsigned commits.', repoOnly: true, options: ['Optional', 'Required'], why: 'A commit can span projects, so this stops at the repo.' },
  { key: 'mirror', name: 'Mirror to', hint: 'Push a copy after every merge.', repoOnly: true, options: ['Off', 'GitHub', 'Codeberg'], why: 'Mirrors copy whole repos.' },
  { key: 'tags', name: 'Release tags', hint: 'Tag format. {project} keeps tags unique inside a monorepo.', repoOnly: false, options: ['v*', '{project}/v*'], why: '' },
  { key: 'timeout', name: 'CI timeout', hint: 'The longest a single run can take.', repoOnly: false, options: ['15 min', '30 min', '45 min', '60 min'], why: '' },
];

export const settingLists: ListMeta[] = [
  { key: 'labels', name: 'Labels', noun: 'label', hint: 'Available on issues and changes.' },
  { key: 'checks', name: 'Required checks', noun: 'check', hint: 'Must pass before a change can merge.' },
  { key: 'secrets', name: 'CI secrets', noun: 'secret', hint: 'Names only. Values are write-only and never shown.' },
];

export const settingDefaults = (): Settings => ({
  visibility: { set: { '': 'Private', oss: 'Public', writing: 'Public' }, lock: null },
  branch: { set: { '': 'main' }, lock: null },
  merge: { set: { '': 'Rebase', 'oss/devtools/build': 'Squash', 'oss/libraries/rust': 'Merge' }, lock: null },
  force: { set: { '': 'Blocked' }, lock: '' },
  signing: { set: { '': 'Optional', oss: 'Required' }, lock: null },
  mirror: { set: { '': 'Off', oss: 'GitHub' }, lock: null },
  tags: { set: { '': 'v*', [KILN]: '{project}/v*', [PLATFORM]: '{project}/v*' }, lock: null },
  timeout: { set: { '': '30 min', [KILN]: '45 min', [`${KILN}:lsp`]: '15 min' }, lock: null },
  labels: { add: { '': ['bug', 'feature', 'docs', 'chore'], oss: ['good first issue'], [KILN]: ['perf'], [`${KILN}:lsp`]: ['protocol'], writing: ['draft'] }, drop: { oss: ['chore'] } },
  checks: { add: { '': ['secret-scan'], oss: ['licence'], [KILN]: ['kiln-test'], [`${KILN}:lsp`]: ['lsp-conformance'] }, drop: {} },
  secrets: { add: { '': ['FORGE_TOKEN'], oss: ['CRATES_TOKEN'], [KILN]: ['REGISTRY_TOKEN'] }, drop: {} },
});

export type Level = { node: ForgeNode; addr: string };

export const levelsOf = (trail: ForgeNode[]): Level[] =>
  trail.map((node, i) => ({ node, addr: addrOf(trail.slice(0, i + 1)) }));

export type ValueStep =
  | { na: true }
  | {
      na: false;
      own?: string;
      has: boolean;
      ignored: boolean;
      value: string;
      origin: number;
      lockedAt: number | null;
      prevValue: string;
      prevOrigin: number;
    };

// Nearest level wins, unless a level above locked the value.
export const walkValue = (meta: ValueMeta, state: ValueState, levels: Level[]) => {
  const out: ValueStep[] = [];
  let value = '';
  let origin = -1;
  let lockedAt: number | null = null;
  levels.forEach((level, i) => {
    if (meta.repoOnly && level.node.kind === 'project') {
      out.push({ na: true });
      return;
    }
    const own = state.set[level.addr];
    const has = own !== undefined;
    const ignored = has && lockedAt !== null;
    const prevValue = value;
    const prevOrigin = origin;
    if (has && !ignored) {
      value = own;
      origin = i;
    }
    if (state.lock === level.addr && has && !ignored) lockedAt = i;
    out.push({ na: false, own, has, ignored, value, origin, lockedAt, prevValue, prevOrigin });
  });
  return out;
};

export type ListStep = {
  add: string[];
  drop: string[];
  items: { name: string; origin: number }[];
  has: boolean;
  count: number;
};

// Each level adds to what it inherits, and can drop entries it doesn't want.
export const walkList = (state: ListState, levels: Level[]) => {
  const out: ListStep[] = [];
  let items: ListStep['items'] = [];
  levels.forEach((level, i) => {
    const add = state.add[level.addr] ?? [];
    const drop = state.drop[level.addr] ?? [];
    items = [...items.filter((x) => !drop.includes(x.name)), ...add.map((name) => ({ name, origin: i }))];
    out.push({ add, drop, items, has: add.length > 0 || drop.length > 0, count: items.length });
  });
  return out;
};

export const labelOrigin = (settings: Settings, name: string) => {
  const add = (settings.labels as ListState).add;
  const hit = Object.keys(add).find((addr) => add[addr].includes(name));
  return hit === undefined ? null : hit;
};

export const cueFile = (repo: ForgeNode, repoAddr: string, settings: Settings) => {
  const quoted = (list: string[]) => `[${list.map((x) => `"${x}"`).join(', ')}]`;
  const timeout = (settings.timeout as ValueState).set;
  const labels = (settings.labels as ListState).add;
  const checks = (settings.checks as ListState).add;
  const lines = repo.children
    .filter((k) => k.name !== 'root')
    .map((k) => {
      const addr = `${repoAddr}:${k.name}`;
      const fields = [`path: "${k.path}"`];
      if (k.deps.length) fields.push(`dependsOn: ${quoted(k.deps)}`);
      if (timeout[addr]) fields.push(`ci: timeout: "${timeout[addr]}"`);
      if (labels[addr]) fields.push(`labels: ${quoted(labels[addr])}`);
      if (checks[addr]) fields.push(`checks: ${quoted(checks[addr])}`);
      if (fields.length === 1) return `\t${k.name}: ${fields[0]}`;
      if (fields.length === 2) return `\t${k.name}: {${fields.join(', ')}}`;
      return `\t${k.name}: {\n\t\t${fields.join('\n\t\t')}\n\t}`;
    });
  return `package forge\n\nprojects: {\n${lines.join('\n')}\n}`;
};

export const cueLine = (project: string, key: string, value: unknown) =>
  `projects: ${project}: ${key === 'timeout' ? 'ci: timeout' : key}: ${JSON.stringify(value).replace(/,/g, ', ')}`;
