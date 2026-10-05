// Runner image checks against local Docker (not part of `deno task test`, which
// never needs Docker). Build the image first:
//
//   docker build --platform linux/amd64 -t tartan-runner:wp09 containers/runner
//   deno test -A containers/runner/image.test.ts
//
// They use the exact command strings TartanSandbox sends (`shell.ts`,
// `jobs.ts`, `selftest.ts`), so what passes here is what runs in the
// container: git >= 2.38 with merge-tree, pnpm on PATH, the uid split (a
// `tartan-git` process cannot read a `tartan-push` exec's environ, and the
// pre-push `pkill` leaves no `tartan-git` process), the sessionless checkout
// by SHA, and a 3-job run on a pnpm workspace fixture. The fail-closed build
// cases rebuild with a bad pin and an impossible minimum
// (`TARTAN_RUNNER_BUILD_CASES=1`, slow under emulation).

import { deepEqual, equal, ok } from "node:assert/strict";
import { CHECKOUT_DIR } from "../../src/kernel/runs/jobs.ts";
import {
	parseSelftest,
	SELFTEST_SCRIPT,
} from "../../src/kernel/runs/selftest.ts";
import {
	asUid,
	KILL_CONTENT_UID,
	shellAsUid,
} from "../../src/kernel/runs/shell.ts";

const IMAGE = Deno.env.get("TARTAN_RUNNER_IMAGE") ?? "tartan-runner:wp09";
const HERE = new URL(".", import.meta.url).pathname;

