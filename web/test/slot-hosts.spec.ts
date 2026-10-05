// Every catalogue slot a manifest uses has an SPA host, or is a listed
// exception: `src/slots/hosts.ts` against the components' `SlotOutlet`s and
// against `extensions/*/tartan.json`.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOT_IDS } from "@tartan/contract/slots.ts";
import {
	KERNEL_HOST_COMPONENTS,
	SLOT_HOSTS,
	SLOTS_NOT_RENDERED,
} from "../src/slots/hosts.ts";

// Not `new URL("..", import.meta.url)`: Vite's client transform rewrites it.
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name))
			: /\.(vue|ts)$/.test(e.name)
			? [join(dir, e.name)]
			: []
	);

/** Slot ids mounted by a component: `slot-id="x"` or a quoted slot id bound to `:slot-id`. */
const mounted = (file: string): Set<string> => {
	const source = readFileSync(file, "utf8");
	const ids = new Set(
		[...source.matchAll(/\bslot-id="([a-z.]+)"/g)].map((m) => m[1]!),
	);
	if (/:slot-id="/.test(source)) {
		for (const m of source.matchAll(/"([a-z]+\.[a-z.]+)"/g)) {
			if (SLOT_IDS.includes(m[1] as never)) ids.add(m[1]!);
		}
	}
	return ids;
};

const manifestSlots = (): Set<string> => {
	const slots = new Set<string>();
	for (
		const e of readdirSync(join(ROOT, "extensions"), { withFileTypes: true })
	) {
		if (!e.isDirectory()) continue;
		let raw: string;
		try {
			raw = readFileSync(
				join(ROOT, "extensions", e.name, "tartan.json"),
				"utf8",
			);
		} catch {
			continue;
		}
		const m = JSON.parse(raw) as {
			contributes?: { slots?: { slot: string }[] };
		};
		for (const c of m.contributes?.slots ?? []) slots.add(c.slot);
	}
	return slots;
};

describe("slot hosts", () => {
	it("lists each catalogue slot once: hosted or a reasoned exception", () => {
		for (const slot of SLOT_IDS) {
			const hosted = Object.hasOwn(SLOT_HOSTS, slot);
			const excepted = Object.hasOwn(SLOTS_NOT_RENDERED, slot);
			expect(hosted !== excepted, slot).toBe(true);
		}
	});

	it("mounts each kernel host component in its page, beside a slot that page hosts", () => {
		for (const k of KERNEL_HOST_COMPONENTS) {
			const page = readFileSync(join(WEB, "src", k.page), "utf8");
			const name = k.component.split("/").pop()!.replace(/\.vue$/, "");
			expect(page, k.page).toContain(`<${name}`);
			expect(SLOT_HOSTS[k.beside], k.beside).toContain(k.page);
			expect(readFileSync(join(WEB, "src", k.component), "utf8")).toBeTruthy();
		}
	});

	it("mounts every hosted slot in the components the table names", () => {
		for (const [slot, files] of Object.entries(SLOT_HOSTS)) {
			for (const file of files ?? []) {
				expect(mounted(join(WEB, "src", file)), `${slot} in ${file}`).toContain(
					slot,
				);
			}
		}
	});

	it("names every component that mounts a slot", () => {
		for (const file of walk(join(WEB, "src"))) {
			const rel = file.slice(join(WEB, "src").length + 1);
			if (rel.startsWith("slots/")) continue;
			for (const slot of mounted(file)) {
				expect(SLOT_HOSTS[slot as keyof typeof SLOT_HOSTS], `${rel}: ${slot}`)
					.toContain(rel);
			}
		}
	});

	it("covers every slot the manifests use", () => {
		for (const slot of manifestSlots()) {
			expect(
				Object.hasOwn(SLOT_HOSTS, slot) ||
					Object.hasOwn(SLOTS_NOT_RENDERED, slot),
				slot,
			).toBe(true);
		}
	});
});
