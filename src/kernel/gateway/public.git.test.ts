// Anonymous and public-view reads through the gateway (the public-view cases):
// 401 first, hidden refs never advertised, the fail-closed upload-pack parser
// on the decoded body (identity and gzip), wants checked against the RepoDO
// index and the 10-minute window, and the capability allowlist for every
// caller.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { ulid } from "@tartan/contract";
import { encodePktLine, encodeSpecialPkt } from "@tartan/gitproto";
import { commitFile, revParse } from "./testing/git.ts";
import {
	agentWithLane,
	gitTest as test,
	laneRef,
	withWorld,
	type World,
} from "./testing/world.ts";

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const pkt = (line: string) => encodePktLine(`${line}\n`);
const FLUSH = encodeSpecialPkt("flush");
const DELIM = encodeSpecialPkt("delim");

/** A v2 request: `command=<c>`, capabilities, delim, arguments, flush. */
const v2Request = (command: string, args: readonly string[]) =>
	concat([
		pkt(`command=${command}`),
		pkt("agent=git/2.55.0"),
		pkt("object-format=sha1"),
		DELIM,
		...args.map(pkt),
		FLUSH,
	]);

/** A v0 fetch request: one want with capabilities, flush, done. */
const v0Request = (want: string) =>
	concat([
		pkt(`want ${want} side-band-64k ofs-delta agent=git/2.55.0`),
		FLUSH,
		pkt("done"),
	]);

const gzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Response(bytes).body!.pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);

const uploadPost = (
	w: World,
	body: Uint8Array,
	options: {
		readonly v2?: boolean;
		readonly gzip?: boolean;
		readonly token?: string;
	} = {},
) =>
	fetch(`${w.remote}/git-upload-pack`, {
		method: "POST",
		headers: {
			"content-type": "application/x-git-upload-pack-request",
			...(options.v2 ?? true ? { "git-protocol": "version=2" } : {}),
			...(options.gzip ? { "content-encoding": "gzip" } : {}),
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		body: body as Uint8Array<ArrayBuffer>,
	});

/** Fetch requests (v2 `command=fetch`, or a v0 want list) that reached upstream. */
const forwardedUploads = (w: World) =>
	w.backend.requests.filter((r) =>
		r.method === "POST" && r.path.endsWith("/git-upload-pack") &&
		!r.bodyHead.includes("command=ls-refs")
	).length;

/** A public repo with an agent lane holding a hidden commit. */
const publicWithHiddenLane = async (w: World) => {
	const { agent, laneId, dir } = await agentWithLane(w, "a");
	const hidden = await commitFile(w.sandbox, dir, "secret.txt", "s\n");
	await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
		cwd: dir,
	});
	await w.settle();
	w.node.visibility = "public";
	return { agent, laneId, hidden };
};

test("401 first: anonymous reads of a private repo are challenged and nothing reaches upstream", async () => {
	await withWorld(async (w) => {
		const out = await w.gitAs(null, [
			"clone",
			w.remote,
			`${w.sandbox.root}/anon`,
		], { allowFail: true });
		ok(out.code !== 0);
		equal(w.backend.requests.length, 0);
		for (
			const path of [
				"info/refs?service=git-upload-pack",
				"info/refs?service=git-receive-pack",
			]
		) {
			const res = await fetch(`${w.remote}/${path}`);
			equal(res.status, 401, path);
			match(res.headers.get("www-authenticate") ?? "", /^Basic realm=/);
			await res.body?.cancel();
		}
		// The receive-pack probe and an upload-pack POST without credentials.
		const probe = await fetch(`${w.remote}/git-receive-pack`, {
			method: "POST",
			headers: { "content-type": "application/x-git-receive-pack-request" },
			body: "0000",
		});
		equal(probe.status, 401);
		await probe.body?.cancel();
		const upload = await uploadPost(w, v2Request("ls-refs", []));
		equal(upload.status, 401);
		await upload.body?.cancel();
		equal(w.backend.requests.length, 0);
		// A missing repo looks the same to an anonymous caller.
		const missing = await fetch(
			`${w.gatewayUrl}/acme/nope.git/info/refs?service=git-upload-pack`,
		);
		equal(missing.status, 401);
		await missing.body?.cancel();
		// An authenticated caller without a role gets 404 (existence hidden).
		const stranger = w.principal("user", { role: 0 });
		const res = await fetch(`${w.remote}/info/refs?service=git-upload-pack`, {
			headers: { authorization: `Bearer ${stranger.token}` },
		});
		equal(res.status, 404);
		await res.body?.cancel();
	});
});

