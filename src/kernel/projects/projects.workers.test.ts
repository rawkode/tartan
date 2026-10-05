/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP25 slice A′ through the real Worker entry: a claimed forge, the demo-shaped cuenv monorepo imported under
// the Swarm pack (the real `tartan.work` and `tartan.changes`), an agent's
// two work items (one whose footprint names `rawkode-academy-design-system`,
// one that does not) and two submitted changes (one whose push touches the
// design system, one that does not). Then the projects API: 38 projects at
// the trunk tip, the design system's page, and its Issues and Pull requests
// with exactly one hit each, read through the providers' tools as the
// viewer; an anonymous reader of the private repo gets 404; the SPA mock
// answers with the same shapes.
//
// Needs the src/router.ts route, the vitest binding `TARTAN_PROJECTS:
// "scan"` and this file in a vitest project.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoArtifactsName, repoDoName, ulid } from "@tartan/contract";
import { CUENV_DEMO_FILES } from "../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import { createMockProjects } from "../../../web/src/api/mock/projects.ts";
import {
	call,
	claimForge,
	env,
	jsonOf,
	mcp,
	type McpTool,
	type Patched,
	patchGlobals,
	repoke,
} from "../exthost/api/test/worker.ts";
import { settleBackground } from "../../../test/env.ts";
import type {
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectIssuesResponse,
	ProjectsResponse,
} from "@tartan/contract";

const REPO = "demo/academy";
const DS = "rawkode-academy-design-system";
const WEB = "rawkode-academy-website";

type Seeding = {
	seed(name: string, o: { files: Record<string, string> }): Promise<unknown>;
	commit(
		name: string,
		ref: string,
		changes: Record<string, string>,
		message: string,
	): Promise<string>;
	refs(name: string): Promise<Record<string, string>>;
	setRef(name: string, ref: string, oid: string | null): Promise<void>;
};
const artifacts = env.ARTIFACTS as unknown as Seeding;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventually = async <T>(
	what: string,
	attempt: () => Promise<T | undefined>,
): Promise<T> => {
	for (let i = 1; i <= 100; i++) {
		const value = await attempt();
		if (value !== undefined) return value;
		if (i % 10 === 0) await repoke();
		await sleep(150);
	}
	throw new Error(`${what} never happened`);
};

let patched: Patched;
let session = "";
let repoId = "";
const refs: {
	ds?: string;
	api?: string;
	dsChange?: string;
	apiChange?: string;
} = {};

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
	const res = await call(path, { ...init, cookie: session });
	const body = await jsonOf<T>(res);
	if (res.status >= 300) {
		throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
	}
	return body;
};
const post = <T>(path: string, body: unknown): Promise<T> =>
	api<T>(path, { method: "POST", body: JSON.stringify(body) });

const tool = async (
	t: McpTool,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
	const out = await t(name, args);
	if (out.isError) throw new Error(`${name}: ${JSON.stringify(out.value)}`);
	return out.value as Record<string, unknown>;
};

/** An item, claimed with its footprint, one pushed commit, a submitted change. */
const workAndChange = async (
	t: McpTool,
	agentId: string,
	title: string,
	footprint: { projects: string[]; prefixes: string[] },
	file: string,
): Promise<{ ref: string; changeId: string }> => {
	const created = await tool(t, "work_create", {
		repo: REPO,
		kind: "issue",
		title,
		why: "WP25 workerd acceptance.",
		footprint,
	});
	const claim = await tool(t, "work_claim", {
		ref: created["ref"],
		footprint,
		plan: "One commit.",
	});
	const lane = claim["lane"] as { id: string; ref: string };
	const name = repoArtifactsName(repoId);
	const trunk = (await artifacts.refs(name))["refs/heads/main"]!;
	if ((await artifacts.refs(name))[lane.ref] === undefined) {
		await artifacts.setRef(name, lane.ref, trunk);
	}
	const head = await artifacts.commit(name, lane.ref, {
		[file]: "export const changed = true;\n",
	}, `feat: ${title}\n\nTartan-Work: ${created["ref"]}`);
	await env.REPO.getByName(repoDoName(repoId)).core().recordPush({
		target: "repo",
		refs: [{ ref: lane.ref, before: trunk, after: head }],
		principal: agentId,
		via: "gateway",
		requestId: `req_${ulid()}`,
	} as never);
	const changeId = await eventually(`a change for ${title}`, async () => {
		const out = await t("changes_submit", {
			repo: REPO,
			laneId: lane.id,
			title,
			summary: title,
			why: "WP25 workerd acceptance.",
		});
		return out.isError
			? undefined
			: (out.value as { changeId: string }).changeId;
	});
	return { ref: created["ref"] as string, changeId };
};

