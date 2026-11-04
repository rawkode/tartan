// The forge shell's address tree: its types and pure helpers.
//
// Addresses: groups and repos join with "/", a project joins its repo with ":"
// (`router/address.ts`); "/-/" separates an address from a page on it.

import { parseAddress } from "../../router/address.ts";

export type NodeKind = "group" | "repo" | "project";

export type ForgeNode = {
	/** The last part of the address. */
	name: string;
	kind: NodeKind;
	/** The address: a group's or repo's is also its kernel node path. */
	addr: string;
	/** The kernel's node id; empty for the forge root and for a project. */
	id: string;
	description: string;
	/** Groups and repos below a group, projects below a repo. */
	children: ForgeNode[];
	/** `children` holds what the kernel answered (not a guess of "none"). */
	loaded: boolean;
	/** Why `children` could not be loaded. */
	loadError?: string;
	/** A user's root, which the kernel lists next to the groups. */
	user?: boolean;
	visibility?: string;
	/** Repos only. */
	defaultBranch?: string;
	/** Repos only: the trunk commit `children` was discovered at. */
	sha?: string | null;
	/** Projects only: its directory in the repo. */
	root?: string;
	/** Projects only: its `package tartan` file. */
	manifestPath?: string;
	deps: readonly string[];
	dependents: readonly string[];
	/** Projects only: false when its `.cue` file turns Issues off. */
	issuesEnabled?: boolean;
};

export type Author = {
	readonly kind: string;
	readonly id: string;
	readonly onBehalfOf?: string;
};

/** `rawkode.issues` 0.2.0. `project` is the root path it was filed under. */
export type Issue = {
	readonly number: number;
	readonly title: string;
	readonly project: string | null;
	readonly state: "open" | "closed";
	readonly author: Author;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly closedAt: number | null;
	readonly body?: string;
};

export type IssueList = {
	readonly state: string;
	readonly project: string | null;
	readonly issues: readonly Issue[];
	readonly open: number;
	readonly closed: number;
};

/** An issue with the address it lives at, for lists that span repos. */
export type PlacedIssue = Issue & {
	/** The repo's address. */
	readonly repo: string;
	/** Its project's address, or the repo's when no project has that root now. */
	readonly where: string;
};

export type Commit = {
	readonly sha: string;
	readonly subject: string;
	readonly authoredAt: number;
	readonly authorName: string;
};

export type ActivityEvent = {
	readonly seq: number;
	readonly type: string;
	readonly at: number;
	readonly actor: string;
	readonly text: string;
	/** The commit the event leaves the repo at, if any. */
	readonly sha?: string;
	readonly subject?: string;
};

export const plural = (n: number, noun: string) =>
	`${n} ${noun}${n === 1 ? "" : "s"}`;

// Addresses: groups and repos join with "/", a project joins its repo with ":".
export const splitAddr = (addr: string) => addr.split(/[/:]/).filter(Boolean);

/** The repo an address belongs to, when it names a project. */
export const repoOf = (addr: string) => addr.split(":")[0]!;

// The nodes from the root down to an address, as far as it is loaded. Only ":" reaches a project.
export const trailOf = (tree: ForgeNode, addr: string) => {
	const address = parseAddress(addr);
	if (!address) return null;
	const out = [tree];
	for (const name of address.path.split("/").filter(Boolean)) {
		const next = out[out.length - 1]!.children.find((k) =>
			k.name === name && k.kind !== "project"
		);
		if (!next) return null;
		out.push(next);
	}
	if (address.project !== null) {
		const next = out[out.length - 1]!.children.find((k) =>
			k.name === address.project && k.kind === "project"
		);
		if (!next) return null;
		out.push(next);
	}
	return out;
};

export const under = (where: string, addr: string) =>
	!addr || where === addr || where.startsWith(`${addr}/`) ||
	where.startsWith(`${addr}:`);

// Addresses read like relative paths from the current scope.
export const rel = (scope: string, where: string) => {
	if (where === scope) return "";
	if (!scope) return where;
	if (where.startsWith(`${scope}/`) || where.startsWith(`${scope}:`)) {
		return where.slice(scope.length + 1);
	}
	const parts = where.split(":");
	if (repoOf(scope) === parts[0]) {
		return parts[1] ?? parts[0]!.split("/").pop()!;
	}
	return `~/${where}`;
};

