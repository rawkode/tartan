// Landing views against the mock kernel: repo header
// actions post their action and apply the result; the repo sidebar column
// shows only when the view lists `repo.sidebar`; the Runs, Advances,
// why-blame and forge home pages read the kernel APIs (WP9, WP10,
// WP5a) and say plainly what is not available, with no stub page left.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api/client.ts";
import { createHttp, type FetchLike } from "../src/api/http.ts";
import { LANE_IDS } from "../src/api/mock/coord.ts";
import { instId, REPO_ID, SHAS } from "../src/api/mock/fixtures.ts";
import { BATCH_IDS, RUN_IDS } from "../src/api/mock/land.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import { duration } from "../src/views/coord/landing.ts";
import { mountApp, recordingFetch } from "./support/app.ts";
import {
	byAttr,
	byTag,
	byText,
	click,
	findAll,
	flush,
	type TestElement,
	text,
} from "./support/renderer.ts";

const REPO = "/acme/platform/router";

const links = (root: TestElement): string[] =>
	byTag(root, "a").map((a) => a.attrs["href"] ?? "");

const tabs = (root: TestElement): string[] =>
	findAll(root, (el) => (el.attrs["class"] ?? "").includes("repo__tab")).map(
		text,
	);

describe("repo header actions", () => {
	it("posts the contribution id with the narrowed ctx and follows the result", async () => {
		const app = await mountApp(REPO);
		const button = byAttr(app.root, "data-action", "new-work")[0]!;
		expect(button.tag).toBe("button");
		expect(text(button)).toContain("New work");
		click(button);
		await flush();
		const post = app.calls.find((c) => c.method === "POST");
		expect(post?.path).toBe(
			`/-/api/slot/${instId("tartan.work")}/new-work/action`,
		);
		expect(post?.body).toEqual({
			action: "new-work",
			ctx: { node: "acme/platform/router" },
		});
		await vi.waitFor(() =>
			expect(app.router.currentRoute.value.fullPath).toBe(`${REPO}/-/work`)
		);
	});

	it("narrows a code page's hint to the repo and shows failures as a toast", async () => {
		const inner = createMockFetch();
		const failing: FetchLike = (input, init) =>
			input.endsWith("/action")
				? Promise.resolve(
					Response.json({
						error: "denied",
						message: "creating work needs Developer",
					}, {
						status: 403,
					}),
				)
				: inner(input, init);
		const app = await mountApp(`${REPO}/-/tree/main/services`, {
			fetch: failing,
		});
		click(byAttr(app.root, "data-action", "new-work")[0]!);
		await flush();
		const post = app.calls.find((c) => c.method === "POST");
		expect(post?.body).toEqual({
			action: "new-work",
			ctx: { node: "acme/platform/router" },
		});
		expect(app.toasts.items.map((t) => [t.tone, t.text])).toContainEqual([
			"danger",
			"creating work needs Developer",
		]);
		expect(app.router.currentRoute.value.fullPath).toBe(
			`${REPO}/-/tree/main/services`,
		);
	});
});

describe("repo sidebar column", () => {
	it("shows the sidebar only when the view lists repo.sidebar instances", async () => {
		const home = await mountApp(REPO);
		expect(byAttr(home.root, "aria-label", "Repository sidebar")).toHaveLength(
			1,
		);
		const tree = await mountApp(`${REPO}/-/tree/main/services`);
		expect(byAttr(tree.root, "aria-label", "Repository sidebar")).toEqual([]);
		expect(
			findAll(
				tree.root,
				(el) => (el.attrs["class"] ?? "").includes("repo__body--wide"),
			),
		).toHaveLength(1);
		const log = await mountApp(`${REPO}/-/commits/main`);
		expect(byAttr(log.root, "aria-label", "Repository sidebar")).toEqual([]);
	});
});

describe("repo tabs", () => {
	it("shows Runs to signed-in viewers only (the runs API needs a caller)", async () => {
		const owner = await mountApp(REPO);
		expect(tabs(owner.root)).toEqual(
			expect.arrayContaining(["Code", "History", "Lanes", "Runs", "Advances"]),
		);
		const anonymous = await mountApp(REPO, { mock: { signedIn: false } });
		expect(tabs(anonymous.root)).not.toContain("Runs");
		expect(tabs(anonymous.root)).toContain("Advances");
	});

	it("has no coordination page left as a stub", () => {
		const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/views");
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory()
					? walk(join(d, e.name))
					: e.name.endsWith(".vue")
					? [join(d, e.name)]
					: []
			);
		const stubs = walk(join(dir, "coord")).concat(walk(join(dir, "repo")))
			.filter((f) => readFileSync(f, "utf8").includes("StubView"));
		expect(stubs).toEqual([]);
	});
});

