// `deno task poc:proof`: the live proof over HTTP, against a forge `deno task
// poc` just seeded, with real WASM on workerd. Each check prints PASS or FAIL
// with what came back; it exits 1 when any fails. It adds issues, so a second
// run needs a fresh forge.
//
// Usage: deno task poc:proof --session .wrangler/poc/8801/session.json

import {
	createClient,
	ISSUES_ID,
	type Session,
	type ToolReply,
} from "./client.ts";

type Issue = {
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly project: string | null;
};
type ListResult = {
	readonly issues: readonly Issue[];
	readonly open: number;
	readonly closed: number;
};
type NodeDto = { readonly id: string };

const flag = Deno.args.indexOf("--session");
const sessionPath = flag < 0 ? undefined : Deno.args[flag + 1];
if (sessionPath === undefined) {
	console.error("usage: deno task poc:proof --session <session.json>");
	Deno.exit(2);
}

const session = JSON.parse(await Deno.readTextFile(sessionPath)) as Session;
const client = createClient(session);
let failures = 0;

const check = (name: string, ok: boolean, got: unknown): void => {
	if (!ok) failures++;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${
			ok ? "" : `\n      got ${JSON.stringify(got)}`
		}`,
	);
};

const repoId = async (path: string): Promise<string> =>
	(await client.must<{ readonly node: NodeDto }>(
		"GET",
		`/-/api/nodes/resolve?path=${encodeURIComponent(path)}`,
	)).node.id;

const KILN = await repoId("oss/devtools/build/kiln");
const CACHE = await repoId("oss/devtools/build/remote-cache");
const PLATFORM = await repoId("infra/cloud/platform");
const DOTFILES = await repoId("dotfiles");

const refused = (reply: ToolReply, status: number, code: string): boolean =>
	reply.status === status && reply.code === code;
const issuesOf = (reply: ToolReply): readonly Issue[] =>
	(reply.result as ListResult | undefined)?.issues ?? [];
const issueOf = (reply: ToolReply): Issue | undefined =>
	(reply.result as { issue?: Issue } | undefined)?.issue;
const all = { state: "all", limit: 100 };

console.log(`# ${session.origin}`);

const health = await client.must<{ ok: boolean; stage: string }>(
	"GET",
	"/-/health",
);
check(
	"the forge is the local workerd stage",
	health.stage === "dev-local",
	health,
);

console.log("\n## Projects");
const projectsOf = (id: string) =>
	client.must<{
		sha: string;
		detector: string | null;
		projects: {
			name: string;
			root: string;
			manifestPath: string;
			deps: string[];
			extensions: Record<string, { enabled: boolean }>;
		}[];
	}>("GET", `/-/api/repos/${id}/projects`);
const kiln = await projectsOf(KILN);
check("kiln: detector tartan", kiln.detector === "tartan", kiln.detector);
check(
	"kiln: six projects by directory, under any filename",
	JSON.stringify(kiln.projects.map((p) => p.name).sort()) ===
		'["cli","core","docs","lsp","registry","vscode"]',
	kiln.projects.map((p) => p.name),
);
const registry = kiln.projects.find((p) => p.root === "services/registry");
check(
	"kiln: the env.cue beside registry is ignored (name, deps, switch)",
	registry?.name === "registry" && registry.deps.join() === "core" &&
		registry.extensions[ISSUES_ID]?.enabled === true,
	registry,
);
check(
	"kiln: editors/vscode found through tartan.cue",
	kiln.projects.find((p) => p.name === "vscode")?.manifestPath ===
		"editors/vscode/tartan.cue",
	kiln.projects.find((p) => p.name === "vscode"),
);
check(
	"kiln: site/docs has Issues switched off",
	kiln.projects.find((p) => p.root === "site/docs")?.extensions[ISSUES_ID]
		?.enabled === false,
	kiln.projects.find((p) => p.root === "site/docs"),
);
const platform = await projectsOf(PLATFORM);
check(
	'platform: deploy/terraform is named by its literal name: "deploy"',
	platform.projects.find((p) => p.root === "deploy/terraform")?.name ===
		"deploy",
	platform.projects.map((p) => [p.name, p.root]),
);
const cache = await projectsOf(CACHE);
check(
	"remote-cache: projects [] is a single-project repo",
	cache.projects.length === 0,
	cache.projects,
);

console.log("\n## Seeded issues");
const wide = await client.tool(KILN, "list", all);
check(
	"kiln repo-wide list has all 7, each with its project or null",
	issuesOf(wide).length === 7 &&
		issuesOf(wide).filter((i) => i.project === null).length === 1,
	wide,
);

console.log("\n## Per project");
const lsp = await client.tool(KILN, "list", all, "lsp");
check(
	"list in lsp: only crates/lsp's issues",
	issuesOf(lsp).length === 2 &&
		issuesOf(lsp).every((i) => i.project === "crates/lsp"),
	lsp,
);
const made = await client.tool(
	KILN,
	"create",
	{ title: "Proof: filed against lsp", body: "From the proof." },
	"lsp",
);
const number = issueOf(made)?.number ?? 0;
check(
	"create in lsp stores the root path",
	made.status === 200 && issueOf(made)?.project === "crates/lsp",
	made,
);
check(
	"the new issue shows in lsp's list",
	issuesOf(await client.tool(KILN, "list", all, "lsp")).some((i) =>
		i.number === number
	),
	number,
);
check(
	"the new issue shows in the repo-wide list",
	issuesOf(await client.tool(KILN, "list", all)).some((i) =>
		i.number === number && i.project === "crates/lsp"
	),
	number,
);
check(
	"and not in core's",
	!issuesOf(await client.tool(KILN, "list", all, "core")).some((i) =>
		i.number === number
	),
	number,
);
const got = await client.tool(KILN, "get", { number }, "lsp");
check(
	"get in lsp returns it with its project",
	issueOf(got)?.project === "crates/lsp",
	got,
);
check(
	"get in core is 404 not_found: it is lsp's",
	refused(await client.tool(KILN, "get", { number }, "core"), 404, "not_found"),
	number,
);

console.log("\n## Close and reopen");
const closed = await client.tool(KILN, "close", { number }, "lsp");
check(
	"close: closed, changed, project kept",
	issueOf(closed)?.state === "closed" &&
		(closed.result as { changed: boolean }).changed === true &&
		issueOf(closed)?.project === "crates/lsp",
	closed,
);
check(
	"close again is idempotent",
	(await client.tool(KILN, "close", { number }, "lsp") as {
		result: { changed: boolean };
	}).result.changed === false,
	number,
);
check(
	"an open list in lsp no longer has it",
	!issuesOf(await client.tool(KILN, "list", {}, "lsp")).some((i) =>
		i.number === number
	),
	number,
);
const counted = (await client.tool(KILN, "list", all, "lsp"))
	.result as ListResult;
check(
	"lsp's counts are lsp's own",
	counted.open === 2 && counted.closed === 1,
	counted,
);
const reopened = await client.tool(KILN, "reopen", { number });
check(
	"reopen repo-wide: open again, project kept",
	issueOf(reopened)?.state === "open" &&
		issueOf(reopened)?.project === "crates/lsp",
	reopened,
);

console.log("\n## Refusals");
for (const name of ["list", "create", "get", "close", "reopen"]) {
	const args = name === "create" ? { title: "no" } : { number: 1 };
	check(
		`403 extension_disabled: ${name} in docs (site/docs)`,
		refused(
			await client.tool(KILN, name, args, "docs"),
			403,
			"extension_disabled",
		),
		name,
	);
}
check(
	"also by root path",
	refused(
		await client.tool(KILN, "list", {}, "site/docs"),
		403,
		"extension_disabled",
	),
	"site/docs",
);
const noInstall = await client.tool(DOTFILES, "list", {});
check(
	"404 not_installed: dotfiles",
	refused(noInstall, 404, "not_installed"),
	noInstall,
);
const noProject = await client.tool(KILN, "list", {}, "nope");
check(
	"404 not_found: an unknown project",
	refused(noProject, 404, "not_found"),
	noProject,
);
const noTool = await client.tool(KILN, "nope", {});
check(
	"404 not_found: an unknown tool",
	refused(noTool, 404, "not_found"),
	noTool,
);
const badTitle = await client.tool(KILN, "create", { title: "  " });
check(
	"400 invalid: a blank title",
	refused(badTitle, 400, "invalid"),
	badTitle,
);
const smuggled = await client.tool(KILN, "create", {
	title: "Proof: repo-wide despite args.project",
	project: "site/docs",
});
check(
	"repo-wide: a caller's args.project is dropped",
	issueOf(smuggled)?.project === null,
	smuggled,
);
const flat = await fetch(
	new URL(`/-/api/repos/${KILN}/ext/${ISSUES_ID}/tools/list`, session.origin),
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	},
);
const flatBody = await flat.json() as { error?: unknown };
check(
	"anonymous: the router's flat 401",
	flat.status === 401 && flatBody.error === "unauthenticated",
	flatBody,
);

