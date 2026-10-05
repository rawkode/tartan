// Why-blame, file level (WP19) over the mock kernel: the
// commits that touched the file with a gutter per work item, and the
// provenance drawer (work why and acceptance, agent, review route, gates,
// reason events, chain head) for the newest landing or a selected commit.
// The model's trailer parsing, colours, bands and note sections are pure.

import { describe, expect, it, vi } from "vitest";
import type { CommitMeta } from "@tartan/contract/git.ts";
import type { WhyNote } from "@tartan/contract/notes.ts";
import { SHAS } from "../src/api/mock/fixtures.ts";
import { WHY } from "../src/api/mock/land.ts";
import {
	agentOf,
	blameRows,
	GUTTER_COLOURS,
	gutterOf,
	provenanceOf,
	reasonEvents,
	workLegend,
} from "../src/views/coord/why/model.ts";
import { mountApp } from "./support/app.ts";
import { byAttr, click, flush, text } from "./support/renderer.ts";

const REPO = "/acme/platform/router";
const FILE = "services/api/src/server.ts";
const PAGE = `${REPO}/-/blame/main/${FILE}`;

describe("why-blame page", () => {
	it("lists every commit that touched the file, coloured by work item", async () => {
		const app = await mountApp(PAGE);
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/log?repo=acme%2Fplatform%2Frouter&ref=main&path=${
				encodeURIComponent(FILE)
			}`,
		);
		const rows = byAttr(app.root, "data-why-row");
		expect(rows.map((r) => r.attrs["data-why-row"])).toEqual([
			SHAS.c3,
			SHAS.c2,
			SHAS.c1,
			SHAS.genesis,
		]);
		const work = rows.find((r) => r.attrs["data-work"] === "w_17")!;
		expect(work.attrs["class"]).toMatch(/why-row--w[0-5]/);
		const none = rows.find((r) => r.attrs["data-why-row"] === SHAS.c1)!;
		expect(none.attrs["class"]).toContain("why-row--none");
		expect(text(app.root)).toContain("File-level why-blame");
		expect(text(app.root)).toContain("Line-by-line why-blame is not available");
	});

	it("opens the drawer on the newest landing with its provenance", async () => {
		const app = await mountApp(PAGE);
		await vi.waitFor(() =>
			expect(byAttr(app.root, "data-why-section").length).toBeGreaterThan(0)
		);
		const drawer = byAttr(app.root, "data-drawer")[0]!;
		const t = text(drawer);
		expect(t).toContain("Provenance · the newest landing");
		expect(t).toContain(
			"Each team should own its routes without merge fights in one file.",
		);
		expect(t).toContain("routes load per service");
		expect(t).toContain("api: split router into modules");
		expect(t).toContain("auto review");
		expect(t).toContain("risk 0.18");
		expect(t).toContain("verified");
		expect(byAttr(drawer, "data-reason")).toHaveLength(2);
		expect(
			byAttr(drawer, "data-why-section").map((s) =>
				s.attrs["data-why-section"]
			),
		).toEqual(["work", "change", "review", "reasons"]);
	});

	it("selecting a commit asks for its why by sha; one not landed says so", async () => {
		const app = await mountApp(PAGE);
		const row = byAttr(app.root, "data-why-row", SHAS.c1)[0]!;
		click(byAttr(row, "aria-pressed")[0]!);
		await vi.waitFor(() =>
			expect(app.router.currentRoute.value.query["sha"]).toBe(SHAS.c1)
		);
		await flush();
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/why?repo=acme%2Fplatform%2Frouter&sha=${SHAS.c1}`,
		);
		await vi.waitFor(() =>
			expect(text(byAttr(app.root, "data-drawer")[0]!)).toContain(
				"This commit has no why note",
			)
		);
		const close = byAttr(app.root, "data-drawer")[0]!;
		expect(text(close)).toContain("Close");
	});

	it("a selected landed commit shows its note", async () => {
		const app = await mountApp(`${PAGE}?sha=${SHAS.c2}`);
		await vi.waitFor(() =>
			expect(text(byAttr(app.root, "data-drawer")[0]!)).toContain(
				"Split router into modules",
			)
		);
		expect(text(app.root)).toContain(
			`Provenance · commit ${SHAS.c2.slice(0, 7)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const commit = (
	sha: string,
	trailers: { key: string; value: string }[],
): CommitMeta => ({
	sha,
	treeSha: sha,
	subject: sha,
	message: sha,
	author: { name: "a", email: "a@x" },
	committer: { name: "a", email: "a@x" },
	parents: [],
	authoredAt: 0,
	committedAt: 0,
	trailers,
});

describe("why model", () => {
	it("reads the agent and model from Tartan-Agent", () => {
		expect(
			agentOf(
				commit("a", [{
					key: "Tartan-Agent",
					value: "codex-2 (codex/gpt-5-codex)",
				}]),
			),
		).toEqual({ agent: "codex-2", model: "codex/gpt-5-codex" });
		expect(agentOf(commit("a", [{ key: "tartan-agent", value: "sim-7" }])))
			.toEqual({ agent: "sim-7" });
		expect(agentOf(commit("a", []))).toBeNull();
	});

	it("gives each work item a stable colour and bands consecutive commits", () => {
		expect(gutterOf(null)).toBeNull();
		expect(gutterOf("r#1")).toBe(gutterOf("r#1"));
		for (let i = 0; i < 50; i++) {
			const g = gutterOf(`r#${i}`)!;
			expect(g >= 0 && g < GUTTER_COLOURS).toBe(true);
		}
		const rows = blameRows([
			commit("1", [{ key: "Tartan-Work", value: "r#1" }]),
			commit("2", [{ key: "Tartan-Work", value: "r#1" }]),
			commit("3", [{ key: "Tartan-Work", value: "r#2" }]),
			commit("4", []),
		]);
		expect(rows.map((r) => r.bandStart)).toEqual([true, false, true, true]);
		expect(workLegend(rows).map((l) => [l.work, l.commits])).toEqual([
			["r#1", 2],
			["r#2", 1],
		]);
	});

	it("reads note sections by extension id, with or without a version", () => {
		const p = provenanceOf(WHY.note!);
		expect(p.work?.why).toContain("Each team should own its routes");
		expect(p.work?.acceptance).toHaveLength(2);
		expect(p.change?.revision).toBe(2);
		expect(p.review).toEqual({
			route: "auto",
			risk: 0.18,
			decidedBy: undefined,
		});
		expect(p.others).toEqual([]);
		const odd: WhyNote = {
			...WHY.note!,
			ext: { "acme.no-secrets": { findings: 0 }, "tartan.work": "garbage" },
		};
		const q = provenanceOf(odd);
		expect(q.work).toBeUndefined();
		expect(q.others).toEqual(["acme.no-secrets"]);
	});

	it("lists every reason event, marking those the answer did not carry", () => {
		const note: WhyNote = {
			...WHY.note!,
			kernel: {
				...WHY.note!.kernel,
				reason: {
					summary: "x",
					events: [WHY.events[0]!.id, "01k6zzzzzzzzzzzzzzzzzzzzzz"],
				},
			},
		};
		const out = reasonEvents(note, WHY.events);
		expect(out[0]!.event?.id).toBe(WHY.events[0]!.id);
		expect(out[1]).toEqual({ id: "01k6zzzzzzzzzzzzzzzzzzzzzz" });
	});
});
