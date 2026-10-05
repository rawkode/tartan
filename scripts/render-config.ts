// Renders a per-stage wrangler config from the repo's `wrangler.jsonc`.
//
// The source file is deployable as-is with default names (the button path).
// For the CLI path this script writes `.wrangler/deploy/wrangler.<stage>.jsonc`:
//   - every derived name gets the stage: Worker `tartan-<stage>`, Artifacts
//     namespace `tartan-<stage>` in the binding AND the trigger filter, Workflows
//     `tartan-<stage>-{run,land,ingest,swarm}` (and the trigger target), bucket
//     `tartan-<stage>-blobs`, `vars.TARTAN_STAGE = <stage>`;
//   - `--domain <host>` adds `routes: [{ pattern: host, custom_domain: true }]`;
//   - `--no-containers` drops the `containers` entry; `TartanSandbox` stays a
//     plain SQLite DO class with the same migration;
//   - `--image dockerfile|registry` picks the container image variant
//     (`IMAGE_VARIANT`): the Dockerfile (default), or the
//     digest-pinned reference `containers/runner/publish.ts` recorded
//     (`--image-record`, default `.wrangler/deploy/runner-image.json` next to
//     the source); a tag reference is refused;
//   - `--no-eviction-flag` drops `durable_object_io_tasks_prevent_eviction`
//     (the documented fallback if the edge rejects it);
//   - `--repo-config on` sets `vars.TARTAN_REPO_CONFIG = "on"` (repository
//     config in CUE, ADR repo config; absent means off, the default); it
//     needs containers, so `--no-containers` keeps it off;
//   - `--projects scan` sets `vars.TARTAN_PROJECTS = "scan"` (monorepo
//     projects from cuenv `#Project`s, WP25; absent means off, the default);
//     it needs no containers (the scan runs in the Worker);
//   - `--dev-tools` sets `vars.TARTAN_DEV_TOOLS = "1"` (swarm, bulk tokens,
//     reset), only for a `dev` or `dev-*` stage;
//   - `--k2-stream <32 hex>` adds the global log's producer binding
//     (`k2: [{binding: "EVENT_LOG", stream, remote: true}]`, never in the
//     source: the stream is per stage) and `vars.TARTAN_K2_STREAM`;
//     `--k2-token-store <32 hex> --k2-token-secret <name>` add the K2
//     Consume token as a Secrets Store binding (`secrets_store_secrets`,
//     `TARTAN_K2_TOKEN`). Without a stream the forge has no global log and
//     every run dispatches inline (WP26);
//   - `--lane-mode <import|branch>` sets `vars.TARTAN_LANE_MODE`, the stage's
//     override of the compiled `LANE_MODE` (set once the stage's live lane
//     acceptance passed);
//   - `--workload-transport <local|k2>` sets `vars.TARTAN_WORKLOAD_TRANSPORT`,
//     the stage's override of `WORKLOAD_TRANSPORT` (`k2` needs `--k2-stream`
//     with the consume token);
//   - relative paths (`$schema`, `main`, `assets.directory`, a Dockerfile
//     `image`) are rebased, because wrangler resolves them against the
//     directory of the config file it is given.
//
// Edits are applied to the original text, so comments and layout survive.
// Nothing here talks to Cloudflare; deploy orchestration is scripts/deploy.ts.
//
// Usage:
//   deno run -A scripts/render-config.ts --stage <stage> [--domain <host>]
//     [--no-containers | --image dockerfile|registry [--image-record <path>]]
//     [--no-eviction-flag] [--dev-tools]
//     [--k2-stream <id> [--k2-token-store <id> --k2-token-secret <name>]]
//     [--source wrangler.jsonc] [--out <path>]
// Prints the path of the rendered file on stdout.

import * as path from "node:path";

export const EVICTION_FLAG = "durable_object_io_tasks_prevent_eviction";
export const DOCKERFILE_IMAGE = "./containers/runner/Dockerfile";
export const SANDBOX_CLASS = "TartanSandbox";
export const MAX_STAGE_LENGTH = 32;
/**
 * Where `containers/runner/publish.ts` records the image it pushed, relative
 * to the source config's directory: JSON `{ "ref": "<host>/<path>@sha256:<64
 * hex>" }` (other fields are ignored).
 */
export const RUNNER_IMAGE_RECORD = ".wrangler/deploy/runner-image.json";
/** The var that, with a `dev` stage, enables the dev-only tools. */
export const DEV_TOOLS_VAR = "TARTAN_DEV_TOOLS";
/** Repository config in CUE (`on` | absent = off; src/env.ts). */
export const REPO_CONFIG_VAR = "TARTAN_REPO_CONFIG";
/** Monorepo projects (`scan` | absent = off; src/env.ts, WP25). */
export const PROJECTS_VAR = "TARTAN_PROJECTS";
/** Per-stage switch overrides (src/constants.ts `laneModeOf`, `workloadTransportOf`). */
export const LANE_MODE_VAR = "TARTAN_LANE_MODE";
export const WORKLOAD_TRANSPORT_VAR = "TARTAN_WORKLOAD_TRANSPORT";
export const LANE_MODE_VALUES = ["import", "branch"] as const;
export type LaneModeOverride = typeof LANE_MODE_VALUES[number];
export const WORKLOAD_TRANSPORT_VALUES = ["local", "k2"] as const;
export type WorkloadTransportOverride =
	typeof WORKLOAD_TRANSPORT_VALUES[number];
