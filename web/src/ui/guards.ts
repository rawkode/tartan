// Client-side shape check for one `tartan-ui@1` node (defence in depth).
//
// The kernel validates every document strictly before the SPA sees it, so a
// node that fails here means a kernel bug or a tampered response. The renderer
// then shows an "unsupported node" chip instead of the node; it never renders
// a partially understood node. The check mirrors the contract's closed shapes:
// a node, or any fixed-shape object inside it, with a key the type does not
// declare (`innerHTML`, `style`, `onClick`, `href` on a non-link …) is invalid.
//
// Child nodes are checked when they render (each `UiNode` checks its own
// node), so this check is shallow for nested nodes and exact for everything
// else. `contract-parity.spec.ts` cross-checks it against `validateUi()`.

import {
	ACTION_ID_RE,
	AVATAR_PRINCIPAL_RE,
	FIELD_NAME_RE,
	ICON_NAME_RE,
	isTone,
	isUiNodeType,
	LINK_HREF_RE,
	SAME_ORIGIN_PATH_RE,
	type UiNode,
} from "./nodeTypes.ts";

export type NodeCheck =
	| { readonly ok: true; readonly node: UiNode }
	| { readonly ok: false; readonly reason: string };

type Obj = Readonly<Record<string, unknown>>;
type Rule = (node: Obj) => string | null;

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStr = (value: unknown, max = Infinity): value is string =>
	typeof value === "string" && value.length <= max;
