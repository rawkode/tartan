// WP20 live acceptance: a simulated swarm on a dev stage
// with dev tools, watched until it ends, then judged against the acceptance
// numbers: < 1% errors, every sim push accepted for its own lane only (the
// wrong-lane probe refused in every cohort that ran it), read-your-writes
// held (every submitted revision's head is the pushed head), and the
// HUD on the namespace counting the swarm.
//
//   TARTAN_TOKEN=… deno task live -- --stage dev wp20 \
//     --origin https://<dev host> [--agents 50] [--minutes 10] [--max 300] \
//     [--repo rawkode/platform/edge/router] [--no-stop]
//
// TARTAN_TOKEN: the forge Owner's PAT with the `api` and `admin` scopes,
// never printed. The stage must match `^dev` and run with `--dev-tools`.
// Start with 50 agents (read the Artifacts operation counter before
// scaling up). The swarm is stopped on exit unless `--no-stop`.
// Exit code 0 only when every check passes.

import {
	assertDevStage,
	createForgeClient,
} from "../../fixtures/demo/client.ts";
import type { SwarmDetail } from "../../src/kernel/swarm/store.ts";

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const fail = (message: string): never => {
	console.error(`wp20: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");
const agents = Number(arg("agents") ?? "50");
const minutes = Number(arg("minutes") ?? "10");
const max = Number(arg("max") ?? "300");
const repo = arg("repo") ?? "rawkode/platform/edge/router";
const POLL_MS = 15_000;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const client = createForgeClient({ origin, token });
const health = await client.health();
assertDevStage(health.stage);

const status = async (id: string): Promise<SwarmDetail> => {
	const res = await fetch(`${origin}/-/api/swarm/${id}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!res.ok) fail(`status ${res.status}`);
	return await res.json() as SwarmDetail;
};

const started = await client.startSwarm({
	repo,
	agents,
	workItems: agents * 2,
	minutes,
}, max);
console.log(
	`wp20: swarm ${started.id}: ${started.agents} agents for ${minutes} min`,
);
let last: SwarmDetail | null = null;
try {
	const deadline = Date.now() + (minutes + 6) * 60_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		last = await status(started.id);
		console.log(
			`wp20: ${last.state} pushes=${last.pushes} claims=${last.claims} submits=${last.submits} errors=${last.errors} generations=${last.generations}`,
		);
		if (last.state === "done" || last.state === "error") break;
	}
} finally {
	if (!Deno.args.includes("--no-stop")) await client.stopSwarms();
}

if (!last) fail("no status was read");
const s = last!;
const actions = s.claims + s.pushes + s.submits;
check("the swarm ran to its end", s.state === "done", s.state);
check("agents pushed", s.pushes > 0, `${s.pushes} pushes`);
check(
	"< 1% errors",
	actions > 0 && s.errors / actions < 0.01,
	`${s.errors} errors over ${actions} actions${
		s.lastError ? `; last: ${s.lastError}` : ""
	}`,
);
check("no push refused on an agent's own lane", s.pushesRejected === 0);
check(
	"a push to another agent's lane was refused in every probing cohort",
	s.wrongLane.refused > 0 && s.wrongLane.accepted === 0 &&
		s.wrongLane.inconclusive === 0,
	JSON.stringify(s.wrongLane),
);
check(
	"read-your-writes: every submitted revision's head is the pushed head",
	s.rywChecks > 0 && s.rywMismatches === 0,
	`${s.rywChecks} checks, ${s.rywMismatches} mismatches`,
);
check(
	"sharded over sim repos",
	s.shards.length === Math.ceil(started.agents / 50),
);

const ns = repo.split("/")[0]!;
const view = await fetch(
	`${origin}/-/api/view?path=${encodeURIComponent(ns)}&view=hud`,
	{ headers: { authorization: `Bearer ${token}` } },
);
const hud = await view.json() as { slots: { ext: string; id: string }[] };
check(
	"the HUD is in force on the namespace",
	hud.slots.some((x) => x.ext === "tartan.hud" && x.id === "active-lanes"),
);

const failed = results.filter((r) => !r.ok);
console.log(`wp20: ${results.length - failed.length}/${results.length} passed`);
Deno.exit(failed.length === 0 ? 0 : 1);