/** Stages that may enable the dev tools: `dev` and `dev-*`. */
export const DEV_TOOLS_STAGE_RE = /^dev(?:-|$)/;
/** The global log's producer binding and var (WP26; `src/env.ts`). */
export const K2_BINDING = "EVENT_LOG";
export const K2_STREAM_VAR = "TARTAN_K2_STREAM";
export const K2_TOKEN_BINDING = "TARTAN_K2_TOKEN";
/** K2 stream ids and Secrets Store ids are 32 lowercase hex characters. */
export const HEX32_RE = /^[0-9a-f]{32}$/;
/** A Secrets Store secret name. */
export const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** The global log inputs: the stage's stream, and the consume token's store and name. */
export type K2Render = {
	readonly streamId: string;
	readonly token?: { readonly storeId: string; readonly secretName: string };
};

export type ImageVariant =
	| { readonly kind: "dockerfile" }
	| { readonly kind: "registry"; readonly ref: string };

export type RenderOptions = {
	readonly stage: string;
	readonly domain?: string;
	readonly containers: boolean;
	readonly image: ImageVariant;
	readonly evictionFlag: boolean;
	/** `TARTAN_DEV_TOOLS = "1"`; only for a `dev`/`dev-*` stage. */
	readonly devTools?: boolean;
	/** `TARTAN_REPO_CONFIG = "on"`; needs containers (the evaluator runs there). */
	readonly repoConfig?: boolean;
	/** The global log (WP26): absent = no stream, inline dispatch. */
	readonly k2?: K2Render;
	/** `TARTAN_PROJECTS = "scan"` (cuenv projects, WP25). */
	readonly projects?: boolean;
	/** `TARTAN_LANE_MODE`: the stage's lane mode (absent = the compiled default). */
	readonly laneMode?: LaneModeOverride;
	/** `TARTAN_WORKLOAD_TRANSPORT` (absent = the compiled default; `k2` needs `k2.token`). */
	readonly workloadTransport?: WorkloadTransportOverride;
	// Directory of the source config and of the rendered file; used only to
	// rebase relative paths. Equal directories leave paths untouched.
	readonly sourceDir: string;
	readonly outDir: string;
};

export type CliOptions = Omit<RenderOptions, "image"> & {
	/** `registry` is resolved from `imageRecordPath` before rendering. */
	readonly image: ImageVariant["kind"];
	readonly imageRecordPath: string;
	readonly sourcePath: string;
	readonly outPath: string;
};

export class ConfigRenderError extends Error {
	override name = "ConfigRenderError";
}

const fail = (message: string): never => {
	throw new ConfigRenderError(message);
};

// ---------------------------------------------------------------------------
// JSONC parsing with source offsets (comments, trailing commas allowed)
// ---------------------------------------------------------------------------

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type Entry = {
	// Start of the entry: the key of a property, the value of an array item.
	readonly start: number;
	readonly value: JsonNode;
	// Offset of the comma that follows the value, if any.
	readonly commaAt?: number;
};

export type PropEntry = Entry & { readonly key: string };

export type JsonNode =
	| {
		readonly kind: "object";
		readonly start: number;
		readonly end: number;
		readonly props: readonly PropEntry[];
	}
	| {
		readonly kind: "array";
		readonly start: number;
		readonly end: number;
		readonly items: readonly Entry[];
	}
	| {
		readonly kind: "literal";
		readonly start: number;
		readonly end: number;
		readonly value: string | number | boolean | null;
	};

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export const parseJsonc = (text: string): JsonNode => {
	let pos = 0;

	const where = (at: number): string => {
		const before = text.slice(0, at).split("\n");
		return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
	};
	const error = (message: string, at = pos): never =>
		fail(`JSONC parse error at ${where(at)}: ${message}`);

	const skipTrivia = (): void => {
		while (pos < text.length) {
			const ch = text[pos];
			if (
				ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "﻿"
			) {
				pos++;
			} else if (text.startsWith("//", pos)) {
				const eol = text.indexOf("\n", pos);
				pos = eol === -1 ? text.length : eol;
			} else if (text.startsWith("/*", pos)) {
				const close = text.indexOf("*/", pos + 2);
				if (close === -1) error("unterminated block comment");
				pos = close + 2;
			} else {
				return;
			}
		}
	};

	const parseString = (): string => {
		const start = pos;
		pos++;
		while (pos < text.length) {
			const ch = text[pos];
			if (ch === "\\") pos += 2;
			else if (ch === "\n") error("newline in string", start);
			else if (ch === '"') {
				pos++;
				try {
					return JSON.parse(text.slice(start, pos)) as string;
				} catch {
					return error("invalid string escape", start);
				}
			} else pos++;
		}
		return error("unterminated string", start);
	};

	const parseValue = (): JsonNode => {
		skipTrivia();
		const start = pos;
		const ch = text[pos];
		if (ch === "{") {
			pos++;
			const props: PropEntry[] = [];
			skipTrivia();
			while (text[pos] !== "}") {
				if (text[pos] !== '"') error("expected a property name or '}'");
				const keyStart = pos;
				const key = parseString();
				skipTrivia();
				if (text[pos] !== ":") error("expected ':'");
				pos++;
				const value = parseValue();
				skipTrivia();
				if (text[pos] === ",") {
					props.push({ key, start: keyStart, value, commaAt: pos });
					pos++;
					skipTrivia();
				} else if (text[pos] === "}") {
					props.push({ key, start: keyStart, value });
				} else {
					error("expected ',' or '}'");
				}
			}
			pos++;
			return { kind: "object", start, end: pos, props };
		}
		if (ch === "[") {
			pos++;
			const items: Entry[] = [];
			skipTrivia();
			while (text[pos] !== "]") {
				if (pos >= text.length) error("unterminated array", start);
				const value = parseValue();
				skipTrivia();
				if (text[pos] === ",") {
					items.push({ start: value.start, value, commaAt: pos });
					pos++;
					skipTrivia();
				} else if (text[pos] === "]") {
					items.push({ start: value.start, value });
				} else {
					error("expected ',' or ']'");
				}
			}
			pos++;
			return { kind: "array", start, end: pos, items };
		}
		if (ch === '"') {
			const value = parseString();
			return { kind: "literal", start, end: pos, value };
		}
		for (
			const [word, value] of [["true", true], ["false", false], [
				"null",
				null,
			]] as const
		) {
			if (text.startsWith(word, pos)) {
				pos += word.length;
				return { kind: "literal", start, end: pos, value };
			}
		}
		NUMBER.lastIndex = pos;
		const match = NUMBER.exec(text);
		if (match) {
			pos += match[0].length;
			return { kind: "literal", start, end: pos, value: Number(match[0]) };
		}
		return error(
			pos >= text.length ? "unexpected end of input" : `unexpected '${ch}'`,
		);
	};

	const root = parseValue();
	skipTrivia();
	if (pos !== text.length) error("unexpected content after the root value");
	return root;
};

