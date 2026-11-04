export type NodeKind = 'group' | 'repo' | 'project';

export type ForgeNode = {
  name: string;
  kind: NodeKind;
  description: string;
  children: ForgeNode[];
  deps: string[];
  path?: string;
  releases?: [tag: string, age: string][];
  // What is failing on the default branch, if anything.
  fail?: string;
  readme?: boolean;
  // A repo nothing has been pushed to yet.
  empty?: boolean;
};

export type Issue = {
  id: string;
  where: string;
  n: number;
  title: string;
  tag: string;
  age: string;
  closed: boolean;
  labels: string[];
  affected: string[];
  log: IssueLog[];
  past: { where: string; n: number }[];
  found?: string | null;
  rich?: boolean;
  body?: string;
};

export type IssueLog =
  | { kind: 'note'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'moved'; where: string; n: number };

export type Change = {
  id: string;
  repo: string;
  n: number;
  title: string;
  branch: string;
  touches: string[];
  fail: string[];
  age: string;
  closes?: string;
  rich?: boolean;
  bumps?: Record<string, [from: string, to: string]>;
};

export type Commit = { sha: string; subject: string; projects: string[]; age: string };
export type ForgeEvent = { repo: string; sha: string; subject: string; age: string; projects: string[] };
export type Diff = { key: string; file: string; lines: string[] };

const group = (name: string, description: string, children: ForgeNode[]): ForgeNode => ({
  name,
  kind: 'group',
  description,
  children,
  deps: [],
});

export const repoNode = (name: string, description: string, extra: Partial<ForgeNode> = {}, children: ForgeNode[] = []): ForgeNode => ({
  name,
  kind: 'repo',
  description,
  children,
  deps: [],
  ...extra,
});

export const groupNode = (name: string, description: string) => group(name, description, []);

const project = (name: string, path: string, description: string, extra: Partial<ForgeNode> = {}): ForgeNode => ({
  name,
  kind: 'project',
  path,
  description,
  children: [],
  deps: [],
  ...extra,
});