const sh = async (
	cmd: string,
	args: string[],
	options: { cwd?: string; allowFail?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const out = await new Deno.Command(cmd, {
		args,
		cwd: options.cwd,
		stdout: "piped",
		stderr: "piped",
	}).output();
	const result = {
		code: out.code,
		stdout: new TextDecoder().decode(out.stdout),
		stderr: new TextDecoder().decode(out.stderr),
	};
	if (!options.allowFail && out.code !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} failed (${out.code}): ${result.stderr}`,
		);
	}
	return result;
};

/** A running container to `docker exec` into, removed afterwards. */
const withContainer = async (
	fn: (
		exec: (
			command: string,
			env?: Record<string, string>,
			detach?: boolean,
		) => Promise<{ code: number; stdout: string; stderr: string }>,
	) => Promise<void>,
	mounts: string[] = [],
) => {
	const id = (await sh("docker", [
		"run",
		"-d",
		"--rm",
		"--platform",
		"linux/amd64",
		...mounts.flatMap((m) => ["-v", m]),
		"--entrypoint",
		"sleep",
		IMAGE,
		"infinity",
	])).stdout.trim();
	try {
		await fn((command, env = {}, detach = false) =>
			sh("docker", [
				"exec",
				...(detach ? ["-d"] : []),
				...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
				id,
				"bash",
				"-c",
				command,
			], { allowFail: true })
		);
	} finally {
		await sh("docker", ["rm", "-f", id], { allowFail: true });
	}
};

Deno.test("selftest: git >= 2.38 with merge-tree, pnpm for tartan-git, both users", async () => {
	await withContainer(async (exec) => {
		const out = await exec(SELFTEST_SCRIPT);
		const info = parseSelftest(out.stdout, 0);
		ok(info.ok, JSON.stringify(info));
		ok(info.image?.base.includes("@sha256:"), "base pinned by digest");
		const pnpm = await exec(asUid("tartan-git", ["pnpm", "--version"]), {
			HOME: "/home/tartan-git",
		});
		equal(pnpm.code, 0);
		equal(pnpm.stdout.trim(), info.pnpmVersion);
	});
});

Deno.test("uid split: tartan-git cannot read a tartan-push environ; pkill leaves no tartan-git process", async () => {
	await withContainer(async (exec) => {
		const secret =
			"art_v2_x_0000000000000000000000000000000000000001?expires=1";
		await exec(
			asUid("tartan-push", ["sleep", "60"]),
			{ PUSH_TOKEN: secret },
			true,
		);
		await exec(
			asUid("tartan-git", ["sleep", "300"]),
			{ MARK: "same-uid" },
			true,
		);
		await exec("sleep 2");
		const pid = (await exec("pgrep -u tartan-push -x sleep")).stdout.trim();
		ok(/^\d+$/.test(pid), `tartan-push sleep running: ${pid}`);
		const peek = await exec(
			asUid("tartan-git", ["cat", `/proc/${pid}/environ`]),
		);
		ok(peek.code !== 0, "reading another uid's environ fails");
		equal(peek.stdout.includes("PUSH_TOKEN"), false);
		// Sanity: the same read works for a process of the reader's own uid.
		const own = (await exec("pgrep -u tartan-git -x sleep")).stdout.trim();
		ok(
			(await exec(asUid("tartan-git", ["cat", `/proc/${own}/environ`])))
				.stdout.includes("MARK=same-uid"),
			"tartan-git reads its own process's environ",
		);
		const before = await exec("pgrep -u tartan-git");
		ok(before.stdout.trim() !== "", "a tartan-git process is running");
		equal((await exec(KILL_CONTENT_UID)).code, 0);
		await exec("sleep 1");
		const after = await exec("pgrep -u tartan-git");
		equal(
			after.code,
			1,
			"no tartan-git process survives into a write-token exec",
		);
		equal(
			(await exec(KILL_CONTENT_UID)).code,
			0,
			"pkill with nothing to kill is success",
		);
	});
});

const fixture = async (): Promise<{ dir: string; sha: string }> => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-fixture-" });
	const work = `${dir}/work`;
	const write = (path: string, text: string) =>
		Deno.mkdir(`${work}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true })
			.then(() => Deno.writeTextFile(`${work}/${path}`, text));
	await write(
		"package.json",
		JSON.stringify({
			name: "fixture",
			private: true,
			scripts: { lint: "pnpm -r run lint", test: "pnpm -r test" },
		}),
	);
	await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
	for (const name of ["a", "b"]) {
		await write(
			`packages/${name}/package.json`,
			JSON.stringify({
				name,
				version: "1.0.0",
				scripts: {
					lint: `node -e "console.log('lint ${name} ok')"`,
					test: `node -e "console.log('test ${name}: 1 passed')"`,
				},
			}),
		);
	}
	const git = (args: string[], cwd = work) => sh("git", args, { cwd });
	await git(["init", "-q", "-b", "main", "."]);
	await git(["add", "-A"]);
	await git([
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"fixture",
	]);
	const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
	await sh("git", ["clone", "-q", "--bare", work, `${dir}/fixture.git`]);
	await git(
		["config", "uploadpack.allowAnySHA1InWant", "true"],
		`${dir}/fixture.git`,
	);
	return { dir, sha };
};

