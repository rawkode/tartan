// The forge shell's address tree: its types and pure helpers.
//
// Addresses: groups and repos join with "/", a project joins its repo with ":"
// (`router/address.ts`); "/-/" separates an address from a page on it.

import { parseAddress } from "../../router/address.ts";

export type NodeKind = "group" | "repo" | "project";

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
	| { kind: "note"; text: string }
	| { kind: "status"; text: string }
	| { kind: "moved"; where: string; n: number };

export type Commit = {
	sha: string;
	subject: string;
	projects: string[];
	age: string;
};
export type ForgeEvent = {
	repo: string;
	sha: string;
	subject: string;
	age: string;
	projects: string[];
};

export const plural = (n: number, noun: string) =>
	`${n} ${noun}${n === 1 ? "" : "s"}`;

// Addresses: groups and repos join with "/", a project joins its repo with ":".
export const splitAddr = (addr: string) => addr.split(/[/:]/).filter(Boolean);

// The nodes from the root down to an address. Only ":" reaches a project.
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

export const addrOf = (trail: ForgeNode[]) =>
	trail.slice(1).reduce(
		(acc, node) => (acc
			? `${acc}${node.kind === "project" ? ":" : "/"}${node.name}`
			: node.name),
		"",
	);

export const under = (where: string, addr: string) =>
	!addr || where === addr || where.startsWith(`${addr}/`) ||
	where.startsWith(`${addr}:`);

// Addresses read like relative paths from the current scope. kiln:root is written as plain kiln.
export const rel = (scope: string, where: string) => {
	const s = scope.replace(/:root$/, "");
	const w = where.replace(/:root$/, "");
	if (w === s) return "";
	if (!s) return w;
	if (w.startsWith(`${s}/`) || w.startsWith(`${s}:`)) {
		return w.slice(s.length + 1);
	}
	const sRepo = s.split(":")[0];
	const wParts = w.split(":");
	if (sRepo === wParts[0]) return wParts[1] || wParts[0].split("/").pop()!;
	const parent = (a: string) => a.split("/").slice(0, -1).join("/");
	if (parent(sRepo) === parent(wParts[0])) return `../${w.split("/").pop()}`;
	return `~/${w}`;
};

export const short = (where: string, n: number) => {
	const parts = where.replace(/:root$/, "").split(":");
	return `${parts[1] || parts[0].split("/").pop()}#${n}`;
};

export const named = (node: ForgeNode) =>
	node.children.filter((k) => k.name !== "root").length;

export const repoCount = (node: ForgeNode): number =>
	node.kind === "repo"
		? 1
		: node.kind === "project"
		? 0
		: node.children.reduce((sum, k) => sum + repoCount(k), 0);

// A repo is one project unless it splits into several. Its root project isn't counted as one of them.
const isProject = (node: ForgeNode) =>
	node.kind === "project"
		? node.name !== "root"
		: node.kind === "repo" && !node.children.length;

export const failingUnder = (
	node: ForgeNode,
	trail: ForgeNode[],
	out: { addr: string; node: ForgeNode }[] = [],
) => {
	const here = [...trail, node];
	if (node.fail) out.push({ addr: addrOf(here), node });
	node.children.forEach((k) => failingUnder(k, here, out));
	return out;
};

export const walk = (
	node: ForgeNode,
	trail: ForgeNode[] = [],
	out: { addr: string; node: ForgeNode }[] = [],
) => {
	const here = [...trail, node];
	out.push({ addr: addrOf(here), node });
	node.children.forEach((k) => walk(k, here, out));
	return out;
};

export const projectsUnder = (node: ForgeNode, trail: ForgeNode[]) =>
	walk(node, trail).filter((k) => isProject(k.node));

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
		return { addr, tab: "issues", detail: { type: "issue", n: Number(sub) } };
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
