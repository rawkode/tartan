// Advances with gates (WP19): the summary of the
// loaded advances and the gate filters over the mock kernel, and the
// summary's counting rules (an enforced veto blocks; a shadow veto is "would
// have vetoed N of the last M") as pure functions.

import { describe, expect, it } from "vitest";
import type { AdvanceDto } from "@tartan/contract/api.ts";
import { ADVANCES } from "../src/api/mock/land.ts";
import { matchesFilter, summarize } from "../src/views/coord/advances/model.ts";
import { mountApp } from "./support/app.ts";
import { byAttr, click, flush, text } from "./support/renderer.ts";

const REPO = "/acme/platform/router";

describe("advances page", () => {
	it("summarizes what is loaded", async () => {
		const app = await mountApp(`${REPO}/-/advances`);
		const summary = text(byAttr(app.root, "data-advances-summary")[0]!);
		expect(summary).toContain("1 landed");
		expect(summary).toContain("1 stale");
		expect(summary).toContain("1 reused evidence");
		expect(summary).toContain("of the 2 loaded");
		expect(text(app.root)).toContain("chain #2");
	});

	it("filters by gate: shadow decisions, vetoes, back to all", async () => {
		const app = await mountApp(`${REPO}/-/advances`);
		const filter = (f: string) => byAttr(app.root, "data-filter", f)[0]!;
		click(filter("shadow"));
		await flush();
		expect(byAttr(app.root, "data-advance")).toHaveLength(1);
		expect(filter("shadow").attrs["aria-pressed"]).toBe("true");
		click(filter("veto"));
		await flush();
		expect(byAttr(app.root, "data-advance")).toHaveLength(0);
		expect(text(app.root)).toContain("No loaded advance matches this filter.");
		click(filter("all"));
		await flush();
		expect(byAttr(app.root, "data-advance")).toHaveLength(2);
	});
});

const advance = (
	n: number,
	gates: AdvanceDto["gateResults"],
	state: AdvanceDto["state"] = "done",
): AdvanceDto => ({
	...ADVANCES[0]!,
	id: `adv_${n}`,
	state,
	gateResults: gates,
});

describe("advances model", () => {
	it("counts enforced vetoes and what shadow gates would have vetoed", () => {
		const list = [
			advance(1, [
				{ ext: "acme.no-secrets@1.0.0", decision: "veto", mode: "shadow" },
			]),
			advance(2, [
				{ ext: "acme.no-secrets@1.0.0", decision: "veto", mode: "shadow" },
				{ ext: "tartan.radar", decision: "veto", mode: "shadow" },
			]),
			advance(3, [{
				ext: "acme.no-secrets@1.0.0",
				decision: "allow",
				mode: "shadow",
			}]),
			advance(
				4,
				[{ ext: "tartan.review", decision: "veto", mode: "enforce" }],
				"failed",
			),
			advance(5, undefined, "locked"),
		];
		const s = summarize(list);
		expect(s.total).toBe(5);
		expect(s.landed).toBe(3);
		expect(s.failed).toBe(1);
		expect(s.inFlight).toBe(1);
		expect(s.vetoed).toBe(1);
		expect(s.shadowVetoes).toBe(2);
		expect(s.shadowByExt).toEqual([
			{ ext: "acme.no-secrets@1.0.0", vetoes: 2 },
			{ ext: "tartan.radar", vetoes: 1 },
		]);
		expect(list.filter((a) => matchesFilter(a, "gated"))).toHaveLength(4);
		expect(list.filter((a) => matchesFilter(a, "veto")).map((a) => a.id))
			.toEqual(["adv_4"]);
		expect(list.filter((a) => matchesFilter(a, "shadow"))).toHaveLength(3);
		expect(s.seeded).toBe(0);
	});

	it("counts the labelled Advances of the dev-only history seeding", () => {
		const list = [
			{ ...advance(1, undefined), seeded: true as const },
			{ ...advance(2, undefined), seeded: true as const },
			advance(3, undefined),
		];
		const s = summarize(list);
		expect(s.seeded).toBe(2);
		expect(s.landed).toBe(3);
	});
});
