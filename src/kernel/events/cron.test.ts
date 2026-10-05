// The events cron (WP6): every repo is pruned and has
// its subscribers rebuilt (which re-pokes them: known_head recovery), pages
// are followed, and one repo's failure never skips another.

import { deepStrictEqual, equal } from "node:assert/strict";
import type { SubscriberRow } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { runEventsCron } from "./cron.ts";
import { registrySubscriberSource } from "./subscribers.ts";

Deno.test("events cron prunes and refreshes every repo, isolating failures", async () => {
	const calls: string[] = [];
	const pages: Record<string, { repos: { id: string }[]; cursor?: string }> = {
		start: { repos: [{ id: "r1" }, { id: "r2" }], cursor: "p2" },
		p2: { repos: [{ id: "r3" }] },
	};
	const rows: SubscriberRow[] = [{
		installation_id: "i_1",
		host_name: "ext:i_1:node",
		pattern: "*",
		mode: "enforce",
		ext_version: 4,
	}];
	const result = await runEventsCron({
		listRepos: ({ cursor }) => Promise.resolve(pages[cursor ?? "start"]),
		repoEvents: (id) => ({
			prune: (now) => {
				calls.push(`prune ${id} ${now}`);
				return id === "r2"
					? Promise.reject(new Error("busy"))
					: Promise.resolve({ deleted: 2 });
			},
			refreshSubscribers: (got, version) => {
				calls.push(`refresh ${id} ${got.length} v${version}`);
				return Promise.resolve();
			},
		}),
		subscribers: {
			extVersion: () => Promise.resolve(4),
			load: (id) =>
				id === "r3"
					? Promise.reject(new Error("registry down"))
					: Promise.resolve({ rows, extVersion: 4 }),
		},
	}, 99);
	deepStrictEqual(calls, [
		"prune r1 99",
		"refresh r1 1 v4",
		"prune r2 99",
		"refresh r2 1 v4",
		"prune r3 99",
	]);
	equal(result.repos, 3);
	equal(result.pruned, 4);
	deepStrictEqual(result.failures.map((f) => f.split(":")[0]), [
		"r2 prune",
		"r3 subscribers",
	]);
});

Deno.test("events cron closes each repo's call context, also when its calls fail", async () => {
	const disposed: string[] = [];
	await runEventsCron({
		listRepos: () => Promise.resolve({ repos: [{ id: "r1" }, { id: "r2" }] }),
		repoEvents: (id) => ({
			prune: () =>
				id === "r2"
					? Promise.reject(new Error("busy"))
					: Promise.resolve({ deleted: 0 }),
			refreshSubscribers: () => Promise.reject(new Error("down")),
			[Symbol.dispose]: () => disposed.push(id),
		}),
		subscribers: {
			extVersion: () => Promise.resolve(1),
			load: () => Promise.resolve({ rows: [], extVersion: 1 }),
		},
	}, 1);
	deepStrictEqual(disposed, ["r1", "r2"]);
});

Deno.test("the registry subscriber source disposes every ForgeDO facade it opens", async () => {
	let opened = 0;
	let disposed = 0;
	const env = {
		FORGE: {
			getByName: () => ({
				registry: () => {
					opened++;
					return {
						extVersion: () => Promise.resolve(7),
						inForce: () => Promise.resolve([]),
						[Symbol.dispose]: () => disposed++,
					};
				},
			}),
		},
	} as unknown as Env;
	const source = registrySubscriberSource(env);
	equal(await source.extVersion(), 7);
	deepStrictEqual(await source.load("01k6repo000000000000000000"), {
		rows: [],
		extVersion: 7,
	});
	equal(opened, 3);
	equal(disposed, 3);
});

Deno.test("the events cron asks for archived repos only on the first tick of a UTC day", async () => {
	const asked: (boolean | undefined)[] = [];
	const deps = {
		listRepos: (o: { archived?: boolean }) => {
			asked.push(o.archived);
			return Promise.resolve({ repos: [] });
		},
		repoEvents: () => ({
			prune: () => Promise.resolve({ deleted: 0 }),
			refreshSubscribers: () => Promise.resolve(),
		}),
		subscribers: {
			extVersion: () => Promise.resolve(1),
			load: () => Promise.resolve({ rows: [], extVersion: 1 }),
		},
	};
	const midnight = Date.UTC(2026, 9, 6);
	await runEventsCron(deps, midnight + 60_000);
	await runEventsCron(deps, midnight + 5 * 60_000);
	await runEventsCron(deps, midnight + 12 * 3_600_000);
	deepStrictEqual(asked, [true, false, false]);
});
