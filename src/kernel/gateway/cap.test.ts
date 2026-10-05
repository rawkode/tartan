// The capability route (`repo` backend, locally, against WP22's parser and
// FakeArtifacts' `import()`):
//
// - FakeArtifacts' importer seeds a lane repo through the route: exactly
//   `HEAD` → `refs/heads/main` at the base, also from a `master` repo; the
//   served pack size reaches `capReport`;
// - a DO spy: 10,000 forged URLs with a fresh `exp` and random or real repo
//   ids make zero RepoDO calls, the failure buckets answer 429 past their
//   limits, and a genuine capability in the middle of the flood is served;
// - every negative case answers 404 (or refuses) without an upstream call;
// - the trunk-moved rule (503 + `capReport`, unless kernel-explained with
//   `pinBase`), the per-request read token revoked after a completed
//   response, a client abort and an upstream error; the trailer strip only
//   for v0 without side-band; no capability path in any log line.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { laneId as laneIdOf, ulid } from "@tartan/contract";
import { importerRequestBody } from "@tartan/testkit";
import { IMPORTER_USER_AGENT } from "./cap.ts";
import { randomNonce, signedCapPath } from "./testing/capstate.ts";
import {
	CAP_NOW,
	CAP_NOW_S,
	CAP_ORIGIN,
	capGet,
	capLaneName,
	capPost,
	capWorld,
	importLane,
	LANE_MAIN,
} from "./testing/capworld.ts";

const ORIGIN = CAP_ORIGIN;
const NOW_S = CAP_NOW_S;
const MAIN = LANE_MAIN;
const get = capGet;
const post = capPost;
const decoder = new TextDecoder();
void CAP_NOW;

const refsOf = (text: string): string[] =>
	[...text.matchAll(/([0-9a-f]{40}) ([^\0\n ]+)/g)].map((m) =>
		`${m[1]} ${m[2]}`
	);

// ---------------------------------------------------------------------------
// The importer through the route
// ---------------------------------------------------------------------------

for (const defaultBranch of ["main", "master"]) {
	Deno.test(`capability route: FakeArtifacts' import() seeds a lane repo with exactly HEAD → refs/heads/main at the base (canonical default ${defaultBranch})`, async () => {
		const world = await capWorld({ defaultBranch });
		const { lane, url } = await world.lane();
		const result = await importLane(world, url, lane);
		ok(result.remote.includes(capLaneName(world, lane)));
		await world.settle();
		deepStrictEqual(world.fake.inspect.refs(capLaneName(world, lane)), {
			[MAIN]: world.trunk,
		});
		equal(
			world.fake.inspect.repo(capLaneName(world, lane))?.defaultBranch,
			"main",
		);
		// The importer made one GET and one POST, with its own user agent.
		const requests = world.fake.inspect.importRequests();
		deepStrictEqual(requests.map((r) => r.method), ["GET", "POST"]);
		ok(requests.every((r) => r.status === 200));
		// One info use, one consumed pack request, a served report with the size.
		equal(lane.infoUses, 1);
		equal(lane.consumed, true);
		const served = world.state.reports.find((r) =>
			r.report.outcome === "served"
		);
		ok(served !== undefined);
		equal(served.report.op, "pack");
		ok((served.report.bytes ?? 0) > 100, `bytes ${served.report.bytes}`);
		// A read token per proxied request, each revoked.
		deepStrictEqual(world.tokenOps(), { create: 2, revoke: 2 });
		// No Tartan log line carries the capability path or its secrets.
		const text = JSON.stringify(world.logs);
		ok(!text.includes("/-/cap/v1/"));
		ok(!text.includes(lane.nonce as string));
	});
}