export const buildTree = () =>
  group('~', 'Everything you keep here. Groups nest as deep as you like, and repos sit at any level.', [
    group('oss', 'Things published for other people.', [
      group('devtools', 'Tools for building software.', [
        group('build', 'Build systems and everything around them.', [
          repoNode('kiln', 'Task runner and build graph for polyglot repos.', {}, [
            project('core', 'crates/core', 'Workspace model, task graph and cache keys.', { releases: [['core/v1.8.0', '10d']] }),
            project('cli', 'crates/cli', 'The kiln command.', { deps: ['core'], releases: [['cli/v1.8.0', '10d']] }),
            project('lsp', 'crates/lsp', 'Language server for kiln.toml and the task graph.', { deps: ['core'], readme: true, releases: [['lsp/v0.9.2', '12d'], ['lsp/v0.9.1', '5w'], ['lsp/v0.9.0', '2mo']] }),
            project('registry', 'services/registry', 'Hosted package registry.', { deps: ['core'], releases: [['registry/v2.3.1', '14d']] }),
            project('vscode', 'editors/vscode', 'Editor extension that wraps lsp.', { deps: ['lsp'], releases: [['vscode/v0.9.2', '12d']] }),
            project('action', 'integrations/action', 'CI action that runs kiln with a shared cache.', { deps: ['cli'], releases: [['action/v3.0.0', '11d']] }),
            project('docs', 'site/docs', 'Documentation site.', { fail: 'Link checker found 3 broken links.', releases: [] }),
            project('root', '.', 'Anything no other project claims.', { releases: [] }),
          ]),
          repoNode('kiln-examples', 'Sample repos used by the kiln test suite.', { releases: [['v0.3.0', '6w']] }),
          repoNode('remote-cache', 'Content-addressed cache server.', { releases: [['v2.1.0', '3w']] }),
        ]),
        group('editors', 'Editor grammars and plugins.', [
          repoNode('treesitter-kiln', 'Tree-sitter grammar for kiln.toml.', { releases: [['v0.4.1', '2mo']] }),
        ]),
        repoNode('git-tools', 'Small git helpers.', { releases: [['v1.2.0', '9d']] }),
      ]),
      group('libraries', 'Reusable libraries.', [
        group('rust', 'Rust crates.', [
          repoNode('semver-lite', 'Version parsing without dependencies.', { releases: [['v0.7.0', '11d']] }),
          repoNode('toml-patch', 'Edit TOML while keeping comments and layout.', { releases: [['v1.0.2', '4w']] }),
        ]),
      ]),
    ]),
    group('infra', 'Machines and services I run.', [
      group('homelab', 'Hardware at home.', [
        repoNode('nodes', 'Host configuration for every machine.', { releases: [] }),
        repoNode('dns', 'Zones and split-horizon records.', { releases: [] }),
      ]),
      group('cloud', 'Anything rented.', [
        repoNode('edge', 'Reverse proxies and certificates.', { releases: [] }),
        repoNode('platform', 'The services everything else runs behind.', {}, [
          project('shared', 'libs/shared', 'Config, tracing and retry helpers.', { releases: [['shared/v0.6.0', '3w']] }),
          project('gateway', 'services/gateway', 'Routing, auth and rate limits.', { deps: ['shared'], releases: [['gateway/v0.6.1', '4d'], ['gateway/v0.6.0', '3w']] }),
          project('metrics', 'services/metrics', 'Collects and stores service metrics.', { deps: ['shared'], releases: [['metrics/v0.3.0', '2w']] }),
          project('deploy', 'deploy/terraform', 'Infrastructure for every service.', { releases: [] }),
          project('root', '.', 'Anything no other project claims.', { releases: [] }),
        ]),
      ]),
    ]),
    group('clients', 'Paid work, kept private.', [
      group('halden', 'Halden Joinery.', [repoNode('site', 'Marketing site.', { releases: [] })]),
    ]),
    group('writing', 'Words.', [
      group('talks', 'Slides and demos.', [
        group('2026', 'This year.', [repoNode('monorepo-lessons', 'Talk on moving everything to one repo.', { releases: [] })]),
      ]),
      repoNode('blog', 'Posts and drafts.', { releases: [] }),
    ]),
    repoNode('dotfiles', 'Shell and editor configuration.', { releases: [] }),
  ]);

const BUILD = 'oss/devtools/build/';
export const KILN = `${BUILD}kiln`;
export const PLATFORM = 'infra/cloud/platform';

