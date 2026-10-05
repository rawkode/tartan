// Drift check for the generated JSON files and sanity of the interface bundles.
// Regenerate with:
//   deno run -A packages/contract/scripts/gen-schemas.ts && deno fmt packages/contract

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { INTERFACE_IDS } from "../src/common.ts";
import { generatedFiles } from "../src/generated.ts";
import {
	CONTEXT_PRIORITIES,
	ContextSectionSchema,
	DEFINED_INTERFACE_IDS,
	INTERFACE_TOOLS,
	INTERFACES,
	LaneHandleSchema,
} from "../src/interfaces.ts";
import { KERNEL_TOOL_NAMES } from "../src/mcp.ts";
import { jsonSchemaValidator, readJson } from "./helpers.ts";

// Generated JSON (interfaces/*.json, schema/envelope-1.json) is not committed; `deno task gen` writes it.
const generated = (path: string): unknown =>
	JSON.parse(JSON.stringify(generatedFiles()[path]));

Deno.test("generated: every generated file is JSON-serializable", () => {
	for (const [path, value] of Object.entries(generatedFiles())) {
		ok(value !== undefined, `${path} generated`);
		deepStrictEqual(generated(path), JSON.parse(JSON.stringify(value)));
	}
});

Deno.test("generated: the files on disk match their zod sources (run `deno task gen`)", async () => {
	for (const path of Object.keys(generatedFiles())) {
		let onDisk: unknown;
		try {
			onDisk = await readJson(path);
		} catch (e) {
			throw new Error(
				`${path} is missing or unreadable: run \`deno task gen\``,
				{
					cause: e,
				},
			);
		}
		deepStrictEqual(
			onDisk,
			generated(path),
			`${path} drifted: run \`deno task gen\``,
		);
	}
});

Deno.test("interfaces v0.2: lane handles carry mode and state; reviews carry the head", () => {
	const work = generated("interfaces/work@1.json") as {
		tools: Record<string, { output: unknown }>;
	};
	const claim = jsonSchemaValidator(work.tools.work_claim.output);
	const lane = {
		id: "ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
		mode: "repo",
		state: "opening",
		remote:
			"https://forge.test/acme/x/-/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa.git",
		ref: "refs/heads/main",
		branch: "lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
		base: "a".repeat(40),
	};
	const result = (l: unknown) => ({
		lane: l,
		work: {
			ref: "acme/x#1",
			kind: "intent",
			title: "t",
			why: "",
			acceptance: [],
			footprint: { projects: [], prefixes: [] },
			state: "claimed",
			claims: [],
			labels: [],
			priority: 2,
		},
		overlaps: [],
		context: null,
	});
	ok(claim(result(lane)).valid, claim(result(lane)).errors.join("; "));
	const open = {
		...lane,
		state: "open",
		git: {
			start:
				"git fetch <lane remote> main && git switch -c lanes/ln_… FETCH_HEAD",
			push: "git push <lane remote> HEAD:refs/heads/main",
		},
	};
	ok(claim(result(open)).valid, claim(result(open)).errors.join("; "));
	for (
		const bad of [{ ...lane, mode: undefined }, { ...lane, state: "landing" }]
	) {
		equal(claim(result(JSON.parse(JSON.stringify(bad)))).valid, false);
	}
	ok(LaneHandleSchema.safeParse(open).success);
	const review = generated("interfaces/review@1.json") as {
		events: Record<string, unknown>;
	};
	const decided = jsonSchemaValidator(review.events["review.decided"]);
	const requested = jsonSchemaValidator(review.events["review.requested"]);
	const d = {
		changeId: "zkqv".repeat(8),
		revision: 1,
		head: "b".repeat(40),
		decision: "approve",
		route: "human",
		decidedBy: { kind: "user", id: "u_01k6aaaaaaaaaaaaaaaaaaaaaa" },
	};
	ok(decided(d).valid, decided(d).errors.join("; "));
	const { head: _dh, ...noHead } = d;
	equal(decided(noHead).valid, false, "head is required");
	const r = {
		changeId: "zkqv".repeat(8),
		revision: 1,
		head: "b".repeat(40),
		route: "human",
		attentionSet: [],
	};
	ok(requested(r).valid, requested(r).errors.join("; "));
	const { head: _rh, ...requestedNoHead } = r;
	equal(requested(requestedNoHead).valid, false);
});