Deno.test("capability route: the advertisement lists only HEAD → refs/heads/main at the base, with allowlisted capabilities", async () => {
	const world = await capWorld({ defaultBranch: "master" });
	const { url } = await world.lane();
	const res = await get(world, url, { "user-agent": IMPORTER_USER_AGENT });
	equal(res.status, 200);
	equal(
		res.headers.get("content-type"),
		"application/x-git-upload-pack-advertisement",
	);
	const text = decoder.decode(await res.arrayBuffer());
	deepStrictEqual(refsOf(text), [
		`${world.trunk} HEAD`,
		`${world.trunk} ${MAIN}`,
	]);
	ok(text.includes("symref=HEAD:refs/heads/main"));
	for (
		const stripped of ["allow-tip-sha1-in-want", "shallow", "feature", "v1"]
	) {
		ok(!text.includes(stripped), stripped);
	}
});

Deno.test("capability route: protocol v2 (ls-refs counts as an info use, the fetch pack is not stripped)", async () => {
	const world = await capWorld();
	const { lane, url } = await world.lane();
	const v2 = { "git-protocol": "version=2" };
	const caps = await get(world, url, v2);
	equal(caps.status, 200);
	ok(decoder.decode(await caps.arrayBuffer()).startsWith("000eversion 2\n"));
	const lsRefs = await post(
		world,
		url,
		"0014command=ls-refs\n0016object-format=sha10001000csymrefs\n0014ref-prefix HEAD\n001bref-prefix refs/heads/\n0000",
		v2,
	);
	const listed = decoder.decode(await lsRefs.arrayBuffer());
	equal(
		listed,
		`0050${world.trunk} HEAD symref-target:refs/heads/main\n003d${world.trunk} refs/heads/main\n0000`,
	);
	equal(lane.infoUses, 2);
	const want = `want ${world.trunk}\n`;
	const fetch = await post(
		world,
		url,
		`0011command=fetch0001000dofs-delta${
			(want.length + 4).toString(16).padStart(4, "0")
		}${want}0009done\n0000`,
		v2,
	);
	equal(fetch.status, 200);
	const body = decoder.decode(await fetch.arrayBuffer());
	ok(body.startsWith("000dpackfile\n"), body.slice(0, 20));
	ok(body.endsWith("0000"), "v2 keeps its final flush");
	await world.settle();
	equal(lane.consumed, true);
	deepStrictEqual(world.tokenOps(), { create: 2, revoke: 2 });
});

// ---------------------------------------------------------------------------
// The DO spy and the failure buckets
// ---------------------------------------------------------------------------

Deno.test("capability route: 10,000 forged URLs make zero RepoDO calls; the buckets answer 429 past their limits; a genuine capability in the flood is served", async () => {
	const world = await capWorld();
	const { lane, url } = await world.lane();
	const real = new URL(url).pathname.split("/");
	let notFound = 0;
	let throttled = 0;
	let served = false;
	for (let i = 0; i < 10_000; i++) {
		if (i === 5_000) {
			// The genuine capability, mid-flood, from an address that is
			// already over its bucket.
			const res = await importLane(world, url, lane);
			ok(res.remote.length > 0);
			served = true;
		}
		const mac = [...crypto.getRandomValues(new Uint8Array(32))].map((b) =>
			b.toString(16).padStart(2, "0")
		).join("");
		const repoId = i % 2 === 0 ? world.repoId : ulid().toLowerCase();
		const laneId = i % 3 === 0 ? lane.laneId : laneIdOf(ulid());
		const nonce = i % 5 === 0 ? lane.nonce : randomNonce();
		const path = `/-/cap/v1/${
			real[4]
		}/${laneId}/${nonce}/${mac}/${repoId}.git/info/refs?service=git-upload-pack`;
		const res = await world.route(
			new Request(`${ORIGIN}${path}`, {
				headers: { "cf-connecting-ip": `198.51.100.${i % 50}` },
			}),
		);
		if (res.status === 404) notFound++;
		else if (res.status === 429) throttled++;
		else throw new Error(`unexpected ${res.status}`);
	}
	ok(served);
	await world.settle();
	// Zero RepoDO calls for forged traffic: only the genuine import's two.
	equal(world.state.repoPorts, 2);
	deepStrictEqual(
		world.state.calls.filter((c) => c.method === "capUse").map((c) => c.op),
		["info", "pack"],
	);
	// The isolate bucket allows 200 per minute; everything after is throttled.
	equal(notFound, 200);
	equal(throttled, 9_800);
	deepStrictEqual(world.fake.inspect.refs(capLaneName(world, lane)), {
		[MAIN]: world.trunk,
	});
	// Throttled failures leave no log line; logged ones never carry the path.
	ok(world.logs.length < 210, `${world.logs.length} log lines`);
	ok(!JSON.stringify(world.logs).includes("/-/cap/v1/"));
});

