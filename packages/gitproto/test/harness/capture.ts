// Records the golden request and response bodies of stock git against a
// local `git http-backend` (the harness in ./git.ts). The output,
// `test/goldens/captures.json`, is reviewed test data: re-record it only on
// purpose (a new git version, a new case), then review the diff.
//
// Usage: deno run -A --config deno.json packages/gitproto/test/harness/capture.ts
//
// Object ids are reproducible (fixed identities and dates); the agent string
// records the git version that produced each body.

import {
	rewriteAdvertisement,
	UPLOAD_PACK_V0_CAPABILITIES,
} from "../../src/index.ts";
import { encodeBase64 } from "./base64.ts";
import {
	commitFile,
	git,
	type GitServer,
	initBare,
	initWork,
	type Recorded,
	revParse,
	type Sandbox,
	withGitServer,
} from "./git.ts";

export type Capture = {
	readonly name: string;
	readonly description: string;
	readonly method: string;
	readonly op: string;
	readonly gitProtocol: string | null;
	readonly contentEncoding: string | null;
	/** The request carried a Content-Length (false: chunked). */
	readonly contentLength: boolean;
	readonly body: string;
	readonly status: number;
	readonly response: string;
};

const opOf = (record: Recorded): string =>
	record.path.endsWith("/info/refs")
		? `info/refs${record.query}`
		: record.path.slice(record.path.lastIndexOf("/") + 1);

const toCapture = (
	name: string,
	description: string,
	record: Recorded,
): Capture => ({
	name,
	description,
	method: record.method,
	op: opOf(record),
	gitProtocol: record.headers["git-protocol"] ?? null,
	contentEncoding: record.headers["content-encoding"] ?? null,
	contentLength: "content-length" in record.headers,
	body: encodeBase64(record.body),
	status: record.status,
	// Fetch responses are packs (noise for these tests): not kept.
	response: isFetch(record) ? "" : encodeBase64(record.response),
});

const isFetch = (record: Recorded): boolean =>
	record.method === "POST" && record.path.endsWith("/git-upload-pack") &&
	!new TextDecoder().decode(record.body).includes("command=ls-refs");

/** Runs `action` and returns the requests it made. */
const during = async (
	server: GitServer,
	action: () => Promise<unknown>,
): Promise<Recorded[]> => {
	const start = server.requests.length;
	await action();
	return server.requests.slice(start);
};

const pick = (
	records: Recorded[],
	predicate: (r: Recorded) => boolean,
	what: string,
): Recorded => {
	const found = records.find(predicate);
	if (!found) throw new Error(`capture: no request for ${what}`);
	return found;
};

const isPost = (op: string) => (r: Recorded) =>
	r.method === "POST" && r.path.endsWith(`/${op}`);
const isInfo = (service: string) => (r: Recorded) =>
	r.method === "GET" && r.query === `?service=${service}`;

