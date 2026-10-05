// The lane smoke Worker's capability route, locally against FakeArtifacts:
// Artifacts' importer (the fake's `import()`) pulls through the route, which
// proxies to the fake trunk remote. docs/SMOKE.md lists the live runs.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	commitChanges,
	concat,
	createFakeArtifacts,
	fetchPack,
	flushPkt,
	pkt,
} from "@tartan/testkit";
import { createLanesApp, createMemoryCapStore, PREFIX } from "./src/app.ts";

const SMOKE_KEY = "smoke-key-for-tests";
const TRUNK = `${PREFIX}-trunk`;

const setup = async (
	options: { defaultBranch?: string; pinBase?: boolean } = {},
) => {
	const store = createMemoryCapStore();
	// The importer pulls through the route, which proxies to the trunk remote.
	const appRef: { current?: ReturnType<typeof createLanesApp> } = {};
	const fake = createFakeArtifacts({
		namespace: "tartan-smoke-lanes",
		fetch: (r) => appRef.current!.fetch(r),
	});
	const app = appRef.current = createLanesApp({
		artifacts: fake,
		capKey: "test-capability-key",
		smokeKey: SMOKE_KEY,
		store,
		upstreamFetch: fake.fetch,
		pinBase: options.pinBase,
		backstopMs: 0,
	});
	const seeded = await fake.seed(TRUNK, {
		files: { "README.md": "# trunk\n", "src/a.txt": "a\n" },
		defaultBranch: options.defaultBranch,
		alsoRefs: ["refs/heads/feat-a", "refs/tartan/attic/x"],
	});
	const api = async (path: string, body: unknown) => {
		const res = await app.fetch(
			new Request(`https://lanes.example${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${SMOKE_KEY}` },
				body: JSON.stringify(body),
			}),
		);
		return await res.json();
	};
	const mint = (body: Record<string, unknown> = {}) =>
		api("/api/cap", { repo: TRUNK, ...body }) as Promise<{
			url: string;
			nonce: string;
			laneId: string;
			repoId: string;
			exp: number;
			mac: string;
			base: string;
		}>;
	const importLane = (url: string, name: string) =>
		fake.import({ source: { url, branch: "main" }, target: { name } });
	return { fake, app, store, seeded, api, mint, importLane };
};

const activeRouteTokens = async (
	fake: ReturnType<typeof createFakeArtifacts>,
) => {
	const repo = await fake.get(TRUNK);
	const { tokens } = await repo.listTokens();
	return tokens.filter((t) => t.scope === "read" && t.state === "active");
};

Deno.test("U59/import: a lane repo ends with exactly refs/heads/main at the base", async () => {
	for (const defaultBranch of ["main", "master"]) {
		const { fake, app, seeded, mint, importLane } = await setup({
			defaultBranch,
		});
		const cap = await mint();
		equal(cap.base, seeded.head);
		const lane = `${PREFIX}-l-${defaultBranch}`;
		const result = await importLane(cap.url, lane);
		equal(result.defaultBranch, "main");
		deepStrictEqual(fake.inspect.refs(lane), {
			"refs/heads/main": seeded.head,
		});
		deepStrictEqual(
			app.logs.map((l) => [l.op, l.status, l.outcome]),
			[
				["info/refs", 200, "advertised"],
				["git-upload-pack", 200, "served"],
			],
			defaultBranch,
		);
		equal(app.logs[1].tokenRevoked, true);
		deepStrictEqual(
			await activeRouteTokens(fake),
			[],
			"no live read token left",
		);
		equal(app.logs[0].userAgent, "artifacts/1.0");
	}
});

Deno.test("the pack request is single-use; replays and closed nonces are 404", async () => {
	const { app, mint, importLane, api } = await setup();
	const cap = await mint();
	await importLane(cap.url, `${PREFIX}-l-1`);
	const again = await importLane(cap.url, `${PREFIX}-l-2`).then(
		() => "imported",
		(e: { code?: string }) => e.code,
	);
	equal(again, "NOT_FOUND");
	const other = await mint();
	await api("/api/cap/close", { nonce: other.nonce });
	const closed = await app.fetch(
		new Request(`${other.url}/info/refs?service=git-upload-pack`),
	);
	equal(closed.status, 404);
});

