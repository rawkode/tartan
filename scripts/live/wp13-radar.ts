// WP13 live acceptance: two agents edit the same file in
// their own lanes; the second push yields a radar conflict notice in both
// owners' inboxes within 3 s of the push (and, once S3 and the M2 echo pass,
// `remote: [radar]` lines, which this script prints but does not require).
//
//   TARTAN_TOKEN_A=… TARTAN_TOKEN_B=… deno task live -- --stage dev wp13 \
//     --origin https://tartan-dev.example.workers.dev --repo acme/platform/router \
//     [--path services/api/src/middleware/limit.ts]
//
// TARTAN_TOKEN_A and TARTAN_TOKEN_B are agent tokens (`tagt_…`) of two
// different agents with Developer on the repo; they are read from the
// environment and never printed. The stage needs the Swarm pack (or at least
// tartan.radar) installed on the repo. Both lanes are closed at the end.
// Exit code 0 only when every check passes.

import {
	type Lane,
	laneGitCommands,
	type Notice,
} from "../../packages/contract/src/index.ts";

const NOTICE_WITHIN_MS = 3_000;
const POLL_MS = 150;

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const fail = (message: string): never => {
	console.error(`wp13: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const repo = arg("repo") ?? fail("--repo is required");
const file = arg("path") ?? "services/api/src/middleware/limit.ts";
const tokens = {
	a: Deno.env.get("TARTAN_TOKEN_A") ?? fail("TARTAN_TOKEN_A unset"),
	b: Deno.env.get("TARTAN_TOKEN_B") ?? fail("TARTAN_TOKEN_B unset"),
};

type Who = keyof typeof tokens;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const api = async <T>(
	who: Who,
	path: string,
	init: RequestInit = {},
): Promise<T> => {
	const res = await fetch(`${origin}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${tokens[who]}`,
			"content-type": "application/json",
			...init.headers,
		},
	});
	if (!res.ok) {
		throw new Error(`${init.method ?? "GET"} ${path}: ${res.status}`);
	}
	return res.status === 204 ? (undefined as T) : await res.json() as T;
};

const git = async (
	who: Who,
	cwd: string,
	args: string[],
): Promise<{ code: number; stderr: string }> => {
	const out = await new Deno.Command("git", {
		cwd,
		args: [
			"-c",
			`http.extraHeader=Authorization: Bearer ${tokens[who]}`,
			"-c",
			"user.name=wp13-live",
			"-c",
			"user.email=wp13-live@tartan.test",
			...args,
		],
		stdout: "piped",
		stderr: "piped",
	}).output();
	return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
};

const sh = (who: Who, cwd: string, command: string) =>
	git(who, cwd, command.replace(/^git /, "").split(" "));

const openLane = async (who: Who): Promise<Lane> => {
	let lane = await api<Lane>(who, "/-/api/lanes", {
		method: "POST",
		body: JSON.stringify({
			repo,
			purpose: "wp13 live radar check",
			footprint: {
				projects: [],
				prefixes: [file.split("/").slice(0, -1).join("/")],
			},
		}),
	});
	const deadline = Date.now() + 25_000;
	while (lane.state === "opening" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		lane = await api<Lane>(
			who,
			`/-/api/lanes/${lane.id}?repo=${encodeURIComponent(repo)}`,
		);
	}
	return lane;
};

const inboxHead = async (who: Who): Promise<number> => {
	const page = await api<{ notices: Notice[]; head: number }>(
		who,
		"/-/api/inbox?since=0&limit=500",
	);
	return page.notices.reduce((m, n) => Math.max(m, n.seq), 0);
};

/** Waits for a radar conflict notice naming `other` after `since`. */
const waitNotice = async (
	who: Who,
	since: number,
	other: string,
): Promise<Notice | null> => {
	const deadline = Date.now() + NOTICE_WITHIN_MS + 2_000;
	while (Date.now() < deadline) {
		const page = await api<{ notices: Notice[] }>(
			who,
			`/-/api/inbox?since=${since}&limit=50`,
		);
		const hit = page.notices.find((n) =>
			n.kind === "conflict" && n.text.includes(other)
		);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return null;
};

const work = async (who: Who, lane: Lane, line: string) => {
	const dir = await Deno.makeTempDir({ prefix: `wp13-${who}-` });
	const remote = `${origin}${lane.remote}`;
	const clone = await git(who, dir, ["clone", `${origin}/${repo}.git`, "w"]);
	if (clone.code !== 0) throw new Error(`clone failed for ${who}`);
	const cwd = `${dir}/w`;
	const cmds = laneGitCommands(lane, remote);
	for (const part of cmds.start.split(" && ")) {
		const r = await sh(who, cwd, part);
		if (r.code !== 0) {
			throw new Error(`${part.split(" ")[1]} failed for ${who}`);
		}
	}
	const path = `${cwd}/${file}`;
	await Deno.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
	let text = "";
	try {
		text = await Deno.readTextFile(path);
	} catch {
		// a new file
	}
	await Deno.writeTextFile(path, `${text}${line}\n`);
	await git(who, cwd, ["add", file]);
	await git(who, cwd, ["commit", "-m", `wp13 live: ${who} edits ${file}`]);
	return { dir, cwd, push: () => sh(who, cwd, cmds.push) };
};

const lanes: { who: Who; lane: Lane }[] = [];
const dirs: string[] = [];
try {
	const a = await openLane("a");
	lanes.push({ who: "a", lane: a });
	const b = await openLane("b");
	lanes.push({ who: "b", lane: b });
	check(
		"both lanes open",
		a.state === "open" && b.state === "open",
		`${a.mode}/${b.mode}`,
	);
	const wa = await work("a", a, `// wp13 a ${Date.now()}`);
	const wb = await work("b", b, `// wp13 b ${Date.now()}`);
	dirs.push(wa.dir, wb.dir);
	const pa = await wa.push();
	check("lane A push accepted", pa.code === 0);
	const [headA, headB] = [await inboxHead("a"), await inboxHead("b")];
	const t0 = Date.now();
	const pb = await wb.push();
	check("lane B push accepted", pb.code === 0);
	const echoed = pb.stderr.split("\n").filter((l) => l.includes("[radar]"));
	console.log(
		echoed.length > 0
			? `info: push printed ${echoed.length} radar line(s)`
			: "info: no remote: radar lines (echo is M2 / needs S3)",
	);
	const [na, nb] = await Promise.all([
		waitNotice("a", headA, b.id),
		waitNotice("b", headB, a.id),
	]);
	const ms = Date.now() - t0;
	check(
		`owner A told within ${NOTICE_WITHIN_MS} ms`,
		na !== null && na.createdAt - t0 < NOTICE_WITHIN_MS,
		na ? `${na.createdAt - t0} ms after push start; polled ${ms} ms` : "none",
	);
	check(
		`owner B (the pusher) told within ${NOTICE_WITHIN_MS} ms`,
		nb !== null && nb.createdAt - t0 < NOTICE_WITHIN_MS,
		nb ? `${nb.createdAt - t0} ms` : "none",
	);
	check(
		"the notice names a suggestion",
		(nb?.text ?? "").includes("suggestion:"),
	);
} catch (error) {
	check("run", false, error instanceof Error ? error.message : String(error));
} finally {
	for (const { who, lane } of lanes) {
		await api(who, `/-/api/lanes/${lane.id}?repo=${encodeURIComponent(repo)}`, {
			method: "DELETE",
		}).catch(() => undefined);
	}
	for (const dir of dirs) {
		await Deno.remove(dir, { recursive: true }).catch(() => undefined);
	}
}

Deno.exit(results.every((r) => r.ok) ? 0 : 1);
