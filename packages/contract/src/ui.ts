// Server-driven UI: `tartan-ui@1`.
//
// Strictness: every node and every nested object is closed (`strictObject`
// here; `unevaluatedProperties`/`additionalProperties: false` in
// `schema/ui-1.json`), so unknown props such as `innerHTML`, `style` or
// `onClick` fail validation. Same-origin fields must match `^/(?![/\\])` and
// contain no control characters (browsers strip TAB/LF/CR from URLs, which
// would turn `/\n/evil` into `//evil`); external links must be `https://`.
// `validateUi()` returns the **parsed** value, never its input, and enforces
// the host limits (≤ 500 nodes, ≤ 64 KB, depth ≤ 16). `error-chip` is
// host-only and is never accepted from an extension.

import { z } from "zod";
import { LaneIdSchema } from "./common.ts";
import { byteLength } from "./text.ts";

export const UI_LIMITS = {
	maxNodes: 500,
	maxBytes: 64 * 1024,
	maxDepth: 16,
	/** Raw JSON nesting guard applied before parsing (≈ 4 JSON levels per UI level). */
	maxJsonDepth: 80,
} as const;

/** Same-origin path: `/…` but not `//…` or `/\…`, no control characters. */
// deno-lint-ignore no-control-regex
export const SAME_ORIGIN_PATH_RE = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/;
/** Link href: a same-origin path or an `https://` URL, no control characters. */
export const LINK_HREF_RE =
	// deno-lint-ignore no-control-regex
	/^(?:\/(?![/\\])|https:\/\/)[^\u0000-\u001f\u007f]*$/;
/** Principal ids rendered through `/-/avatar/<principal>` (no path tricks). */
export const AVATAR_PRINCIPAL_RE = /^[a-z0-9_]{1,80}$/;
export const ICON_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const ACTION_ID_RE = /^[a-z0-9._-]{1,64}$/;
export const FIELD_NAME_RE = /^[a-z0-9_]{1,32}$/;

export const TONES = [
	"neutral",
	"info",
	"success",
	"warning",
	"danger",
	"muted",
] as const;
export type Tone = typeof TONES[number];

export const UI_NODE_TYPES = [
	"stack",
	"row",
	"grid",
	"section",
	"card",
	"tabs",
	"divider",
	"heading",
	"text",
	"markdown",
	"code",
	"badge",
	"label",
	"avatar",
	"icon",
	"link",
	"empty",
	"progress",
	"kv",
	"stat",
	"alert",
	"button",
	"menu",
	"form",
	"input",
	"textarea",
	"select",
	"checkbox",
	"table",
	"list",
	"timeline",
	"diff",
	"board",
	"matrix",
	"sparkline",
] as const;
export type UiNodeType = typeof UI_NODE_TYPES[number];

// ---------------------------------------------------------------------------
// Types (hand-written so the recursive schema can be annotated)
// ---------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
export type UiJson = JsonPrimitive | UiJson[] | { [key: string]: UiJson };

export type UiAction = { id: string; payload?: UiJson; confirm?: string };

type Base = { id?: string };
export type ContainerNode = Base & {
	t: "stack" | "row" | "grid" | "section" | "card";
	children?: UiNode[];
	gap?: 0 | 1 | 2 | 3;
	cols?: number;
	title?: string;
};
export type TabsNode = Base & {
	t: "tabs";
	tabs: { label: string; body: UiNode }[];
};
export type DividerNode = Base & { t: "divider" };
export type TextNode = Base & {
	t: "heading" | "text" | "label" | "badge" | "empty";
	text: string;
	tone?: Tone;
	level?: 2 | 3 | 4;
	mono?: boolean;
	body?: string;
};
export type MarkdownNode = Base & { t: "markdown"; md: string };
export type CodeNode = Base & { t: "code"; text: string; lang?: string };
export type LinkNode = Base & { t: "link"; text: string; href: string };
export type AvatarNode = Base & {
	t: "avatar" | "icon";
	principal?: string;
	name?: string;
};
export type ValueNode = Base & {
	t: "progress" | "stat";
	value?: number;
	max?: number;
	label?: string;
	delta?: number;
	unit?: string;
};
export type KvNode = Base & {
	t: "kv";
	items: { k: string; v: string | UiNode }[];
};
export type AlertNode = Base & {
	t: "alert";
	tone: Tone;
	title: string;
	body?: UiNode;
};
export type ButtonNode = Base & {
	t: "button" | "menu";
	text: string;
	action?: UiAction;
	tone?: Tone;
	items?: { text: string; action: UiAction }[];
};
/**
 * A form. Submit payload (the host's convention, `@tartan/ext-api` `ui.form`):
 * the field values by name at the top level with `submit.action.payload`
 * merged over them (an action key beats a field of the same name); a
 * non-object action payload travels as `payload`. There is no `values` key.
 */