export const defaultIssues = (): Issue[] => {
  const rows: [string, number, string, string, string][] = [
    [`${KILN}:lsp`, 128, 'Go-to-definition fails across workspace members', 'bug', '2h'],
    [`${KILN}:core`, 311, 'Cache key ignores environment passthrough', 'bug', '5h'],
    [`${KILN}:root`, 9, 'Release script assumes a clean worktree', 'chore', '6h'],
    [`${PLATFORM}:gateway`, 24, 'Rate limit counters reset on every deploy', 'bug', '7h'],
    ['infra/homelab/nodes', 19, 'Rebuild nas-02 with the new ZFS pool layout', 'chore', '8h'],
    [`${KILN}:lsp`, 131, 'Hover shows a stale task graph after editing kiln.toml', 'bug', '1d'],
    [`${KILN}:cli`, 207, 'kiln run --affected should accept a change id', 'feature', '1d'],
    [`${BUILD}remote-cache`, 44, 'Evict by last read, not last write', 'feature', '2d'],
    [`${KILN}:registry`, 58, 'Yank endpoint returns 500 on scoped packages', 'bug', '2d'],
    [`${PLATFORM}:metrics`, 11, 'Retention setting is ignored for new series', 'bug', '2d'],
    [`${KILN}:lsp`, 119, 'Semantic tokens for task references', 'feature', '3d'],
    ['clients/halden/site', 7, 'Contact form drops non-ASCII names', 'bug', '3d'],
    [`${KILN}:docs`, 76, 'Monorepo guide still uses the old workspace syntax', 'docs', '4d'],
    ['oss/libraries/rust/toml-patch', 6, 'Comments vanish when a table is removed', 'bug', '4d'],
    [`${KILN}:core`, 298, 'Parallelism limit ignored inside nested workspaces', 'bug', '5d'],
    ['infra/cloud/edge', 8, 'Certificate renewal alert fires twice', 'bug', '5d'],
    [`${KILN}:vscode`, 40, 'Task graph panel loses its scroll position', 'bug', '6d'],
    ['infra/homelab/nodes', 17, 'Move backups off the old pool', 'chore', '6d'],
    [`${KILN}:lsp`, 112, 'Completion for task names in kiln.toml', 'feature', '1w'],
    ['writing/blog', 23, 'Draft: what moving to one repo actually changed', 'draft', '1w'],
    [`${KILN}:cli`, 199, 'Shell completions for fish', 'feature', '1w'],
    [`${PLATFORM}:deploy`, 16, 'Split the state file by environment', 'chore', '1w'],
    [`${BUILD}remote-cache`, 41, 'Report hit rate per project', 'feature', '1w'],
    ['oss/devtools/git-tools', 14, 'Stacked rebase loses the base commit', 'bug', '1w'],
    [`${KILN}:core`, 287, 'Task graph snapshot grows without bound', 'bug', '2w'],
    [`${KILN}:lsp`, 104, 'Workspace symbol search is slow over 5k files', 'perf', '2w'],
    ['infra/homelab/dns', 6, 'Split-horizon record for forge.internal', 'chore', '2w'],
    [`${KILN}:registry`, 52, 'Show download counts per version', 'feature', '2w'],
    [`${PLATFORM}:gateway`, 19, 'Trace ids for upstream retries', 'feature', '2w'],
    ['oss/libraries/rust/semver-lite', 18, 'Reject leading zeros in pre-release ids', 'bug', '2w'],
    ['clients/halden/site', 6, 'Gallery images load at full size', 'perf', '2w'],
    [`${BUILD}kiln-examples`, 3, 'Add a multi-member fixture', 'feature', '2d'],
    [`${KILN}:docs`, 71, 'Landing page hero image is too large', 'docs', '3w'],
    [`${PLATFORM}:shared`, 7, 'Drop the vendored retry helper', 'chore', '3w'],
    [`${KILN}:core`, 264, 'Derive macro errors point at the wrong span', 'bug', '3w'],
    [`${KILN}:cli`, 188, 'kiln fmt wraps long task lists badly', 'bug', '3w'],
    ['infra/homelab/nodes', 15, 'Label every disk by bay', 'chore', '3w'],
    ['infra/cloud/edge', 5, 'Drop the old staging hostnames', 'chore', '4w'],
    ['oss/devtools/git-tools', 11, 'Document the worktree helper', 'docs', '4w'],
    [`${BUILD}remote-cache`, 37, 'Compress blobs at rest', 'feature', '5w'],
    ['oss/libraries/rust/semver-lite', 12, 'Add a range intersection helper', 'feature', '5w'],
    ['writing/blog', 21, 'Fix the RSS feed dates', 'bug', '6w'],
    ['writing/talks/2026/monorepo-lessons', 2, 'Cut the talk to 25 minutes', 'draft', '6w'],
    ['clients/halden/site', 4, 'Add the new workshop address', 'chore', '6w'],
    ['infra/homelab/nodes', 12, 'Replace the failing fan in nas-01', 'chore', '2mo'],
  ];
  return rows.map(([where, n, title, tag, age]) => {
    const issue: Issue = { id: `${where}#${n}`, where, n, title, tag, age, closed: false, labels: [tag], affected: [], log: [], past: [] };
    return where === `${KILN}:lsp` && n === 128
      ? { ...issue, labels: ['bug', 'protocol'], found: 'lsp/v0.9.2', affected: [`${KILN}:core`], rich: true }
      : issue;
  });
};