/** A node and everything loaded below it, depth first. */
export const walk = (
	node: ForgeNode,
	out: ForgeNode[] = [],
): ForgeNode[] => {
	out.push(node);
	node.children.forEach((k) => walk(k, out));
	return out;
};

export const reposUnder = (node: ForgeNode): ForgeNode[] =>
	walk(node).filter((k) => k.kind === "repo");

/** A repo with no project directories is itself the one project. */
export const projectsUnder = (node: ForgeNode): ForgeNode[] =>
	walk(node).filter((k) =>
		k.kind === "project" ||
		(k.kind === "repo" && k.loaded && !k.children.length)
	);

export type Tab = "overview" | "projects" | "issues" | "activity" | "settings";

export type Route = {
	addr: string;
	tab: Tab;
	detail?:
		| { type: "issue"; n: number }
		| { type: "new-node"; kind: "group" | "repo" }
		| { type: "new-issue" };

	unknown?: boolean;
};

export const urlFor = (
	addr: string,
	page = "",
) => (page ? `${addr ? `/${addr}` : ""}/-/${page}` : `/${addr}`);

const decode = (pathname: string): string | null => {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
};

export const parseUrl = (pathname: string): Route => {
	const decoded = decode(pathname);
	if (decoded === null) return { addr: "", tab: "overview", unknown: true };
	const clean = decoded.replace(/^\/|\/$/g, "");
	const [left = "", page = ""] = clean.startsWith("-/")
		? ["", clean.slice(2)]
		: clean.split("/-/");
	const addr = left;
	const [head, sub] = page.split("/");
	if (!page) return { addr, tab: "overview" };
	if (head === "new") {
		return {
			addr,
			tab: "overview",
			detail: { type: "new-node", kind: sub === "group" ? "group" : "repo" },
		};
	}
	if (head === "issues" && sub === "new") {
		return { addr, tab: "issues", detail: { type: "new-issue" } };
	}
	if (head === "issues" && sub) {
		return /^\d+$/.test(sub)
			? { addr, tab: "issues", detail: { type: "issue", n: Number(sub) } }
			: { addr, tab: "issues", unknown: true };
	}
	if (head === "projects" || head === "issues" || head === "activity") {
		return { addr, tab: head };
	}
	return { addr, tab: "overview", unknown: true };
};

export const titleFor = (route: Route) => {
	const place = splitAddr(route.addr).pop() ?? "Everything";
	if (route.detail?.type === "issue") return `#${route.detail.n} · ${place}`;
	if (route.detail?.type === "new-node") {
		return `New ${route.detail.kind} · ${place}`;
	}
	if (route.detail?.type === "new-issue") return `New issue · ${place}`;
	return route.tab === "overview"
		? place
		: `${route.tab[0]!.toUpperCase()}${route.tab.slice(1)} · ${place}`;
};

/** How long ago, in the shortest words that fit a list row. */
export const age = (at: number, now: number = Date.now()): string => {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 60) return `${days}d`;
	return new Date(at).toISOString().slice(0, 10);
};

/** The reading of one log event. Unknown types show their name, nothing made up. */
export const describeEvent = (
	type: string,
	data: Readonly<Record<string, unknown>>,
): { readonly text: string; readonly sha?: string } => {
	const branch = typeof data["ref"] === "string"
		? data["ref"].replace(/^refs\/heads\//, "")
		: null;
	const after = typeof data["after"] === "string" ? data["after"] : undefined;
	if (type === "push.accepted" && branch !== null) {
		return /^0+$/.test(after ?? "")
			? { text: `Deleted ${branch}` }
			: { text: `Pushed to ${branch}`, ...(after ? { sha: after } : {}) };
	}
	if (type === "repo.created") return { text: "Repo created" };
	if (type === "ref.advanced" && branch !== null) {
		return { text: `Advanced ${branch}`, ...(after ? { sha: after } : {}) };
	}
	return { text: type };
};
