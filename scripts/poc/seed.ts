// `deno task poc`: a local forge with sample data, in one command.
//
//   nix develop -c deno task poc                  boots a forge on :8801, seeds
//                                                 it and stays up until Ctrl-C
//   nix develop -c deno task poc --port 8802
//   nix develop -c deno task poc --skip-web-build reuses web/dist
//   nix develop -c deno task poc --skip-ext-build reuses extensions/issues/dist
//   nix develop -c deno task poc --origin https://localhost:8801 --log dev.log
//                                                 seeds a fresh forge already
//                                                 running; `--log` holds its output
//
// It runs setup and the dev sign-in, builds and publishes rawkode.issues, makes
// the sample hierarchy (sample.ts), installs Issues on the repos that have it,
// pushes each repo's history directly to `main` as the Owner, and opens the
// sample issues through the tool route.
//
// `deno task dev` keeps everything in memory, so re-seeding is this command
// again: stop the forge and run it. A forge that is already set up cannot be
// seeded. Persistence is not cheap here: repository contents live in the fake
// Artifacts binding inside the dev Worker's memory.
//
// The session it writes (`.wrangler/poc/<port>/session.json`, 0600) is what
// `deno task poc:proof` reads, and it dies with the forge.

import { buildExtension } from "../build-ext.ts";
import { bootstrap } from "../../tools/dev/bootstrap.ts";
import {
	createClient,
	gitFor,
	type GitWork,
	ISSUES_ID,
	type Session,
} from "./client.ts";
import {
	pathOf,
	SAMPLE_GROUPS,
	SAMPLE_REPOS,
	type SampleRepo,
} from "./sample.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const DEFAULT_PORT = 8801;
const HEALTH_ATTEMPTS = 900;
const HEALTH_INTERVAL_MS = 200;
const DAY_MS = 86_400_000;

export type PocArgs = {
	readonly port: number;
	/** A fresh forge already running, and the file holding its output. */
	readonly target?: { readonly origin: string; readonly log: string };
	readonly skipWebBuild: boolean;
	readonly skipExtBuild: boolean;
};

export const parsePocArgs = (argv: readonly string[]): PocArgs => {
	let port = DEFAULT_PORT;
	let origin: string | undefined;
	let log: string | undefined;
	let skipWebBuild = false;
	let skipExtBuild = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--skip-web-build") skipWebBuild = true;
		else if (arg === "--skip-ext-build") skipExtBuild = true;
		else if (arg === "--port") port = Number(argv[++i]);
		else if (arg === "--origin") origin = argv[++i];
		else if (arg === "--log") log = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("--port needs a port number");
	}
	if ((origin === undefined) !== (log === undefined)) {
		throw new Error("--origin and --log go together");
	}
	if (origin !== undefined && log !== undefined) {
		const target = { origin: new URL(origin).origin, log };
		return {
			port: Number(new URL(target.origin).port) || 443,
			target,
			skipWebBuild,
			skipExtBuild,
		};
	}
	return { port, skipWebBuild, skipExtBuild };
};

/** Commit dates a day apart, the last one today. */
export const commitDates = (count: number, now: number): Date[] =>
	Array.from(
		{ length: count },
		(_, i) => new Date(now - (count - 1 - i) * DAY_MS),
	);

const portTaken = (port: number): boolean => {
	try {
		Deno.listen({ hostname: "localhost", port }).close();
		return false;
	} catch {
		return true;
	}
};

/** Appends a stream to the log, whole chunks at a time. */
const drainInto = async (
	stream: ReadableStream<Uint8Array>,
	log: Deno.FsFile,
): Promise<void> => {
	for await (const chunk of stream) await log.write(chunk);
};

/** `deno task dev` as a child, its output in `logPath`. */
const bootForge = async (args: PocArgs, logPath: string) => {
	if (portTaken(args.port)) {
		throw new Error(
			`port ${args.port} is taken: stop that forge, or use --port`,
		);
	}
	const log = await Deno.open(logPath, {
		create: true,
		write: true,
		truncate: true,
	});
	const child = new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"-A",
			"tools/dev/main.ts",
			"--port",
			String(args.port),
			...(args.skipWebBuild ? ["--skip-web-build"] : []),
		],
		cwd: ROOT,
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	const drained = Promise.all([
		drainInto(child.stdout, log),
		drainInto(child.stderr, log),
	]);
	const stop = async (): Promise<void> => {
		try {
			child.kill("SIGTERM");
		} catch {
			// It has already exited.
		}
		await child.status;
		await drained.catch(() => {});
		log.close();
	};
	return { child, stop };
};

const waitForHealth = async (
	origin: string,
	exited: Promise<Deno.CommandStatus> | null,
	logPath: string,
): Promise<void> => {
	let gone = false;
	exited?.then(() => gone = true);
	for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
		if (gone) throw new Error(`the forge exited at start: see ${logPath}`);
		const up = await fetch(`${origin}/-/health`).then(async (r) => {
			await r.body?.cancel();
			return r.status === 200;
		}, () => false);
		if (up) return;
		await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
	}
	throw new Error(`no answer from ${origin}/-/health: see ${logPath}`);
};

const pushHistory = async (
	session: Session,
	repo: SampleRepo,
	work: string,
): Promise<number> => {
	const dir = `${work}/${repo.slug}`;
	const outer: GitWork = gitFor(session, work);
	await outer.run([
		"clone",
		"-q",
		`${session.origin}/${pathOf(repo)}.git`,
		dir,
	]);
	const git = gitFor(session, dir);
	const dates = commitDates(repo.commits.length, Date.now());
	for (const [i, commit] of repo.commits.entries()) {
		for (const [path, text] of Object.entries(commit.files)) {
			const file = `${dir}/${path}`;
			await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), {
				recursive: true,
			});
			await Deno.writeTextFile(file, text);
		}
		await git.run(["add", "--all"]);
		await git.run(["commit", "-q", "-m", commit.message], dates[i]);
		// One push per commit: discovery runs on every push to main.
		await git.run(["push", "-q", "origin", "HEAD:main"]);
	}
	return repo.commits.length;
};