export const defaultChanges = (): Change[] => [
  { id: `${KILN}!412`, repo: KILN, n: 412, title: 'Resolve workspace members through the shared index', branch: 'workspace-index', touches: ['core', 'lsp', 'cli'], fail: ['lsp'], age: '2h', closes: `${KILN}:lsp#128`, rich: true, bumps: { core: ['1.8.0', '1.9.0'], lsp: ['0.9.2', '0.9.3'], cli: ['1.8.0', '1.8.1'] } },
  { id: 'infra/homelab/nodes!33', repo: 'infra/homelab/nodes', n: 33, title: 'Rebuild nas-02 with the new pool layout', branch: 'nas-02', touches: [], fail: [], age: '8h' },
  { id: `${PLATFORM}!27`, repo: PLATFORM, n: 27, title: 'Keep rate limit counters across deploys', branch: 'durable-limits', touches: ['shared', 'gateway'], fail: [], age: '9h', closes: `${PLATFORM}:gateway#24` },
  { id: `${KILN}!405`, repo: KILN, n: 405, title: 'Cancel stale diagnostics when a file changes', branch: 'cancel-diagnostics', touches: ['lsp'], fail: [], age: '1d' },
  { id: `${BUILD}remote-cache!21`, repo: `${BUILD}remote-cache`, n: 21, title: 'Evict by last read, behind a flag', branch: 'evict-last-read', touches: [], fail: [], age: '2d' },
  { id: `${KILN}!398`, repo: KILN, n: 398, title: 'Hash task inputs in parallel', branch: 'parallel-hash', touches: ['core'], fail: [], age: '3d' },
  { id: 'clients/halden/site!15', repo: 'clients/halden/site', n: 15, title: 'Accept non-ASCII names on the contact form', branch: 'unicode-names', touches: [], fail: [], age: '3d' },
  { id: 'oss/libraries/rust/toml-patch!9', repo: 'oss/libraries/rust/toml-patch', n: 9, title: 'Keep comments when a table is removed', branch: 'keep-comments', touches: [], fail: [], age: '4d' },
  { id: `${KILN}!387`, repo: KILN, n: 387, title: 'Show the task graph in the sidebar', branch: 'graph-panel', touches: ['vscode'], fail: [], age: '5d' },
];

const commitRows = (rows: readonly (readonly [string, string, string, string])[]): Commit[] =>
  rows.map(([sha, subject, projects, age]) => ({ sha, subject, projects: projects.split(' '), age }));