Deno.test("capability route: the per-IP bucket throttles one address past 20 failures per minute", async () => {
	const world = await capWorld();
	const forged = async (ip: string) =>
		(await world.route(
			new Request(`${ORIGIN}/-/cap/v1/garbage`, {
				headers: { "cf-connecting-ip": ip },
			}),
		)).status;
	for (let i = 0; i < 20; i++) equal(await forged("203.0.113.7"), 404);
	equal(await forged("203.0.113.7"), 429);
	equal(await forged("203.0.113.8"), 404, "another address is not throttled");
	equal(world.state.repoPorts, 0);
});

Deno.test("capability route: an unavailable MAC key is a 404 counted in the buckets (no log flood, no RepoDO call)", async () => {
	const world = await capWorld();
	const { url } = await world.lane();
	world.deps = {
		...world.deps,
		verifyMac: () => Promise.reject(new Error("the forge has no root key yet")),
	};
	const statuses: number[] = [];
	for (let i = 0; i < 25; i++) {
		const res = await get(world, url, { "cf-connecting-ip": "192.0.2.9" });
		statuses.push(res.status);
	}
	equal(statuses.filter((s) => s === 404).length, 20);
	equal(statuses.filter((s) => s === 429).length, 5);
	equal(world.logs.length, 20);
	equal(world.state.repoPorts, 0);
});

// ---------------------------------------------------------------------------
// Negative cases: 404 (or a refusal), nothing upstream
// ---------------------------------------------------------------------------

const flipHex = (hex: string): string =>
	`${hex[0] === "a" ? "b" : "a"}${hex.slice(1)}`;

Deno.test("capability route: every negative case answers 404 without an upstream call", async () => {
	const world = await capWorld();
	const { lane, url } = await world.lane();
	const path = new URL(url).pathname;
	const [, , , , exp, laneId, nonce, mac, repoGit] = path.split("/");
	const at = (p: string) => `${ORIGIN}${p}`;
	const other = await world.lane();
	const cases: [string, () => Promise<Response>][] = [
		["forged MAC", () => get(world, at(path.replace(mac, flipHex(mac))))],
		[
			"another lane id under a valid MAC",
			() => get(world, at(path.replace(laneId, other.lane.laneId))),
		],
		[
			"another repo id under a valid MAC",
			() =>
				get(world, at(path.replace(repoGit, `${ulid().toLowerCase()}.git`))),
		],
		[
			"a moved exp",
			() => get(world, at(path.replace(`/${exp}/`, `/${Number(exp) + 1}/`))),
		],
		[
			"an uppercase lane id",
			() => get(world, at(path.replace(laneId, laneId.toUpperCase()))),
		],
		["receive-pack advertisement", () =>
			world.route(
				new Request(`${url}/info/refs?service=git-receive-pack`),
			)],
		["receive-pack POST", () =>
			world.route(
				new Request(`${url}/git-receive-pack`, {
					method: "POST",
					body: "0000",
				}),
			)],
		["dumb HTTP info/refs", () => world.route(new Request(`${url}/info/refs`))],
		["dumb HTTP HEAD", () => world.route(new Request(`${url}/HEAD`))],
		[
			"dumb HTTP objects",
			() => world.route(new Request(`${url}/objects/info/packs`)),
		],
		["an extra query", () =>
			world.route(
				new Request(`${url}/info/refs?service=git-upload-pack&x=1`),
			)],
		["a non-prefixed name", () =>
			world.route(
				new Request(
					`${ORIGIN}/-/cap/${exp}/${mac}/r-${world.repoId}.git/info/refs`,
				),
			)],
	];
	for (const [name, run] of cases) {
		const res = await run();
		equal(res.status, 404, name);
		equal(await res.text(), "", `${name}: no body detail`);
	}
	equal(world.state.repoPorts, 0, "no RepoDO call before the MAC verifies");
	// TTL rules, with correctly signed paths.
	for (
		const [name, expiry] of [
			["expired", NOW_S - 1],
			["exactly now", NOW_S],
			["beyond the TTL", NOW_S + 120 + 6],
		] as const
	) {
		const signed = await signedCapPath(world.mac, lane, expiry);
		equal((await get(world, at(signed))).status, 404, name);
	}
	const edge = await signedCapPath(world.mac, lane, NOW_S + 125);
	equal((await get(world, at(edge))).status, 200, "TTL + 5 s skew is valid");
	equal(world.state.repoPorts, 1);
	deepStrictEqual(world.tokenOps(), { create: 1, revoke: 0 });
	await world.settle();
	deepStrictEqual(world.tokenOps(), { create: 1, revoke: 1 });
	void nonce;
});

