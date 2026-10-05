// go.work and go.mod directives: `use`, `module`, `require` and `replace`,
// in single-line and block (`use ( … )`) form, with `//` comments.

export type GoWork = { readonly use: readonly string[] };
export type GoMod = {
	readonly module: string | null;
	readonly require: readonly string[];
	/** `replace <module> => <local path>` entries with a local target. */
	readonly replaceLocal: readonly {
		readonly module: string;
		readonly path: string;
	}[];
};

const unquote = (s: string): string =>
	s.length >= 2 && (s[0] === '"' || s[0] === "`") && s.at(-1) === s[0]
		? s.slice(1, -1)
		: s;

/** Every directive as `[verb, args]`, expanding blocks to one entry per line. */
const directives = (text: string): [string, string[]][] => {
	const out: [string, string[]][] = [];
	let block: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\/\/.*$/, "").trim();
		if (line === "") continue;
		if (block !== null) {
			if (line === ")") block = null;
			else out.push([block, line.split(/\s+/).map(unquote)]);
			continue;
		}
		const [verb, ...rest] = line.split(/\s+/);
		if (rest.length === 1 && rest[0] === "(") block = verb;
		else out.push([verb, rest.map(unquote)]);
	}
	return out;
};

export const parseGoWork = (text: string): GoWork => ({
	use: directives(text).flatMap(([verb, args]) =>
		verb === "use" && args[0] ? [args[0]] : []
	),
});

export const parseGoMod = (text: string): GoMod => {
	const all = directives(text);
	return {
		module: all.find(([verb]) => verb === "module")?.[1][0] ?? null,
		require: all.flatMap(([verb, args]) =>
			verb === "require" && args[0] ? [args[0]] : []
		),
		replaceLocal: all.flatMap(([verb, args]) => {
			if (verb !== "replace") return [];
			const arrow = args.indexOf("=>");
			const target = args[arrow + 1];
			return arrow > 0 && target && /^\.\.?\//.test(target)
				? [{ module: args[0], path: target }]
				: [];
		}),
	};
};
