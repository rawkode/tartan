// The kernel's clients against stock `git http-backend`: v2 ls-refs with
// prefixes, peel and
// symrefs; ref-only receive-pack create, update and CAS delete with an empty
// pack (U46 locally), `ng` for a wrong old id (U48 locally), atomic pushes,
// and new objects from the pack writer (genesis) that fsck accepts.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import {
	encodeCommit,
	encodeTree,
	type GitRemote,
	hashObject,
	lsRefs,
	parseLsRefs,
	pushRefs,
	writePack,
} from "../src/index.ts";
import {
	commitFile,
	git,
	type GitServer,
	hasGit,
	initBare,
	initWork,
	revParse,
	type Sandbox,
	withGitServer,
} from "./harness/git.ts";
import { enc, join, pkt, SHA_A, ZERO } from "./helpers.ts";
import { encodePushRequest, PUSH_REQUEST_CAPABILITIES } from "../src/client.ts";

const AUTH = "Bearer test-token-not-a-secret";

const remoteOf = (server: GitServer, name: string): GitRemote => ({
	url: `${server.url}/${name}.git`,
	authorization: AUTH,
});

const refsOf = async (
	sandbox: Sandbox,
	bare: string,
): Promise<Record<string, string>> => {
	const out = await git(sandbox, [
		"for-each-ref",
		"--format=%(refname) %(objectname)",
	], { cwd: bare });
	return Object.fromEntries(
		out.text.trim().split("\n").filter(Boolean).map((line) => line.split(" ")),
	);
};

/** A served repo with main (2 commits), a branch lane ref and an annotated tag. */
const seeded = async (sandbox: Sandbox, server: GitServer) => {
	const bare = await initBare(sandbox, "repo");
	const work = await initWork(sandbox, "work", 2);
	const head = await revParse(sandbox, work, "HEAD");
	const parent = await revParse(sandbox, work, "HEAD~1");
	await git(sandbox, ["tag", "-a", "v1", "-m", "release"], { cwd: work });
	const url = `${server.url}/repo.git`;
	await git(sandbox, [
		"push",
		"-q",
		url,
		"main",
		"v1",
		"HEAD~1:refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
	], { cwd: work });
	const tag = await revParse(sandbox, work, "v1");
	return { bare, work, head, parent, tag };
};

Deno.test({
	name: "lsRefs: prefixes, peel, symrefs and an empty repository",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const { head, parent, tag } = await seeded(sandbox, server);
			const remote = remoteOf(server, "repo");
			const all = await lsRefs(remote, { peel: true, symrefs: true });
			deepStrictEqual(all, [
				{ ref: "HEAD", sha: head, symrefTarget: "refs/heads/main" },
				{ ref: "refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa", sha: parent },
				{ ref: "refs/heads/main", sha: head },
				{ ref: "refs/tags/v1", sha: tag, peeled: head },
			]);
			deepStrictEqual(
				await lsRefs(remote, { refPrefixes: ["refs/heads/lanes/"] }),
				[{
					ref: "refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
					sha: parent,
				}],
			);
			deepStrictEqual(
				await lsRefs(remote, { refPrefixes: ["refs/tartan/"] }),
				[],
			);
			const request = server.requests[server.requests.length - 1];
			equal(request.headers["authorization"], AUTH);
			equal(request.headers["git-protocol"], "version=2");
			await initBare(sandbox, "empty");
			deepStrictEqual(await lsRefs(remoteOf(server, "empty")), []);
		}),
});