describe("runs (WP9 API)", () => {
	it("lists the repo's runs by repo id with links to each run", async () => {
		const app = await mountApp(`${REPO}/-/runs`);
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/runs/${REPO_ID}?limit=50`,
		);
		expect(byAttr(app.root, "data-run")).toHaveLength(3);
		expect(links(app.root)).toContain(`${REPO}/-/runs/${RUN_IDS.failed}`);
		const t = text(app.root);
		expect(t).toContain("failure");
		expect(t).toContain("1 failed");
		expect(t).not.toContain("stub");
	});

	it("narrows to a subject from the query", async () => {
		const app = await mountApp(
			`${REPO}/-/runs?subject=change:lmnopqrstuvwxyzklmnopqrstuvwxyzk`,
		);
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/runs/${REPO_ID}?subject=change%3Almnopqrstuvwxyzklmnopqrstuvwxyzk&limit=50`,
		);
		expect(byAttr(app.root, "data-run")).toHaveLength(1);
		expect(links(app.root)).toContain(`${REPO}/-/runs`);
	});

	it("asks anonymous viewers to sign in", async () => {
		const app = await mountApp(`${REPO}/-/runs`, { mock: { signedIn: false } });
		expect(text(app.root)).toContain("Sign in and try again.");
	});

	it("shows a run's jobs and a job's redacted log tail", async () => {
		const app = await mountApp(`${REPO}/-/runs/${RUN_IDS.failed}`);
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/runs/${REPO_ID}/${RUN_IDS.failed}`,
		);
		expect(text(app.root)).toContain("test-web");
		expect(links(app.root)).toContain(
			`${REPO}/-/runs/${RUN_IDS.failed}/jobs/test-web`,
		);
		const job = await mountApp(
			`${REPO}/-/runs/${RUN_IDS.failed}/jobs/test-web`,
		);
		expect(job.calls.map((c) => c.path)).toContain(
			`/-/api/runs/${REPO_ID}/${RUN_IDS.failed}/jobs/test-web/log`,
		);
		expect(text(byTag(job.root, "pre")[0]!)).toContain(
			"theme toggle remembers dark",
		);
	});

	it("offers Refresh only while a run is live", async () => {
		const live = await mountApp(`${REPO}/-/runs/${RUN_IDS.running}`);
		expect(byText(live.root, "button", "Refresh")).not.toBeNull();
		const done = await mountApp(`${REPO}/-/runs/${RUN_IDS.passed}`);
		expect(byText(done.root, "button", "Refresh")).toBeNull();
	});
});

describe("advances and why (WP10 API)", () => {
	it("lists advances with gate decisions, shadow labelled", async () => {
		const app = await mountApp(`${REPO}/-/advances`);
		expect(app.calls.map((c) => c.path)).toContain(
			"/-/api/advances?repo=acme%2Fplatform%2Frouter&limit=50",
		);
		expect(byAttr(app.root, "data-advance")).toHaveLength(2);
		const t = text(app.root);
		expect(t).toContain("tartan.radar: advise (shadow)");
		expect(t).toContain("evidence reused");
		expect(t).toContain("(trunk not moved)");
		expect(links(app.root)).toContain(
			`${REPO}/-/advances/${BATCH_IDS.landed}`,
		);
	});

	it("is public for a public repo (no Runs tab, advances still read)", async () => {
		const app = await mountApp(`${REPO}/-/advances`, {
			mock: { signedIn: false },
		});
		expect(byAttr(app.root, "data-advance")).toHaveLength(2);
	});

	it("shows a batch's changes and the landed commit's why note", async () => {
		const app = await mountApp(`${REPO}/-/advances/${BATCH_IDS.landed}`);
		const paths = app.calls.map((c) => c.path);
		expect(paths).toContain(
			`/-/api/advances/${BATCH_IDS.landed}?repo=acme%2Fplatform%2Frouter`,
		);
		expect(paths).toContain(
			`/-/api/why?repo=acme%2Fplatform%2Frouter&sha=${SHAS.c2}`,
		);
		const t = text(app.root);
		expect(t).toContain("landed");
		expect(t).toContain("Split the router config by service");
		expect(links(app.root)).toContain(`${REPO}/-/lanes/${LANE_IDS.router}`);
	});

	it("does not ask for a why note when nothing landed", async () => {
		const app = await mountApp(`${REPO}/-/advances/${BATCH_IDS.conflicted}`);
		expect(text(app.root)).toContain("conflicted");
		expect(app.calls.some((c) => c.path.startsWith("/-/api/why"))).toBe(false);
	});

	it("why-blame shows the file's newest landing and says blame is not available", async () => {
		const app = await mountApp(
			`${REPO}/-/blame/main/services/api/src/server.ts`,
		);
		expect(app.calls.map((c) => c.path)).toContain(
			"/-/api/why?repo=acme%2Fplatform%2Frouter&path=services%2Fapi%2Fsrc%2Fserver.ts",
		);
		expect(app.calls.some((c) => c.path.startsWith("/-/api/blame"))).toBe(
			false,
		);
		const t = text(app.root);
		expect(t).toContain("Line-by-line why-blame is not available");
		expect(t).toContain("Split the router config by service");
		const none = await mountApp(`${REPO}/-/blame/main/README.md?line=1`);
		expect(none.calls.map((c) => c.path)).toContain(
			"/-/api/why?repo=acme%2Fplatform%2Frouter&path=README.md&line=1",
		);
		expect(text(none.root)).toContain(
			"No landing through an Advance has touched this file yet.",
		);
	});

	it("links a file page to its why page", async () => {
		const app = await mountApp(
			`${REPO}/-/blob/main/services/api/src/server.ts`,
		);
		expect(links(app.root)).toContain(
			`${REPO}/-/blame/main/services/api/src/server.ts`,
		);
	});
});

describe("forge home", () => {
	it("shows real namespaces and the HUD of each namespace that has one", async () => {
		const app = await mountApp("/");
		const paths = app.calls.map((c) => c.path);
		expect(paths).toContain("/-/api/nodes");
		expect(paths).toContain("/-/api/view?path=acme&view=hud");
		expect(paths).toContain("/-/api/view?path=acme&view=home");
		expect(links(app.root)).toContain("/acme");
		const t = text(app.root);
		expect(t).toContain("Active lanes");
		expect(t).not.toContain("No forge-wide metrics yet.");
		expect(t).not.toContain("stub");
	});
});

describe("client paths (WP9, WP10 handlers)", () => {
	it("uses the handlers' paths and query names", async () => {
		const rec = recordingFetch(() =>
			Promise.resolve(Response.json({ runs: [], advances: [] }))
		);
		const api = createApi(createHttp(rec.fetch));
		await api.runs.list(REPO_ID, {
			subject: { kind: "lane", id: "ln_x" },
			cursor: "c",
			limit: 5,
		});
		await api.runs.get(REPO_ID, RUN_IDS.passed);
		await api.runs.log(REPO_ID, RUN_IDS.passed, "compose", 4096);
		await api.land.advances("acme/r", { cursor: "2" });
		await api.land.batch("acme/r", BATCH_IDS.landed);
		await api.land.why("acme/r", { sha: "abc1234" });
		await api.land.why("acme/r", { path: "a b.ts", line: 3 });
		expect(rec.calls.map((c) => c.path)).toEqual([
			`/-/api/runs/${REPO_ID}?subject=lane%3Aln_x&cursor=c&limit=5`,
			`/-/api/runs/${REPO_ID}/${RUN_IDS.passed}`,
			`/-/api/runs/${REPO_ID}/${RUN_IDS.passed}/jobs/compose/log?tail=4096`,
			"/-/api/advances?repo=acme%2Fr&cursor=2",
			`/-/api/advances/${BATCH_IDS.landed}?repo=acme%2Fr`,
			"/-/api/why?repo=acme%2Fr&sha=abc1234",
			"/-/api/why?repo=acme%2Fr&path=a+b.ts&line=3",
		]);
	});

	it("formats durations", () => {
		expect(duration(undefined, undefined, 0)).toBe("—");
		expect(duration(0, 42_000, 0)).toBe("42s");
		expect(duration(0, 65_000, 0)).toBe("1m 05s");
		expect(duration(0, 3_780_000, 0)).toBe("1h 03m");
	});
});
