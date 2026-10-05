// Builders for `tartan-ui@1`. Each builder returns a
// plain node of the contract's `UiNode` union with only its declared props, so
// a tree built here passes `validateUi` as long as the values themselves are
// valid (same-origin paths start with a single `/`, external links are
// `https://`, limits of ≤ 500 nodes, ≤ 64 KB and depth ≤ 16). The host
// validates every render again and shows an error chip when it fails.
//
// Optional props that are `undefined` are left out, so the output never
// carries `{"tone": undefined}` noise.

import type {
	ActionResult,
	AlertNode,
	AvatarNode,
	BoardNode,
	ButtonNode,
	CodeNode,
	ContainerNode,
	DiffNode,
	DividerNode,
	FieldNode,
	FieldValue,
	FormNode,
	KvNode,
	LinkNode,
	ListNode,
	MarkdownNode,
	MatrixNode,
	SelectOption,
	SparklineNode,
	TableNode,
	TabsNode,
	TextNode,
	TimelineNode,
	Tone,
	UiAction,
	UiDoc,
	UiJson,
	UiNode,
	ValueNode,
} from "@tartan/contract";

/** Drops keys whose value is `undefined` (immutable). */
const compact = <T extends Record<string, unknown>>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;

type ContainerOptions = {
	readonly gap?: 0 | 1 | 2 | 3;
	readonly cols?: number;
	readonly title?: string;
	readonly id?: string;
};

const container = (
	t: ContainerNode["t"],
	children: readonly UiNode[],
	options: ContainerOptions = {},
): ContainerNode =>
	compact({
		t,
		id: options.id,
		children: [...children],
		gap: options.gap,
		cols: options.cols,
		title: options.title,
	});

type TextOptions = {
	readonly tone?: Tone;
	readonly mono?: boolean;
	readonly id?: string;
};

const textNode = (
	t: TextNode["t"],
	text: string,
	options: TextOptions & { level?: 2 | 3 | 4; body?: string } = {},
): TextNode =>
	compact({
		t,
		id: options.id,
		text,
		tone: options.tone,
		level: options.level,
		mono: options.mono,
		body: options.body,
	});

type FieldOptions = {
	readonly label?: string;
	readonly value?: FieldValue;
	readonly required?: boolean;
	readonly id?: string;
};

const field = (
	t: FieldNode["t"],
	name: string,
	options: FieldOptions & { options?: readonly SelectOption[] } = {},
): FieldNode =>
	compact({
		t,
		id: options.id,
		name,
		label: options.label,
		value: options.value,
		options: options.options ? [...options.options] : undefined,
		required: options.required,
	});

/** A button/menu action: `id` matches `ACTION_ID_RE`; `payload` must be JSON. */
export const action = (
	id: string,
	payload?: UiJson,
	confirm?: string,
): UiAction => compact({ id, payload, confirm });