Deno.test("capability route: capUse refusals (unknown nonce, replay after open, consumed nonce, a fourth info/refs) are 404s with no upstream call", async () => {
	const world = await capWorld();
	// Unknown nonce under a valid MAC (an older attempt's nonce).
	const { lane, url } = await world.lane();
	const stale = await signedCapPath(
		world.mac,
		{ ...lane, nonce: randomNonce() },
		NOW_S + 120,
	);
	equal((await get(world, `${ORIGIN}${stale}`)).status, 404);
	// Three info uses, then a fourth.
	for (let i = 0; i < 3; i++) {
		const res = await get(world, url);
		equal(res.status, 200);
		await res.body?.cancel();
	}
	equal((await get(world, url)).status, 404, "a fourth info/refs");
	// The single pack request, then a second one.
	const first = await post(world, url, importerRequestBody(world.trunk));
	equal(first.status, 200);
	await first.arrayBuffer();
	const second = await post(world, url, importerRequestBody(world.trunk));
	equal(second.status, 404, "the pack request is single-use");
	// Replay after the lane opened.
	const opened = await world.lane();
	opened.lane.state = "open";
	equal((await get(world, opened.url)).status, 404);
	equal(
		(await post(world, opened.url, importerRequestBody(world.trunk))).status,
		404,
	);
	await world.settle();
	// Tokens: three advertisements and one pack, all revoked; nothing else.
	deepStrictEqual(world.tokenOps(), { create: 4, revoke: 4 });
	const refusals = world.logs.filter((l) =>
		l.message.includes("capUse refused")
	).map((l) => l.data.reason);
	deepStrictEqual(refusals.sort(), [
		"consumed",
		"not-opening",
		"not-opening",
		"unknown",
		"uses-exceeded",
	]);
});

