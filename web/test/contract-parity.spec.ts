// The SPA copies a few contract values so zod stays out of the browser
// bundle; these tests fail when the copies drift from `@tartan/contract`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDABLE_INTERFACES, ROLE } from "@tartan/contract/common.ts";
import * as contractEvents from "@tartan/contract/events.ts";
import * as contractConfig from "@tartan/contract/repoconfig.ts";
import * as contractUi from "@tartan/contract/ui.ts";
import { matchesEventPattern } from "../src/live/patterns.ts";
import { checkNode } from "../src/ui/guards.ts";
import * as ui from "../src/ui/nodeTypes.ts";
import { NODE_SAMPLES } from "../src/ui/samples.ts";
import { settingsForm, settingsValues } from "../src/ui/settingsForm.ts";
import * as config from "../src/views/repoconfig/model.ts";
import * as admin from "../src/views/admin/interfaces.ts";

describe("contract copies", () => {
	it("the single-provider interfaces match (the swap offers them)", () => {
		expect([...admin.PROVIDABLE_INTERFACES]).toEqual([
			...PROVIDABLE_INTERFACES,
		]);
	});

	it("node types, tones and limits match", () => {
		expect([...ui.UI_NODE_TYPES]).toEqual([...contractUi.UI_NODE_TYPES]);
		expect([...ui.TONES]).toEqual([...contractUi.TONES]);
		expect(ui.UI_LIMITS.maxNodes).toBe(contractUi.UI_LIMITS.maxNodes);
		expect(ui.UI_LIMITS.maxBytes).toBe(contractUi.UI_LIMITS.maxBytes);
		expect(ui.MAX_DEPTH).toBe(contractUi.UI_LIMITS.maxDepth);
	});

	it("regexes match", () => {
		const pairs: [RegExp, RegExp][] = [
			[ui.SAME_ORIGIN_PATH_RE, contractUi.SAME_ORIGIN_PATH_RE],
			[ui.LINK_HREF_RE, contractUi.LINK_HREF_RE],
			[ui.AVATAR_PRINCIPAL_RE, contractUi.AVATAR_PRINCIPAL_RE],
			[ui.ICON_NAME_RE, contractUi.ICON_NAME_RE],
			[ui.ACTION_ID_RE, contractUi.ACTION_ID_RE],
			[ui.FIELD_NAME_RE, contractUi.FIELD_NAME_RE],
		];
		for (const [mine, theirs] of pairs) expect(mine.source).toBe(theirs.source);
	});

	it("event pattern matching agrees", () => {
		const cases: [string, string][] = [
			["*", "changes.opened"],
			["changes.*", "changes.opened"],
			["changes.*", "changes.revision.added"],
			["changes.*", "changesx.opened"],
			["changes.opened", "changes.opened"],
			["changes.opened", "changes.closed"],
			["x.acme.a.*", "x.acme.a.b.evt"],
			["checks.*", "checks"],
		];
		for (const [pattern, type] of cases) {
			expect(matchesEventPattern(pattern, type)).toBe(
				contractEvents.matchesEventPattern(pattern, type),
			);
		}
	});
});

describe("repository config copies (WP23)", () => {
	it("texts, the position rule, the binding file and roles match", () => {
		expect(config.REPO_CONFIG_POSITION_RE.source).toBe(
			contractConfig.REPO_CONFIG_POSITION_RE.source,
		);
		expect(config.FORGE_BINDING_FILE).toBe(contractConfig.FORGE_BINDING_FILE);
		expect(config.NO_CHANGE_TEXT).toBe(contractConfig.NO_CHANGE_TEXT);
		expect(config.REPO_CONFIG_EXPORT_COMMAND).toBe(
			contractConfig.REPO_CONFIG_EXPORT_COMMAND,
		);
		expect(config.LEGACY_DIR_HINT).toBe(contractConfig.LEGACY_DIR_HINT);
		expect(config.MANAGED_BY_TEXT).toBe(contractConfig.MANAGED_BY_TEXT);
		expect(config.ROLE_MAINTAINER).toBe(ROLE.maintainer);
		expect(config.ROLE_OWNER).toBe(ROLE.owner);
	});

	it("has a label for every status, preview state and denial code", () => {
		expect(Object.keys(config.STATUS_VIEW).sort()).toEqual(
			[...contractConfig.REPO_CONFIG_STATUSES].sort(),
		);
		expect(Object.keys(config.PREVIEW_VIEW).sort()).toEqual(
			[...contractConfig.REPO_CONFIG_PREVIEW_STATES].sort(),
		);
		expect(Object.keys(config.DENIAL_LABEL).sort()).toEqual(
			[...contractConfig.REPO_CONFIG_DENIAL_CODES].sort(),
		);
	});
});

