// The shell's view of the kernel: an address tree loaded a level at a time, and
// each repo's projects and issues. One store lives as long as the page, so
// `reach` and the `ensure*` calls answer from it until their copy is `MAX_AGE_MS`
// old, then read again and keep showing the old copy meanwhile.
//
// The kernel names things two ways: browse takes node paths, while projects,
// events and tools take repo ids. Only this file knows which, so components deal
// in addresses. A count that has no source is undefined, never 0.

import { inject, type InjectionKey, reactive } from "vue";
import type { Api } from "../../api/client.ts";
import type { Session } from "../../auth/session.ts";
import { ApiError, errorMessage, isApiError } from "../../api/http.ts";
import { parseAddress } from "../../router/address.ts";
import {
	type ActivityEvent,
	type Commit,
	describeEvent,
	type ForgeNode,
	type Issue,
	type IssueList,
	type PlacedIssue,
	repoOf,
	reposUnder,
	trailOf,
	urlFor,
	walk,
} from "./model.ts";

export const ISSUES_EXTENSION = "rawkode.issues";

const MAX_AGE_MS = 30_000;
const FAN_OUT = 6;
const PAGE = 100;
const ACTIVITY = 50;

/** Why a repo or project has no issue list to show. */
export type IssuesRefusal =
	| "not_installed"
	| "extension_disabled"
	| "not_found"
	| "unauthenticated"
	| "denied"
	| "error";

export type IssuesState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly list: IssueList }
	| {
		readonly status: "refused";
		readonly reason: IssuesRefusal;
		readonly message: string;
	};

export type Reach =
	| { readonly status: "found"; readonly trail: ForgeNode[] }
	| { readonly status: "missing" }
	| { readonly status: "error"; readonly message: string };

const newNode = (
	fields: Pick<ForgeNode, "name" | "kind" | "addr" | "id"> & Partial<ForgeNode>,
): ForgeNode => ({
	description: "",
	children: [],
	loaded: false,
	deps: [],
	dependents: [],
	...fields,
});

const refusalOf = (e: unknown): IssuesRefusal => {
	if (!isApiError(e)) return "error";
	if (e.status === 401) return "unauthenticated";
	if (e.code === "not_installed") return "not_installed";
	if (e.code === "extension_disabled") return "extension_disabled";
	if (e.code === "not_found") return "not_found";
	if (e.status === 403) return "denied";
	return "error";
};

const notFound = (e: unknown): boolean => isApiError(e) && e.status === 404;

