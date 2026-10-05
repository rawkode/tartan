// Demo reset against a fake REST forge: every swarm
// stops; the demo repo, the docs repo and the sim group move into
// `<namespace>/attic` under stamped slugs and are archived, freeing their
// paths for the next seed; only seeded actors are disabled; a missing node
// is skipped; arguments need `--yes`; a reset then seed leaves no duplicate.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import { beatOf, DEMO } from "../fixtures/demo/beats.ts";
import { createForgeClient } from "../fixtures/demo/client.ts";
import { atticSlug, resetDemo } from "../fixtures/demo/reset.ts";
import { seedBeat } from "../fixtures/demo/seed.ts";
import { createFakeRest } from "../fixtures/demo/testing.ts";
import { SAMPLE_FILES } from "../src/kernel/swarm/sample.ts";
import { createFakeForge } from "../src/kernel/swarm/testing/fakeforge.ts";
import { main, parseResetArgs } from "./reset.ts";

const ORIGIN = "https://dev.example.com";
const NOW = 1_790_000_000_000;
const STAMP = NOW.toString(36);

Deno.test("reset moves the demo state into the attic, archives it, stops swarms, disables seeded actors", async () => {
	const rest = createFakeRest();
	const forge = await createFakeForge(SAMPLE_FILES, DEMO.repo);
	const client = createForgeClient({
		origin: ORIGIN,
		token: "t",
		fetch: rest.fetch,
	});
	const seedDeps = {
		client,
		portFor: (token: string) => forge.portFor(token),
		pushMirror: () => Promise.resolve(),
		saveAgentTokens: () => Promise.resolve(),
		log: () => {},
		now: () => NOW,
	};
	await seedBeat(seedDeps, {
		beat: beatOf(DEMO, 2),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/m.git" },
		allowMissing: false,
	});
	await seedBeat(seedDeps, {
		beat: beatOf(DEMO, 0),
		fixture: DEMO,
		allowMissing: false,
	});
	// The swarm's sim group, as the swarm would have made it.
	await client.createGroup("rawkode", "sim", "sim");
	const logs: string[] = [];
	const report = await resetDemo(
		{ client, log: (l) => logs.push(l), now: () => NOW },
		DEMO,
	);
	deepStrictEqual(report.stoppedSwarms, [rest.swarms[0]!.id]);
	deepStrictEqual(report.moved, [
		{ from: DEMO.repo, to: `rawkode/attic/router-${STAMP}` },
		{ from: DEMO.docsRepo, to: `rawkode/attic/site-${STAMP}` },
		{ from: "rawkode/sim", to: `rawkode/attic/sim-${STAMP}` },
	]);
	for (const { from, to } of report.moved) {
		equal(rest.nodes.get(from), undefined, `${from} is free`);
		equal(rest.nodes.get(to)?.archived, true, `${to} archived`);
	}
	equal(report.disabledAgents.length, 11);
	ok(report.disabledAgents.every((h) => h.startsWith("seeded-")));
	ok(
		rest.agents.filter((a) => !a.handle.startsWith("seeded-")).every((a) =>
			!a.disabled
		),
		"the real agents stay",
	);
	equal(logs.length, 1);
	// A seed after the reset recreates the repos at their paths.
	await seedBeat(seedDeps, {
		beat: beatOf(DEMO, 1),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/m.git" },
		allowMissing: false,
	});
	equal(rest.nodes.get(DEMO.repo)?.archived, false);
	equal(rest.installs.length, 3, "installations stay on the groups");
	// Nothing to move twice.
	const again = await resetDemo(
		{ client, log: () => {}, now: () => NOW + 1 },
		DEMO,
	);
	equal(again.moved.length, 2);
});

Deno.test("attic slugs stay within the slug grammar", () => {
	equal(atticSlug("router", "abc"), "router-abc");
	const long = atticSlug("a".repeat(40), STAMP);
	ok(long.length <= 40);
	ok(/^[a-z0-9][a-z0-9-]*$/.test(long));
});

Deno.test("reset arguments: --yes is required; --beat seeds afterwards", async () => {
	deepStrictEqual(
		parseResetArgs(["--origin", "https://d.example.com/x", "--yes"]),
		{
			origin: "https://d.example.com",
			yes: true,
		},
	);
	deepStrictEqual(
		parseResetArgs([
			"--origin",
			"https://d.example.com",
			"--yes",
			"--beat",
			"1",
			"--mirror",
			"/m",
		]),
		{
			origin: "https://d.example.com",
			yes: true,
			seed: [
				"--origin",
				"https://d.example.com",
				"--beat",
				"1",
				"--mirror",
				"/m",
			],
		},
	);
	throws(() => parseResetArgs(["--yes"]), /--origin is required/);
	throws(() => parseResetArgs(["--origin", "http://d.example.com"]), /https/);
	await rejects(main(["--origin", "https://d.example.com"]), /--yes/);
});