export const toValue = (node: JsonNode): JsonValue => {
	switch (node.kind) {
		case "literal":
			return node.value;
		case "array":
			return node.items.map((item) => toValue(item.value));
		case "object":
			return Object.fromEntries(
				node.props.map((prop) => [prop.key, toValue(prop.value)]),
			);
	}
};

export const parseJsoncValue = (text: string): JsonValue =>
	toValue(parseJsonc(text));

// ---------------------------------------------------------------------------
// Comment-preserving edits
// ---------------------------------------------------------------------------

type Edit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

const applyEdits = (text: string, edits: readonly Edit[]): string => {
	const sorted = edits
		.map((edit, order) => ({ ...edit, order }))
		.sort((a, b) => a.start - b.start || a.order - b.order);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].start < sorted[i - 1].end) {
			fail(`internal error: overlapping edits at offset ${sorted[i].start}`);
		}
	}
	let out = "";
	let cursor = 0;
	for (const edit of sorted) {
		out += text.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return out + text.slice(cursor);
};

// Inline JSON in the style deno fmt uses for short values.
export const formatInline = (value: JsonValue): string => {
	if (Array.isArray(value)) return `[${value.map(formatInline).join(", ")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		return `{ ${
			entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatInline(v)}`).join(
				", ",
			)
		} }`;
	}
	return JSON.stringify(value);
};

const lineStart = (text: string, at: number): number =>
	text.lastIndexOf("\n", at - 1) + 1;
const isBlank = (s: string): boolean => /^[ \t\r]*$/.test(s);
const indentAt = (text: string, at: number): string =>
	/^[ \t]*/.exec(text.slice(lineStart(text, at)))![0];

const replaceValue = (node: JsonNode, value: JsonValue): Edit => ({
	start: node.start,
	end: node.end,
	text: formatInline(value),
});

