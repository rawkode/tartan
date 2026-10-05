// The global log's Owner-only routes, health word and cron (WP26).

import { deepEqual, equal, ok } from "node:assert/strict";
import { authOf, routeContext } from "../events/testing/ports.ts";
import type {
	BusFacade,
	BusStatus,
	DeadRecordDto,
	LogDeadListResponse,
	LogStatusResponse,
	RelayStatus,
} from "./contract.ts";
import { runBusCron } from "./cron.ts";
import { logHandler, type LogPorts } from "./routes.ts";
import {
	envStatusPorts,
	k2Health,
	readK2Health,
	readLogStatus,
} from "./status.ts";
import type { Env } from "../../env.ts";

const OWNER = "u_01k6aaaaaaaaaaaaaaaaaaaaac";
const MAINTAINER = "u_01k6aaaaaaaaaaaaaaaaaaaaad";
const NOW = Date.UTC(2026, 9, 5, 12, 30);

const relay = (over: Partial<RelayStatus> = {}): RelayStatus => ({
	stream: "forge",
	state: "ok",
	epoch: "01k6eeeeeeeeeeeeeeeeeeeeee",
	head: 10,
	relayedSeq: 10,
	lag: 0,
	oldestUnrelayedAt: null,
	attempts: 0,
	nextAt: null,
	lastError: null,
	lastOkAt: NOW - 1000,
	sentRecords: 10,
	sentBytes: 12_000,
	unknownOutcomes: 0,
	...over,
});

const consumerStatus = (over: Partial<BusStatus> = {}): BusStatus => ({
	group: "workloads",
	worker: 0,
	consume: "ok",
	subscription: "workloads-01k6ffffffffffffffffffffff",
	lastPollOkAt: NOW - 2000,
	lastRecordAt: NOW - 3000,
	consumerLagMs: 900,
	records: 42,
	retry: 1,
	dead: 1,
	resubscribed: 0,
	lastError: null,
	via: [
		{ hour: Date.UTC(2026, 9, 5, 12), k2: 9, backstop: 1, local: 0 },
		{ hour: Date.UTC(2026, 9, 5, 11), k2: 3, backstop: 0, local: 2 },
		{ hour: Date.UTC(2026, 9, 5, 9), k2: 100, backstop: 0, local: 0 },
	],
	relayLags: [],
	relayLagsAt: null,
	...over,
});

const fakeBus = (status: BusStatus) => {
	const dead: DeadRecordDto[] = [{
		id: "01k6dddddddddddddddddddddd",
		type: "run.started",
		error: "poison: unknown-run",
		at: NOW,
	}];
	const calls: string[] = [];
	const bus: BusFacade = {
		nudge: () => Promise.resolve(),
		wake: () => {
			calls.push("wake");
			return Promise.resolve(status);
		},
		status: () => Promise.resolve(status),
		deadList: () => Promise.resolve({ dead }),
		deadRetry: (id) => {
			calls.push(`retry:${id}`);
			return Promise.resolve(dead.some((d) => d.id === id));
		},
		deadDiscard: (id) => {
			calls.push(`discard:${id}`);
			return Promise.resolve(dead.some((d) => d.id === id));
		},
		recordRelayLags: (lags) => {
			calls.push(`lags:${lags.length}`);
			return Promise.resolve();
		},
	};
	return { bus, calls };
};

const ports = (
	over: Partial<LogPorts> = {},
	status = consumerStatus(),
) => {
	const fake = fakeBus(status);
	const audits: unknown[] = [];
	const p: LogPorts = {
		env: {
			TARTAN_STAGE: "dev-wp26",
			EVENT_LOG: { send: () => Promise.resolve({ success: true }) },
			TARTAN_K2_STREAM: "0123456789abcdef0123456789abcdef",
			TARTAN_K2_TOKEN: { get: () => Promise.resolve("secret-token-value") },
		},
		maximum: "local",
		now: () => NOW,
		consumer: () => fake.bus,
		forgeRelay: () => Promise.resolve(relay()),
		isOwner: (principal) => Promise.resolve(principal === OWNER),
		audit: (entry) => {
			audits.push(entry);
			return Promise.resolve();
		},
		...over,
	};
	return { p, audits, calls: fake.calls };
};

/** The Owner's session (the claim makes the Owner an admin). */
const OWNER_SESSION = authOf(OWNER, { isAdmin: true });

const call = async (
	p: LogPorts,
	method: string,
	rest: string,
	auth = OWNER_SESSION,
) => {
	const res = await logHandler(
		routeContext(method, `/-/api/log/${rest}`, { auth, rest }),
		p,
	).catch((error) => error);
	return res;
};