Deno.test("forged capabilities are 404 before any state call (spy)", async () => {
	const { app, store, mint } = await setup();
	const cap = await mint();
	const before = store.stateCalls;
	const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
	const u = new URL(cap.url);
	const variants = [
		cap.url.replace(cap.mac, flip(cap.mac)),
		cap.url.replace(`/${cap.exp}/`, `/${cap.exp + 1}/`),
		cap.url.replace(cap.laneId, "ln_01k6zzzzzzzzzzzzzzzzzzzzzz"),
		cap.url.replace(cap.repoId, "01k6zzzzzzzzzzzzzzzzzzzzzz"),
		cap.url.replace(cap.nonce, "0".repeat(32)),
		cap.url.replace(`/${cap.exp}/`, "/1000000000/"),
		`${u.origin}/-/cap/v1/x/y.git`,
	];
	for (const v of variants) {
		const res = await app.fetch(
			new Request(`${v}/info/refs?service=git-upload-pack`),
		);
		equal(res.status, 404, v.replace(/[0-9a-f]{32,}/g, "…"));
		equal(await res.text(), "not found\n", "no detail");
	}
	for (const path of ["/info/refs?service=git-receive-pack", "/HEAD"]) {
		const res = await app.fetch(new Request(`${cap.url}${path}`));
		equal(res.status, 404, path);
	}
	const receive = await app.fetch(
		new Request(`${cap.url}/git-receive-pack`, {
			method: "POST",
			body: "0000",
		}),
	);
	equal(receive.status, 404);
	equal(
		store.stateCalls,
		before,
		"no forged or non-upload-pack request reached capability state",
	);
});

Deno.test("the single-want parser refuses everything but one want of the base", async () => {
	const { app, mint, seeded, fake } = await setup();
	const store = fake.inspect.store(TRUNK);
	const other = commitChanges(store, seeded.head, { "b.txt": "b\n" }, {
		message: "other",
	});
	const bodies: [string, Uint8Array][] = [
		[
			"two wants",
			concat([
				pkt(`want ${seeded.head}\n`),
				pkt(`want ${other}\n`),
				flushPkt(),
				pkt("done\n"),
			]),
		],
		[
			"have",
			concat([
				pkt(`want ${seeded.head}\n`),
				flushPkt(),
				pkt(`have ${other}\n`),
				pkt("done\n"),
			]),
		],
		[
			"deepen",
			concat([
				pkt(`want ${seeded.head}\n`),
				pkt("deepen 1\n"),
				flushPkt(),
				pkt("done\n"),
			]),
		],
		[
			"not the base",
			concat([pkt(`want ${other}\n`), flushPkt(), pkt("done\n")]),
		],
		["no done", concat([pkt(`want ${seeded.head}\n`), flushPkt()])],
	];
	for (const [label, body] of bodies) {
		const cap = await mint();
		const res = await app.fetch(
			new Request(`${cap.url}/git-upload-pack`, {
				method: "POST",
				body: body.slice(),
			}),
		);
		equal(res.status, 400, label);
		const replay = await app.fetch(
			new Request(`${cap.url}/git-upload-pack`, {
				method: "POST",
				body: concat([pkt(`want ${seeded.head}\n`), flushPkt(), pkt("done\n")]),
			}),
		);
		equal(
			replay.status,
			404,
			`${label}: the refused request consumed the nonce`,
		);
	}
	const v2 = await mint();
	const wantRef = await app.fetch(
		new Request(`${v2.url}/git-upload-pack`, {
			method: "POST",
			headers: { "git-protocol": "version=2" },
			body: concat([
				pkt("command=fetch\n"),
				pkt("object-format=sha1\n"),
				new TextEncoder().encode("0001"),
				pkt("want-ref refs/heads/main\n"),
				pkt("done\n"),
				flushPkt(),
			]),
		}),
	);
	equal(wantRef.status, 400);
});