Deno.test("a 3-job run on a pnpm workspace fixture: checkout by SHA, then install, lint and test as tartan-git", async () => {
	const { dir, sha } = await fixture();
	try {
		await withContainer(async (exec) => {
			// prepare(): the same setup and checkout commands as jobs.ts.
			equal(
				(await exec(
					`rm -rf ${CHECKOUT_DIR} && install -d -o tartan-git -g tartan-git ${CHECKOUT_DIR}`,
				)).code,
				0,
			);
			const script = [
				'cd "$1"',
				"git init -q .",
				'git fetch -q --depth=1 --no-tags "$2" "$3"',
				'git checkout -q --detach "$3"',
				'test "$(git rev-parse HEAD)" = "$3"',
			].join(" && ");
			const checkout = await exec(
				asUid("tartan-git", [
					"bash",
					"-eo",
					"pipefail",
					"-c",
					script,
					"checkout",
					CHECKOUT_DIR,
					"file:///fixture/fixture.git",
					sha,
				]),
				{ HOME: "/home/tartan-git" },
			);
			equal(checkout.code, 0, checkout.stderr);
			const jobs = [
				["install", "pnpm install"],
				["lint", "pnpm lint"],
				["test", "pnpm test"],
			] as const;
			const results: Record<string, number> = {};
			for (const [id, run] of jobs) {
				const out = await exec(
					`cd ${CHECKOUT_DIR} && ${shellAsUid("tartan-git", run)}`,
					{
						HOME: "/home/tartan-git",
						CI: "true",
						TARTAN_JOB_ID: id,
					},
				);
				results[id] = out.code;
				if (id === "test") {
					ok(out.stdout.includes("test a: 1 passed"));
					ok(out.stdout.includes("test b: 1 passed"));
				}
			}
			deepEqual(results, { install: 0, lint: 0, test: 0 });
			const owner = await exec(`stat -c %U ${CHECKOUT_DIR}/node_modules`);
			equal(owner.stdout.trim(), "tartan-git");
		}, [`${dir}:/fixture:ro`]);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

/**
 * The image's own control plane (the Sandbox SDK container server on port
 * 3000), driven over HTTP the way the SDK client does, to pin two SDK
 * behaviours the runner relies on.
 */
const withServer = async (
	fn: (
		call: (path: string, body?: unknown) => Promise<Response>,
	) => Promise<void>,
) => {
	const id = (await sh("docker", [
		"run",
		"-d",
		"--rm",
		"--platform",
		"linux/amd64",
		"-p",
		"127.0.0.1::3000",
		IMAGE,
	])).stdout.trim();
	try {
		const port = (await sh("docker", ["port", id, "3000/tcp"])).stdout.trim()
			.split(":").at(-1);
		const call = (path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const start = Date.now();
		while (true) {
			try {
				const res = await call("/api/execute", {
					command: "true",
					sessionId: "__DISABLE_SESSION__",
				});
				await res.body?.cancel();
				if (res.ok) break;
			} catch { /* not up yet */ }
			if (Date.now() - start > 180_000) {
				throw new Error("server never came up");
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		await fn(call);
	} finally {
		await sh("docker", ["rm", "-f", id], { allowFail: true });
	}
};

Deno.test("SDK server: sessionless execs keep no env; a late log stream replays earlier output", async () => {
	await withServer(async (call) => {
		const a = await (await call("/api/execute", {
			command: 'echo "A=${T:-unset}"; export B=1; cd /tmp',
			sessionId: "__DISABLE_SESSION__",
			env: { T: "per-exec" },
		})).json() as { stdout: string };
		ok(a.stdout.includes("A=per-exec"), JSON.stringify(a));
		const b = await (await call("/api/execute", {
			command: 'echo "T=${T:-unset} B=${B:-unset} pwd=$(pwd)"',
			sessionId: "__DISABLE_SESSION__",
		})).json() as { stdout: string };
		ok(b.stdout.includes("T=unset B=unset"), b.stdout);
		equal(b.stdout.includes("pwd=/tmp"), false);

		const started = await (await call("/api/process/start", {
			command: "echo early; sleep 3; echo late",
			sessionId: "__DISABLE_SESSION__",
			autoCleanup: false,
		})).json() as { processId: string };
		await new Promise((r) => setTimeout(r, 1500));
		const text = await (await call(`/api/process/${started.processId}/stream`))
			.text();
		ok(text.includes("early"), `late attach replays: ${text.slice(0, 400)}`);
		ok(text.includes("late"));
		const again = await (await call(`/api/process/${started.processId}/stream`))
			.text();
		ok(
			again.includes("early") && again.includes("late"),
			"a second attach replays all",
		);
	});
});

Deno.test({
	name:
		"the build fails closed on an unavailable git pin and on git below the minimum",
	ignore: Deno.env.get("TARTAN_RUNNER_BUILD_CASES") !== "1",
	fn: async () => {
		const build = (arg: string) =>
			sh("docker", [
				"build",
				"--platform",
				"linux/amd64",
				"--build-arg",
				arg,
				"--progress=plain",
				HERE,
			], { allowFail: true });
		const minimum = await build("GIT_MIN=99.0");
		ok(minimum.code !== 0, "git older than GIT_MIN fails the build");
		ok(minimum.stderr.includes("is older than 99.0"));
		const pin = await build("GIT_DEB=1:0.0.0-0ppa0~ubuntu22.04.1");
		ok(pin.code !== 0, "an unavailable .deb fails the build");
	},
});
