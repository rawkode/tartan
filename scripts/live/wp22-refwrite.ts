// WP22 live acceptance (U46, U48): the ref-only receive-pack client creates
// `refs/tartan/attic/…` at an existing commit with an empty pack (U46), is
// refused for a create of an existing ref and for an update or delete with a
// wrong old id (U48), moves and deletes the ref with the right old id, and
// reads it back with v2 ls-refs.
//
// Usage:
//   deno task live -- wp22 --local
//       runs against a local `git http-backend` (no Cloudflare, no credential)
//   TARTAN_LIVE_GIT_AUTH='Bearer <token>' deno task live -- --stage dev wp22 --remote <repo url>
//       runs against an Artifacts repo of the `dev` stage; the token is a
//       short-lived write token for that one repo, minted by the operator. It
//       is read from the environment only and never printed.
//
// Exit code 0 when every step matches; each step prints one line.

import {
	type GitRemote,
	lsRefs,
	pushRefs,
} from "../../packages/gitproto/src/index.ts";
import {
	git,
	initBare,
	initWork,
	revParse,
	withGitServer,
} from "../../packages/gitproto/test/harness/git.ts";

const ZERO = "0".repeat(40);

type Step = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
};

export const runRefWrite = async (remote: GitRemote): Promise<Step[]> => {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail = "") => {
		steps.push({ name, ok, detail });
		console.log(
			`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`,
		);
	};
	const refs = await lsRefs(remote, { symrefs: true });
	const head = refs.find((r) => r.ref === "HEAD") ??
		refs.find((r) => r.ref.startsWith("refs/heads/"));
	if (!head) {
		step("the repo has a commit to point at", false, "empty repository");
		return steps;
	}
	const base = head.sha;
	const other = refs.find((r) => r.sha !== base && /^refs\/heads\//.test(r.ref))
		?.sha;
	const attic = `refs/tartan/attic/wp22-live-${Date.now().toString(36)}`;
	const [created] = await pushRefs(remote, [{
		ref: attic,
		old: ZERO,
		new: base,
	}]);
	step(
		"U46: create a ref at an existing commit with an empty pack",
		created.ok,
		created.ok ? "" : created.reason,
	);
	const listed = await lsRefs(remote, { refPrefixes: ["refs/tartan/attic/"] });
	step(
		"ls-refs with ref-prefix reads it back",
		listed.some((r) => r.ref === attic && r.sha === base),
	);
	const [again] = await pushRefs(remote, [{
		ref: attic,
		old: ZERO,
		new: base,
	}]);
	step(
		"U48: create of an existing ref gets ng",
		!again.ok,
		again.ok ? "accepted" : again.reason,
	);
	const wrong = other ?? base.replace(/^./, (c) => (c === "0" ? "1" : "0"));
	const [stale] = await pushRefs(remote, [{
		ref: attic,
		old: wrong,
		new: base,
	}]);
	step(
		"U48: update with a wrong old id gets ng",
		!stale.ok,
		stale.ok ? "accepted" : stale.reason,
	);
	const [badDelete] = await pushRefs(remote, [{
		ref: attic,
		old: wrong,
		new: ZERO,
	}]);
	step(
		"delete with a wrong old id gets ng",
		!badDelete.ok,
		badDelete.ok ? "accepted" : badDelete.reason,
	);
	const [deleted] = await pushRefs(remote, [{
		ref: attic,
		old: base,
		new: ZERO,
	}]);
	step(
		"delete with the right old id",
		deleted.ok,
		deleted.ok ? "" : deleted.reason,
	);
	const after = await lsRefs(remote, { refPrefixes: [attic] });
	step("the ref is gone", after.length === 0);
	return steps;
};

const local = async (): Promise<Step[]> =>
	await withGitServer(async (sandbox, server) => {
		await initBare(sandbox, "live");
		const work = await initWork(sandbox, "live-work", 2);
		const url = `${server.url}/live.git`;
		await git(sandbox, ["push", "-q", url, "main", "HEAD~1:refs/heads/older"], {
			cwd: work,
		});
		console.log(
			`local git http-backend, main at ${await revParse(
				sandbox,
				work,
				"HEAD",
			)}`,
		);
		return await runRefWrite({
			url,
			authorization: "Bearer local-harness-accepts-anything",
		});
	});

const main = async (): Promise<number> => {
	const args = Deno.args;
	const remoteIndex = args.indexOf("--remote");
	let steps: Step[];
	if (remoteIndex >= 0) {
		const url = args[remoteIndex + 1];
		const authorization = Deno.env.get("TARTAN_LIVE_GIT_AUTH");
		if (!url || !authorization) {
			console.error(
				"wp22: --remote <repo url> needs TARTAN_LIVE_GIT_AUTH in the environment",
			);
			return 2;
		}
		steps = await runRefWrite({ url, authorization });
	} else if (args.includes("--local")) {
		steps = await local();
	} else {
		console.error(
			"wp22: pass --local, or --remote <repo url> with TARTAN_LIVE_GIT_AUTH",
		);
		return 2;
	}
	return steps.length > 0 && steps.every((s) => s.ok) ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