Deno.test("log routes: a Maintainer and an agent get 403, anonymous 401, the Owner 200", async () => {
	const { p } = ports();
	const denied = await call(p, "GET", "status", authOf(MAINTAINER));
	equal(denied.code, "denied");
	const agent = await call(
		p,
		"GET",
		"status",
		authOf("a_01k6aaaaaaaaaaaaaaaaaaaaac", { kind: "agent" }),
	);
	equal(agent.code, "denied");
	const anonymous = await logHandler(
		routeContext("GET", "/-/api/log/status", { auth: null, rest: "status" }),
		p,
	).catch((e) => e);
	equal(anonymous.code, "unauthenticated");
	for (const rest of ["status", "dead"]) {
		const res = await call(p, "GET", rest) as Response;
		equal(res.status, 200, rest);
	}
	const deniedDead = await call(p, "GET", "dead", authOf(MAINTAINER));
	equal(deniedDead.code, "denied");
});

Deno.test("log routes: a bounded token of the Owner is refused; an unbounded admin token is not", async () => {
	const { p } = ports();
	const pat = (extra: Partial<Parameters<typeof authOf>[1]>) =>
		authOf(OWNER, { via: "pat", tokenId: "tok_1", ...extra });
	// A CI PAT: api scope, one subtree, Reporter.
	const ci = pat({
		scopes: ["api"],
		nodeId: "01k6nnnnnnnnnnnnnnnnnnnnnn",
		maxRole: 20,
	});
	for (
		const [method, rest] of [
			["GET", "status"],
			["GET", "dead"],
			["POST", "dead/01k6dddddddddddddddddddddd/discard"],
			["POST", "dead/01k6dddddddddddddddddddddd/retry"],
		] as const
	) {
		equal(
			(await call(p, method, rest, ci)).code,
			"denied",
			`${method} ${rest}`,
		);
	}
	// The admin scope alone is not enough while the token is bounded.
	const bounded = pat({
		scopes: ["api", "admin"],
		isAdmin: true,
		nodeId: "01k6nnnnnnnnnnnnnnnnnnnnnn",
	});
	equal((await call(p, "GET", "status", bounded)).code, "denied");
	const lowRole = pat({ scopes: ["api", "admin"], isAdmin: true, maxRole: 40 });
	equal((await call(p, "GET", "status", lowRole)).code, "denied");
	const noAdmin = pat({ scopes: ["api"] });
	equal((await call(p, "GET", "status", noAdmin)).code, "denied");
	const full = pat({ scopes: ["api", "admin"], isAdmin: true });
	equal(((await call(p, "GET", "status", full)) as Response).status, 200);
});

Deno.test("log status: ids, counts, states and codes only, with the via share of the last hour", async () => {
	const { p } = ports();
	const res = await call(p, "GET", "status") as Response;
	const body = await res.json() as LogStatusResponse;
	equal(body.label, "K2 (public beta)");
	equal(body.health, "ok");
	equal(body.transport, "local");
	deepEqual(body.stream, { configured: true, name: "tartan_dev_wp26_log" });
	deepEqual(body.lastHour, { k2: 12, backstop: 1, local: 2 });
	equal(body.relay.forge?.state, "ok");
	equal(body.consumer?.dead, 1);
	const text = JSON.stringify(body);
	ok(!text.includes("secret-token-value"));
	ok(!text.toLowerCase().includes("bearer"));
	equal(res.headers.get("cache-control"), "no-store");
});

Deno.test("dead letters: list, retry and discard (audited); unknown ids are 404", async () => {
	const { p, audits, calls } = ports();
	const list = await (await call(p, "GET", "dead") as Response)
		.json() as LogDeadListResponse;
	equal(list.dead.length, 1);
	deepEqual(Object.keys(list.dead[0]).sort(), ["at", "error", "id", "type"]);
	const id = list.dead[0].id;
	equal((await call(p, "POST", `dead/${id}/retry`) as Response).status, 204);
	equal((await call(p, "POST", `dead/${id}/discard`) as Response).status, 204);
	deepEqual(audits, [
		{ principal: OWNER, action: "log.dead.retry", target: id },
		{ principal: OWNER, action: "log.dead.discard", target: id },
	]);
	deepEqual(calls, [`retry:${id}`, `discard:${id}`]);
	equal((await call(p, "POST", "dead/nope/retry")).code, "not_found");
	equal((await call(p, "POST", "dead/a%20b/retry")).code, "invalid");
	const badLimit = await logHandler(
		routeContext("GET", "/-/api/log/dead?limit=0", {
			auth: OWNER_SESSION,
			rest: "dead",
		}),
		p,
	).catch((e) => e);
	equal(badLimit.code, "invalid");
	equal((await call(p, "GET", "nothing")).code, "not_found");
	equal(audits.length, 2);
});