beforeAll(async () => {
	patched = await patchGlobals();
	session = await claimForge(patched);
	await post("/-/api/nodes", { kind: "group", slug: "demo" });
	const source = `wp25-${crypto.randomUUID().slice(0, 8)}`;
	await artifacts.seed(source, { files: { ...CUENV_DEMO_FILES } });
	const node = await post<{ id: string }>("/-/api/nodes/repos", {
		parent: "demo",
		slug: "academy",
		import: {
			url: `https://public.artifacts.fake.test/git/tartan-test/${source}.git`,
		},
	});
	repoId = node.id;
	await post("/-/api/installations", {
		extId: "tartan.pack.swarm",
		version: "0.1.0",
		node: "demo",
		mode: "enforce",
	});
	const agent = await post<{ token: string; agent: { id: string } }>(
		"/-/api/agents",
		{ name: "claude-1", tool: "claude-code", node: "demo", maxRole: 30 },
	);
	const t = await mcp(REPO, agent.token);
	const ds = await workAndChange(
		t,
		agent.agent.id,
		"Tighten the button contrast",
		{ projects: [DS], prefixes: ["packages/design-system"] },
		"packages/design-system/src/contrast.ts",
	);
	const other = await workAndChange(
		t,
		agent.agent.id,
		"Paginate the API",
		{ projects: [], prefixes: ["projects/rawkode.academy/api"] },
		"projects/rawkode.academy/api/src/page.ts",
	);
	refs.ds = ds.ref;
	refs.dsChange = ds.changeId;
	refs.api = other.ref;
	refs.apiChange = other.changeId;
}, 180_000);

afterAll(async () => {
	await settleBackground();
	patched?.restore();
});

const projectsPath = (rest = "") => `/-/api/repos/${repoId}/projects${rest}`;

describe("projects API on the real Worker (WP25 A′)", () => {
	it("lists the 38 cuenv projects at the trunk tip", async () => {
		const list = await api<ProjectsResponse>(projectsPath());
		expect(list.detector).toBe("cuenv");
		expect(list.fidelity).toBe("scan");
		expect(list.projects).toHaveLength(38);
		expect(list.layers.map((l) => l.root)).toEqual([
			"",
			"projects",
			"projects/rawkode.academy",
		]);
		expect(list.skipped).toEqual(["projects/code.rawkode.academy/config"]);
		const ds = list.projects.find((p) => p.name === DS)!;
		expect(ds.dependents).toEqual([WEB]);
	});

	it("shows the design system's page with its README and agent doc", async () => {
		const page = await api<ProjectDetailResponse>(projectsPath(`/${DS}`));
		expect(page.project.root).toBe("packages/design-system");
		expect(page.readme?.path).toBe("packages/design-system/README.md");
		expect(page.agentsDoc).toEqual({ path: "AGENTS.md" });
		expect(page.dependents.map((p) => p.name)).toEqual([WEB]);
	});

	it("filters Issues by footprint through tartan.work, as the viewer", async () => {
		const issues = await api<ProjectIssuesResponse>(
			projectsPath(`/${DS}/issues`),
		);
		expect(issues.provider).toBe("tartan.work");
		expect(issues.items.map((i) => i.ref)).toEqual([refs.ds]);
		expect(issues.scanned).toBe(2);
		const api2 = await api<ProjectIssuesResponse>(
			projectsPath("/rawkode-academy-api/issues"),
		);
		expect(api2.items.map((i) => [i.ref, i.matched])).toEqual([[
			refs.api,
			"prefix",
		]]);
	});

	it("filters Pull requests by the revision's affected set through tartan.changes", async () => {
		const changes = await api<ProjectChangesResponse>(
			projectsPath(`/${DS}/changes`),
		);
		expect(changes.provider).toBe("tartan.changes");
		expect(changes.changes.map((c) => c.changeId)).toEqual([refs.dsChange]);
		expect(changes.changes[0].affected).toEqual([DS, WEB]);
		expect(changes.changes[0].global).toBe(false);
		// The website is affected as a dependent of the design system.
		const web = await api<ProjectChangesResponse>(
			projectsPath(`/${WEB}/changes`),
		);
		expect(web.changes.map((c) => c.changeId)).toEqual([refs.dsChange]);
	});

	it("gives an anonymous reader of the private repo the same 404 as an unknown repo", async () => {
		for (const rest of ["", `/${DS}`, `/${DS}/issues`]) {
			const res = await call(projectsPath(rest));
			expect(res.status).toBe(404);
		}
		const unknown = await call(
			`/-/api/repos/${"0".repeat(26)}/projects`,
		);
		expect(unknown.status).toBe(404);
	});

	it("answers in the SPA mock's shapes", async () => {
		const mock = createMockProjects();
		const shape = (v: unknown): unknown =>
			Array.isArray(v)
				? (v.length > 0 ? [shape(v[0])] : [])
				: v !== null && typeof v === "object"
				? Object.fromEntries(
					Object.keys(v).sort().map((k) => [
						k,
						shape((v as Record<string, unknown>)[k]),
					]),
				)
				: typeof v;
		const live = await api<ProjectsResponse>(projectsPath());
		const fake = mock.list(mock.repoId)!;
		expect(Object.keys(fake).sort()).toEqual(Object.keys(live).sort());
		expect(shape(fake.projects[0])).toEqual(
			shape(live.projects.find((p) => p.name === fake.projects[0].name)),
		);
		const liveIssues = await api<ProjectIssuesResponse>(
			projectsPath(`/${DS}/issues`),
		);
		const fakeIssues = mock.issues(mock.repoId, DS)!;
		expect(Object.keys(fakeIssues).sort()).toEqual(
			Object.keys(liveIssues).sort(),
		);
		expect(Object.keys(fakeIssues.items[0]).sort()).toEqual(
			Object.keys(liveIssues.items[0]).sort(),
		);
		const liveChanges = await api<ProjectChangesResponse>(
			projectsPath(`/${DS}/changes`),
		);
		const fakeChanges = mock.changes(mock.repoId, DS)!;
		expect(Object.keys(fakeChanges.changes[0]).sort()).toEqual(
			Object.keys(liveChanges.changes[0]).sort(),
		);
	});
});