const commitLog: Record<string, Commit[]> = {
  [KILN]: commitRows([
    ['7e01b4c', 'Add task graph snapshot format', 'core', '3w'],
    ['19af3d2', 'Snapshot-based --affected', 'core cli', '3w'],
    ['c2d8e10', 'Fix link to the install guide', 'docs', '3w'],
    ['58b1f7a', 'Publish with provenance', 'registry action root', '19d'],
    ['0ad4e63', 'Document --affected', 'cli docs', '19d'],
    ['b93c7d1', 'Diagnostics for unknown tasks', 'lsp', '18d'],
    ['44e0ac9', 'Expose task spans from the parser', 'core lsp', '17d'],
    ['e17f2b6', 'Highlight task references', 'lsp vscode', '16d'],
    ['6cd90a3', 'Retry uploads with backoff', 'registry', '14d'],
    ['a5720ef', 'Release lsp 0.9.2', 'lsp vscode', '12d'],
    ['3f8c1d4', 'Bump the action runtime', 'action', '11d'],
    ['d06b9e7', 'Scoped package names', 'core cli lsp registry', '10d'],
    ['82ea4f0', 'Guide to scoped packages', 'docs', '9d'],
    ['17c3b5a', 'Trim parser allocations', 'core', '8d'],
    ['f4a92c8', 'Watch kiln.toml from the extension', 'vscode', '7d'],
    ['2b6de01', 'Restart the server on config change', 'lsp vscode', '6d'],
    ['90fd7c3', 'Hash declared inputs only', 'core', '6d'],
    ['c81e4a6', 'Tidy the release scripts', 'root', '5d'],
    ['5ea07b2', 'Cache auth for the action', 'cli action', '5d'],
    ['3d19f6e', 'Move docs to the new theme', 'docs', '4d'],
    ['b70c2a9', 'Member index data structure', 'core', '3d'],
    ['6f1ea83', 'Longest-prefix lookup in the index', 'core', '3d'],
    ['08dc5b7', 'Nested workspace fixtures', 'core cli lsp', '2d'],
    ['e3a6d19', 'Debounce diagnostics', 'lsp', '2d'],
    ['7b42c0f', 'Shared version for all crates', 'core cli lsp registry root', '1d'],
    ['a41c9e2', 'Pin the toolchain', 'core cli lsp registry vscode action root', '1d'],
    ['1ce8b70', 'Add a link checker', 'docs', '9h'],
    ['9d57ae4', 'Trace spans for task execution', 'core cli', '3h'],
  ]),
  [PLATFORM]: commitRows([
    ['4be17a0', 'Add the shared retry helper', 'shared', '4w'],
    ['91c0d3e', 'Route through the shared config', 'shared gateway metrics', '3w'],
    ['d2f86b1', 'Release gateway 0.6.0', 'gateway', '3w'],
    ['60ae29c', 'Move state to object storage', 'deploy', '3w'],
    ['b7713fd', 'Store metrics in daily blocks', 'metrics', '2w'],
    ['2ec94a8', 'Pin provider versions', 'deploy root', '2w'],
    ['f03b6d7', 'Trace requests through the gateway', 'shared gateway', '10d'],
    ['7a15ce2', 'Reject oversized headers', 'gateway', '4d'],
    ['c6d2e91', 'Add a staging environment', 'deploy', '2d'],
    ['18fa07b', 'Tidy the Makefile', 'root', '11h'],
  ]),
};

export const commitsFor = (repo: string) => commitLog[repo] ?? [];

export const hours = (age: string) => {
  const m = /^(\d+)(h|d|w|mo)$/.exec(age);
  return m ? Number(m[1]) * { h: 1, d: 24, w: 168, mo: 720 }[m[2] as 'h' | 'd' | 'w' | 'mo'] : 0;
};

const otherEvents: [string, string, string, string][] = [
  ['infra/homelab/nodes', 'c70f2e8', 'Rebuild nas-02 pool layout', '8h'],
  [`${BUILD}remote-cache`, 'e11b03a', 'Evict by last read, behind a flag', '2d'],
  [`${BUILD}kiln-examples`, '77a0c19', 'Add a multi-member fixture', '2d'],
  ['clients/halden/site', 'f2c61d0', 'Accept non-ASCII names', '3d'],
  ['dotfiles', '02fe9c7', 'Switch terminal font', '3d'],
  ['oss/libraries/rust/toml-patch', '8e30b15', 'Keep comments on removed keys', '4d'],
  ['infra/cloud/edge', 'a93e77c', 'Rotate certificates', '5d'],
  [`${BUILD}remote-cache`, '4cd81f2', 'Bound the upload queue', '6d'],
  ['writing/blog', '6ab02e4', 'Draft: moving to one repo', '1w'],
  ['oss/devtools/git-tools', 'b20e6d4', 'Add a stacked rebase helper', '9d'],
  ['oss/libraries/rust/semver-lite', 'd19c7aa', 'Parse build metadata', '11d'],
  ['oss/devtools/editors/treesitter-kiln', '1fa93cd', 'Highlight task references', '16d'],
  ['infra/homelab/dns', '40bd1a6', 'Add forge.internal zone', '2w'],
  ['writing/talks/2026/monorepo-lessons', '39de5b1', 'Outline the talk', '2w'],
];

export const events: ForgeEvent[] = [
  ...Object.entries(commitLog).flatMap(([repo, log]) => log.map((c) => ({ repo, sha: c.sha, subject: c.subject, age: c.age, projects: c.projects }))),
  ...otherEvents.map(([repo, sha, subject, age]) => ({ repo, sha, subject, age, projects: [] })),
].sort((a, b) => hours(a.age) - hours(b.age));