export const createForgeStore = (
	api: Api,
	session: Pick<Session, "state">,
	// Settles once `session` knows who this is.
	signedIn: Promise<unknown> = Promise.resolve(),
) => {
	const state = reactive({
		// Shown once, on the page an action sent the viewer to.
		banner: null as { path: string; text: string } | null,
		tree: newNode({ name: "~", kind: "group", addr: "", id: "" }),
		// By address: a repo's, or a project's when scoped to it.
		issues: {} as Record<string, IssuesState>,
	});

	// In-flight calls and read times, by what was asked for.
	const pending = new Map<string, Promise<unknown>>();
	const readAt = new Map<string, number>();
	let active = 0;
	const waiting: (() => void)[] = [];

	const limited = async <T>(work: () => Promise<T>): Promise<T> => {
		if (active >= FAN_OUT) {
			await new Promise<void>((resume) => waiting.push(resume));
		}
		active++;
		try {
			return await work();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};

	const once = (
		key: string,
		have: boolean,
		work: () => Promise<void>,
		force = false,
	): Promise<void> => {
		const running = pending.get(key) as Promise<void> | undefined;
		if (running) return running;
		const fresh = Date.now() - (readAt.get(key) ?? 0) < MAX_AGE_MS;
		if (have && fresh && !force) return Promise.resolve();
		const run = limited(work).finally(() => {
			pending.delete(key);
			readAt.set(key, Date.now());
		});
		pending.set(key, run);
		return run;
	};

	/** A reused node keeps its own children and the tree keeps its open sections. */
	const merge = (old: ForgeNode | undefined, next: ForgeNode): ForgeNode => {
		if (!old) return next;
		const { children: _children, loaded: _loaded, ...fields } = next;
		return Object.assign(old, fields);
	};

	const ensureChildren = (group: ForgeNode, force = false): Promise<void> =>
		once(`children:${group.addr}`, group.loaded, async () => {
			try {
				const found: ForgeNode[] = [];
				let cursor: string | undefined;
				do {
					const page = await api.nodes.children(group.addr || null, cursor);
					for (const node of page.nodes) {
						found.push(merge(
							group.children.find((k) => k.name === node.slug),
							newNode({
								name: node.slug,
								kind: node.kind === "repo" ? "repo" : "group",
								addr: node.path,
								id: node.id,
								description: node.description ?? "",
								visibility: node.visibility,
								...(node.kind === "user" ? { user: true } : {}),
								...(node.defaultBranch === undefined
									? {}
									: { defaultBranch: node.defaultBranch }),
							}),
						));
					}
					cursor = page.cursor;
				} while (cursor);
				// Groups first, then repos: how the tree reads.
				group.children = [
					...found.filter((k) => k.kind === "group"),
					...found.filter((k) => k.kind === "repo"),
				];
				group.loaded = true;
				delete group.loadError;
			} catch (e) {
				group.loadError = errorMessage(e);
			}
		}, force);

	const ensureProjects = (repo: ForgeNode, force = false): Promise<void> =>
		once(`projects:${repo.addr}`, repo.loaded, async () => {
			try {
				const graph = await api.projects(repo.id);
				repo.sha = graph.sha;
				repo.children = graph.projects.map((project) =>
					merge(
						repo.children.find((k) => k.root === project.root),
						newNode({
							name: project.name,
							kind: "project",
							addr: `${repo.addr}:${project.name}`,
							id: "",
							root: project.root,
							deps: project.deps,
							dependents: project.dependents,
							issuesEnabled: project.extensions[ISSUES_EXTENSION]?.enabled ??
								true,
							...(project.manifestPath === undefined
								? {}
								: { manifestPath: project.manifestPath }),
						}),
					)
				);
				repo.loaded = true;
				delete repo.loadError;
			} catch (e) {
				// A forge deployed without `--projects` answers 404: one project.
				if (notFound(e)) {
					repo.children = [];
					repo.loaded = true;
				} else repo.loadError = errorMessage(e);
			}
		}, force);

	/** Loads every level on the way to an address, then finds it. */
	const reach = async (addr: string): Promise<Reach> => {
		const address = parseAddress(addr);
		if (!address) return { status: "missing" };
		const segments = address.path.split("/").filter(Boolean);
		let node = state.tree as ForgeNode;
		for (const segment of segments) {
			if (node.kind !== "group") return { status: "missing" };
			await ensureChildren(node);
			let next = node.children.find((k) => k.name === segment);
			// A copy from before something was created can't say it's missing.
			if (!next) {
				await ensureChildren(node, true);
				next = node.children.find((k) => k.name === segment);
			}
			if (!next) {
				return node.loadError
					? { status: "error", message: node.loadError }
					: { status: "missing" };
			}
			node = next;
		}
		if (node.kind === "repo") await ensureProjects(node);
		else await ensureChildren(node);
		if (node.loadError && !node.loaded) {
			return { status: "error", message: node.loadError };
		}
		if (address.project !== null) {
			if (!node.children.some((k) => k.name === address.project)) {
				await ensureProjects(node, true);
			}
		}
		const trail = trailOf(state.tree as ForgeNode, addr);
		return trail ? { status: "found", trail } : { status: "missing" };
	};

	const nodeAt = (addr: string): ForgeNode | null =>
		trailOf(state.tree as ForgeNode, addr)?.at(-1) ?? null;

	const issueCall = <T>(
		repo: ForgeNode,
		tool: string,
		args: Readonly<Record<string, unknown>>,
		project?: string,
	) => api.tool<T>(repo.id, ISSUES_EXTENSION, tool, args, project);

	/** The newest `PAGE` issues in a repo, or in one of its projects. */
	const ensureIssues = (addr: string, force = false): Promise<void> => {
		const repo = nodeAt(repoOf(addr));
		if (!repo || repo.kind !== "repo") return Promise.resolve();
		const project = parseAddress(addr)?.project ?? undefined;
		// What the kernel would refuse anyway stays out of the network and the console.
		if (project !== undefined) {
			const node = repo.children.find((k) => k.name === project);
			if (node?.issuesEnabled === false) {
				state.issues[addr] = {
					status: "refused",
					reason: "extension_disabled",
					message: "Issues is turned off for this project.",
				};
				return Promise.resolve();
			}
		}
		return once(`issues:${addr}`, addr in state.issues, async () => {
			if (!(addr in state.issues)) state.issues[addr] = { status: "loading" };
			await signedIn;
			if (session.state.status === "anonymous") {
				state.issues[addr] = {
					status: "refused",
					reason: "unauthenticated",
					message: "Sign in to see issues.",
				};
				return;
			}
			try {
				state.issues[addr] = {
					status: "ready",
					list: await issueCall<IssueList>(
						repo,
						"list",
						{ state: "all", limit: PAGE },
						project,
					),
				};
			} catch (e) {
				state.issues[addr] = {
					status: "refused",
					reason: refusalOf(e),
					message: errorMessage(e),
				};
			}
		}, force);
	};

	/** Every repo below a node, with its projects and issues, as far as they load. */
	const ensureSubtree = async (node: ForgeNode): Promise<void> => {
		if (node.kind === "project") return;
		if (node.kind === "repo") {
			await Promise.all([ensureProjects(node), ensureIssues(node.addr)]);
			return;
		}
		await ensureChildren(node);
		await Promise.all(node.children.map(ensureSubtree));
	};

	const loadEverything = () => ensureSubtree(state.tree as ForgeNode);

	const placed = (repo: ForgeNode, issue: Issue): PlacedIssue => {
		const home = issue.project === null
			? undefined
			: repo.children.find((k) => k.root === issue.project);
		return { ...issue, repo: repo.addr, where: home?.addr ?? repo.addr };
	};

	const issuesOf = (repoAddr: string): IssuesState | undefined =>
		state.issues[repoAddr];

	const notInstalled = (repo: ForgeNode): boolean => {
		const known = issuesOf(repo.addr);
		return known?.status === "refused" && known.reason === "not_installed";
	};

	/** A repo-wide list says nothing of what `PAGE` cut off. */
	const complete = (list: IssueList) =>
		list.issues.length >= list.open + list.closed;

	/**
	 * Open issues at a node, from the repo-wide lists: undefined until each repo
	 * below has answered, when any of them won't say, and where there are no
	 * Issues at all. A repo without them adds nothing to the groups above it.
	 */
	const openCount = (node: ForgeNode): number | undefined => {
		if (node.kind === "group") {
			if (!node.loaded) return undefined;
			let sum = 0;
			for (const child of node.children) {
				const installed = child.kind === "group" || !notInstalled(child);
				const count = installed ? openCount(child) : 0;
				if (count === undefined) return undefined;
				sum += count;
			}
			return sum;
		}
		if (node.issuesEnabled === false) return undefined;
		const known = issuesOf(repoOf(node.addr));
		if (known?.status !== "ready") return undefined;
		if (node.kind === "repo") return known.list.open;
		if (!complete(known.list)) return undefined;
		return known.list.issues.filter((i) =>
			i.project === node.root && i.state === "open"
		).length;
	};

	/** Issues at any address, newest change first, from the repo-wide lists. */
	const issuesUnder = (node: ForgeNode): PlacedIssue[] =>
		reposUnder(node).flatMap((repo) => {
			const known = issuesOf(repo.addr);
			return known?.status === "ready"
				? known.list.issues.map((i) => placed(repo, i))
				: [];
		}).sort((a, b) => b.updatedAt - a.updatedAt);

	/** Repo-wide issues can be unreadable; says which repos a total leaves out. */
	const refusedUnder = (node: ForgeNode): IssuesRefusal[] =>
		reposUnder(node).flatMap((repo) => {
			const known = issuesOf(repo.addr);
			return known?.status === "refused" && known.reason !== "not_installed"
				? [known.reason]
				: [];
		});

	const issueRepo = (addr: string): ForgeNode => {
		const repo = nodeAt(repoOf(addr));
		if (!repo) throw new Error(`no repo at ${addr}`);
		return repo;
	};

	const projectName = (addr: string) =>
		parseAddress(addr)?.project ?? undefined;

	const getIssue = async (
		addr: string,
		number: number,
	): Promise<PlacedIssue> => {
		const repo = issueRepo(addr);
		await signedIn;
		if (session.state.status === "anonymous") {
			throw new ApiError(401, "unauthenticated", "Sign in to see issues.");
		}
		const { issue } = await issueCall<{ issue: Issue }>(
			repo,
			"get",
			{ number },
			projectName(addr),
		);
		return placed(repo, issue);
	};

	/** Every list that could hold an issue of this repo. */
	const invalidateIssues = (repoAddr: string): Promise<unknown> => {
		const lists = Object.keys(state.issues).filter((k) =>
			repoOf(k) === repoAddr
		);
		return Promise.all(lists.map((addr) => ensureIssues(addr, true)));
	};

	const setBanner = (path: string, text: string) => {
		state.banner = { path, text };
	};

	const createIssue = async (
		addr: string,
		title: string,
		body: string,
	): Promise<string> => {
		const repo = issueRepo(addr);
		const { issue } = await issueCall<{ issue: Issue }>(
			repo,
			"create",
			{ title, ...(body ? { body } : {}) },
			projectName(addr),
		);
		await invalidateIssues(repo.addr);
		const url = urlFor(addr, `issues/${issue.number}`);
		setBanner(url, "Issue opened.");
		return url;
	};

	const setIssueState = async (
		addr: string,
		number: number,
		tool: "close" | "reopen",
	): Promise<PlacedIssue> => {
		const repo = issueRepo(addr);
		const { issue } = await issueCall<{ issue: Issue }>(
			repo,
			tool,
			{ number },
			projectName(addr),
		);
		await invalidateIssues(repo.addr);
		return placed(repo, issue);
	};

	const createNode = async (
		parent: ForgeNode,
		kind: "group" | "repo",
		slug: string,
		description: string,
		visibility: "public" | "private",
	): Promise<string> => {
		const common = {
			slug,
			visibility,
			...(description ? { description } : {}),
		};
		const place = parent.addr ? { parent: parent.addr } : {};
		const created = kind === "group"
			? await api.nodes.createGroup({ ...common, ...place, kind: "group" })
			: await api.nodes.createRepo({ ...common, ...place });
		await ensureChildren(parent, true);
		const url = urlFor(created.path);
		setBanner(url, `${kind === "group" ? "Group" : "Repo"} created.`);
		return url;
	};

	/** A file at the trunk tip as text, or null when it isn't there. */
	const readFile = async (
		repo: ForgeNode,
		path: string,
	): Promise<string | null> => {
		try {
			const blob = await api.browse.blob(
				repo.addr,
				repo.defaultBranch ?? "main",
				path,
			);
			return blob.text ?? null;
		} catch (e) {
			if (notFound(e)) return null;
			throw e;
		}
	};

	/** A directory's README at the trunk tip, found from its listing. */
	const readme = async (
		repo: ForgeNode,
		dir = "",
	): Promise<{ readonly path: string; readonly text: string } | null> => {
		const ref = repo.defaultBranch ?? "main";
		let entry: { readonly path: string } | undefined;
		try {
			const tree = await api.browse.tree(repo.addr, ref, dir);
			entry = tree.entries.find((e) =>
				e.type === "blob" && /^readme(\.md)?$/i.test(e.name)
			);
		} catch (e) {
			if (notFound(e)) return null;
			throw e;
		}
		if (!entry) return null;
		const text = await readFile(repo, entry.path);
		return text === null ? null : { path: entry.path, text };
	};

	/** The trunk's newest commits, or those touching one directory. */
	const commits = async (
		repo: ForgeNode,
		path?: string,
	): Promise<readonly Commit[]> => {
		try {
			const log = await api.browse.log(
				repo.addr,
				repo.defaultBranch ?? "main",
				path,
			);
			return log.commits.map((c) => ({
				sha: c.sha,
				subject: c.subject,
				authoredAt: c.authoredAt * 1000,
				authorName: c.author.name,
			}));
		} catch (e) {
			if (notFound(e)) return [];
			throw e;
		}
	};

	/** The newest of a repo's log, newest first, its commits named from the trunk. */
	const activity = async (
		repo: ForgeNode,
		handle: (id: string) => string | null,
	): Promise<readonly ActivityEvent[]> => {
		await signedIn;
		// The event log is for signed-in callers.
		if (session.state.status === "anonymous") return [];
		const { head } = await api.events.list(repo.id, { limit: 1 });
		const [{ events }, log] = await Promise.all([
			api.events.list(repo.id, {
				since: Math.max(0, head - ACTIVITY),
				limit: ACTIVITY,
			}),
			commits(repo),
		]);
		const subjects = new Map(log.map((c) => [c.sha, c.subject]));
		return events.filter((e) => e.type !== "push.diffed").reverse().map(
			(event) => {
				const { text, sha } = describeEvent(
					event.type,
					event.data as Readonly<Record<string, unknown>>,
				);
				const subject = sha === undefined ? undefined : subjects.get(sha);
				return {
					seq: event.seq,
					type: event.type,
					at: event.at,
					actor: handle(event.actor.id) ?? event.actor.kind,
					text,
					...(sha === undefined ? {} : { sha }),
					...(subject === undefined ? {} : { subject }),
				};
			},
		);
	};

	return {
		state,
		reach,
		nodeAt,
		ensureChildren,
		ensureProjects,
		ensureIssues,
		ensureSubtree,
		loadEverything,
		openCount,
		issuesUnder,
		refusedUnder,
		placed,
		issuesAt: (addr: string): IssuesState | undefined => state.issues[addr],
		getIssue,
		createIssue,
		setIssueState,
		createNode,
		setBanner,
		readFile,
		readme,
		commits,
		activity,
		everything: () => walk(state.tree as ForgeNode),
	};
};

export type ForgeStore = ReturnType<typeof createForgeStore>;

export const FORGE: InjectionKey<ForgeStore> = Symbol("forge");

export const useForge = (): ForgeStore => {
	const store = inject(FORGE, null);
	if (store === null) throw new Error("forge store is not provided");
	return store;
};
