// The captures parse with the testkit codecs, show the facts they are kept
// for, and replay against a fresh FakeArtifacts with the same seed.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	createFakeArtifacts,
	IMPORTER_POST_BYTES,
	importerRequests,
	isPack,
	MONOREPO_FILES,
	parsePkts,
	parseReport,
	pktText,
	PUSH_EVENT_PAYLOADS,
	pushEvent,
	STOCK_GIT_CAPTURES,
	stockGitCapture,
	text,
} from "../src/index.ts";

const lines = (bytes: Uint8Array) =>
	parsePkts(bytes).pkts.map(pktText).filter((t): t is string => t !== null);

Deno.test("captures exist for every recorded command", () => {
	deepStrictEqual(STOCK_GIT_CAPTURES.map((c) => c.id), [
		"clone-v2",
		"clone-v0",
		"ls-remote-lanes-v2",
		"fetch-lane-v2",
		"push-update",
		"push-ref-only-create",
		"push-delete",
		"push-probe-chunked",
	]);
	for (const c of STOCK_GIT_CAPTURES) {
		for (const e of c.exchanges) {
			ok(!("authorization" in e.requestHeaders), c.id);
		}
	}
});

Deno.test("stock git's ref-prefix use (client side)", () => {
	const lsRemote = lines(
		stockGitCapture("ls-remote-lanes-v2").exchanges[1].request,
	);
	ok(lsRemote.includes("command=ls-refs"));
	deepStrictEqual(
		lsRemote.filter((l) => l.startsWith("ref-prefix")),
		[],
		"ls-remote with a glob sends no ref-prefix",
	);
	const fetch = lines(stockGitCapture("fetch-lane-v2").exchanges[1].request);
	ok(
		fetch.includes("ref-prefix refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa"),
	);
});

Deno.test("receive-pack captures: probe, empty pack, delete without pack", () => {
	const probe = stockGitCapture("push-probe-chunked").exchanges;
	equal(probe[1].requestHeaders["content-length"], "4");
	equal(text(probe[1].request), "0000");
	equal(probe[2].requestHeaders["transfer-encoding"], "chunked");
	const create = stockGitCapture("push-ref-only-create").exchanges[1].request;
	const packAt = parsePkts(create, 0, 1).offset;
	ok(isPack(create, packAt));
	equal(
		new DataView(create.buffer, create.byteOffset).getUint32(packAt + 8),
		0,
	);
	const del = stockGitCapture("push-delete").exchanges[1].request;
	equal(parsePkts(del, 0, 1).offset, del.length, "no pack after a delete");
	const report = parseReport(
		stockGitCapture("push-update").exchanges[1].response,
	);
	equal(report.unpack, "ok");
	equal(report.refs.get("refs/heads/main"), "ok");
});

Deno.test("the push captures replay against a fresh fake with the same seed", async () => {
	const fake = createFakeArtifacts({ namespace: "captures" });
	const seeded = await fake.seed("acme", {
		files: MONOREPO_FILES,
		alsoRefs: ["refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa"],
	});
	for (const id of ["push-update", "push-ref-only-create", "push-delete"]) {
		const e = stockGitCapture(id).exchanges[1];
		const res = await fake.fetch(
			new Request(`${fake.remote("acme")}${e.path}`, {
				method: "POST",
				headers: {
					...e.requestHeaders,
					authorization: `Bearer ${seeded.token}`,
				},
				body: e.request.slice(),
			}),
		);
		const report = parseReport(new Uint8Array(await res.arrayBuffer()));
		equal(report.unpack, "ok", id);
		ok([...report.refs.values()].every((v) => v === "ok"), id);
	}
});

/**
 * The capabilities an `info/refs` answer advertises: the v2 capability lines,
 * or the v0 list after the NUL of the first ref line.
 */
const advertisement = (body: Uint8Array): string[] => {
	const all = lines(body).map((l) => l.replace(/\n$/, "")).filter((l) =>
		!l.startsWith("# service=")
	);
	if (all[0] === "version 2") return all;
	const first = all[0] ?? "";
	const nul = first.indexOf("\0");
	return nul < 0 ? [] : first.slice(nul + 1).trim().split(" ");
};

Deno.test("every recorded advertisement is the fake's current one", async () => {
	const fake = createFakeArtifacts({ namespace: "captures" });
	const seeded = await fake.seed("acme", {
		files: MONOREPO_FILES,
		alsoRefs: ["refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa"],
	});
	let checked = 0;
	for (const c of STOCK_GIT_CAPTURES) {
		for (const e of c.exchanges) {
			if (e.method !== "GET" || !e.path.startsWith("/info/refs")) continue;
			const res = await fake.fetch(
				new Request(`${fake.remote("acme")}${e.path}`, {
					headers: {
						...e.requestHeaders,
						authorization: `Bearer ${seeded.token}`,
					},
				}),
			);
			const current = advertisement(new Uint8Array(await res.arrayBuffer()));
			ok(current.length > 0, `${c.id} ${e.path}`);
			deepStrictEqual(
				advertisement(e.response),
				current,
				`${c.id} ${e.path}: re-record with scripts/record-captures.ts`,
			);
			checked++;
		}
	}
	equal(checked, STOCK_GIT_CAPTURES.length);
	const v0 = advertisement(stockGitCapture("clone-v0").exchanges[0].response);
	ok(v0.includes("ofs-delta"));
	ok(v0.includes("symref=HEAD:refs/heads/main"));
});

Deno.test("push event payloads: the fake's events have the fixture's shape", async () => {
	const keys = (v: unknown): unknown =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
				Object.keys(v).sort().map((k) => [
					k,
					keys((v as Record<string, unknown>)[k]),
				]),
			)
			: Array.isArray(v)
			? (v.length > 0 ? [keys(v[0])] : [])
			: typeof v;
	const fixture =
		PUSH_EVENT_PAYLOADS.find((p) => p.label === "branch update, one commit")!
			.event;
	const fake = createFakeArtifacts();
	await fake.seed("x", { files: { "a.txt": "a\n" } });
	fake.commit("x", "refs/heads/main", { "b.txt": "b\n" }, { message: "b" });
	const ours = fake.pushEvents.at(-1)!;
	deepStrictEqual(keys(ours), keys(fixture));
	const capped = PUSH_EVENT_PAYLOADS.find((p) =>
		p.label.startsWith("60-commit")
	)!;
	equal(capped.event.payload.commits.length, 20);
	equal(capped.event.payload.totalCommitsCount, 21);
	void pushEvent;
});

Deno.test("the importer's request shape: a 73-byte POST for one SHA", async () => {
	const [get, post] = importerRequests(
		"https://forge.example/-/cap/v1/x.git",
		"6bb259a93a49ce2d9e6304b94e58329fb43af3cc",
	);
	equal(get.headers.get("user-agent"), "artifacts/1.0");
	equal(get.headers.get("git-protocol"), null);
	equal((await post.arrayBuffer()).byteLength, IMPORTER_POST_BYTES);
});