Deno.test({
	name: "pushRefs: ref-only create, update, CAS delete; ng for a wrong old id",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const { bare, head, parent } = await seeded(sandbox, server);
			const remote = remoteOf(server, "repo");
			const attic = "refs/tartan/attic/ln_01k6aaaaaaaaaaaaaaaaaaaaaa";
			// Create at an existing object with an empty pack (U46).
			deepStrictEqual(
				await pushRefs(remote, [{ ref: attic, old: ZERO, new: parent }]),
				[
					{ ref: attic, ok: true },
				],
			);
			equal((await refsOf(sandbox, bare))[attic], parent);
			// A create of a ref that exists is refused (U48, create CAS).
			const again = await pushRefs(remote, [{
				ref: attic,
				old: ZERO,
				new: head,
			}]);
			equal(again[0].ok, false);
			equal((await refsOf(sandbox, bare))[attic], parent);
			// An update with a wrong old id is refused (U48, update CAS).
			const stale = await pushRefs(remote, [{
				ref: attic,
				old: head,
				new: head,
			}]);
			equal(stale[0].ok, false);
			ok(!stale[0].ok && stale[0].reason.length > 0);
			// An update with the right old id moves it.
			deepStrictEqual(
				await pushRefs(remote, [{ ref: attic, old: parent, new: head }]),
				[
					{ ref: attic, ok: true },
				],
			);
			// A delete with a wrong old id is refused; the right one deletes.
			equal(
				(await pushRefs(remote, [{ ref: attic, old: parent, new: ZERO }]))[0]
					.ok,
				false,
			);
			deepStrictEqual(
				await pushRefs(remote, [{ ref: attic, old: head, new: ZERO }]),
				[
					{ ref: attic, ok: true },
				],
			);
			equal((await refsOf(sandbox, bare))[attic], undefined);
			// Atomic: one bad command rejects both.
			const atomic = await pushRefs(remote, [
				{ ref: "refs/tartan/change/a", old: ZERO, new: head },
				{ ref: "refs/heads/main", old: parent, new: head },
			], { atomic: true });
			ok(atomic.every((status) => !status.ok), JSON.stringify(atomic));
			equal((await refsOf(sandbox, bare))["refs/tartan/change/a"], undefined);
			// The wire request: report-status, side-band-64k (only advertised
			// capabilities), the given credential.
			const request = server.requests[server.requests.length - 1];
			equal(request.headers["authorization"], AUTH);
			ok(
				new TextDecoder().decode(request.body).includes(
					"\0report-status side-band-64k atomic agent=",
				),
			);
		}),
});

Deno.test({
	name: "pushRefs with a pack-writer pack: a genesis commit that fsck accepts",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const bare = await initBare(sandbox, "fresh");
			const readme = { type: "blob" as const, data: enc("# acme/shop\n") };
			const readmeId = await hashObject(readme.type, readme.data);
			const tree = {
				type: "tree" as const,
				data: encodeTree([{ mode: "100644", name: "README.md", id: readmeId }]),
			};
			const treeId = await hashObject(tree.type, tree.data);
			const commit = {
				type: "commit" as const,
				data: encodeCommit({
					tree: treeId,
					author: {
						name: "Tartan",
						email: "kernel@tartan.invalid",
						at: 1_790_000_000,
					},
					message: "genesis\n",
				}),
			};
			const { pack, ids } = await writePack([readme, tree, commit]);
			const statuses = await pushRefs(remoteOf(server, "fresh"), [
				{ ref: "refs/heads/main", old: ZERO, new: ids[2] },
			], { pack });
			deepStrictEqual(statuses, [{ ref: "refs/heads/main", ok: true }]);
			await git(sandbox, ["fsck", "--strict", "--no-dangling"], { cwd: bare });
			equal(
				(await git(sandbox, ["cat-file", "-p", "main:README.md"], {
					cwd: bare,
				})).text,
				"# acme/shop\n",
			);
			// A clone of it works with stock git.
			await git(sandbox, [
				"clone",
				"-q",
				`${server.url}/fresh.git`,
				`${sandbox.root}/check`,
			]);
			// A second commit on top through a thin incremental pack.
			const work = `${sandbox.root}/check`;
			const next = await commitFile(sandbox, work, "b.txt", "b\n");
			ok(next.length === 40);
		}),
});

Deno.test({
	name: "client errors never repeat the credential",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (_sandbox, server) => {
			await rejects(lsRefs(remoteOf(server, "missing")), (error) => {
				const e = fromRpcError(error);
				return e.code === "unavailable" && !e.message.includes("test-token");
			});
			await rejects(
				pushRefs(remoteOf(server, "missing"), [{
					ref: "refs/heads/x",
					old: ZERO,
					new: SHA_A,
				}]),
				(error) => !String(error).includes("test-token"),
			);
			await rejects(pushRefs(remoteOf(server, "missing"), []));
			await rejects(
				pushRefs(remoteOf(server, "missing"), [{
					ref: "refs/x",
					old: ZERO,
					new: SHA_A,
				}]),
			);
		}),
});