Deno.test("k2 health: off, produce-only, degraded, blocked, ok", async () => {
	const base = { producer: true, stream: true, token: true, now: NOW };
	equal(
		k2Health({ ...base, producer: false, relay: null, consumer: null }),
		"off",
	);
	equal(
		k2Health({ ...base, stream: false, relay: null, consumer: null }),
		"off",
	);
	equal(
		k2Health({ ...base, token: false, relay: relay(), consumer: null }),
		"produce-only",
	);
	equal(
		k2Health({
			...base,
			token: false,
			relay: relay({ state: "backoff" }),
			consumer: null,
		}),
		"degraded",
	);
	equal(
		k2Health({
			...base,
			relay: relay({ state: "blocked" }),
			consumer: consumerStatus(),
		}),
		"blocked",
	);
	equal(
		k2Health({
			...base,
			relay: relay(),
			consumer: consumerStatus({ consume: "error" }),
		}),
		"blocked",
	);
	equal(
		k2Health({
			...base,
			relay: relay(),
			consumer: consumerStatus({ lastPollOkAt: NOW - 60_000 }),
		}),
		"degraded",
	);
	equal(
		k2Health({ ...base, relay: relay(), consumer: consumerStatus() }),
		"ok",
	);
	// Through the ports: an RPC that fails or hangs degrades, never throws.
	const { p } = ports({ forgeRelay: () => Promise.reject(new Error("down")) });
	equal(await readK2Health(p), "degraded");
	const { p: off } = ports({ env: { TARTAN_STAGE: "x" } });
	equal(await readK2Health(off), "off");
	const status = await readLogStatus(off);
	equal(status.stream.configured, false);
	equal(status.relay.forge, null);
});

Deno.test("bus cron: wakes the consumer, kicks lagging relays and records the worst lags", async () => {
	const fake = fakeBus(consumerStatus());
	const kicks: string[] = [];
	const relayOf = (id: string, lag: number) => ({
		status: () =>
			Promise.resolve(
				relay({ stream: `repo:${id}`, lag, state: lag < 0 ? "off" : "ok" }),
			),
		kick: () => {
			kicks.push(id);
			return Promise.resolve(relay({ stream: `repo:${id}`, lag: 0 }));
		},
	});
	const lags: Record<string, number> = { a: 0, b: 5, c: -1 };
	const result = await runBusCron({
		relaysOn: true,
		consumers: () => [{ name: "bus:workloads:0", bus: fake.bus }],
		forgeRelay: () => relayOf("forge", 2),
		repoRelay: (id) => relayOf(id, lags[id]),
		listRepos: ({ cursor }) =>
			Promise.resolve(
				cursor === undefined
					? { repos: [{ id: "a" }, { id: "b" }], cursor: "next" }
					: { repos: [{ id: "c" }] },
			),
	});
	deepEqual(result, { woken: 1, repos: 3, kicked: 2, failures: [] });
	deepEqual(kicks, ["forge", "b"]);
	deepEqual(fake.calls, ["wake", "lags:3"]);
	const quiet = await runBusCron({
		relaysOn: false,
		consumers: () => [{ name: "bus:workloads:0", bus: fake.bus }],
		forgeRelay: () => {
			throw new Error("not called");
		},
		repoRelay: () => {
			throw new Error("not called");
		},
		listRepos: () => Promise.reject(new Error("not called")),
	});
	deepEqual(quiet, { woken: 1, repos: 0, kicked: 0, failures: [] });
});

Deno.test("bus cron closes every DO call context it opens, also when calls fail", async () => {
	const disposed: string[] = [];
	const fake = fakeBus(consumerStatus());
	const relayOf = (id: string, fail: boolean) => ({
		status: () =>
			fail
				? Promise.reject(new Error("busy"))
				: Promise.resolve(relay({ stream: `repo:${id}`, lag: 1 })),
		kick: () => Promise.resolve(relay({ stream: `repo:${id}`, lag: 0 })),
		[Symbol.dispose]: () => disposed.push(id),
	});
	const result = await runBusCron({
		relaysOn: true,
		consumers: () => [{
			name: "bus:workloads:0",
			bus: { ...fake.bus, [Symbol.dispose]: () => disposed.push("bus") },
		}],
		forgeRelay: () => relayOf("forge", false),
		repoRelay: (id) => relayOf(id, id === "b"),
		listRepos: () => Promise.resolve({ repos: [{ id: "a" }, { id: "b" }] }),
	});
	equal(result.failures.length, 1);
	deepEqual(disposed.sort(), ["a", "b", "bus", "forge"]);
});

Deno.test("health and log status close the consumer's and ForgeDO's call contexts", async () => {
	const disposed: string[] = [];
	const fake = fakeBus(consumerStatus());
	const { p } = ports({
		consumer: () =>
			({
				...fake.bus,
				[Symbol.dispose]: () => disposed.push("consumer"),
			}) as BusFacade,
	});
	await readK2Health(p);
	await readLogStatus(p);
	deepEqual(disposed, ["consumer", "consumer"]);
	// The production ForgeDO relay port disposes its stub too.
	const env = {
		FORGE: {
			getByName: () => ({
				bus: () => ({
					status: () => Promise.resolve(relay()),
					[Symbol.dispose]: () => disposed.push("forge"),
				}),
			}),
		},
	} as unknown as Env;
	await envStatusPorts(env).forgeRelay();
	deepEqual(disposed, ["consumer", "consumer", "forge"]);
});