// Removes entry `index` of an object or array. When the entry sits on its own
// lines, the whole lines go, together with its trailing line comment and the
// full-line comments directly above it (they describe it); `note`, if given,
// replaces them as a single comment line at the same indentation.
const removeEntry = (
	text: string,
	entries: readonly Entry[],
	index: number,
	note?: string,
): Edit[] => {
	const entry = entries[index];
	const edits: Edit[] = [];
	let start = entry.start;
	let end = entry.commaAt === undefined ? entry.value.end : entry.commaAt + 1;
	if (entry.commaAt === undefined && index > 0) {
		const previousComma = entries[index - 1].commaAt!;
		edits.push({ start: previousComma, end: previousComma + 1, text: "" });
	}
	const ls = lineStart(text, start);
	let rest = end;
	while (text[rest] === " " || text[rest] === "\t") rest++;
	if (text.startsWith("//", rest)) {
		const eol = text.indexOf("\n", rest);
		rest = eol === -1 ? text.length : eol;
	}
	const isolated = isBlank(text.slice(ls, start)) &&
		(rest === text.length || text[rest] === "\n" || text[rest] === "\r");
	if (isolated) {
		const indent = text.slice(ls, start);
		start = ls;
		while (start > 0) {
			const previous = lineStart(text, start - 1);
			if (!/^[ \t]*\/\//.test(text.slice(previous, start - 1))) break;
			start = previous;
		}
		end = rest === text.length ? rest : text.indexOf("\n", rest) + 1;
		edits.push({
			start,
			end,
			text: note === undefined ? "" : `${indent}// ${note}\n`,
		});
	} else {
		edits.push({ start, end, text: note === undefined ? "" : `/* ${note} */` });
	}
	return edits;
};

// Appends properties to an object (after any trailing comments), adding the
// separating comma right after the current last value. All additions to one
// object must go through a single call so they are comma-joined.
const appendProperties = (
	text: string,
	object: Extract<JsonNode, { kind: "object" }>,
	additions: readonly (readonly [string, JsonValue])[],
): Edit[] => {
	if (additions.length === 0) return [];
	const edits: Edit[] = [];
	const last = object.props.at(-1);
	if (last && last.commaAt === undefined) {
		edits.push({ start: last.value.end, end: last.value.end, text: "," });
	}
	const close = object.end - 1;
	const ls = lineStart(text, close);
	const properties = additions.map(([key, value]) =>
		`${JSON.stringify(key)}: ${formatInline(value)}`
	);
	if (isBlank(text.slice(ls, close)) && ls > object.start) {
		const indent = last
			? indentAt(text, last.start)
			: `${text.slice(ls, close)}\t`;
		const lines = properties.map((p) => `${indent}${p}`).join(",\n");
		edits.push({ start: ls, end: ls, text: `${lines}\n` });
	} else {
		const spaced = /\s$/.test(text.slice(0, close));
		const joined = properties.join(", ");
		edits.push({
			start: close,
			end: close,
			text: last ? `${spaced ? "" : " "}${joined} ` : joined,
		});
	}
	return edits;
};

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

const STAGE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// host[:port]/path@sha256:<64 hex>: a digest and never a tag (anyone can push
// any name to ttl.sh, so only the digest pins what runs).
const DIGEST_REF =
	/^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$/;
const TAGGED_REF = /^[^@]*\/[^/@]*:[^/@]*(?:@.*)?$/;

export const validateStage = (stage: string): string => {
	if (!STAGE.test(stage) || stage.length > MAX_STAGE_LENGTH) {
		fail(
			`invalid --stage ${
				JSON.stringify(stage)
			}: use 1-${MAX_STAGE_LENGTH} lowercase letters, digits and single hyphens, starting with a letter`,
		);
	}
	return stage;
};

export const validateDomain = (domain: string): string => {
	const host = domain.toLowerCase();
	const labels = host.split(".");
	if (
		host.length > 253 || labels.length < 2 ||
		!labels.every((label) => LABEL.test(label))
	) {
		fail(
			`invalid --domain ${
				JSON.stringify(domain)
			}: give a bare hostname such as git.example.com (no scheme, port, path or wildcard)`,
		);
	}
	return host;
};

/** Validates the global log inputs (WP26). */
export const validateK2 = (k2: K2Render): K2Render => {
	if (!HEX32_RE.test(k2.streamId)) {
		fail(
			`invalid --k2-stream ${
				JSON.stringify(k2.streamId)
			}: give the stream id (32 lowercase hex), not its name`,
		);
	}
	if (k2.token !== undefined) {
		if (!HEX32_RE.test(k2.token.storeId)) {
			fail(
				`invalid --k2-token-store ${
					JSON.stringify(k2.token.storeId)
				}: give the Secrets Store id (32 lowercase hex)`,
			);
		}
		if (!SECRET_NAME_RE.test(k2.token.secretName)) {
			fail(
				`invalid --k2-token-secret ${JSON.stringify(k2.token.secretName)}`,
			);
		}
	}
	return k2;
};

export const parseImageKind = (value: string): ImageVariant["kind"] => {
	if (value === "dockerfile" || value === "registry") return value;
	return fail(
		`invalid --image ${
			JSON.stringify(value)
		}: use "dockerfile" (default) or "registry" (the digest recorded by containers/runner/publish.ts)`,
	);
};

/** A registry image reference pinned by digest; a tag is refused. */
export const validateRegistryRef = (ref: string): string => {
	if (DIGEST_REF.test(ref)) return ref;
	return fail(
		TAGGED_REF.test(ref)
			? `registry image ${
				JSON.stringify(ref)
			} carries a tag: only a digest reference (<host>/<path>@sha256:<64 hex>) is rendered`
			: `invalid registry image ${
				JSON.stringify(ref)
			}: expected <host>/<path>@sha256:<64 hex>`,
	);
};

/** The `registry` variant from the record `containers/runner/publish.ts` wrote. */
export const parseImageRecord = (text: string, where: string): ImageVariant => {
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch {
		return fail(`${where}: not JSON; re-run containers/runner/publish.ts`);
	}
	const ref = record !== null && typeof record === "object"
		? (record as { ref?: unknown }).ref
		: undefined;
	if (typeof ref !== "string") {
		return fail(
			`${where}: no "ref" string; re-run containers/runner/publish.ts`,
		);
	}
	return { kind: "registry", ref: validateRegistryRef(ref) };
};

const imageValue = (
	image: ImageVariant,
	rebase: (p: string) => string,
): string => {
	switch (image.kind) {
		case "dockerfile":
			return rebase(DOCKERFILE_IMAGE);
		case "registry":
			return validateRegistryRef(image.ref);
	}
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type ObjectNode = Extract<JsonNode, { kind: "object" }>;
type ArrayNode = Extract<JsonNode, { kind: "array" }>;

const prop = (object: ObjectNode, key: string): PropEntry | undefined =>
	object.props.find((entry) => entry.key === key);

const asObject = (node: JsonNode | undefined, where: string): ObjectNode =>
	node?.kind === "object"
		? node
		: fail(`wrangler config: ${where} must be an object`);

const asArray = (node: JsonNode | undefined, where: string): ArrayNode =>
	node?.kind === "array"
		? node
		: fail(`wrangler config: ${where} must be an array`);

const asString = (node: JsonNode | undefined, where: string): string =>
	node?.kind === "literal" && typeof node.value === "string"
		? node.value
		: fail(`wrangler config: ${where} must be a string`);

const classNameOf = (node: JsonNode): string | undefined => {
	if (node.kind !== "object") return undefined;
	const name = prop(node, "class_name")?.value;
	return name?.kind === "literal" && typeof name.value === "string"
		? name.value
		: undefined;
};

const isRelativePath = (p: string): boolean =>
	!/^[a-z][a-z0-9+.-]*:/i.test(p) && !path.isAbsolute(p);

export const renderConfig = (
	source: string,
	options: RenderOptions,
): string => {
	const stage = validateStage(options.stage);
	const domain = options.domain === undefined
		? undefined
		: validateDomain(options.domain);
	if (!options.containers && options.image.kind !== "dockerfile") {
		fail("--image cannot be combined with --no-containers");
	}
	const k2 = options.k2 === undefined ? undefined : validateK2(options.k2);
	if (
		options.laneMode !== undefined &&
		!(LANE_MODE_VALUES as readonly string[]).includes(options.laneMode)
	) {
		fail(`--lane-mode is ${LANE_MODE_VALUES.join(", ")}`);
	}
	if (
		options.workloadTransport !== undefined &&
		!(WORKLOAD_TRANSPORT_VALUES as readonly string[]).includes(
			options.workloadTransport,
		)
	) {
		fail(`--workload-transport is ${WORKLOAD_TRANSPORT_VALUES.join(" or ")}`);
	}
	if (options.workloadTransport === "k2" && k2?.token === undefined) {
		fail(
			"--workload-transport k2 needs the global log: --k2-stream with --k2-token-store and --k2-token-secret",
		);
	}

	const root = asObject(parseJsonc(source), "the root");
	for (const key of ["k2", "secrets_store_secrets"]) {
		if (prop(root, key) !== undefined) {
			fail(
				`wrangler config: "${key}" is rendered per stage (--k2-stream); remove it from the source`,
			);
		}
	}
	const edits: Edit[] = [];

	// Names: "<base>" → "<base>-<stage>", "<base>-x" → "<base>-<stage>-x".
	const base = asString(prop(root, "name")?.value, "name");
	const stageName = (value: string, where: string): string => {
		if (value === base) return `${base}-${stage}`;
		if (value.startsWith(`${base}-`)) {
			return `${base}-${stage}${value.slice(base.length)}`;
		}
		return fail(
			`wrangler config: ${where} ${
				JSON.stringify(value)
			} does not start with "${base}"`,
		);
	};
	const rename = (node: JsonNode | undefined, where: string): string => {
		const renamed = stageName(asString(node, where), where);
		edits.push(replaceValue(node!, renamed));
		return renamed;
	};

	const rebase = (p: string): string => {
		if (!isRelativePath(p)) return p;
		// Outside the source tree, an absolute path is clearer than a long climb.
		if (path.relative(options.sourceDir, options.outDir).startsWith("..")) {
			return path.resolve(options.sourceDir, p);
		}
		const rebased = path.relative(
			options.outDir,
			path.resolve(options.sourceDir, p),
		).split(path.sep).join("/");
		const prefixed = rebased.startsWith(".") ? rebased : `./${rebased}`;
		return p.startsWith("./") || p.startsWith("../") ? prefixed : rebased;
	};
	const rebaseAt = (node: JsonNode | undefined, where: string): void => {
		if (node === undefined) return;
		const value = asString(node, where);
		const rebased = rebase(value);
		if (rebased !== value) edits.push(replaceValue(node, rebased));
	};

	rename(prop(root, "name")!.value, "name");
	rebaseAt(prop(root, "$schema")?.value, "$schema");
	rebaseAt(prop(root, "main")?.value, "main");
	const assets = prop(root, "assets");
	if (assets) {
		rebaseAt(
			prop(asObject(assets.value, "assets"), "directory")?.value,
			"assets.directory",
		);
	}

	// Artifacts namespaces (binding) and the map used for trigger filters.
	const namespaces = new Map<string, string>();
	const artifacts = prop(root, "artifacts");
	if (artifacts) {
		asArray(artifacts.value, "artifacts").items.forEach((item, i) => {
			const where = `artifacts[${i}].namespace`;
			const ns = prop(asObject(item.value, `artifacts[${i}]`), "namespace")
				?.value;
			namespaces.set(asString(ns, where), rename(ns, where));
		});
	}

	// Workflow names (and the map used for trigger targets).
	const workflowNames = new Map<string, string>();
	const workflows = prop(root, "workflows");
	if (workflows) {
		asArray(workflows.value, "workflows").items.forEach((item, i) => {
			const where = `workflows[${i}].name`;
			const name = prop(asObject(item.value, `workflows[${i}]`), "name")?.value;
			workflowNames.set(asString(name, where), rename(name, where));
		});
	}

	const buckets = prop(root, "r2_buckets");
	if (buckets) {
		asArray(buckets.value, "r2_buckets").items.forEach((item, i) => {
			rename(
				prop(asObject(item.value, `r2_buckets[${i}]`), "bucket_name")?.value,
				`r2_buckets[${i}].bucket_name`,
			);
		});
	}

	// Event triggers: the namespace filter and Workflow targets follow the stage.
	const triggers = prop(root, "triggers");
	const events = triggers
		? prop(asObject(triggers.value, "triggers"), "events")
		: undefined;
	if (events) {
		asArray(events.value, "triggers.events").items.forEach((item, i) => {
			const event = asObject(item.value, `triggers.events[${i}]`);
			const filter = prop(event, "filter");
			const namespace = filter
				? prop(
					asObject(filter.value, `triggers.events[${i}].filter`),
					"namespace",
				)
				: undefined;
			if (namespace) {
				const where = `triggers.events[${i}].filter.namespace`;
				const renamed = namespaces.get(asString(namespace.value, where)) ??
					fail(
						`wrangler config: ${where} names no declared Artifacts namespace`,
					);
				edits.push(replaceValue(namespace.value, renamed));
			}
			const targets = prop(event, "targets");
			if (targets) {
				asArray(targets.value, `triggers.events[${i}].targets`).items.forEach(
					(target, j) => {
						const where = `triggers.events[${i}].targets[${j}].workflow_name`;
						const workflow = prop(
							asObject(target.value, where),
							"workflow_name",
						);
						if (!workflow) return;
						const renamed =
							workflowNames.get(asString(workflow.value, where)) ??
								fail(`wrangler config: ${where} names no declared Workflow`);
						edits.push(replaceValue(workflow.value, renamed));
					},
				);
			}
		});
	}

	// Root-level additions are collected and appended in one comma-joined edit.
	const rootAdditions: [string, JsonValue][] = [];

	// Vars: replaced where present, else appended in one edit.
	if (options.devTools && !DEV_TOOLS_STAGE_RE.test(stage)) {
		fail(
			`--dev-tools needs a dev or dev-* stage, not ${JSON.stringify(stage)}`,
		);
	}
	if (options.repoConfig && !options.containers) {
		fail(
			"--repo-config on needs containers: the evaluator runs in the sandbox",
		);
	}
	const renderedVars: [string, string][] = [
		["TARTAN_STAGE", stage],
		...(options.devTools ? [[DEV_TOOLS_VAR, "1"] as [string, string]] : []),
		...(options.repoConfig
			? [[REPO_CONFIG_VAR, "on"] as [string, string]]
			: []),
		...(k2 ? [[K2_STREAM_VAR, k2.streamId] as [string, string]] : []),
		...(options.projects ? [[PROJECTS_VAR, "scan"] as [string, string]] : []),
		...(options.laneMode
			? [[LANE_MODE_VAR, options.laneMode] as [string, string]]
			: []),
		...(options.workloadTransport
			? [[WORKLOAD_TRANSPORT_VAR, options.workloadTransport] as [
				string,
				string,
			]]
			: []),
	];
	const vars = prop(root, "vars");
	if (vars) {
		const varsObject = asObject(vars.value, "vars");
		const missing: [string, string][] = [];
		for (const [key, value] of renderedVars) {
			const existing = prop(varsObject, key);
			if (existing) edits.push(replaceValue(existing.value, value));
			else missing.push([key, value]);
		}
		edits.push(...appendProperties(source, varsObject, missing));
	} else rootAdditions.push(["vars", Object.fromEntries(renderedVars)]);

	if (!options.evictionFlag) {
		const flags = prop(root, "compatibility_flags");
		const items = flags
			? asArray(flags.value, "compatibility_flags").items
			: [];
		const index = items.findIndex((item) =>
			item.value.kind === "literal" && item.value.value === EVICTION_FLAG
		);
		if (index !== -1) edits.push(...removeEntry(source, items, index));
	}

	// Containers: keep the DO binding and migration either way.
	const containers = prop(root, "containers");
	const durable = prop(root, "durable_objects");
	const bindings = durable
		? prop(asObject(durable.value, "durable_objects"), "bindings")
		: undefined;
	const hasSandboxBinding =
		(bindings ? asArray(bindings.value, "durable_objects.bindings").items : [])
			.some((item) => classNameOf(item.value) === SANDBOX_CLASS);
	if (!hasSandboxBinding) {
		fail(
			`wrangler config: durable_objects.bindings must declare ${SANDBOX_CLASS}`,
		);
	}
	if (!options.containers) {
		if (containers) {
			edits.push(
				...removeEntry(
					source,
					root.props,
					root.props.indexOf(containers),
					`"containers" omitted (--no-containers): ${SANDBOX_CLASS} stays a plain SQLite DO class with the same migration.`,
				),
			);
		}
	} else {
		const entries = containers
			? asArray(containers.value, "containers").items
			: [];
		const sandbox = entries.find((item) =>
			classNameOf(item.value) === SANDBOX_CLASS
		);
		if (!sandbox) {
			fail(
				`wrangler config: containers must have an entry with class_name ${SANDBOX_CLASS}`,
			);
		}
		const image = prop(asObject(sandbox!.value, "containers[]"), "image") ??
			fail(`wrangler config: the ${SANDBOX_CLASS} container needs an "image"`);
		const value = imageValue(options.image, rebase);
		if (value !== asString(image.value, "containers[].image")) {
			edits.push(replaceValue(image.value, value));
		}
	}

	if (k2 !== undefined) {
		rootAdditions.push([
			"k2",
			[{ binding: K2_BINDING, stream: k2.streamId, remote: true }],
		]);
		if (k2.token !== undefined) {
			rootAdditions.push([
				"secrets_store_secrets",
				[{
					binding: K2_TOKEN_BINDING,
					store_id: k2.token.storeId,
					secret_name: k2.token.secretName,
				}],
			]);
		}
	}

	if (domain !== undefined) {
		const route = [{ pattern: domain, custom_domain: true }];
		const routes = prop(root, "routes");
		if (routes) edits.push(replaceValue(routes.value, route));
		else rootAdditions.push(["routes", route]);
	}
	edits.push(...appendProperties(source, root, rootAdditions));

	const variant = options.containers ? options.image.kind : "none";
	const header = [
		"// GENERATED by scripts/render-config.ts from wrangler.jsonc. Do not edit; re-render instead.",
		`// stage=${stage} domain=${
			domain ?? "-"
		} containers=${variant} eviction_flag=${
			options.evictionFlag ? "on" : "off"
		}${options.devTools ? " dev_tools=on" : ""}${
			options.repoConfig ? " repo_config=on" : ""
		}${k2 ? ` k2=${k2.token ? "on" : "produce-only"}` : ""}${
			options.projects ? " projects=scan" : ""
		}${options.laneMode ? ` lane_mode=${options.laneMode}` : ""}${
			options.workloadTransport
				? ` workload_transport=${options.workloadTransport}`
				: ""
		}`,
		"",
	].join("\n");
	const rendered = header + applyEdits(source, edits);
	parseJsonc(rendered); // the edits must leave valid JSONC
	return rendered;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE =
	`Usage: deno run -A scripts/render-config.ts --stage <stage> [options]

  --stage <stage>          required; names become tartan-<stage>[-...]
  --domain <host>          add a Workers Custom Domain route (custom_domain: true)
  --no-containers          drop the containers entry (TartanSandbox stays a DO class)
  --image <variant>        dockerfile (default) | registry (the digest reference recorded
                           by containers/runner/publish.ts; tags are refused)
  --image-record <path>    the registry record (default: ${RUNNER_IMAGE_RECORD} next to the source)
  --no-eviction-flag       drop ${EVICTION_FLAG}
  --dev-tools              set ${DEV_TOOLS_VAR}=1 (dev and dev-* stages only)
  --repo-config <on|off>   ${REPO_CONFIG_VAR}=on evaluates the root CUE package tartan (default off; needs containers)
  --k2-stream <id>         the global log: bind ${K2_BINDING} to this K2 stream id
                           (32 hex) and set ${K2_STREAM_VAR}
  --k2-token-store <id>    the K2 Consume token's Secrets Store id (32 hex) …
  --k2-token-secret <name> … and secret name: bound as ${K2_TOKEN_BINDING}
  --projects <off|scan>    ${PROJECTS_VAR}=scan detects cuenv #Projects as projects (default off)
  --lane-mode <mode>       ${LANE_MODE_VAR}: this stage's lane mode (${
		LANE_MODE_VALUES.join(" | ")
	}; default: the compiled LANE_MODE)
  --workload-transport <t> ${WORKLOAD_TRANSPORT_VAR}: local | k2 (k2 needs --k2-stream and the token)
  --source <path>          source config (default: wrangler.jsonc)
  --out <path>             output (default: .wrangler/deploy/wrangler.<stage>.jsonc next to the source)
  -h, --help               show this help`;

export const defaultOutPath = (sourcePath: string, stage: string): string =>
	path.join(
		path.dirname(sourcePath),
		".wrangler",
		"deploy",
		`wrangler.${stage}.jsonc`,
	);

// Returns undefined for --help.
export const parseCliArgs = (
	args: readonly string[],
): CliOptions | undefined => {
	let stage: string | undefined;
	let domain: string | undefined;
	let containers = true;
	let image: ImageVariant["kind"] | undefined;
	let imageRecordPath: string | undefined;
	let evictionFlag = true;
	let devTools = false;
	let repoConfig = false;
	let k2Stream: string | undefined;
	let k2TokenStore: string | undefined;
	let k2TokenSecret: string | undefined;
	let projects = false;
	let laneMode: LaneModeOverride | undefined;
	let workloadTransport: WorkloadTransportOverride | undefined;
	let sourcePath = "wrangler.jsonc";
	let outPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const [flag, inline] = args[i].startsWith("--") && args[i].includes("=")
			? [
				args[i].slice(0, args[i].indexOf("=")),
				args[i].slice(args[i].indexOf("=") + 1),
			]
			: [args[i], undefined];
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = args[++i];
			return next === undefined || next.startsWith("--")
				? fail(`${flag} needs a value`)
				: next;
		};
		const noValue = (): void => {
			if (inline !== undefined) fail(`${flag} takes no value`);
		};
		switch (flag) {
			case "-h":
			case "--help":
				return undefined;
			case "--stage":
				stage = value();
				break;
			case "--domain":
				domain = value();
				break;
			case "--no-containers":
				noValue();
				containers = false;
				break;
			case "--image":
				image = parseImageKind(value());
				break;
			case "--image-record":
				imageRecordPath = value();
				break;
			case "--no-eviction-flag":
				noValue();
				evictionFlag = false;
				break;
			case "--dev-tools":
				noValue();
				devTools = true;
				break;
			case "--repo-config": {
				const v = value();
				if (v !== "on" && v !== "off") fail("--repo-config is on or off");
				repoConfig = v === "on";
				break;
			}
			case "--k2-stream":
				k2Stream = value();
				break;
			case "--k2-token-store":
				k2TokenStore = value();
				break;
			case "--k2-token-secret":
				k2TokenSecret = value();
				break;
			case "--projects": {
				const v = value();
				if (v !== "off" && v !== "scan") fail("--projects is off or scan");
				projects = v === "scan";
				break;
			}
			case "--lane-mode": {
				const v = value();
				if (!(LANE_MODE_VALUES as readonly string[]).includes(v)) {
					fail(`--lane-mode is ${LANE_MODE_VALUES.join(", ")}`);
				}
				laneMode = v as LaneModeOverride;
				break;
			}
			case "--workload-transport": {
				const v = value();
				if (!(WORKLOAD_TRANSPORT_VALUES as readonly string[]).includes(v)) {
					fail(
						`--workload-transport is ${WORKLOAD_TRANSPORT_VALUES.join(" or ")}`,
					);
				}
				workloadTransport = v as WorkloadTransportOverride;
				break;
			}
			case "--source":
				sourcePath = value();
				break;
			case "--out":
				outPath = value();
				break;
			default:
				fail(`unknown argument ${JSON.stringify(args[i])}\n\n${USAGE}`);
		}
	}

	if (stage === undefined) return fail(`--stage is required\n\n${USAGE}`);
	validateStage(stage);
	if (domain !== undefined) domain = validateDomain(domain);
	if (!containers && image !== undefined) {
		fail("--image cannot be combined with --no-containers");
	}
	if (imageRecordPath !== undefined && image !== "registry") {
		fail("--image-record needs --image registry");
	}
	if (devTools && !DEV_TOOLS_STAGE_RE.test(stage)) {
		fail(
			`--dev-tools needs a dev or dev-* stage, not ${JSON.stringify(stage)}`,
		);
	}
	if (repoConfig && !containers) {
		fail("--repo-config on cannot be combined with --no-containers");
	}
	if ((k2TokenStore === undefined) !== (k2TokenSecret === undefined)) {
		fail("--k2-token-store and --k2-token-secret go together");
	}
	if (k2Stream === undefined && k2TokenStore !== undefined) {
		fail("--k2-token-store needs --k2-stream");
	}
	const k2 = k2Stream === undefined ? undefined : validateK2({
		streamId: k2Stream,
		...(k2TokenStore !== undefined && k2TokenSecret !== undefined
			? { token: { storeId: k2TokenStore, secretName: k2TokenSecret } }
			: {}),
	});
	const out = outPath ?? defaultOutPath(sourcePath, stage);
	return {
		stage,
		domain,
		containers,
		image: image ?? "dockerfile",
		imageRecordPath: imageRecordPath ??
			path.join(path.dirname(sourcePath), RUNNER_IMAGE_RECORD),
		evictionFlag,
		devTools,
		repoConfig,
		...(k2 === undefined ? {} : { k2 }),
		projects,
		...(laneMode === undefined ? {} : { laneMode }),
		...(workloadTransport === undefined ? {} : { workloadTransport }),
		sourcePath,
		outPath: out,
		sourceDir: path.dirname(path.resolve(sourcePath)),
		outDir: path.dirname(path.resolve(out)),
	};
};

const readRecord = async (recordPath: string): Promise<string> => {
	try {
		return await Deno.readTextFile(recordPath);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return fail(
				`${recordPath}: no recorded registry image; run containers/runner/publish.ts first`,
			);
		}
		throw error;
	}
};

const main = async (args: readonly string[]): Promise<number> => {
	try {
		const options = parseCliArgs(args);
		if (options === undefined) {
			console.log(USAGE);
			return 0;
		}
		const image: ImageVariant = options.image === "registry"
			? parseImageRecord(
				await readRecord(options.imageRecordPath),
				options.imageRecordPath,
			)
			: { kind: "dockerfile" };
		const rendered = renderConfig(
			await Deno.readTextFile(options.sourcePath),
			{ ...options, image },
		);
		await Deno.mkdir(path.dirname(options.outPath), { recursive: true });
		await Deno.writeTextFile(options.outPath, rendered);
		console.log(options.outPath);
		return 0;
	} catch (error) {
		if (error instanceof ConfigRenderError) {
			console.error(`render-config: ${error.message}`);
			return 2;
		}
		throw error;
	}
};

if (import.meta.main) Deno.exit(await main(Deno.args));