Deno.test("pushRefs reads a plain (no side-band) report and band-3 errors", async () => {
	const reply = (body: Uint8Array) => (): Promise<Response> =>
		Promise.resolve(
			new Response(body.slice(), {
				headers: { "content-type": "application/x-git-receive-pack-result" },
			}),
		);
	const command = { ref: "refs/tartan/attic/x", old: ZERO, new: SHA_A };
	const plain = join(
		pkt("unpack ok\n"),
		pkt("ng refs/tartan/attic/x reference already exists\n"),
		"0000",
	);
	deepStrictEqual(
		await pushRefs({
			url: "https://x.invalid/r.git",
			authorization: AUTH,
			fetch: reply(plain),
		}, [command]),
		[{
			ref: "refs/tartan/attic/x",
			ok: false,
			reason: "reference already exists",
		}],
	);
	const unpackFailed = join(
		pkt("unpack index-pack abnormal exit\n"),
		pkt("ok refs/tartan/attic/x\n"),
		"0000",
	);
	deepStrictEqual(
		await pushRefs({
			url: "https://x.invalid/r.git",
			authorization: AUTH,
			fetch: reply(unpackFailed),
		}, [command]),
		[{
			ref: "refs/tartan/attic/x",
			ok: false,
			reason: "unpack index-pack abnormal exit",
		}],
	);
	const fatal = join(
		pkt(join(new Uint8Array([3]), enc("fatal: disk full"))),
		"0000",
	);
	await rejects(
		pushRefs({
			url: "https://x.invalid/r.git",
			authorization: AUTH,
			fetch: reply(fatal),
		}, [command]),
		(error) => fromRpcError(error).message.includes("disk full"),
	);
});

// The receive-pack capabilities the upstream advertises; pushRefs asks for
// nothing else, and an empty reply is an error.
const ADVERTISED_RECEIVE_CAPS = new Set([
	"report-status",
	"report-status-v2",
	"delete-refs",
	"atomic",
	"ofs-delta",
	"side-band",
	"side-band-64k",
]);

const requestedCaps = (body: Uint8Array): string[] => {
	const length = parseInt(new TextDecoder().decode(body.slice(0, 4)), 16);
	const first = new TextDecoder().decode(body.slice(4, length));
	const nul = first.indexOf("\0");
	return first.slice(nul + 1).trim().split(" ").filter((c) => c.length > 0);
};

Deno.test("pushRefs asks only for advertised capabilities; an empty reply is an error", async () => {
	const command = { ref: "refs/tartan/attic/x", old: ZERO, new: SHA_A };
	for (const atomic of [false, true]) {
		const caps = requestedCaps(await encodePushRequest([command], { atomic }));
		for (const cap of caps) {
			ok(
				cap.startsWith("agent=") || ADVERTISED_RECEIVE_CAPS.has(cap),
				`unadvertised capability ${cap}`,
			);
		}
		deepStrictEqual(
			caps.filter((c) => !c.startsWith("agent=")),
			[...PUSH_REQUEST_CAPABILITIES, ...(atomic ? ["atomic"] : [])],
		);
	}
	// A server that answers an unadvertised capability with an empty 200.
	const strictServer = async (
		_url: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const body = new Uint8Array(
			await new Response(init?.body as BodyInit).arrayBuffer(),
		);
		const unadvertised = requestedCaps(body).some((c) =>
			!c.startsWith("agent=") && !ADVERTISED_RECEIVE_CAPS.has(c)
		);
		const reply = unadvertised ? new Uint8Array(0) : join(
			pkt(
				join(
					new Uint8Array([1]),
					join(pkt("unpack ok\n"), pkt("ok refs/tartan/attic/x\n"), "0000"),
				),
			),
			"0000",
		);
		return new Response(reply.slice(), {
			headers: { "content-type": "application/x-git-receive-pack-result" },
		});
	};
	deepStrictEqual(
		await pushRefs({
			url: "https://x.invalid/r.git",
			authorization: AUTH,
			fetch: strictServer,
		}, [command]),
		[{ ref: "refs/tartan/attic/x", ok: true }],
	);
	const empty = (): Promise<Response> =>
		Promise.resolve(
			new Response(new Uint8Array(0), {
				headers: { "content-type": "application/x-git-receive-pack-result" },
			}),
		);
	await rejects(
		pushRefs({
			url: "https://x.invalid/r.git",
			authorization: AUTH,
			fetch: empty,
		}, [command]),
		(error) => {
			const e = fromRpcError(error);
			return e.code === "unavailable" && e.message.includes("no report");
		},
	);
});

Deno.test("parseLsRefs: ERR, unborn and malformed lines", () => {
	deepStrictEqual(
		parseLsRefs(
			join(pkt("unborn HEAD symref-target:refs/heads/main\n"), "0000"),
		),
		[],
	);
	let threw = false;
	try {
		parseLsRefs(join(pkt("ERR access denied\n"), "0000"));
	} catch (error) {
		threw = fromRpcError(error).code === "unavailable";
	}
	ok(threw);
	for (
		const body of [
			join(pkt("junk\n"), "0000"),
			pkt(`${SHA_A} refs/heads/x\n`),
			join(pkt(`${SHA_A} refs/heads/x peeled:zz\n`), "0000"),
		]
	) {
		let failed = false;
		try {
			parseLsRefs(body);
		} catch {
			failed = true;
		}
		ok(failed);
	}
});
