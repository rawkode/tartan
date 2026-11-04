// In-memory state for the sample data: a full page load starts again. Actions
// return the URL to go to, because navigation belongs to the router.

import { reactive } from "vue";
import {
	addrOf,
	failingUnder,
	type ForgeNode,
	type Issue,
	type IssueLog,
	rel,
	trailOf,
	under,
	urlFor,
} from "./model.ts";
import {
	buildTree,
	defaultIssues,
	events,
	groupNode,
	repoNode,
} from "./sample.ts";

export { commitsFor, KILN } from "./sample.ts";

export const store = reactive({
	// Shown once, on the page an action sent the viewer to.
	banner: null as { path: string; text: string } | null,
	tree: buildTree(),
	issues: defaultIssues(),
});

export const setBanner = (path: string, text: string) => {
	store.banner = { path, text };
};

export const trailAt = (addr: string) => trailOf(store.tree as ForgeNode, addr);

export const openIssues = (addr: string) =>
	store.issues.filter((i) => !i.closed && under(i.where, addr));

export const eventsAt = (node: ForgeNode, addr: string, limit: number) => {
	const repo = addr.split(":")[0];
	return events
		.filter((e) =>
			node.kind === "project"
				? e.repo === repo && e.projects.includes(node.name)
				: under(e.repo, addr)
		)
		.slice(0, limit)
		.map((e) => ({
			...e,
			place: node.kind === "project" ? "" : rel(addr, e.repo),
			chips: node.kind === "project" ? [] : e.projects,
		}));
};

// A project's file, shown from its own directory. Only a name that differs from
// the directory has to be written down. The implicit root project has no file.
export const projectFile = (node: ForgeNode) => {
	if (node.kind !== "project" || node.name === "root") return null;
	const lines = ["package tartan", ""];
	if (node.path?.split("/").pop() !== node.name) {
		lines.push(`name: "${node.name}"`);
	}
	if (node.deps.length) {
		lines.push(`deps: [${node.deps.map((d) => `"${d}"`).join(", ")}]`);
	}
	return {
		path: `${node.path}/forge.cue`,
		source: lines.join("\n").trimEnd(),
	};
};

export const hasFailure = (node: ForgeNode) =>
	failingUnder(node, []).length > 0;

// An issue that moved answers at its old address too.
export const findIssue = (where: string, n: number) =>
	store.issues.find((i) =>
		(i.where === where && i.n === n) ||
		i.past.some((p) => p.where === where && p.n === n)
	);

export const issueUrl = (issue: Issue) =>
	urlFor(issue.where, `issues/${issue.n}`);

export const logOnIssue = (issue: Issue, entry: IssueLog) => {
	issue.log.push(entry);
};

export const toggleClosed = (issue: Issue) => {
	logOnIssue(issue, {
		kind: "status",
		text: issue.closed ? "Reopened." : "Closed.",
	});
	issue.closed = !issue.closed;
};

export const toggleAffected = (issue: Issue, addr: string) => {
	issue.affected = issue.affected.includes(addr)
		? issue.affected.filter((a) => a !== addr)
		: [...issue.affected, addr];
};

// Where an issue can move: its repo's other projects, and the repos beside that repo.
export const destinations = (issue: Issue) => {
	const repoAddr = issue.where.split(":")[0]!;
	const repoTrail = trailAt(repoAddr);
	if (!repoTrail) return [];
	const repo = repoTrail[repoTrail.length - 1]!;
	const parent = repoTrail[repoTrail.length - 2]!;
	const parentAddr = addrOf(repoTrail.slice(0, -1));
	const own = repo.children.map((k) => `${repoAddr}:${k.name}`).filter((w) =>
		w !== issue.where
	);
	const beside = parent.children
		.filter((k) => k.kind === "repo" && k !== repo)
		.map((k) => {
			const addr = `${parentAddr ? `${parentAddr}/` : ""}${k.name}`;
			return k.children.length ? `${addr}:root` : addr;
		});
	return [...own, ...beside];
};

// Moving back to a project reuses the number the issue had there.
export const nextNumber = (issue: Issue, dest: string) =>
	issue.past.find((p) => p.where === dest)?.n ??
		store.issues.filter((i) => i.where === dest).reduce(
				(max, i) => Math.max(max, i.n),
				0,
			) + 1;

export const moveIssue = (issue: Issue, dest: string): string => {
	const n = nextNumber(issue, dest);
	const from = { where: issue.where, n: issue.n };
	issue.affected = [
		...issue.affected.filter((a) => a !== dest),
		...(issue.affected.includes(from.where) ? [] : [from.where]),
	];
	issue.past.push(from);
	issue.log.push({ kind: "moved", ...from });
	issue.found = null;
	issue.where = dest;
	issue.n = n;
	return issueUrl(issue);
};

export const createIssue = (
	where: string,
	title: string,
	body: string,
): string => {
	const n = store.issues.filter((i) => i.where === where).reduce(
		(max, i) => Math.max(max, i.n),
		0,
	) + 1;
	const issue: Issue = {
		id: `${where}#${n}`,
		where,
		n,
		title,
		tag: "new",
		age: "now",
		closed: false,
		labels: [],
		affected: [],
		log: [],
		past: [],
		body,
	};
	store.issues.unshift(issue);
	const url = issueUrl(issue);
	setBanner(url, "Issue opened.");
	return url;
};

export const createNode = (
	parentAddr: string,
	kind: "group" | "repo",
	name: string,
	description: string,
): string | null => {
	const trail = trailAt(parentAddr);
	if (!trail) return null;
	const children = trail[trail.length - 1]!.children;
	if (kind === "group") {
		const firstRepo = children.findIndex((k) => k.kind === "repo");
		children.splice(
			firstRepo === -1 ? children.length : firstRepo,
			0,
			groupNode(name, description),
		);
	} else {
		children.push(repoNode(name, description, { releases: [], empty: true }));
	}
	const url = `/${parentAddr ? `${parentAddr}/` : ""}${name}`;
	setBanner(url, `${kind === "group" ? "Group" : "Repo"} created.`);
	return url;
};