Deno.test("capability route: a second want, a have, a deepen or a filter is refused before capUse; nothing is forwarded", async () => {
	const world = await capWorld();
	const { lane, url } = await world.lane();
	const pkt = (s: string) =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const other = "1".repeat(40);
	const bodies = [
		`${pkt(`want ${world.trunk}\n`)}${pkt(`want ${other}\n`)}0000${
			pkt("done\n")
		}`,
		`${pkt(`want ${world.trunk}\n`)}0000${pkt(`have ${other}\n`)}${
			pkt("done\n")
		}`,
		`${pkt(`want ${world.trunk}\n`)}${pkt("deepen 1\n")}0000${pkt("done\n")}`,
		`${pkt(`want ${world.trunk}\n`)}${pkt("filter blob:none\n")}0000${
			pkt("done\n")
		}`,
		`${pkt(`want ${world.trunk} shallow\n`)}0000${pkt("done\n")}`,
	];
	for (const body of bodies) {
		const res = await post(world, url, body);
		equal(res.status, 200);
		ok(decoder.decode(await res.arrayBuffer()).includes("ERR unsupported"));
	}
	equal(world.state.repoPorts, 0);
	equal(lane.consumed, false);
	deepStrictEqual(world.tokenOps(), { create: 0, revoke: 0 });
	// A want other than the base consumes the nonce but reaches nothing.
	const wrong = await post(world, url, importerRequestBody(other));
	ok(
		decoder.decode(await wrong.arrayBuffer()).includes(
			"ERR want-not-advertised",
		),
	);
	equal(lane.consumed, true);
	deepStrictEqual(world.tokenOps(), { create: 0, revoke: 0 });
	equal(world.state.reports.at(-1)?.report.outcome, "aborted");
	// A body that decodes past 4 MiB, or an unknown encoding: 415.
	const bomb = await new Response(
		new Blob([new Uint8Array(8 * 1024 * 1024)]).stream().pipeThrough(
			new CompressionStream("gzip"),
		),
	).arrayBuffer();
	const fresh = await world.lane();
	equal(
		(await post(world, fresh.url, bomb, { "content-encoding": "gzip" })).status,
		415,
	);
	equal(
		(await post(world, fresh.url, "x", { "content-encoding": "br" })).status,
		415,
	);
});

// ---------------------------------------------------------------------------
// Trunk moved; tokens; trailer; client check
// ---------------------------------------------------------------------------

Deno.test("capability route: an upstream tip ahead of the base answers 503 with capReport(trunk-moved), unless kernel-explained with pinBase", async () => {
	const world = await capWorld();
	const { lane, url } = await world.lane();
	const moved = world.fake.commit(world.canonical, MAIN, {
		"README.md": "moved\n",
	}, { message: "advance" });
	const res = await get(world, url);
	equal(res.status, 503);
	const [report] = world.state.reports;
	deepStrictEqual(report.report, {
		op: "info",
		outcome: "trunk-moved",
		upstreamTip: moved,
	});
	equal(report.laneId, lane.laneId);
	// Explained but `pinBase` off: still 503.
	const explainedOff = await world.lane({ explainedTips: [moved] });
	equal((await get(world, explainedOff.url)).status, 503);
	// Pinned and explained: the base is served and imported.
	const pinned = await world.lane({ pinBase: true, explainedTips: [moved] });
	await importLane(world, pinned.url, pinned.lane);
	deepStrictEqual(world.fake.inspect.refs(capLaneName(world, pinned.lane)), {
		[MAIN]: world.trunk,
	});
	// Pinned but unexplained: 503.
	const unexplained = await world.lane({ pinBase: true });
	equal((await get(world, unexplained.url)).status, 503);
	await world.settle();
	const { create, revoke } = world.tokenOps();
	equal(create, revoke, "every read token revoked");
});

Deno.test("capability route: the read token is revoked after a completed response, after a client abort and after an upstream error", async () => {
	const world = await capWorld();
	// Completed.
	const done = await world.lane();
	await (await post(world, done.url, importerRequestBody(world.trunk)))
		.arrayBuffer();
	await world.settle();
	deepStrictEqual(world.tokenOps(), { create: 1, revoke: 1 });
	equal(world.state.reports.at(-1)?.report.outcome, "served");
	// Client abort: the body is cancelled before it is read.
	const aborted = await world.lane();
	const res = await post(world, aborted.url, importerRequestBody(world.trunk));
	equal(res.status, 200);
	await res.body?.cancel("client went away");
	await world.settle();
	deepStrictEqual(world.tokenOps(), { create: 2, revoke: 2 });
	equal(world.state.reports.at(-1)?.report.outcome, "aborted");
	// Upstream error.
	world.fake.faults.inject({
		op: "git.upload-pack",
		fault: { kind: "error", code: "INTERNAL_ERROR" },
		times: 1,
	});
	const failing = await world.lane();
	const failed = await post(
		world,
		failing.url,
		importerRequestBody(world.trunk),
	);
	ok(failed.status >= 500, `status ${failed.status}`);
	await world.settle();
	deepStrictEqual(world.tokenOps(), { create: 3, revoke: 3 });
	equal(world.state.reports.at(-1)?.report.outcome, "upstream-error");
});