describe("guards.checkNode agrees with validateUi", () => {
	for (const [t, node] of Object.entries(NODE_SAMPLES)) {
		it(`accepts the ${t} sample like the contract`, () => {
			expect(contractUi.validateUi({ v: 1, root: node }).ok).toBe(true);
			expect(checkNode(node).ok).toBe(true);
		});
	}

	const invalid: [string, unknown][] = [
		["unknown type", { t: "iframe" }],
		["missing text", { t: "text" }],
		["text too long", { t: "badge", text: "x".repeat(4001) }],
		["bad tone", { t: "badge", text: "x", tone: "loud" }],
		["bad level", { t: "heading", text: "x", level: 1 }],
		["extra prop", { t: "divider", style: "x" }],
		["link //", { t: "link", text: "x", href: "//evil" }],
		["link /\\", { t: "link", text: "x", href: "/\\evil" }],
		["link http", { t: "link", text: "x", href: "http://evil" }],
		["link control char", { t: "link", text: "x", href: "/\t/evil" }],
		["bad avatar", { t: "avatar", principal: "../x" }],
		["bad icon", { t: "icon", name: "Bad Name" }],
		["bad action id", { t: "button", text: "x", action: { id: "Bad!" } }],
		["action extra", { t: "button", text: "x", action: { id: "a", url: "/" } }],
		["confirm too long", {
			t: "button",
			text: "x",
			action: { id: "a", confirm: "x".repeat(201) },
		}],
		["button text too long", { t: "button", text: "x".repeat(61) }],
		["bad field name", { t: "input", name: "Bad-Name" }],
		["bad option", { t: "select", name: "a", options: [{ value: "a" }] }],
		["grid cols 7", { t: "grid", cols: 7 }],
		["gap 4", { t: "stack", gap: 4 }],
		["tabs > 12", {
			t: "tabs",
			tabs: Array.from(
				{ length: 13 },
				() => ({ label: "x", body: { t: "divider" } }),
			),
		}],
		["matrix level 6", {
			t: "matrix",
			rows: [],
			cols: [],
			cells: [{ r: "a", c: "b", level: 6 }],
		}],
		["timeline at float", { t: "timeline", items: [{ at: 1.5, text: "x" }] }],
		["board card href //", {
			t: "board",
			columns: [],
			cards: [{ id: "a", col: "b", title: "c", href: "//x" }],
		}],
		["sparkline string", { t: "sparkline", values: ["1"] }],
		["table columns > 12", {
			t: "table",
			columns: Array.from({ length: 13 }, () => "c"),
			rows: [],
		}],
		["kv item extra", { t: "kv", items: [{ k: "a", v: "b", x: 1 }] }],
		["error-chip from extension", { t: "error-chip", text: "x" }],
	];
	for (const [label, node] of invalid) {
		it(`rejects ${label} like the contract`, () => {
			expect(contractUi.validateUi({ v: 1, root: node }).ok).toBe(false);
			expect(checkNode(node).ok).toBe(false);
		});
	}
});

describe("settings forms are valid tartan-ui@1", () => {
	it("renders a JSON-schema settings form the contract accepts, strings as text", () => {
		const { form, unsupported } = settingsForm(
			{
				type: "object",
				required: ["label"],
				properties: {
					trainSize: { type: "integer", title: "Train size", default: 1 },
					label: {
						type: "string",
						title: "Queue label <script>alert(1)</script>",
					},
					strict: { type: "boolean", title: "Strict" },
					mode: { enum: ["a", "b"], title: "Mode" },
					nested: { type: "object" },
					"Bad Name": { type: "string" },
				},
			},
			{ label: "main", trainSize: 3 },
		);
		expect(unsupported).toEqual(["nested"]);
		expect(form).not.toBeNull();
		expect(contractUi.validateUi({ v: 1, root: form }).ok).toBe(true);
		expect(checkNode(form).ok).toBe(true);
		expect(JSON.stringify(form)).toContain('"value":3');
		const parsed = settingsForm(
			{
				properties: {
					trainSize: { type: "integer" },
					"Bad Name": { type: "string" },
				},
			},
			{},
		);
		expect(parsed.names).toEqual({ f0: "trainSize", f1: "Bad Name" });
		expect(settingsValues(parsed, { f0: 2, f1: "x", f9: "ignored" })).toEqual({
			trainSize: 2,
			"Bad Name": "x",
		});
	});
});

// Not `new URL(…, import.meta.url)`: Vite's client transform rewrites it.
const CONTRACT_SRC = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../packages/contract/src",
);

/** The contract modules the SPA imports values from (vite.config.ts). */
const RUNTIME_MODULES = ["slots.ts", "slot-ctx.ts", "paths.ts"];

describe("contract modules imported at runtime", () => {
	for (const file of RUNTIME_MODULES) {
		it(`${file} imports values only from the other zod-free modules`, () => {
			const source = readFileSync(join(CONTRACT_SRC, file), "utf8");
			const valueImports = [
				...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms),
			].map((m) => m[1]);
			for (const specifier of valueImports) {
				expect(RUNTIME_MODULES.map((m) => `./${m}`)).toContain(specifier);
			}
		});
	}
});
