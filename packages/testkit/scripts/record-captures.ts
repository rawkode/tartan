// Records smart-HTTP captures of stock git against FakeArtifacts' server and
// writes them to `packages/testkit/captures/stock-git.json` (test vectors
// for the gitproto parsers, the gateway and the capability route).
//
// The requests are stock git's own bytes (the version is recorded); the
// responses are the fake's. Authorization headers are never recorded. Run
// it again to refresh after a git upgrade or a change to the fake's
// advertisements (`test/captures.test.ts` compares every recorded one with
// the fake's), from the repo root (`--config` makes Deno use the root import
// map rather than this package's package.json):
//
//   deno run -A --config deno.json packages/testkit/scripts/record-captures.ts

import { toBase64 } from "../src/bytes.ts";
import { createFakeArtifacts } from "../src/artifacts/fake.ts";
import { MONOREPO_FILES } from "../src/fixtures/monorepo.ts";

export type CapturedExchange = {
	readonly method: string;
	/** Path and query below the repo (`/info/refs?…`, `/git-upload-pack`, …). */
	readonly path: string;
	readonly requestHeaders: Readonly<Record<string, string>>;
	readonly requestBody: string;
	readonly status: number;
	readonly responseBody: string;
};

export type Capture = {
	readonly id: string;
	readonly title: string;
	readonly command: string;
	readonly exchanges: readonly CapturedExchange[];
};

const KEPT_HEADERS = [
	"content-type",
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"git-protocol",
	"accept",
];

const run = async (
	cwd: string,
	args: string[],
	env: Record<string, string>,
): Promise<string> => {
	const out = await new Deno.Command("git", {
		args,
		cwd,
		env,
		stdout: "piped",
		stderr: "piped",
	}).output();
	const text = new TextDecoder().decode(out.stdout).trim();
	if (!out.success) {
		throw new Error(
			`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
		);
	}
	return text;
};

const main = async () => {
	const fake = createFakeArtifacts({ namespace: "captures" });
	const seeded = await fake.seed("acme", {
		files: MONOREPO_FILES,
		alsoRefs: ["refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa"],
	});
	const log: CapturedExchange[] = [];
	const server = Deno.serve({
		hostname: "127.0.0.1",
		port: 0,
		onListen: () => {},
	}, async (req) => {
		const url = new URL(req.url);
		const body = new Uint8Array(await req.arrayBuffer());
		const headers = new Headers(req.headers);
		const res = await fake.fetch(
			new Request(`https://${fake.host}${url.pathname}${url.search}`, {
				method: req.method,
				headers,
				body: req.method === "POST" ? body : null,
			}),
		);
		const resBody = new Uint8Array(await res.arrayBuffer());
		log.push({
			method: req.method,
			path: url.pathname.replace(/^.*\.git/, "") + url.search,
			requestHeaders: Object.fromEntries(
				KEPT_HEADERS.flatMap((h) => {
					const v = req.headers.get(h);
					return v === null ? [] : [[h, v]];
				}),
			),
			requestBody: toBase64(body),
			status: res.status,
			responseBody: toBase64(resBody),
		});
		return new Response(resBody, { status: res.status, headers: res.headers });
	});
	const remote = `http://127.0.0.1:${server.addr.port}/git/captures/acme.git`;
	const home = await Deno.makeTempDir({ prefix: "tartan-captures-" });
	const env = {
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Tartan Capture",
		GIT_AUTHOR_EMAIL: "capture@example.invalid",
		GIT_COMMITTER_NAME: "Tartan Capture",
		GIT_COMMITTER_EMAIL: "capture@example.invalid",
		GIT_AUTHOR_DATE: "2026-10-02T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-10-02T00:00:00Z",
	};
	const auth = ["-c", `http.extraHeader=Authorization: Bearer ${seeded.token}`];
	const captures: Capture[] = [];
	const record = async (
		id: string,
		title: string,
		cwd: string,
		args: string[],
	) => {
		log.length = 0;
		await run(cwd, [...auth, ...args], env);
		captures.push({
			id,
			title,
			command: `git ${args.join(" ")}`
				.replaceAll(remote, "<remote>")
				.replaceAll(home, "<tmp>"),
			exchanges: [...log],
		});
	};
	try {
		const work = `${home}/work`;
		await record("clone-v2", "clone, protocol v2", home, [
			"-c",
			"protocol.version=2",
			"clone",
			remote,
			work,
		]);
		await record("clone-v0", "clone, protocol v0", home, [
			"-c",
			"protocol.version=0",
			"clone",
			remote,
			`${home}/work-v0`,
		]);
		await record(
			"ls-remote-lanes-v2",
			"ls-remote with a lane pattern: ls-refs with ref-prefix (U47)",
			work,
			["ls-remote", "origin", "refs/heads/lanes/*"],
		);
		await record(
			"fetch-lane-v2",
			"fetch one lane ref by name: ls-refs ref-prefix (U47)",
			work,
			["fetch", "origin", "refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa"],
		);
		await Deno.writeTextFile(`${work}/CHANGELOG.md`, "# changes\n\n- one\n");
		await run(work, ["add", "CHANGELOG.md"], env);
		await run(work, ["commit", "-q", "-m", "docs: changelog"], env);
		await record(
			"push-update",
			"push an update to main (report-status, side-band-64k)",
			work,
			["push", "origin", "HEAD:refs/heads/main"],
		);
		const head = await run(work, ["rev-parse", "HEAD"], env);
		await record(
			"push-ref-only-create",
			"create a ref at an existing commit (empty pack, U46)",
			work,
			[
				"push",
				"origin",
				`${head}:refs/heads/lanes/ln_01k6bbbbbbbbbbbbbbbbbbbbbb`,
			],
		);
		await record(
			"push-delete",
			"delete a ref (no pack)",
			work,
			["push", "origin", ":refs/heads/lanes/ln_01k6bbbbbbbbbbbbbbbbbbbbbb"],
		);
		const big = Array.from(
			{ length: 4000 },
			(_, i) => `line ${i} ${"x".repeat(40)}`,
		).join("\n");
		await Deno.writeTextFile(`${work}/big.txt`, `${big}\n`);
		await run(work, ["add", "big.txt"], env);
		await run(work, ["commit", "-q", "-m", "big file"], env);
		await record(
			"push-probe-chunked",
			"push above http.postBuffer: the 0000 probe, then a chunked body",
			work,
			["-c", "http.postBuffer=4096", "push", "origin", "HEAD:refs/heads/main"],
		);
		const gitVersion = await run(home, ["--version"], env);
		const out = new URL("../captures/stock-git.json", import.meta.url);
		await Deno.writeTextFile(
			out,
			`${
				JSON.stringify(
					{
						gitVersion,
						recordedAt: new Date().toISOString().slice(0, 10),
						captures,
					},
					null,
					"\t",
				)
			}\n`,
		);
		console.log(
			`wrote ${captures.length} captures (${gitVersion}) to ${out.pathname}`,
		);
	} finally {
		await server.shutdown();
		await Deno.remove(home, { recursive: true });
	}
};

if (import.meta.main) await main();