export type FormNode = Base & {
	t: "form";
	fields: UiNode[];
	submit: { text: string; action: UiAction };
};
export type SelectOption = string | number | {
	value: string | number | boolean;
	label: string;
};
export type FieldValue = string | number | boolean | null | (string | number)[];
export type FieldNode = Base & {
	t: "input" | "textarea" | "select" | "checkbox";
	name: string;
	label?: string;
	value?: FieldValue;
	options?: SelectOption[];
	required?: boolean;
};
export type TableNode = Base & {
	t: "table";
	columns: string[];
	rows: (string | number | UiNode)[][];
};
export type ListNode = Base & { t: "list"; items: UiNode[] };
export type TimelineNode = Base & {
	t: "timeline";
	items: { at: number; text: string; actor?: string; tone?: Tone }[];
};
export type DiffNode = Base & {
	t: "diff";
	repo?: string;
	base?: string;
	head?: string;
	source?: string;
	/**
	 * The lane whose objects `head` (and `base`) are read from: a `repo`
	 * lane's commits live in its own lane repo, never in the canonical one
	 * until they land, so the host asks for the comparison with the
	 * lane as the source (members only).
	 */
	lane?: string;
	paths?: string[];
	patch?: string;
};
export type BoardNode = Base & {
	t: "board";
	columns: { id: string; title: string; wip?: number }[];
	cards: {
		id: string;
		col: string;
		title: string;
		href?: string;
		badges?: string[];
	}[];
	moveAction?: UiAction;
};
export type MatrixNode = Base & {
	t: "matrix";
	rows: { id: string; label: string }[];
	cols: { id: string; label: string }[];
	cells: {
		r: string;
		c: string;
		level: number;
		label?: string;
		action?: UiAction;
	}[];
};
export type SparklineNode = Base & { t: "sparkline"; values: number[] };

export type UiNode =
	| ContainerNode
	| TabsNode
	| DividerNode
	| TextNode
	| MarkdownNode
	| CodeNode
	| LinkNode
	| AvatarNode
	| ValueNode
	| KvNode
	| AlertNode
	| ButtonNode
	| FormNode
	| FieldNode
	| TableNode
	| ListNode
	| TimelineNode
	| DiffNode
	| BoardNode
	| MatrixNode
	| SparklineNode;

export type UiDoc = {
	v: 1;
	root: UiNode;
	refreshOn?: string[];
	refreshMs?: number;
};

/** Host-only node shown when a render fails or times out. */
export type ErrorChipNode = { t: "error-chip"; text: string };
export type HostUiDoc = Omit<UiDoc, "root"> & { root: UiNode | ErrorChipNode };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ToneSchema = z.enum(TONES);
const JsonSchema: z.ZodType<UiJson> = z.json() as z.ZodType<UiJson>;

export const UiActionSchema: z.ZodType<UiAction> = z.strictObject({
	id: z.string().regex(ACTION_ID_RE),
	payload: JsonSchema.optional(),
	confirm: z.string().max(200).optional(),
});

export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() => UiNodeUnion);
const Children = z.array(UiNodeSchema).max(200);
const id = z.string().max(64).optional();

const container = <T extends ContainerNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		children: Children.optional(),
		gap: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
			.optional(),
		cols: z.number().int().min(1).max(6).optional(),
		title: z.string().max(120).optional(),
	});

const textLike = <T extends TextNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		text: z.string().max(4000),
		tone: ToneSchema.optional(),
		level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
		mono: z.boolean().optional(),
		body: z.string().max(2000).optional(),
	});

const avatarLike = <T extends AvatarNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		principal: z.string().regex(AVATAR_PRINCIPAL_RE).optional(),
		name: z.string().regex(ICON_NAME_RE).optional(),
	});

const valueLike = <T extends ValueNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		value: z.number().optional(),
		max: z.number().optional(),
		label: z.string().optional(),
		delta: z.number().optional(),
		unit: z.string().max(12).optional(),
	});

const MenuItem = z.strictObject({ text: z.string(), action: UiActionSchema });
const buttonLike = <T extends ButtonNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		text: z.string().max(60),
		action: UiActionSchema.optional(),
		tone: ToneSchema.optional(),
		items: z.array(MenuItem).max(20).optional(),
	});

const SelectOptionSchema = z.union([
	z.string(),
	z.number(),
	z.strictObject({
		value: z.union([z.string(), z.number(), z.boolean()]),
		label: z.string(),
	}),
]);
const FieldValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.union([z.string(), z.number()])),
]);
const field = <T extends FieldNode["t"]>(t: T) =>
	z.strictObject({
		t: z.literal(t),
		id,
		name: z.string().regex(FIELD_NAME_RE),
		label: z.string().optional(),
		value: FieldValueSchema.optional(),
		options: z.array(SelectOptionSchema).max(100).optional(),
		required: z.boolean().optional(),
	});