test("public repo: anonymous clones work in v0 and v2 and never see hidden refs", async () => {
	await withWorld(async (w) => {
		const { laneId } = await publicWithHiddenLane(w);
		for (const version of ["2", "0"]) {
			const v = ["-c", `protocol.version=${version}`];
			const target = `${w.sandbox.root}/anon-v${version}`;
			await w.gitAs(null, [...v, "clone", "-q", w.remote, target]);
			equal(await revParse(w.sandbox, target, "HEAD"), w.trunk);
			const refs = (await w.gitAs(null, [...v, "ls-remote", w.remote])).stdout;
			ok(!refs.includes("refs/heads/lanes/"), refs);
			ok(!refs.includes("refs/tartan/"), refs);
		}
		// An explicit refspec into the hidden namespace finds nothing.
		const out = await w.gitAs(null, [
			"fetch",
			"origin",
			`${laneRef(laneId)}:refs/remotes/x`,
		], { cwd: `${w.sandbox.root}/anon-v2`, allowFail: true });
		ok(out.code !== 0);
		// An anonymous push is challenged.
		const push = await w.gitAs(null, ["push", "origin", "HEAD:refs/heads/x"], {
			cwd: `${w.sandbox.root}/anon-v2`,
			allowFail: true,
		});
		ok(push.code !== 0);
	});
});

test("public repo: stock git cannot fetch a hidden SHA anonymously (v2: want-not-advertised; v0: refused)", async () => {
	await withWorld(async (w) => {
		const { hidden } = await publicWithHiddenLane(w);
		const anon = `${w.sandbox.root}/anon`;
		await w.gitAs(null, ["clone", "-q", w.remote, anon]);
		for (const version of ["2", "0"]) {
			const before = forwardedUploads(w);
			const out = await w.gitAs(null, [
				"-c",
				`protocol.version=${version}`,
				"fetch",
				"origin",
				hidden,
			], { cwd: anon, allowFail: true });
			ok(out.code !== 0, `v${version} fetched a hidden sha`);
			if (version === "2") match(out.stderr, /want-not-advertised/);
			equal(forwardedUploads(w), before, "forwarded");
		}
	});
});

test("public view, crafted requests: hidden wants (identity and gzip), want-ref, deepen-not, object-info are refused and nothing is forwarded", async () => {
	await withWorld(async (w) => {
		const { hidden } = await publicWithHiddenLane(w);
		const cases: [
			string,
			Uint8Array,
			{ v2?: boolean; gzip?: boolean },
			RegExp,
		][] = [
			[
				"v2 hidden want",
				v2Request("fetch", [`want ${hidden}`, "done"]),
				{},
				/ERR want-not-advertised/,
			],
			[
				"v2 hidden want, gzip",
				await gzip(v2Request("fetch", [`want ${hidden}`, "done"])),
				{ gzip: true },
				/ERR want-not-advertised/,
			],
			[
				"v0 hidden want",
				v0Request(hidden),
				{ v2: false },
				/ERR want-not-advertised/,
			],
			[
				"v0 hidden want, gzip",
				await gzip(v0Request(hidden)),
				{ v2: false, gzip: true },
				/ERR want-not-advertised/,
			],
			[
				"v2 want-ref",
				v2Request("fetch", [`want-ref ${laneRef("x")}`, "done"]),
				{},
				/ERR unsupported-argument/,
			],
			[
				"v2 deepen-not",
				v2Request("fetch", [
					`want ${w.trunk}`,
					"deepen-not refs/heads/x",
					"done",
				]),
				{},
				/ERR unsupported-argument/,
			],
			[
				"v2 object-info",
				v2Request("object-info", ["size", `oid ${hidden}`]),
				{},
				/ERR unsupported-command/,
			],
			[
				"v2 bundle-uri",
				v2Request("bundle-uri", []),
				{},
				/ERR unsupported-command/,
			],
		];
		const before = forwardedUploads(w);
		for (const [name, body, options, expected] of cases) {
			const res = await uploadPost(w, body, options);
			equal(res.status, 200, name);
			match(await res.text(), expected, name);
		}
		equal(forwardedUploads(w), before, "a refused request was forwarded");
		// A roleless authenticated caller gets exactly the same answers.
		const stranger = w.principal("user", { role: 0 });
		const res = await uploadPost(
			w,
			v2Request("fetch", [`want ${hidden}`, "done"]),
			{ token: stranger.token },
		);
		match(await res.text(), /ERR want-not-advertised/);
		// A member may fetch the hidden SHA (it reads every lane).
		const member = w.principal("user");
		const ok200 = await uploadPost(
			w,
			v2Request("fetch", [`want ${hidden}`, "done"]),
			{ token: member.token },
		);
		equal(ok200.status, 200);
		ok(!(await ok200.text()).includes("ERR "));
	});
});

test("public view: a body that decodes past 4 MiB or does not decode is 415, nothing forwarded", async () => {
	await withWorld(async (w) => {
		w.node.visibility = "public";
		const haves = Array.from(
			{ length: 90_000 },
			(_, i) => `have ${(i + 1).toString(16).padStart(40, "0")}`,
		);
		const big = await gzip(
			v2Request("fetch", [`want ${w.trunk}`, ...haves, "done"]),
		);
		ok(big.length < 4 * 1024 * 1024);
		const over = await uploadPost(w, big, { gzip: true });
		equal(over.status, 415);
		await over.body?.cancel();
		const garbage = await uploadPost(w, new Uint8Array([1, 2, 3, 4, 5]), {
			gzip: true,
		});
		equal(garbage.status, 415);
		await garbage.body?.cancel();
		equal(forwardedUploads(w), 0);
	});
});

