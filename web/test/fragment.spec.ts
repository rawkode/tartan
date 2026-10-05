// The setup token rides in the URL fragment;
// the SPA reads it and clears it with `history.replaceState` BEFORE the first
// render, so it is gone from `location` after load.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { takeSetupToken } from "../src/setup/fragment.ts";

/** A Location + History pair where replaceState really updates the location. */
const browser = (url: string) => {
	const current = new URL(url);
	const calls: { state: unknown; url: string }[] = [];
	const location = {
		get hash() {
			return current.hash;
		},
		get pathname() {
			return current.pathname;
		},
		get search() {
			return current.search;
		},
		get href() {
			return current.href;
		},
	};
	const history = {
		state: { back: null },
		replaceState: (state: unknown, _title: string, next: string) => {
			calls.push({ state, url: next });
			const resolved = new URL(next, current);
			current.hash = resolved.hash;
			current.pathname = resolved.pathname;
			current.search = resolved.search;
		},
	};
	return { location, history, calls };
};

const TOKEN = "s3t_ab12cd34ef56gh78ij90kl12mn34op";

describe("setup token hand-off", () => {
	it("returns the token and removes the fragment from location", () => {
		const b = browser(`https://code.example/-/setup#t=${TOKEN}`);
		expect(takeSetupToken(b.location, b.history)).toBe(TOKEN);
		expect(b.location.hash).toBe("");
		expect(b.location.href).toBe("https://code.example/-/setup");
		expect(b.location.href).not.toContain(TOKEN);
		expect(b.calls).toEqual([{ state: { back: null }, url: "/-/setup" }]);
	});

	it("keeps the query string and drops the whole fragment", () => {
		const b = browser(`https://code.example/-/setup?x=1#t=${TOKEN}&other=2`);
		expect(takeSetupToken(b.location, b.history)).toBe(TOKEN);
		expect(b.location.href).toBe("https://code.example/-/setup?x=1");
	});

	it("clears an empty t= without returning a token", () => {
		const b = browser("https://code.example/-/setup#t=");
		expect(takeSetupToken(b.location, b.history)).toBeNull();
		expect(b.location.hash).toBe("");
	});

	it("leaves unrelated fragments alone", () => {
		const b = browser("https://code.example/acme/r/-/blob/main/a.ts#L10");
		expect(takeSetupToken(b.location, b.history)).toBeNull();
		expect(b.location.hash).toBe("#L10");
		expect(b.calls).toEqual([]);
	});

	it("runs in main.ts before any await, router or render", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const main = readFileSync(join(here, "../src/main.ts"), "utf8")
			.replace(/^\s*\/\/.*$/gm, "");
		const take = main.indexOf("takeSetupToken(globalThis.location");
		expect(take).toBeGreaterThan(0);
		for (
			const later of ["await ", "createApp(", "createAppRouter(", ".mount("]
		) {
			expect(main.indexOf(later)).toBeGreaterThan(take);
		}
	});

	it("is never written to storage", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const files = [
			"../src/setup/fragment.ts",
			"../src/views/setup/steps/StepUnlock.vue",
		];
		for (const file of files) {
			const source = readFileSync(join(here, file), "utf8");
			expect(source).not.toMatch(
				/localStorage|sessionStorage|indexedDB|document\.cookie/,
			);
		}
	});
});