const UiNodeUnion = z.discriminatedUnion("t", [
	container("stack"),
	container("row"),
	container("grid"),
	container("section"),
	container("card"),
	z.strictObject({
		t: z.literal("tabs"),
		id,
		tabs: z.array(
			z.strictObject({ label: z.string().max(40), body: UiNodeSchema }),
		).max(12),
	}),
	z.strictObject({ t: z.literal("divider"), id }),
	textLike("heading"),
	textLike("text"),
	textLike("label"),
	textLike("badge"),
	textLike("empty"),
	z.strictObject({ t: z.literal("markdown"), id, md: z.string().max(20000) }),
	z.strictObject({
		t: z.literal("code"),
		id,
		text: z.string().max(20000),
		lang: z.string().max(20).optional(),
	}),
	z.strictObject({
		t: z.literal("link"),
		id,
		text: z.string(),
		href: z.string().regex(LINK_HREF_RE),
	}),
	avatarLike("avatar"),
	avatarLike("icon"),
	valueLike("progress"),
	valueLike("stat"),
	z.strictObject({
		t: z.literal("kv"),
		id,
		items: z.array(
			z.strictObject({
				k: z.string(),
				v: z.union([z.string(), UiNodeSchema]),
			}),
		).max(50),
	}),
	z.strictObject({
		t: z.literal("alert"),
		id,
		tone: ToneSchema,
		title: z.string(),
		body: UiNodeSchema.optional(),
	}),
	buttonLike("button"),
	buttonLike("menu"),
	z.strictObject({
		t: z.literal("form"),
		id,
		fields: z.array(UiNodeSchema).max(30),
		submit: z.strictObject({ text: z.string(), action: UiActionSchema }),
	}),
	field("input"),
	field("textarea"),
	field("select"),
	field("checkbox"),
	z.strictObject({
		t: z.literal("table"),
		id,
		columns: z.array(z.string()).max(12),
		rows: z.array(z.array(z.union([z.string(), z.number(), UiNodeSchema])))
			.max(500),
	}),
	z.strictObject({ t: z.literal("list"), id, items: Children }),
	z.strictObject({
		t: z.literal("timeline"),
		id,
		items: z.array(
			z.strictObject({
				at: z.number().int(),
				text: z.string(),
				actor: z.string().optional(),
				tone: ToneSchema.optional(),
			}),
		).max(200),
	}),
	z.strictObject({
		t: z.literal("diff"),
		id,
		repo: z.string().optional(),
		base: z.string().optional(),
		head: z.string().optional(),
		source: z.string().optional(),
		lane: LaneIdSchema.optional(),
		paths: z.array(z.string()).optional(),
		patch: z.string().max(60000).optional(),
	}),
	z.strictObject({
		t: z.literal("board"),
		id,
		columns: z.array(
			z.strictObject({
				id: z.string(),
				title: z.string(),
				wip: z.number().int().optional(),
			}),
		).max(12),
		cards: z.array(
			z.strictObject({
				id: z.string(),
				col: z.string(),
				title: z.string(),
				href: z.string().regex(SAME_ORIGIN_PATH_RE).optional(),
				badges: z.array(z.string()).optional(),
			}),
		).max(500),
		moveAction: UiActionSchema.optional(),
	}),
	z.strictObject({
		t: z.literal("matrix"),
		id,
		rows: z.array(z.strictObject({ id: z.string(), label: z.string() })).max(
			200,
		),
		cols: z.array(z.strictObject({ id: z.string(), label: z.string() })).max(
			200,
		),
		cells: z.array(
			z.strictObject({
				r: z.string(),
				c: z.string(),
				level: z.number().int().min(0).max(5),
				label: z.string().optional(),
				action: UiActionSchema.optional(),
			}),
		).max(5000),
	}),
	z.strictObject({
		t: z.literal("sparkline"),
		id,
		values: z.array(z.number()).max(240),
	}),
]);