test("public view: a want of the trunk tip of 5 minutes ago succeeds, 11 minutes ago fails; an Advance between ls-refs and fetch is fine", async () => {
	await withWorld(async (w) => {
		w.node.visibility = "public";
		const old = w.trunk;
		// ls-refs first, as a clone does.
		const ls = await uploadPost(
			w,
			v2Request("ls-refs", ["symrefs", "ref-prefix refs/heads/"]),
		);
		match(await ls.text(), new RegExp(`${old} refs/heads/main`));
		// An Advance lands: upstream trunk moves and the kernel records it.
		const next = await commitFile(w.sandbox, w.seed, "landed.txt", "l\n");
		await w.gitAs(null, ["push", "-q", w.bare, "main:refs/heads/main"], {
			cwd: w.seed,
		});
		await w.h.facade.recordPush({
			target: "repo",
			refs: [{ ref: "refs/heads/main", before: old, after: next }],
			principal: null,
			via: "kernel",
			requestId: ulid(),
		});
		const fetchOld = () =>
			uploadPost(w, v2Request("fetch", [`want ${old}`, "done"]));
		// The fetch of the advertised (now previous) tip still works.
		const now = await fetchOld();
		const pack = await now.text();
		ok(pack.includes("packfile") && !pack.includes("ERR "), "pack");
		w.h.clock.advance(5 * 60 * 1000);
		const five = await fetchOld();
		ok(!(await five.text()).includes("ERR "), "5 minutes");
		w.h.clock.advance(6 * 60 * 1000);
		const eleven = await fetchOld();
		match(await eleven.text(), /ERR want-not-advertised/);
		// The current tip is always fine.
		const current = await uploadPost(
			w,
			v2Request("fetch", [`want ${next}`, "done"]),
		);
		ok(!(await current.text()).includes("ERR "));
	});
});

test("public repo: a roleless authenticated caller gets exactly the anonymous advertisement", async () => {
	await withWorld(async (w) => {
		const { agent, laneId } = await publicWithHiddenLane(w);
		const stranger = w.principal("user", { role: 0 });
		const guest = w.principal("user", { role: 10 });
		const otherNode = w.principal("user", { nodeId: "group-other" });
		const read = async (headers: Record<string, string>) => {
			const res = await fetch(
				`${w.remote}/info/refs?service=git-upload-pack`,
				{ headers },
			);
			equal(res.status, 200);
			return new Uint8Array(await res.arrayBuffer());
		};
		const anonymous = await read({});
		for (const who of [stranger, guest, otherNode]) {
			deepStrictEqual(
				await read({ authorization: `Bearer ${who.token}` }),
				anonymous,
			);
		}
		ok(!new TextDecoder().decode(anonymous).includes("refs/heads/lanes/"));
		// The lane's owner (a member) sees its lane.
		const member = await read({ authorization: `Bearer ${agent.token}` });
		ok(new TextDecoder().decode(member).includes(laneRef(laneId)));
	});
});

test("upload-pack capability allowlist for every caller: allow-*-sha1-in-want, object-info, bundle-uri, server-option are stripped", async () => {
	await withWorld(async (w) => {
		w.node.visibility = "public";
		const member = w.principal("user");
		const callers: Record<string, string>[] = [
			{},
			{ authorization: `Bearer ${member.token}` },
		];
		for (const headers of callers) {
			const v0 = await (await fetch(
				`${w.remote}/info/refs?service=git-upload-pack`,
				{ headers },
			)).text();
			ok(v0.includes("side-band-64k"), v0);
			ok(!/allow-(tip|reachable|any)-sha1-in-want/.test(v0), v0);
			ok(!v0.includes(" filter"), v0);
			const v2 = await (await fetch(
				`${w.remote}/info/refs?service=git-upload-pack`,
				{ headers: { ...headers, "git-protocol": "version=2" } },
			)).text();
			ok(v2.includes("version 2"), v2);
			ok(v2.includes("ls-refs"), v2);
			for (
				const banned of [
					"object-info",
					"bundle-uri",
					"server-option",
					"packfile-uris",
					"session-id",
				]
			) {
				ok(!v2.includes(banned), `${banned} in ${v2}`);
			}
		}
		// The receive-pack advertisement never carries push-cert or push-options.
		const rp = await (await fetch(
			`${w.remote}/info/refs?service=git-receive-pack`,
			{ headers: { authorization: `Bearer ${member.token}` } },
		)).text();
		ok(rp.includes("report-status"), rp);
		ok(!rp.includes("push-cert") && !rp.includes("push-options"), rp);
	});
});