export const captureAll = async (): Promise<Capture[]> =>
	await withGitServer(async (sandbox: Sandbox, server: GitServer) => {
		const out: Capture[] = [];
		const add = (name: string, description: string, record: Recorded) =>
			out.push(toCapture(name, description, record));
		await initBare(sandbox, "repo");
		const remote = `${server.url}/repo.git`;
		const work = await initWork(sandbox, "work", 2);

		let reqs = await during(
			server,
			() => git(sandbox, ["push", remote, "main"], { cwd: work }),
		);
		add(
			"receive-pack-ad-empty",
			"receive-pack advertisement of an empty repository",
			pick(reqs, isInfo("git-receive-pack"), "empty receive-pack ad"),
		);
		add(
			"receive-pack-create",
			"first push of main: one create command, then a pack",
			pick(reqs, isPost("git-receive-pack"), "create"),
		);

		reqs = await during(server, () =>
			git(sandbox, [
				"push",
				remote,
				"main:refs/heads/feat",
				"HEAD:refs/tags/v1",
			], { cwd: work }));
		add(
			"receive-pack-multi-ref",
			"two creates of existing objects (a branch and a tag): an empty pack",
			pick(reqs, isPost("git-receive-pack"), "multi-ref"),
		);

		reqs = await during(
			server,
			() => git(sandbox, ["push", remote, ":refs/heads/feat"], { cwd: work }),
		);
		add(
			"receive-pack-ad",
			"receive-pack advertisement with refs",
			pick(reqs, isInfo("git-receive-pack"), "receive-pack ad"),
		);
		add(
			"receive-pack-delete",
			"a delete-only push: commands and a flush, no pack",
			pick(reqs, isPost("git-receive-pack"), "delete"),
		);

		const leased = await revParse(sandbox, work, "HEAD");
		await commitFile(sandbox, work, "atomic.txt", "atomic\n");
		reqs = await during(server, () =>
			git(sandbox, [
				"push",
				"--atomic",
				`--force-with-lease=main:${leased}`,
				remote,
				"main",
			], { cwd: work }));
		add(
			"receive-pack-atomic-update",
			"an --atomic --force-with-lease update of main",
			pick(reqs, isPost("git-receive-pack"), "atomic update"),
		);

		// A push larger than http.postBuffer: git probes with `0000` first,
		// then streams the request without a Content-Length.
		await commitFile(sandbox, work, "big.txt", pseudoRandomHex(100_000));
		reqs = await during(
			server,
			() =>
				git(sandbox, ["-c", "http.postBuffer=4096", "push", remote, "main"], {
					cwd: work,
				}),
		);
		const receivePosts = reqs.filter(isPost("git-receive-pack"));
		add(
			"receive-pack-probe",
			"the 0000 probe git sends before a large push",
			pick(receivePosts, (r) => r.body.length === 4, "probe"),
		);
		const chunked = pick(
			receivePosts,
			(r) => r.body.length > 4,
			"chunked push",
		);
		add(
			"receive-pack-chunked",
			"a large push sent without a Content-Length (pack bytes trimmed)",
			{ ...chunked, body: trimPack(chunked.body) },
		);

		// A push from a shallow clone.
		const shallow = `${sandbox.root}/shallow`;
		await git(sandbox, ["clone", "-q", "--depth", "1", remote, shallow]);
		await commitFile(sandbox, shallow, "from-shallow.txt", "s\n");
		reqs = await during(
			server,
			() =>
				git(sandbox, ["push", remote, "HEAD:refs/heads/from-shallow"], {
					cwd: shallow,
					allowFail: true,
				}),
		);
		add(
			"receive-pack-from-shallow",
			"a push from a shallow clone (git sends shallow lines first)",
			pick(reqs, isPost("git-receive-pack"), "shallow push"),
		);

		// Upload-pack, protocol v2.
		const clone2 = `${sandbox.root}/clone-v2`;
		reqs = await during(
			server,
			() => git(sandbox, ["clone", "-q", remote, clone2]),
		);
		add(
			"upload-pack-v2-caps",
			"v2 capability advertisement (no service line)",
			pick(reqs, isInfo("git-upload-pack"), "v2 caps"),
		);
		const v2Posts = reqs.filter(isPost("git-upload-pack"));
		add(
			"upload-pack-v2-ls-refs",
			"v2 ls-refs of a clone (peel, symrefs, unborn, ref-prefix)",
			pick(
				v2Posts,
				(r) => new TextDecoder().decode(r.body).includes("command=ls-refs"),
				"ls-refs",
			),
		);
		add(
			"upload-pack-v2-fetch-clone",
			"v2 fetch of a clone (wants, done)",
			pick(
				v2Posts,
				(r) => new TextDecoder().decode(r.body).includes("command=fetch"),
				"fetch",
			),
		);

		reqs = await during(
			server,
			() => git(sandbox, ["ls-remote", remote, "refs/heads/lanes/ln_x"]),
		);
		add(
			"upload-pack-v2-ls-remote-pattern",
			"ls-remote with a pattern: git 2.55 sends no ref-prefix for it (U47)",
			pick(reqs, isPost("git-upload-pack"), "ls-remote pattern"),
		);
		reqs = await during(server, () =>
			git(sandbox, [
				"fetch",
				remote,
				"refs/heads/lanes/ln_x:refs/remotes/lane",
			], { cwd: clone2, allowFail: true }));
		add(
			"upload-pack-v2-fetch-refspec",
			"fetch of an explicit refspec: git sends its ref-prefix (U47)",
			pick(reqs, isPost("git-upload-pack"), "fetch refspec"),
		);

		const deep = `${sandbox.root}/clone-depth`;
		reqs = await during(
			server,
			() => git(sandbox, ["clone", "-q", "--depth", "1", remote, deep]),
		);
		add(
			"upload-pack-v2-fetch-depth",
			"v2 fetch of a --depth 1 clone (deepen)",
			pick(
				reqs.filter(isPost("git-upload-pack")),
				(r) => new TextDecoder().decode(r.body).includes("deepen"),
				"depth fetch",
			),
		);

		// A fetch with many haves: git gzips request bodies over 1 KiB. Without
		// tags or a tracking ref git knows no common commit, so it keeps sending
		// haves until a round's body passes 1 KiB.
		const gzipClone = async (name: string, version: string) => {
			const dir = `${sandbox.root}/${name}`;
			await git(sandbox, [
				"-c",
				`protocol.version=${version}`,
				"clone",
				"-q",
				"--no-tags",
				"--single-branch",
				remote,
				dir,
			]);
			for (let i = 0; i < 60; i++) {
				await commitFile(sandbox, dir, `local-${i}.txt`, `${name} ${i}\n`);
			}
			await git(sandbox, ["update-ref", "-d", "refs/remotes/origin/main"], {
				cwd: dir,
			});
			return dir;
		};
		const gzip2 = await gzipClone("gzip-v2", "2");
		await commitFile(sandbox, work, "upstream.txt", "u\n");
		await git(sandbox, ["push", "-q", remote, "main"], { cwd: work });
		reqs = await during(
			server,
			() =>
				git(sandbox, ["fetch", "-q", "--no-tags", "origin"], { cwd: gzip2 }),
		);
		add(
			"upload-pack-v2-fetch-gzip",
			"a v2 fetch whose haves make git gzip the body",
			pick(
				reqs.filter(isPost("git-upload-pack")),
				(r) => r.headers["content-encoding"] === "gzip",
				"gzip fetch",
			),
		);

		// Upload-pack, protocol v0 and v1: first against http-backend's own
		// advertisement, then against the allowlisted one Tartan serves.
		const raw0 = `${sandbox.root}/clone-v0-raw`;
		reqs = await during(
			server,
			() =>
				git(sandbox, ["-c", "protocol.version=0", "clone", "-q", remote, raw0]),
		);
		add(
			"upload-pack-v0-ad",
			"v0 upload-pack advertisement (service line, refs, caps)",
			pick(reqs, isInfo("git-upload-pack"), "v0 ad"),
		);
		add(
			"upload-pack-v0-fetch-raw-ad",
			"v0 clone fetch against http-backend's unfiltered advertisement",
			pick(reqs, isPost("git-upload-pack"), "v0 fetch raw"),
		);
		reqs = await during(
			server,
			() => git(sandbox, ["-c", "protocol.version=1", "ls-remote", remote]),
		);
		add(
			"upload-pack-v1-ad",
			"v1 upload-pack advertisement (version 1 line)",
			pick(reqs, isInfo("git-upload-pack"), "v1 ad"),
		);
		server.setIntercept(async (request) => {
			const v2 = (request.headers.get("git-protocol") ?? "").includes(
				"version=2",
			);
			if (request.op !== "info/refs" || v2) return undefined;
			if (!request.query.includes("git-upload-pack")) return undefined;
			const upstream = await request.backend();
			const body = rewriteAdvertisement(
				new Uint8Array(await upstream.arrayBuffer()),
				{
					service: "git-upload-pack",
					keepRef: () => true,
					capabilities: { protocol: "v0", names: UPLOAD_PACK_V0_CAPABILITIES },
				},
			);
			return new Response(body, { status: 200, headers: upstream.headers });
		});
		const clone0 = `${sandbox.root}/clone-v0`;
		reqs = await during(
			server,
			() =>
				git(sandbox, [
					"-c",
					"protocol.version=0",
					"clone",
					"-q",
					remote,
					clone0,
				]),
		);
		add(
			"upload-pack-v0-fetch-clone",
			"v0 fetch of a clone against the allowlisted advertisement",
			pick(reqs, isPost("git-upload-pack"), "v0 fetch"),
		);
		const gzip0 = await gzipClone("gzip-v0", "0");
		await commitFile(sandbox, work, "upstream0.txt", "u0\n");
		await git(sandbox, ["push", "-q", remote, "main"], { cwd: work });
		reqs = await during(server, () =>
			git(sandbox, [
				"-c",
				"protocol.version=0",
				"fetch",
				"-q",
				"--no-tags",
				"origin",
			], { cwd: gzip0 }));
		const v0Posts = reqs.filter(isPost("git-upload-pack"));
		add(
			"upload-pack-v0-fetch-haves",
			"a v0 fetch negotiation round with haves",
			pick(
				v0Posts,
				(r) => new TextDecoder().decode(r.body).includes("have "),
				"v0 haves",
			),
		);
		const v0Gzip = v0Posts.find((r) =>
			r.headers["content-encoding"] === "gzip"
		);
		if (v0Gzip) {
			add("upload-pack-v0-fetch-gzip", "a gzip-encoded v0 fetch round", v0Gzip);
		}
		const clone1 = `${sandbox.root}/clone-v1`;
		reqs = await during(
			server,
			() =>
				git(sandbox, [
					"-c",
					"protocol.version=1",
					"clone",
					"-q",
					remote,
					clone1,
				]),
		);
		server.setIntercept(undefined);
		add(
			"upload-pack-v1-fetch-clone",
			"v1 fetch of a clone",
			pick(reqs, isPost("git-upload-pack"), "v1 fetch"),
		);
		return out;
	});

/** Deterministic incompressible-ish text (so the pack exceeds http.postBuffer). */
const pseudoRandomHex = (length: number): string => {
	let state = 0x2545f491;
	let out = "";
	while (out.length < length) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		out += (state >>> 0).toString(16).padStart(8, "0");
	}
	return out.slice(0, length);
};

/** Keeps the command section and the pack header (the pack itself is noise). */
const trimPack = (body: Uint8Array): Uint8Array => {
	const pack = indexOf(body, new TextEncoder().encode("PACK"));
	return pack < 0 ? body : body.slice(0, pack + 12);
};

const indexOf = (haystack: Uint8Array, needle: Uint8Array): number => {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
};

if (import.meta.main) {
	const captures = await captureAll();
	const path = new URL("../goldens/captures.json", import.meta.url);
	await Deno.mkdir(new URL("../goldens/", import.meta.url), {
		recursive: true,
	});
	await Deno.writeTextFile(path, JSON.stringify(captures, null, "\t") + "\n");
	console.log(`wrote ${captures.length} captures to ${path.pathname}`);
}