export const diffFor = (id: string): Diff[] =>
  id !== `${KILN}!412`
    ? []
    : [
        {
          key: 'core',
          file: 'crates/core/src/workspace.rs',
          lines: [
            ' pub struct Workspace {',
            '     root: PathBuf,',
            '-    members: Vec<PathBuf>,',
            '+    index: MemberIndex,',
            ' }',
            '  ',
            ' impl Workspace {',
            '-    pub fn member_for(&self, path: &Path) -> Option<&PathBuf> {',
            '-        self.members.iter().find(|m| path.starts_with(m))',
            '+    pub fn member_for(&self, path: &Path) -> Option<&Member> {',
            '+        self.index.longest_prefix(path)',
            '     }',
            ' }',
          ],
        },
        {
          key: 'lsp',
          file: 'crates/lsp/src/definition.rs',
          lines: [
            ' pub fn goto_definition(ws: &Workspace, at: Position) -> Option<Location> {',
            '     let task = ws.task_at(at)?;',
            '-    let member = ws.current_member()?;',
            '-    member.find_task(&task.name).map(Location::from)',
            '+    let member = ws.member_for(&task.declared_in)?;',
            '+    member.resolve(&task.name).map(Location::from)',
            ' }',
          ],
        },
        {
          key: 'cli',
          file: 'crates/cli/src/commands/run.rs',
          lines: [
            ' let ws = Workspace::discover(&cwd)?;',
            '-let member = ws.member_for(&cwd).cloned();',
            '+let member = ws.member_for(&cwd).map(|m| m.path.clone());',
            ' run_tasks(&ws, member, &args.tasks)',
          ],
        },
      ];

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// Addresses: groups and repos join with "/", a project joins its repo with ":".
export const splitAddr = (addr: string) => addr.split(/[/:]/).filter(Boolean);

export const trailOf = (tree: ForgeNode, addr: string) => {
  const out = [tree];
  for (const name of splitAddr(addr)) {
    const next = out[out.length - 1].children.find((k) => k.name === name);
    if (!next) return null;
    out.push(next);
  }
  return out;
};

export const addrOf = (trail: ForgeNode[]) =>
  trail.slice(1).reduce((acc, node) => (acc ? `${acc}${node.kind === 'project' ? ':' : '/'}${node.name}` : node.name), '');

export const under = (where: string, addr: string) =>
  !addr || where === addr || where.startsWith(`${addr}/`) || where.startsWith(`${addr}:`);

// Addresses read like relative paths from the current scope. kiln:root is written as plain kiln.
export const rel = (scope: string, where: string) => {
  const s = scope.replace(/:root$/, '');
  const w = where.replace(/:root$/, '');
  if (w === s) return '';
  if (!s) return w;
  if (w.startsWith(`${s}/`) || w.startsWith(`${s}:`)) return w.slice(s.length + 1);
  const sRepo = s.split(':')[0];
  const wParts = w.split(':');
  if (sRepo === wParts[0]) return wParts[1] || wParts[0].split('/').pop()!;
  const parent = (a: string) => a.split('/').slice(0, -1).join('/');
  if (parent(sRepo) === parent(wParts[0])) return `../${w.split('/').pop()}`;
  return `~/${w}`;
};

export const changeLabel = (scope: string, change: Change) =>
  `${scope.split(':')[0] === change.repo ? '' : rel(scope, change.repo)}!${change.n}`;

export const short = (where: string, n: number) => {
  const parts = where.replace(/:root$/, '').split(':');
  return `${parts[1] || parts[0].split('/').pop()}#${n}`;
};

export const named = (node: ForgeNode) => node.children.filter((k) => k.name !== 'root').length;

export const repoCount = (node: ForgeNode): number =>
  node.kind === 'repo' ? 1 : node.kind === 'project' ? 0 : node.children.reduce((sum, k) => sum + repoCount(k), 0);

// A repo is one project unless it splits into several. Its root project isn't counted as one of them.
const isProject = (node: ForgeNode) =>
  node.kind === 'project' ? node.name !== 'root' : node.kind === 'repo' && !node.children.length;

