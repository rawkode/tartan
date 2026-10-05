// `when` expressions on static contributions, evaluated
// server-side against `WhenContext` (`{viewer.role, node.kind, entity.kind}`).
// A tiny, safe grammar (no eval, no calls, no assignment):
//
//   expr    := or
//   or      := and ("||" and)*
//   and     := unary ("&&" unary)*
//   unary   := "!" unary | compare
//   compare := operand (("==" | "!=" | ">=" | "<=" | ">" | "<") operand)?
//   operand := "(" expr ")" | 'string' | "string" | number | true | false
//            | null | identifier ("." identifier)*
//
// A malformed expression or an unknown identifier fails closed: the
// contribution is hidden.

import type { WhenContext } from "@tartan/contract";

type Token =
	| { readonly t: "op"; readonly v: string }
	| { readonly t: "str"; readonly v: string }
	| { readonly t: "num"; readonly v: number }
	| { readonly t: "id"; readonly v: string };

const OPS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")"];

const tokenize = (src: string): Token[] | null => {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i += 1;
			continue;
		}
		const op = OPS.find((o) => src.startsWith(o, i));
		if (op !== undefined) {
			tokens.push({ t: "op", v: op });
			i += op.length;
			continue;
		}
		if (c === "'" || c === '"') {
			const end = src.indexOf(c, i + 1);
			if (end < 0) return null;
			tokens.push({ t: "str", v: src.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
		if (num) {
			tokens.push({ t: "num", v: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const id = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(
			src.slice(i),
		);
		if (id) {
			tokens.push({ t: "id", v: id[0] });
			i += id[0].length;
			continue;
		}
		return null;
	}
	return tokens;
};

type Value = string | number | boolean | null | undefined;

class WhenError extends Error {}

const lookup = (ctx: WhenContext, path: string): Value => {
	if (path === "true") return true;
	if (path === "false") return false;
	if (path === "null") return null;
	let cur: unknown = ctx;
	for (const part of path.split(".")) {
		if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[part];
	}
	return typeof cur === "string" || typeof cur === "number" ||
			typeof cur === "boolean" || cur === null
		? cur
		: undefined;
};

const compare = (op: string, a: Value, b: Value): boolean => {
	switch (op) {
		case "==":
			return a === b;
		case "!=":
			return a !== b;
		default: {
			if (typeof a !== "number" || typeof b !== "number") return false;
			return op === ">="
				? a >= b
				: op === "<="
				? a <= b
				: op === ">"
				? a > b
				: a < b;
		}
	}
};

const truthy = (v: Value): boolean =>
	v !== undefined && v !== null && v !== false && v !== "" && v !== 0;

/** Evaluates `expr` against `ctx`; true for an absent expression, false when malformed. */
export const evalWhen = (
	expr: string | undefined,
	ctx: WhenContext,
): boolean => {
	if (expr === undefined || expr.trim() === "") return true;
	const tokens = tokenize(expr);
	if (tokens === null) return false;
	let pos = 0;
	const peek = (): Token | undefined => tokens[pos];
	const isOp = (v: string): boolean => {
		const t = peek();
		return t?.t === "op" && t.v === v;
	};
	const expect = (v: string): void => {
		if (!isOp(v)) throw new WhenError(`expected ${v}`);
		pos += 1;
	};
	const operand = (): Value => {
		const t = peek();
		if (t === undefined) throw new WhenError("unexpected end");
		if (t.t === "op" && t.v === "(") {
			pos += 1;
			const v = or();
			expect(")");
			return v;
		}
		pos += 1;
		if (t.t === "str" || t.t === "num") return t.v;
		if (t.t === "id") {
			const v = lookup(ctx, t.v);
			if (v === undefined && !t.v.startsWith("entity.")) {
				throw new WhenError(`unknown ${t.v}`);
			}
			return v;
		}
		throw new WhenError(`unexpected ${t.v}`);
	};
	const cmp = (): Value => {
		const left = operand();
		const t = peek();
		if (t?.t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.v)) {
			pos += 1;
			return compare(t.v, left, operand());
		}
		return left;
	};
	const unary = (): Value => {
		if (isOp("!")) {
			pos += 1;
			return !truthy(unary());
		}
		return cmp();
	};
	const and = (): Value => {
		let v = unary();
		while (isOp("&&")) {
			pos += 1;
			const r = unary();
			v = truthy(v) && truthy(r);
		}
		return v;
	};
	const or = (): Value => {
		let v = and();
		while (isOp("||")) {
			pos += 1;
			const r = and();
			v = truthy(v) || truthy(r);
		}
		return v;
	};
	try {
		const result = or();
		if (pos !== tokens.length) return false;
		return truthy(result);
	} catch (error) {
		if (error instanceof WhenError) return false;
		throw error;
	}
};