Deno.test("interfaces: v0.2 defines the seven interfaces", () => {
	deepStrictEqual(DEFINED_INTERFACE_IDS.sort(), [
		"changes@1",
		"checks@1",
		"conflicts@1",
		"context@1",
		"queue@1",
		"review@1",
		"work@1",
	]);
	deepStrictEqual([...INTERFACE_IDS].sort(), DEFINED_INTERFACE_IDS.sort());
});

Deno.test("interfaces: events and tools live in their interface's namespace", () => {
	for (const def of Object.values(INTERFACES)) {
		for (const type of Object.keys(def.events)) {
			equal(type.split(".")[0], def.name, `${def.id} event ${type}`);
		}
		for (const name of Object.keys(def.tools)) {
			ok(name.startsWith(`${def.name}_`), `${def.id} tool ${name}`);
		}
	}
	for (const name of KERNEL_TOOL_NAMES) {
		equal(INTERFACE_TOOLS[name], undefined, `${name} collides`);
	}
	// Interface tools, by name.
	deepStrictEqual(Object.keys(INTERFACE_TOOLS).sort(), [
		"changes_abandon",
		"changes_comment",
		"changes_get",
		"changes_list",
		"changes_open",
		"changes_submit",
		"checks_get",
		"checks_rerun",
		"conflicts_ack",
		"conflicts_check",
		"conflicts_list",
		"queue_enqueue",
		"queue_status",
		"queue_withdraw",
		"review_decide",
		"review_get",
		"review_queue",
		"work_claim",
		"work_comment",
		"work_create",
		"work_get",
		"work_list",
		"work_release",
		"work_update",
	]);
	for (const tool of ["queue_enqueue", "review_decide", "work_claim"]) {
		ok(INTERFACE_TOOLS[tool].def.mutating, `${tool} is mutating (K12)`);
	}
});

Deno.test("interfaces: generated bundles are usable JSON Schemas", () => {
	for (const id of DEFINED_INTERFACE_IDS) {
		const bundle = generated(`interfaces/${id}.json`) as {
			entity: unknown;
			events: Record<string, unknown>;
			tools: Record<string, { input: unknown; output: unknown }>;
		};
		if (bundle.entity) jsonSchemaValidator(bundle.entity);
		for (const s of Object.values(bundle.events)) jsonSchemaValidator(s);
		for (const t of Object.values(bundle.tools)) {
			jsonSchemaValidator(t.input);
			jsonSchemaValidator(t.output);
		}
	}
	const changes = generated("interfaces/changes@1.json") as {
		events: Record<string, unknown>;
	};
	const submitted = jsonSchemaValidator(changes.events["changes.submitted"]);
	const good = {
		changeId: "zkqv".repeat(8),
		laneId: "ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
		revision: 1,
		head: "b".repeat(40),
		base: "a".repeat(40),
		affected: ["api"],
	};
	ok(submitted(good).valid, submitted(good).errors.join("; "));
	equal(submitted({ ...good, revision: 0 }).valid, false);
	equal(submitted({ ...good, head: "nope" }).valid, false);
});

Deno.test("interfaces: context@1 sections are strict", () => {
	ok(
		ContextSectionSchema.safeParse({
			id: "radar",
			priority: "conflicts",
			md: "x",
		}).success,
	);
	equal(
		ContextSectionSchema.safeParse({ id: "radar", priority: "urgent", md: "x" })
			.success,
		false,
	);
	equal(
		ContextSectionSchema.safeParse({
			id: "radar",
			priority: "hints",
			md: "x",
			html: "<b>",
		}).success,
		false,
	);
	deepStrictEqual([...CONTEXT_PRIORITIES], [
		"protocol",
		"negative",
		"conflicts",
		"ownership",
		"hints",
	]);
});