Deno.test("info uses are capped at 3; v2 ls-refs is synthesized", async () => {
	const { app, mint, seeded } = await setup();
	const cap = await mint();
	const lsRefs = await app.fetch(
		new Request(`${cap.url}/git-upload-pack`, {
			method: "POST",
			headers: { "git-protocol": "version=2" },
			body: concat([
				pkt("command=ls-refs\n"),
				pkt("object-format=sha1\n"),
				new TextEncoder().encode("0001"),
				pkt("symrefs\n"),
				flushPkt(),
			]),
		}),
	);
	const text = await lsRefs.text();
	ok(text.includes(`${seeded.head} HEAD symref-target:refs/heads/main`));
	ok(text.includes(`${seeded.head} refs/heads/main`));
	ok(!text.includes("feat-a") && !text.includes("attic"), "no upstream refs");
	const statuses = [];
	for (let i = 0; i < 3; i++) {
		statuses.push(
			(await app.fetch(
				new Request(`${cap.url}/info/refs?service=git-upload-pack`),
			))
				.status,
		);
	}
	deepStrictEqual(statuses, [200, 200, 404]);
});

Deno.test("U55: trunk moved after minting → 503, or the pinned base is served", async () => {
	for (const pinBase of [false, true]) {
		const { fake, mint, importLane, seeded, app } = await setup({ pinBase });
		const cap = await mint();
		fake.commit(TRUNK, "refs/heads/main", { "moved.txt": "m\n" }, {
			message: "trunk moved",
		});
		const outcome = await importLane(cap.url, `${PREFIX}-l-moved`).then(
			(r) => r.defaultBranch,
			(e: { code?: string }) => e.code,
		);
		if (pinBase) {
			equal(outcome, "main");
			equal(
				fake.inspect.refs(`${PREFIX}-l-moved`)["refs/heads/main"],
				seeded.head,
			);
			equal(app.logs[0].outcome, "advertised-pinned-base");
		} else {
			equal(outcome, "UPSTREAM_UNAVAILABLE");
			equal(app.logs[0].outcome, "trunk-moved");
		}
	}
});

Deno.test("an aborted pack response still revokes its read token", async () => {
	const { app, mint, seeded, fake } = await setup();
	const cap = await mint();
	await app.fetch(new Request(`${cap.url}/info/refs?service=git-upload-pack`));
	const res = await app.fetch(
		new Request(`${cap.url}/git-upload-pack`, {
			method: "POST",
			body: concat([pkt(`want ${seeded.head}\n`), flushPkt(), pkt("done\n")]),
		}),
	);
	await res.body!.cancel();
	await new Promise((r) => setTimeout(r, 10));
	ok(app.logs.some((l) => l.outcome === "aborted" && l.tokenRevoked === true));
	deepStrictEqual(await activeRouteTokens(fake), []);
});

Deno.test("failure buckets throttle forged traffic but never a verified MAC", async () => {
	const { app, mint, seeded } = await setup();
	const statuses: number[] = [];
	for (let i = 0; i < 25; i++) {
		const res = await app.fetch(
			new Request(
				`https://lanes.example/-/cap/v1/x/${i}.git/info/refs?service=git-upload-pack`,
				{ headers: { "cf-connecting-ip": "203.0.113.9" } },
			),
		);
		statuses.push(res.status);
	}
	equal(statuses.filter((s) => s === 404).length, 20);
	equal(statuses.filter((s) => s === 429).length, 5);
	const cap = await mint();
	const real = await app.fetch(
		new Request(`${cap.url}/info/refs?service=git-upload-pack`, {
			headers: { "cf-connecting-ip": "203.0.113.9" },
		}),
	);
	equal(real.status, 200);
	const pack = await fetchPack(app.fetch, cap.url, [seeded.head!], {
		caps: ["side-band-64k"],
	});
	ok(pack.objects.has(seeded.head!), "side-band responses pass untouched");
});