const seedIssues = async (
	client: ReturnType<typeof createClient>,
	repoId: string,
	repo: SampleRepo,
): Promise<void> => {
	const where = pathOf(repo);
	for (const issue of repo.seedIssues) {
		const { title, body, project, closed } = issue;
		const created = await client.tool(
			repoId,
			"create",
			{ title, ...(body === undefined ? {} : { body }) },
			project,
		);
		if (created.result === undefined) {
			throw new Error(
				`${where}: create "${title}": ${created.status} ${created.code}`,
			);
		}
		if (closed === true) {
			const { number } = (created.result as { issue: { number: number } })
				.issue;
			const done = await client.tool(repoId, "close", { number }, project);
			if (done.result === undefined) {
				throw new Error(
					`${where}: close #${number}: ${done.status} ${done.code}`,
				);
			}
		}
	}
};

const seed = async (
	session: Session,
	args: PocArgs,
	say: (line: string) => void,
) => {
	const client = createClient(session);
	const extension = await (async () => {
		if (args.skipExtBuild) {
			return `${ROOT}extensions/issues/dist/publish.json`;
		}
		say("building rawkode.issues");
		const built = await buildExtension({ name: "issues", log: () => {} });
		return `${built.out}/publish.json`;
	})();
	const published = await client.must<{
		readonly manifest: { readonly version: string };
	}>("PUT", "/-/api/packages", JSON.parse(await Deno.readTextFile(extension)));
	const version = published.manifest.version;
	say(`published ${ISSUES_ID}@${version}`);

	for (const [path, description] of SAMPLE_GROUPS) {
		const at = path.lastIndexOf("/");
		await client.must("POST", "/-/api/nodes", {
			...(at < 0 ? {} : { parent: path.slice(0, at) }),
			kind: "group",
			slug: path.slice(at + 1),
			visibility: "public",
			description,
		});
	}
	say(`created ${SAMPLE_GROUPS.length} groups`);

	const work = await Deno.makeTempDir({ prefix: "tartan-poc-" });
	const repos: { path: string; id: string; issues: boolean }[] = [];
	try {
		for (const repo of SAMPLE_REPOS) {
			const { id } = await client.must<{ readonly id: string }>(
				"POST",
				"/-/api/nodes/repos",
				{
					...(repo.parent === undefined ? {} : { parent: repo.parent }),
					slug: repo.slug,
					visibility: "public",
					description: repo.description,
				},
			);
			const path = pathOf(repo);
			if (repo.issues) {
				await client.must("POST", "/-/api/installations", {
					extId: ISSUES_ID,
					version,
					node: path,
					mode: "enforce",
				});
			}
			const commits = await pushHistory(session, repo, work);
			await seedIssues(client, id, repo);
			say(
				`${path}: pushed ${commits} commit(s), ${
					repo.issues
						? `opened ${repo.seedIssues.length} issue(s)`
						: "no Issues"
				}`,
			);
			repos.push({ path, id, issues: repo.issues });
		}
	} finally {
		await Deno.remove(work, { recursive: true }).catch(() => {});
	}
	return { version, repos };
};

const main = async (args: PocArgs): Promise<void> => {
	const dir = `${ROOT}.wrangler/poc/${args.port}`;
	await Deno.mkdir(dir, { recursive: true });
	const logPath = args.target?.log ?? `${dir}/dev.log`;
	const origin = args.target?.origin ?? `https://localhost:${args.port}`;
	const say = (line: string) => console.log(`[poc] ${line}`);

	const forge = args.target === undefined
		? await bootForge(args, logPath)
		: null;
	const stop = async (code: number): Promise<never> => {
		await forge?.stop();
		Deno.exit(code);
	};
	if (forge !== null) {
		const onSignal = () => void stop(0);
		Deno.addSignalListener("SIGINT", onSignal);
		Deno.addSignalListener("SIGTERM", onSignal);
	}
	try {
		say(`waiting for ${origin}`);
		await waitForHealth(origin, forge?.child.status ?? null, logPath);
		const session = await bootstrap({ origin, log: logPath });
		const sessionPath = `${dir}/session.json`;
		await Deno.writeTextFile(sessionPath, JSON.stringify(session, null, "\t"), {
			mode: 0o600,
		});
		const { version, repos } = await seed(session, args, say);
		console.log(`
Tartan is seeded at ${origin}/

Sign in: open ${origin}/-/auth/login in a browser. There is no password: every
sign-in here is the Owner, "${session.handle}". A browser refuses a self-signed
certificate; the launcher's log has the mkcert commands for a trusted one
(${logPath}). git over HTTPS needs GIT_SSL_NO_VERIFY=1 without one.

Repositories (${ISSUES_ID}@${version} on those marked +):
${
			repos.map((r) =>
				`  ${r.issues ? "+" : " "} ${origin}/${r.path}  [${r.id}]`
			)
				.join("\n")
		}

Session for deno task poc:proof: ${sessionPath}
Everything is in memory. To re-seed: stop the forge and run this again.`);
		if (forge === null) return;
		console.log("Press Ctrl-C to stop the forge.");
		await forge.child.status;
		await stop(0);
	} catch (error) {
		console.error(
			`poc: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (forge !== null) console.error(`poc: forge log: ${logPath}`);
		await stop(1);
	}
};

if (import.meta.main) {
	await main(parsePocArgs(Deno.args));
}