export const ui = {
	/** A document; `refreshOn` event patterns, `refreshMs` ≥ 5000. */
	doc: (
		root: UiNode,
		options: { refreshOn?: readonly string[]; refreshMs?: number } = {},
	): UiDoc =>
		compact({
			v: 1 as const,
			root,
			refreshOn: options.refreshOn ? [...options.refreshOn] : undefined,
			refreshMs: options.refreshMs,
		}),
	stack: (children: readonly UiNode[], options?: ContainerOptions) =>
		container("stack", children, options),
	row: (children: readonly UiNode[], options?: ContainerOptions) =>
		container("row", children, options),
	grid: (children: readonly UiNode[], options?: ContainerOptions) =>
		container("grid", children, options),
	section: (
		title: string,
		children: readonly UiNode[],
		options?: ContainerOptions,
	) => container("section", children, { ...options, title }),
	card: (children: readonly UiNode[], options?: ContainerOptions) =>
		container("card", children, options),
	tabs: (
		tabs: readonly { readonly label: string; readonly body: UiNode }[],
	): TabsNode => ({
		t: "tabs",
		tabs: tabs.map((tab) => ({ label: tab.label, body: tab.body })),
	}),
	divider: (): DividerNode => ({ t: "divider" }),
	heading: (text: string, level: 2 | 3 | 4 = 2, options?: TextOptions) =>
		textNode("heading", text, { ...options, level }),
	text: (text: string, options?: TextOptions) =>
		textNode("text", text, options),
	label: (text: string, options?: TextOptions) =>
		textNode("label", text, options),
	badge: (text: string, tone?: Tone) => textNode("badge", text, { tone }),
	empty: (text: string, body?: string) => textNode("empty", text, { body }),
	/** Markdown is rendered server-side without raw HTML. */
	markdown: (md: string): MarkdownNode => ({ t: "markdown", md }),
	code: (text: string, lang?: string): CodeNode =>
		compact({ t: "code" as const, text, lang }),
	/** `href`: a same-origin path (`/…`) or an `https://` URL. */
	link: (text: string, href: string): LinkNode => ({ t: "link", text, href }),
	avatar: (principal: string, name?: string): AvatarNode =>
		compact({ t: "avatar" as const, principal, name }),
	icon: (name: string): AvatarNode => ({ t: "icon", name }),
	progress: (value: number, max?: number, label?: string): ValueNode =>
		compact({ t: "progress" as const, value, max, label }),
	stat: (
		label: string,
		value: number,
		options: { delta?: number; unit?: string } = {},
	): ValueNode =>
		compact({
			t: "stat" as const,
			label,
			value,
			delta: options.delta,
			unit: options.unit,
		}),
	kv: (
		items: readonly { readonly k: string; readonly v: string | UiNode }[],
	): KvNode => ({
		t: "kv",
		items: items.map((item) => ({ k: item.k, v: item.v })),
	}),
	alert: (tone: Tone, title: string, body?: UiNode): AlertNode =>
		compact({ t: "alert" as const, tone, title, body }),
	button: (text: string, act: UiAction, tone?: Tone): ButtonNode =>
		compact({ t: "button" as const, text, action: act, tone }),
	menu: (
		text: string,
		items: readonly { readonly text: string; readonly action: UiAction }[],
	): ButtonNode => ({
		t: "menu",
		text,
		items: items.map((item) => ({ text: item.text, action: item.action })),
	}),
	/**
	 * A form. On submit the host posts `submit.action` with this payload
	 * (tartan-ui@1, `FormNode` in the contract): the field values by name at
	 * the TOP LEVEL, with the action's own payload merged over them, so an
	 * action key wins over a field of the same name. `onAction` reads
	 * `payload.title`, never `payload.values.title`:
	 *
	 * ```ts
	 * ui.form([ui.textarea("body")], {
	 *   text: "Comment",
	 *   action: action("comment", { ref }),
	 * });
	 * // onAction("comment", { body: "…", ref }, ctx, x)
	 * ```
	 *
	 * A non-object action payload travels as `payload` beside the fields.
	 */
	form: (
		fields: readonly UiNode[],
		submit: { readonly text: string; readonly action: UiAction },
	): FormNode => ({
		t: "form",
		fields: [...fields],
		submit: { text: submit.text, action: submit.action },
	}),
	input: (name: string, options?: FieldOptions) =>
		field("input", name, options),
	textarea: (name: string, options?: FieldOptions) =>
		field("textarea", name, options),
	select: (
		name: string,
		options: readonly SelectOption[],
		fieldOptions?: FieldOptions,
	) => field("select", name, { ...fieldOptions, options }),
	checkbox: (name: string, options?: FieldOptions) =>
		field("checkbox", name, options),
	table: (
		columns: readonly string[],
		rows: readonly (readonly (string | number | UiNode)[])[],
	): TableNode => ({
		t: "table",
		columns: [...columns],
		rows: rows.map((row) => [...row]),
	}),
	list: (items: readonly UiNode[]): ListNode => ({
		t: "list",
		items: [...items],
	}),
	timeline: (
		items: readonly {
			readonly at: number;
			readonly text: string;
			readonly actor?: string;
			readonly tone?: Tone;
		}[],
	): TimelineNode => ({
		t: "timeline",
		items: items.map((item) =>
			compact({
				at: item.at,
				text: item.text,
				actor: item.actor,
				tone: item.tone,
			})
		),
	}),
	diff: (options: Omit<DiffNode, "t">): DiffNode =>
		compact({ ...options, t: "diff" as const }),
	board: (
		columns: BoardNode["columns"],
		cards: BoardNode["cards"],
		moveAction?: UiAction,
	): BoardNode =>
		compact({
			t: "board" as const,
			columns: columns.map((c) => compact({ ...c })),
			cards: cards.map((c) => compact({ ...c })),
			moveAction,
		}),
	matrix: (
		rows: MatrixNode["rows"],
		cols: MatrixNode["cols"],
		cells: MatrixNode["cells"],
	): MatrixNode => ({
		t: "matrix",
		rows: rows.map((r) => ({ ...r })),
		cols: cols.map((c) => ({ ...c })),
		cells: cells.map((c) => compact({ ...c })),
	}),
	sparkline: (values: readonly number[]): SparklineNode => ({
		t: "sparkline",
		values: [...values],
	}),
	action,
} as const;

/** `onAction` results. */
export const result = {
	ok: (): ActionResult => ({ v: 1 }),
	toast: (tone: Tone, text: string): ActionResult => ({
		v: 1,
		toast: { tone, text },
	}),
	render: (doc: UiDoc): ActionResult => ({ v: 1, render: doc }),
	/** `path` must be same-origin (`^/(?![/\\])`). */
	navigate: (path: string): ActionResult => ({ v: 1, navigate: path }),
	refresh: (slotIds: readonly string[]): ActionResult => ({
		v: 1,
		refresh: [...slotIds],
	}),
} as const;