export const UiDocSchema = z.strictObject({
	v: z.literal(1),
	root: UiNodeSchema,
	refreshOn: z.array(z.string()).max(16).optional(),
	refreshMs: z.number().int().min(5000).optional(),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type UiValidation =
	| { readonly ok: true; readonly doc: UiDoc }
	| { readonly ok: false; readonly errors: readonly string[] };

/** Max nesting of arrays/objects in a raw JSON value (iterative; no recursion). */
const jsonDepth = (value: unknown, limit: number): number => {
	let max = 0;
	const stack: [unknown, number][] = [[value, 1]];
	while (stack.length > 0) {
		const [v, d] = stack.pop()!;
		if (v === null || typeof v !== "object") continue;
		if (d > max) max = d;
		if (max > limit) return max;
		for (const child of Object.values(v as Record<string, unknown>)) {
			stack.push([child, d + 1]);
		}
	}
	return max;
};

/** Child nodes of a parsed node, in every place a node can nest. */
export const childNodes = (node: UiNode): UiNode[] => {
	switch (node.t) {
		case "stack":
		case "row":
		case "grid":
		case "section":
		case "card":
			return node.children ?? [];
		case "tabs":
			return node.tabs.map((tab) => tab.body);
		case "kv":
			return node.items.flatMap((item) =>
				typeof item.v === "string" ? [] : [item.v]
			);
		case "alert":
			return node.body ? [node.body] : [];
		case "form":
			return node.fields;
		case "table":
			return node.rows.flatMap((row) =>
				row.filter((cell): cell is UiNode => typeof cell === "object")
			);
		case "list":
			return node.items;
		default:
			return [];
	}
};

/** Counts nodes and the maximum node depth (root = 1) of a parsed tree. */
export const measureUi = (
	root: UiNode,
): { readonly nodes: number; readonly depth: number } => {
	let nodes = 0;
	let depth = 0;
	const stack: [UiNode, number][] = [[root, 1]];
	while (stack.length > 0) {
		const [node, d] = stack.pop()!;
		nodes += 1;
		if (d > depth) depth = d;
		for (const child of childNodes(node)) stack.push([child, d + 1]);
	}
	return { nodes, depth };
};

const formatIssues = (error: z.ZodError): string[] =>
	error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * Validates an extension's render output against `tartan-ui@1` and the host
 * limits. On success returns the **parsed** document (a fresh object); the
 * input is never passed through.
 */
export const validateUi = (input: unknown): UiValidation => {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(input);
	} catch {
		return { ok: false, errors: ["(root): not JSON-serializable"] };
	}
	if (serialized === undefined) {
		return { ok: false, errors: ["(root): not a JSON value"] };
	}
	if (byteLength(serialized) > UI_LIMITS.maxBytes) {
		return {
			ok: false,
			errors: [`(root): exceeds ${UI_LIMITS.maxBytes} bytes`],
		};
	}
	if (jsonDepth(input, UI_LIMITS.maxJsonDepth) > UI_LIMITS.maxJsonDepth) {
		return { ok: false, errors: ["(root): nesting too deep"] };
	}
	const parsed = UiDocSchema.safeParse(input);
	if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
	const { nodes, depth } = measureUi(parsed.data.root);
	const errors = [
		...(nodes > UI_LIMITS.maxNodes
			? [`(root): ${nodes} nodes exceeds ${UI_LIMITS.maxNodes}`]
			: []),
		...(depth > UI_LIMITS.maxDepth
			? [`(root): depth ${depth} exceeds ${UI_LIMITS.maxDepth}`]
			: []),
	];
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, doc: parsed.data as UiDoc };
};

/** The host-only error chip document (`<ext>: render failed`). */
export const errorChipDoc = (extLabel: string): HostUiDoc => ({
	v: 1,
	root: {
		t: "error-chip",
		text: `${
			extLabel.replace(/[^a-z0-9._-]/gi, "").slice(0, 64)
		}: render failed`,
	},
});

/** Validates a render result, falling back to the error chip (the page never breaks). */
export const uiOrErrorChip = (input: unknown, extLabel: string): HostUiDoc => {
	const result = validateUi(input);
	return result.ok ? result.doc : errorChipDoc(extLabel);
};

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

export const ActionResultSchema = z.strictObject({
	v: z.literal(1),
	render: UiDocSchema.optional(),
	toast: z.strictObject({ tone: ToneSchema, text: z.string().max(500) })
		.optional(),
	navigate: z.string().regex(SAME_ORIGIN_PATH_RE).optional(),
	refresh: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(32).optional(),
});
export type ActionResult = {
	v: 1;
	render?: UiDoc;
	toast?: { tone: Tone; text: string };
	navigate?: string;
	refresh?: string[];
};

export type ActionValidation =
	| { readonly ok: true; readonly result: ActionResult }
	| { readonly ok: false; readonly errors: readonly string[] };

/** Validates an `onAction` result; an embedded `render` must also pass `validateUi`. */
export const validateActionResult = (input: unknown): ActionValidation => {
	const parsed = ActionResultSchema.safeParse(input);
	if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
	if (parsed.data.render) {
		const ui = validateUi(parsed.data.render);
		if (!ui.ok) {
			return { ok: false, errors: ui.errors.map((e) => `render.${e}`) };
		}
		return { ok: true, result: { ...parsed.data, render: ui.doc } };
	}
	return { ok: true, result: parsed.data as ActionResult };
};
