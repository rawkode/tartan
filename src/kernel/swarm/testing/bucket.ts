// An in-memory stand-in for the R2 operations the swarm store uses (TEST-ONLY):
// `get` (with `json()`), `put`, `head` and a delimited `list`.

import type { Bucket } from "../store.ts";

export const createMemoryBucket = (): Bucket & {
	readonly keys: () => string[];
} => {
	const objects = new Map<string, string>();
	const bucket = {
		get: (key: string) => {
			const text = objects.get(key);
			return Promise.resolve(
				text === undefined ? null : {
					json: () => Promise.resolve(JSON.parse(text)),
					text: () => Promise.resolve(text),
				},
			);
		},
		put: (key: string, value: unknown) => {
			objects.set(key, String(value));
			return Promise.resolve({ key });
		},
		head: (key: string) => Promise.resolve(objects.has(key) ? { key } : null),
		list: (options?: { prefix?: string; delimiter?: string }) => {
			const prefix = options?.prefix ?? "";
			const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
			if (!options?.delimiter) {
				return Promise.resolve({
					objects: keys.map((key) => ({ key })),
					delimitedPrefixes: [],
				});
			}
			const prefixes = new Set<string>();
			for (const key of keys) {
				const rest = key.slice(prefix.length);
				const cut = rest.indexOf(options.delimiter);
				if (cut !== -1) prefixes.add(prefix + rest.slice(0, cut + 1));
			}
			return Promise.resolve({
				objects: [],
				delimitedPrefixes: [...prefixes].sort(),
			});
		},
	};
	return {
		...(bucket as unknown as Bucket),
		keys: () => [...objects.keys()].sort(),
	};
};