const isNum = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const isInt = (value: unknown): value is number =>
	isNum(value) && Number.isInteger(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const opt = (value: unknown, test: (v: unknown) => boolean): boolean =>
	value === undefined || test(value);

/** Keys outside `allowed` (the closed-shape rule). */
const extraKeys = (obj: Obj, allowed: readonly string[]): string[] =>
	Object.keys(obj).filter((key) => !allowed.includes(key));

const closed = (
	obj: unknown,
	allowed: readonly string[],
	what: string,
): string | null => {
	if (!isObj(obj)) return `${what} is not an object`;
	const extra = extraKeys(obj, allowed);
	return extra.length > 0 ? `${what} has unknown prop ${extra[0]}` : null;
};

const isJson = (value: unknown, depth = 0): boolean => {
	if (depth > 64) return false;
	if (value === null || isStr(value) || isBool(value) || isNum(value)) {
		return true;
	}
	if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
	if (isObj(value)) {
		return Object.values(value).every((v) => isJson(v, depth + 1));
	}
	return false;
};

const actionIssue = (value: unknown, what: string): string | null => {
	const shape = closed(value, ["id", "payload", "confirm"], what);
	if (shape) return shape;
	const action = value as Obj;
	if (!isStr(action["id"]) || !ACTION_ID_RE.test(action["id"])) {
		return `${what}.id is invalid`;
	}
	if (!opt(action["confirm"], (v) => isStr(v, 200))) {
		return `${what}.confirm is invalid`;
	}
	if (action["payload"] !== undefined && !isJson(action["payload"])) {
		return `${what}.payload is not JSON`;
	}
	return null;
};

const arrayIssue = (
	value: unknown,
	max: number,
	what: string,
	item: (v: unknown, i: number) => string | null,
): string | null => {
	if (!Array.isArray(value)) return `${what} is not an array`;
	if (value.length > max) return `${what} has more than ${max} items`;
	for (let i = 0; i < value.length; i += 1) {
		const issue = item(value[i], i);
		if (issue) return issue;
	}
	return null;
};

/** A nested node: only its discriminant is checked here (it checks itself when rendered). */
const nodeRef = (value: unknown, what: string): string | null =>
	isObj(value) && isUiNodeType(value["t"]) ? null : `${what} is not a node`;

const ID = ["t", "id"] as const;
const keys = (...rest: string[]): readonly string[] => [...ID, ...rest];

const firstIssue = (...issues: (string | null)[]): string | null =>
	issues.find((issue) => issue !== null) ?? null;

const containerRule: Rule = (n) =>
	firstIssue(
		closed(n, keys("children", "gap", "cols", "title"), n["t"] as string),
		n["children"] === undefined ? null : arrayIssue(
			n["children"],
			200,
			"children",
			(c, i) => nodeRef(c, `children[${i}]`),
		),
		opt(n["gap"], (v) => v === 0 || v === 1 || v === 2 || v === 3)
			? null
			: "gap is invalid",
		opt(n["cols"], (v) => isInt(v) && v >= 1 && v <= 6)
			? null
			: "cols is invalid",
		opt(n["title"], (v) => isStr(v, 120)) ? null : "title is invalid",
	);

const textRule: Rule = (n) =>
	firstIssue(
		closed(n, keys("text", "tone", "level", "mono", "body"), "text node"),
		isStr(n["text"], 4000) ? null : "text is required",
		opt(n["tone"], isTone) ? null : "tone is invalid",
		opt(n["level"], (v) => v === 2 || v === 3 || v === 4)
			? null
			: "level is invalid",
		opt(n["mono"], isBool) ? null : "mono is invalid",
		opt(n["body"], (v) => isStr(v, 2000)) ? null : "body is invalid",
	);

const avatarRule: Rule = (n) =>
	firstIssue(
		closed(n, keys("principal", "name"), "avatar"),
		opt(n["principal"], (v) => isStr(v) && AVATAR_PRINCIPAL_RE.test(v))
			? null
			: "principal is invalid",
		opt(n["name"], (v) => isStr(v) && ICON_NAME_RE.test(v))
			? null
			: "name is invalid",
	);

const valueRule: Rule = (n) =>
	firstIssue(
		closed(n, keys("value", "max", "label", "delta", "unit"), "value node"),
		opt(n["value"], isNum) ? null : "value is invalid",
		opt(n["max"], isNum) ? null : "max is invalid",
		opt(n["label"], isStr) ? null : "label is invalid",
		opt(n["delta"], isNum) ? null : "delta is invalid",
		opt(n["unit"], (v) => isStr(v, 12)) ? null : "unit is invalid",
	);

const buttonRule: Rule = (n) =>
	firstIssue(
		closed(n, keys("text", "action", "tone", "items"), "button"),
		isStr(n["text"], 60) ? null : "text is required",
		n["action"] === undefined ? null : actionIssue(n["action"], "action"),
		opt(n["tone"], isTone) ? null : "tone is invalid",
		n["items"] === undefined ? null : arrayIssue(
			n["items"],
			20,
			"items",
			(item, i) =>
				firstIssue(
					closed(item, ["text", "action"], `items[${i}]`),
					isStr((item as Obj)["text"]) ? null : `items[${i}].text is invalid`,
					actionIssue((item as Obj)["action"], `items[${i}].action`),
				),
		),
	);

const isOption = (value: unknown): boolean =>
	isStr(value) || isNum(value) ||
	(isObj(value) && extraKeys(value, ["value", "label"]).length === 0 &&
		(isStr(value["value"]) || isNum(value["value"]) ||
			isBool(value["value"])) &&
		isStr(value["label"]));

const isFieldValue = (value: unknown): boolean =>
	value === null || isStr(value) || isNum(value) || isBool(value) ||
	(Array.isArray(value) && value.every((v) => isStr(v) || isNum(v)));

const fieldRule: Rule = (n) =>
	firstIssue(
		closed(
			n,
			keys("name", "label", "value", "options", "required"),
			"field",
		),
		isStr(n["name"]) && FIELD_NAME_RE.test(n["name"])
			? null
			: "name is invalid",
		opt(n["label"], isStr) ? null : "label is invalid",
		opt(n["value"], isFieldValue) ? null : "value is invalid",
		n["options"] === undefined ? null : arrayIssue(
			n["options"],
			100,
			"options",
			(o, i) => isOption(o) ? null : `options[${i}] is invalid`,
		),
		opt(n["required"], isBool) ? null : "required is invalid",
	);

const RULES: Readonly<Record<string, Rule>> = {
	stack: containerRule,
	row: containerRule,
	grid: containerRule,
	section: containerRule,
	card: containerRule,
	tabs: (n) =>
		firstIssue(
			closed(n, keys("tabs"), "tabs"),
			arrayIssue(n["tabs"], 12, "tabs", (tab, i) =>
				firstIssue(
					closed(tab, ["label", "body"], `tabs[${i}]`),
					isStr((tab as Obj)["label"], 40) ? null : `tabs[${i}].label`,
					nodeRef((tab as Obj)["body"], `tabs[${i}].body`),
				)),
		),
	divider: (n) => closed(n, keys(), "divider"),
	heading: textRule,
	text: textRule,
	label: textRule,
	badge: textRule,
	empty: textRule,
	markdown: (n) =>
		firstIssue(
			closed(n, keys("md"), "markdown"),
			isStr(n["md"], 20000) ? null : "md is required",
		),
	code: (n) =>
		firstIssue(
			closed(n, keys("text", "lang"), "code"),
			isStr(n["text"], 20000) ? null : "text is required",
			opt(n["lang"], (v) => isStr(v, 20)) ? null : "lang is invalid",
		),
	link: (n) =>
		firstIssue(
			closed(n, keys("text", "href"), "link"),
			isStr(n["text"]) ? null : "text is required",
			isStr(n["href"]) && LINK_HREF_RE.test(n["href"])
				? null
				: "href is not same-origin or https",
		),
	avatar: avatarRule,
	icon: avatarRule,
	progress: valueRule,
	stat: valueRule,
	kv: (n) =>
		firstIssue(
			closed(n, keys("items"), "kv"),
			arrayIssue(n["items"], 50, "items", (item, i) =>
				firstIssue(
					closed(item, ["k", "v"], `items[${i}]`),
					isStr((item as Obj)["k"]) ? null : `items[${i}].k`,
					isStr((item as Obj)["v"])
						? null
						: nodeRef((item as Obj)["v"], `items[${i}].v`),
				)),
		),
	alert: (n) =>
		firstIssue(
			closed(n, keys("tone", "title", "body"), "alert"),
			isTone(n["tone"]) ? null : "tone is required",
			isStr(n["title"]) ? null : "title is required",
			n["body"] === undefined ? null : nodeRef(n["body"], "body"),
		),
	button: buttonRule,
	menu: buttonRule,
	form: (n) =>
		firstIssue(
			closed(n, keys("fields", "submit"), "form"),
			arrayIssue(
				n["fields"],
				30,
				"fields",
				(f, i) => nodeRef(f, `fields[${i}]`),
			),
			closed(n["submit"], ["text", "action"], "submit"),
			isStr((n["submit"] as Obj | undefined)?.["text"]) ? null : "submit.text",
			actionIssue((n["submit"] as Obj | undefined)?.["action"], "submit"),
		),
	input: fieldRule,
	textarea: fieldRule,
	select: fieldRule,
	checkbox: fieldRule,
	table: (n) =>
		firstIssue(
			closed(n, keys("columns", "rows"), "table"),
			arrayIssue(n["columns"], 12, "columns", (c, i) =>
				isStr(c) ? null : `columns[${i}]`),
			arrayIssue(n["rows"], 500, "rows", (row, r) =>
				arrayIssue(row, Infinity, `rows[${r}]`, (cell, c) =>
					isStr(cell) || isNum(cell)
						? null
						: nodeRef(cell, `rows[${r}][${c}]`))),
		),
	list: (n) =>
		firstIssue(
			closed(n, keys("items"), "list"),
			arrayIssue(n["items"], 200, "items", (c, i) => nodeRef(c, `items[${i}]`)),
		),
	timeline: (n) =>
		firstIssue(
			closed(n, keys("items"), "timeline"),
			arrayIssue(n["items"], 200, "items", (item, i) =>
				firstIssue(
					closed(item, ["at", "text", "actor", "tone"], `items[${i}]`),
					isInt((item as Obj)["at"]) ? null : `items[${i}].at`,
					isStr((item as Obj)["text"]) ? null : `items[${i}].text`,
					opt((item as Obj)["actor"], isStr) ? null : `items[${i}].actor`,
					opt((item as Obj)["tone"], isTone) ? null : `items[${i}].tone`,
				)),
		),
	diff: (n) =>
		firstIssue(
			closed(
				n,
				keys("repo", "base", "head", "source", "lane", "paths", "patch"),
				"diff",
			),
			opt(n["repo"], isStr) ? null : "repo is invalid",
			opt(n["base"], isStr) ? null : "base is invalid",
			opt(n["head"], isStr) ? null : "head is invalid",
			opt(n["source"], isStr) ? null : "source is invalid",
			opt(n["lane"], isStr) ? null : "lane is invalid",
			n["paths"] === undefined ? null : arrayIssue(
				n["paths"],
				Infinity,
				"paths",
				(p, i) => isStr(p) ? null : `paths[${i}]`,
			),
			opt(n["patch"], (v) => isStr(v, 60000)) ? null : "patch is invalid",
		),
	board: (n) =>
		firstIssue(
			closed(n, keys("columns", "cards", "moveAction"), "board"),
			arrayIssue(n["columns"], 12, "columns", (col, i) =>
				firstIssue(
					closed(col, ["id", "title", "wip"], `columns[${i}]`),
					isStr((col as Obj)["id"]) && isStr((col as Obj)["title"])
						? null
						: `columns[${i}]`,
					opt((col as Obj)["wip"], isInt) ? null : `columns[${i}].wip`,
				)),
			arrayIssue(n["cards"], 500, "cards", (card, i) => {
				const shape = closed(
					card,
					["id", "col", "title", "href", "badges"],
					`cards[${i}]`,
				);
				if (shape) return shape;
				const c = card as Obj;
				return firstIssue(
					isStr(c["id"]) && isStr(c["col"]) && isStr(c["title"])
						? null
						: `cards[${i}]`,
					opt(c["href"], (v) => isStr(v) && SAME_ORIGIN_PATH_RE.test(v))
						? null
						: `cards[${i}].href is not same-origin`,
					c["badges"] === undefined ? null : arrayIssue(
						c["badges"],
						Infinity,
						`cards[${i}].badges`,
						(b) => isStr(b) ? null : `cards[${i}].badges`,
					),
				);
			}),
			n["moveAction"] === undefined
				? null
				: actionIssue(n["moveAction"], "moveAction"),
		),
	matrix: (n) => {
		const axis = (value: unknown, what: string) =>
			arrayIssue(value, 200, what, (item, i) =>
				firstIssue(
					closed(item, ["id", "label"], `${what}[${i}]`),
					isStr((item as Obj)["id"]) && isStr((item as Obj)["label"])
						? null
						: `${what}[${i}]`,
				));
		return firstIssue(
			closed(n, keys("rows", "cols", "cells"), "matrix"),
			axis(n["rows"], "rows"),
			axis(n["cols"], "cols"),
			arrayIssue(n["cells"], 5000, "cells", (cell, i) => {
				const shape = closed(
					cell,
					["r", "c", "level", "label", "action"],
					`cells[${i}]`,
				);
				if (shape) return shape;
				const c = cell as Obj;
				return firstIssue(
					isStr(c["r"]) && isStr(c["c"]) ? null : `cells[${i}]`,
					isInt(c["level"]) && c["level"] >= 0 && c["level"] <= 5
						? null
						: `cells[${i}].level`,
					opt(c["label"], isStr) ? null : `cells[${i}].label`,
					c["action"] === undefined
						? null
						: actionIssue(c["action"], `cells[${i}].action`),
				);
			}),
		);
	},
	sparkline: (n) =>
		firstIssue(
			closed(n, keys("values"), "sparkline"),
			arrayIssue(n["values"], 240, "values", (v, i) =>
				isNum(v) ? null : `values[${i}]`),
		),
};

/** Checks one node's own shape; nested nodes are checked when they render. */
export const checkNode = (value: unknown): NodeCheck => {
	if (!isObj(value)) return { ok: false, reason: "not an object" };
	const t = value["t"];
	if (!isUiNodeType(t)) return { ok: false, reason: "unknown node type" };
	if (!opt(value["id"], (v) => isStr(v, 64))) {
		return { ok: false, reason: "id is invalid" };
	}
	const rule = RULES[t];
	const issue = rule ? rule(value) : "no rule";
	return issue === null
		? { ok: true, node: value as unknown as UiNode }
		: { ok: false, reason: issue };
};

/** The host-only error chip (`{t:"error-chip", text}`), checked as strictly. */
export const errorChipText = (value: unknown): string | null =>
	isObj(value) && value["t"] === "error-chip" &&
		extraKeys(value, ["t", "text"]).length === 0 && isStr(value["text"], 200)
		? value["text"]
		: null;