Deno.test("capability route: the trailing-flush transform applies exactly to v0 without side-band", async () => {
	const world = await capWorld();
	// A test upstream that ends every pack response with one more flush.
	const upstreamFetch = world.deps.fetch;
	world.deps = {
		...world.deps,
		fetch: async (request) => {
			const res = await upstreamFetch(request);
			if (!request.url.endsWith("/git-upload-pack")) return res;
			const bytes = new Uint8Array(await res.arrayBuffer());
			const out = new Uint8Array(bytes.length + 4);
			out.set(bytes);
			out.set(new TextEncoder().encode("0000"), bytes.length);
			return new Response(out, { status: res.status, headers: res.headers });
		},
	};
	const upstream = async (body: Uint8Array) => {
		const handle = await world.fake.get(world.canonical);
		const token = await handle.createToken("read", 60);
		const res = await world.deps.fetch(
			new Request(`${world.fake.remote(world.canonical)}/git-upload-pack`, {
				method: "POST",
				headers: { authorization: `Bearer ${token.plaintext}` },
				body: body as Uint8Array<ArrayBuffer>,
			}),
		);
		return new Uint8Array(await res.arrayBuffer());
	};
	const plain = importerRequestBody(world.trunk);
	const direct = await upstream(plain);
	equal(decoder.decode(direct.subarray(direct.length - 4)), "0000");
	const viaRoute = new Uint8Array(
		await (await post(world, (await world.lane()).url, plain)).arrayBuffer(),
	);
	deepStrictEqual([...viaRoute], [...direct.subarray(0, direct.length - 4)]);
	const pkt = (s: string) =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const banded = new TextEncoder().encode(
		`${pkt(`want ${world.trunk} side-band-64k ofs-delta\n`)}0000${
			pkt("done\n")
		}`,
	);
	const directBanded = await upstream(banded);
	const viaRouteBanded = new Uint8Array(
		await (await post(world, (await world.lane()).url, banded)).arrayBuffer(),
	);
	deepStrictEqual([...viaRouteBanded], [...directBanded]);
});

Deno.test("capability route: LANE_CAP_CLIENT_CHECK admits only ASN 13335 with the importer's user agent, before any RepoDO call", async () => {
	const world = await capWorld({ clientCheck: true });
	const { lane, url } = await world.lane();
	const asn = (request: Request, value: number) =>
		Object.defineProperty(request, "cf", { value: { asn: value } });
	const plainGit = await world.route(
		asn(
			new Request(`${url}/info/refs?service=git-upload-pack`, {
				headers: { "user-agent": "git/2.55.0" },
			}),
			13335,
		),
	);
	equal(plainGit.status, 404);
	const otherAsn = await world.route(
		asn(
			new Request(`${url}/info/refs?service=git-upload-pack`, {
				headers: { "user-agent": IMPORTER_USER_AGENT },
			}),
			64512,
		),
	);
	equal(otherAsn.status, 404);
	equal(world.state.repoPorts, 0);
	const importer = await world.route(
		asn(
			new Request(`${url}/info/refs?service=git-upload-pack`, {
				headers: { "user-agent": IMPORTER_USER_AGENT },
			}),
			13335,
		),
	);
	equal(importer.status, 200);
	equal(lane.infoUses, 1);
});
