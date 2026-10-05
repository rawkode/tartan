// Repo-relative path helpers and glob matching (`*`, `**`, `?`, `[…]`,
// `{a,b}`) for global-file patterns and owner rules. Paths never start with
// "/" or "./" and never end with "/".
//
// The semantics are WP8's `packages/monorepo/src/glob.ts` (so the CI planner's
// affected sets agree with RepoProbe's), copied because builtins import only
// `@tartan/contract` and `@tartan/ext-api`. Globs come from repository content,
// so they compile to a Thompson NFA run as a state set: linear in path length ×
// pattern size, never backtracking. An invalid `[…]` class matches nothing
// instead of throwing. `extensions/review/src/lib/glob.ts` must stay identical
// (`packages/pipeline/test/copies.test.ts`).

/** True when `path` equals `root` or lies under it ("" is the repo root). */
export const isUnder = (path: string, root: string): boolean =>
	root === "" || path === root || path.startsWith(`${root}/`);

type CharTest = (ch: string) => boolean;

type GlobNode =
	| { readonly kind: "char"; readonly test: CharTest }
	/** `*` (and `**` inside a segment): any run of non-`/` characters. */
	| { readonly kind: "star" }
	/** A trailing `**` at a segment start: anything except line terminators. */
	| { readonly kind: "any" }
	/** `**\/` at a segment start: zero or more whole segments. */
	| { readonly kind: "dirs" }
	| { readonly kind: "alt"; readonly options: readonly GlobNode[][] };

const notSlash: CharTest = (ch) => ch !== "/";
const isSlash: CharTest = (ch) => ch === "/";
const notLineTerminator: CharTest = (ch) =>
	ch !== "\n" && ch !== "\r" && ch !== " " && ch !== " ";
const literal = (c: string): CharTest => (ch) => ch === c;
const never: CharTest = () => false;

/** `[…]` (a leading `!` negates) as a one-character class. */
const charClass = (body: string): CharTest => {
	try {
		const re = new RegExp(
			`^[${body.replace(/^!/, "^").replaceAll("\\", "\\\\")}]$`,
		);
		return (ch) => re.test(ch);
	} catch {
		return never;
	}
};

const parseGlob = (pattern: string): GlobNode[] => {
	const out: GlobNode[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				const slashAfter = pattern[i + 2] === "/";
				const atSegmentStart = i === 0 || pattern[i - 1] === "/";
				if (atSegmentStart && slashAfter) {
					out.push({ kind: "dirs" });
					i += 2;
				} else if (atSegmentStart && i + 2 === pattern.length) {
					out.push({ kind: "any" });
					i += 1;
				} else {
					out.push({ kind: "star" });
					i += 1;
				}
			} else out.push({ kind: "star" });
		} else if (ch === "?") out.push({ kind: "char", test: notSlash });
		else if (ch === "[") {
			const end = pattern.indexOf("]", i + 1);
			if (end === -1) out.push({ kind: "char", test: literal("[") });
			else {
				out.push({ kind: "char", test: charClass(pattern.slice(i + 1, end)) });
				i = end;
			}
		} else if (ch === "{") {
			const end = pattern.indexOf("}", i + 1);
			if (end === -1) out.push({ kind: "char", test: literal("{") });
			else {
				out.push({
					kind: "alt",
					options: pattern.slice(i + 1, end).split(",").map(parseGlob),
				});
				i = end;
			}
		} else out.push({ kind: "char", test: literal(ch) });
	}
	return out;
};

type NfaState = {
	readonly eps: number[];
	readonly edges: { readonly test: CharTest; readonly to: number }[];
};

type Nfa = {
	readonly accept: number;
	readonly closure: readonly (readonly number[])[];
	readonly states: readonly NfaState[];
};

const compileNfa = (nodes: readonly GlobNode[]): Nfa => {
	const states: NfaState[] = [];
	const add = (): number => states.push({ eps: [], edges: [] }) - 1;
	const repeat = (cur: number, test: CharTest): number => {
		const loop = add();
		states[cur].eps.push(loop);
		states[loop].edges.push({ test, to: loop });
		const next = add();
		states[loop].eps.push(next);
		return next;
	};
	const seq = (items: readonly GlobNode[], from: number): number => {
		let cur = from;
		for (const node of items) {
			switch (node.kind) {
				case "char": {
					const next = add();
					states[cur].edges.push({ test: node.test, to: next });
					cur = next;
					break;
				}
				case "star":
					cur = repeat(cur, notSlash);
					break;
				case "any":
					cur = repeat(cur, notLineTerminator);
					break;
				case "dirs": {
					const segment = add();
					const inside = add();
					states[cur].eps.push(segment);
					states[segment].edges.push({ test: notSlash, to: inside });
					states[inside].edges.push({ test: notSlash, to: inside });
					states[inside].edges.push({ test: isSlash, to: segment });
					const next = add();
					states[segment].eps.push(next);
					cur = next;
					break;
				}
				case "alt": {
					const join = add();
					for (const option of node.options) {
						const start = add();
						states[cur].eps.push(start);
						states[seq(option, start)].eps.push(join);
					}
					cur = join;
					break;
				}
			}
		}
		return cur;
	};
	const start = add();
	const accept = seq(nodes, start);
	const closure = states.map((_, id) => {
		const seen = new Set<number>([id]);
		const stack = [id];
		while (stack.length > 0) {
			for (const next of states[stack.pop() as number].eps) {
				if (!seen.has(next)) {
					seen.add(next);
					stack.push(next);
				}
			}
		}
		return [...seen];
	});
	return { accept, closure, states };
};

const runNfa = (nfa: Nfa, path: string): boolean => {
	const mark = new Int32Array(nfa.states.length).fill(-1);
	let current: number[] = [];
	const enter = (state: number, step: number, into: number[]) => {
		for (const s of nfa.closure[state]) {
			if (mark[s] !== step) {
				mark[s] = step;
				into.push(s);
			}
		}
	};
	enter(0, 0, current);
	for (let i = 0; i < path.length && current.length > 0; i++) {
		const ch = path[i];
		const next: number[] = [];
		for (const state of current) {
			for (const edge of nfa.states[state].edges) {
				if (edge.test(ch)) enter(edge.to, i + 1, next);
			}
		}
		current = next;
	}
	return current.includes(nfa.accept);
};

/** Normalises a glob: drops "./" and trailing "/"; "dir/" means the directory itself. */
export const normaliseGlob = (pattern: string): string =>
	pattern.replace(/^\.\//, "").replace(/\/+$/, "");

/** A matcher for one glob over repo-relative paths (whole-path match). */
export const globMatcher = (pattern: string): (path: string) => boolean => {
	const nfa = compileNfa(parseGlob(normaliseGlob(pattern)));
	return (path) => runNfa(nfa, path);
};

/** True when the pattern has no glob characters. */
export const isLiteralGlob = (pattern: string): boolean =>
	!/[*?[{]/.test(pattern);

/** The literal leading directory of a glob ("packages/*" → "packages"). */
export const globBase = (pattern: string): string => {
	const segs = normaliseGlob(pattern).split("/");
	const lit: string[] = [];
	for (const seg of segs) {
		if (!isLiteralGlob(seg)) break;
		lit.push(seg);
	}
	return lit.join("/");
};