const bounded = await client.must<{ readonly token: string }>(
	"POST",
	"/-/api/tokens",
	{
		name: "poc-proof-reporter",
		scopes: ["api"],
		expiresInDays: 1,
		maxRole: 20,
	},
);
const asReporter = async (name: string, args: unknown) => {
	const response = await fetch(
		new URL(
			`/-/api/repos/${KILN}/ext/${ISSUES_ID}/tools/${name}`,
			session.origin,
		),
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${bounded.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ args }),
		},
	);
	const body = await response.json() as { error?: { code?: string } };
	return { status: response.status, code: body.error?.code };
};
const reporterMade = await asReporter("create", {
	title: "Proof: opened as a Reporter",
});
check(
	"a Reporter's token can open an issue",
	reporterMade.status === 200,
	reporterMade,
);
const reporterClose = await asReporter("close", { number: 1 });
check(
	"403 denied: a Reporter's token cannot close one (the host's role check)",
	reporterClose.status === 403 && reporterClose.code === "denied",
	reporterClose,
);

console.log("\n## Two repos are isolated");
const cacheMade = await client.tool(CACHE, "create", {
	title: "Proof: in remote-cache",
});
const cacheAll = await client.tool(CACHE, "list", all);
check(
	"remote-cache numbers its own issues, after its 2 seeded",
	issueOf(cacheMade)?.number === 3,
	cacheMade,
);
check(
	"remote-cache lists only its own",
	issuesOf(cacheAll).length === 3 &&
		!issuesOf(cacheAll).some((i) => i.title.includes("language server")),
	cacheAll,
);
check(
	"kiln does not have remote-cache's issue",
	!issuesOf(await client.tool(KILN, "list", all)).some((i) =>
		i.title === "Proof: in remote-cache"
	),
	"kiln",
);
const platformIssue = await client.tool(PLATFORM, "get", { number: 1 });
check(
	"#1 in platform is platform's, not kiln's",
	issueOf(platformIssue)?.title ===
		"The gateway drops the request id on a retry",
	platformIssue,
);

console.log(
	failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`,
);
Deno.exit(failures === 0 ? 0 : 1);