export const failingUnder = (node: ForgeNode, trail: ForgeNode[], out: { addr: string; node: ForgeNode }[] = []) => {
  const here = [...trail, node];
  if (node.fail) out.push({ addr: addrOf(here), node });
  node.children.forEach((k) => failingUnder(k, here, out));
  return out;
};

export const walk = (node: ForgeNode, trail: ForgeNode[] = [], out: { addr: string; node: ForgeNode }[] = []) => {
  const here = [...trail, node];
  out.push({ addr: addrOf(here), node });
  node.children.forEach((k) => walk(k, here, out));
  return out;
};

export const projectsUnder = (node: ForgeNode, trail: ForgeNode[]) => walk(node, trail).filter((k) => isProject(k.node));

export type Tab = 'overview' | 'projects' | 'issues' | 'changes' | 'activity' | 'settings';

export type Route = {
  addr: string;
  tab: Tab;
  detail?:
    | { type: 'issue'; n: number }
    | { type: 'change'; n: number }
    | { type: 'new-node'; kind: 'group' | 'repo' }
    | { type: 'new-issue' }
    | { type: 'new-change' };
  unknown?: boolean;
};

export const urlFor = (addr: string, page = '') => (page ? `${addr ? `/${addr}` : ''}/-/${page}` : `/${addr}`);

export const parseUrl = (pathname: string): Route => {
  const clean = decodeURIComponent(pathname).replace(/^\/|\/$/g, '');
  const [left, page = ''] = clean.startsWith('-/') ? ['', clean.slice(2)] : clean.split('/-/');
  const addr = left;
  const [head, sub] = page.split('/');
  if (!page) return { addr, tab: 'overview' };
  if (head === 'new') return { addr, tab: 'overview', detail: { type: 'new-node', kind: sub === 'group' ? 'group' : 'repo' } };
  if (head === 'issues' && sub === 'new') return { addr, tab: 'issues', detail: { type: 'new-issue' } };
  if (head === 'changes' && sub === 'new') return { addr, tab: 'changes', detail: { type: 'new-change' } };
  if (head === 'issues' && sub) return { addr, tab: 'issues', detail: { type: 'issue', n: Number(sub) } };
  if (head === 'changes' && sub) return { addr, tab: 'changes', detail: { type: 'change', n: Number(sub) } };
  if (head === 'projects' || head === 'issues' || head === 'changes' || head === 'activity' || head === 'settings') return { addr, tab: head };
  return { addr, tab: 'overview', unknown: true };
};

export const titleFor = (route: Route) => {
  const place = splitAddr(route.addr).pop() ?? 'Everything';
  if (route.detail?.type === 'issue') return `#${route.detail.n} · ${place}`;
  if (route.detail?.type === 'change') return `!${route.detail.n} · ${place}`;
  if (route.detail?.type === 'new-node') return `New ${route.detail.kind} · ${place}`;
  if (route.detail?.type === 'new-issue') return `New issue · ${place}`;
  if (route.detail?.type === 'new-change') return `New change · ${place}`;
  return route.tab === 'overview' ? place : `${route.tab[0].toUpperCase()}${route.tab.slice(1)} · ${place}`;
};

// Every page known at build time. Anything created in the browser only exists until a reload.
export const staticUrls = () => {
  const tree = buildTree();
  const urls: string[] = [];
  for (const { addr, node } of walk(tree)) {
    urls.push(urlFor(addr));
    for (const tab of ['issues', 'changes', 'activity', 'settings']) urls.push(urlFor(addr, tab));
    if (node.kind === 'group') urls.push(urlFor(addr, 'projects'), urlFor(addr, 'new/group'), urlFor(addr, 'new/repo'));
    else urls.push(urlFor(addr, 'issues/new'), urlFor(addr, 'changes/new'));
  }
  for (const issue of defaultIssues()) urls.push(urlFor(issue.where, `issues/${issue.n}`));
  for (const change of defaultChanges()) urls.push(urlFor(change.repo, `changes/${change.n}`));
  return urls;
};
