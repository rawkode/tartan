import { deepEqual, equal, throws } from "node:assert/strict";
import {
	argvToCommand,
	asUid,
	gitAuthEnv,
	safeRelativePath,
	shellAsUid,
	shellQuote,
} from "./shell.ts";

Deno.test("shellQuote leaves safe words bare and quotes everything else", () => {
	equal(shellQuote("git"), "git");
	equal(shellQuote("refs/heads/main"), "refs/heads/main");
	equal(shellQuote(""), "''");
	equal(shellQuote("a b"), "'a b'");
	equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
	equal(shellQuote("it's"), `'it'"'"'s'`);
	equal(shellQuote("x;y|z&`w`"), "'x;y|z&`w`'");
});

Deno.test("argv becomes one quoted command; empty argv is refused", () => {
	equal(
		argvToCommand(["git", "commit", "-m", "a 'b' $c"]),
		`git commit -m 'a '"'"'b'"'"' $c'`,
	);
	throws(() => argvToCommand([]));
});

Deno.test("asUid drops to the runner user with setpriv and keeps env", () => {
	equal(
		asUid("tartan-push", ["git", "push", "origin", "x:y"]),
		"setpriv --reuid=tartan-push --regid=tartan-push --init-groups -- git push origin x:y",
	);
	equal(
		shellAsUid("tartan-git", "pnpm test && echo $HOME"),
		"setpriv --reuid=tartan-git --regid=tartan-git --init-groups -- bash -eo pipefail -c 'pnpm test && echo $HOME'",
	);
});

Deno.test("gitAuthEnv puts one extraHeader per remote in GIT_CONFIG_*", () => {
	const env = gitAuthEnv([
		{ remote: "https://a/r.git", token: "art_v2_x_1?expires=2" },
	]);
	deepEqual(env, {
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: "3",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "protocol.version",
		GIT_CONFIG_VALUE_1: "2",
		GIT_CONFIG_KEY_2: "http.https://a/r.git.extraHeader",
		GIT_CONFIG_VALUE_2: "Authorization: Bearer art_v2_x_1?expires=2",
	});
});

Deno.test("job cwd stays inside the checkout", () => {
	equal(safeRelativePath(""), "");
	equal(safeRelativePath("./apps/web/"), "apps/web");
	equal(safeRelativePath("/etc"), null);
	equal(safeRelativePath("apps/../.."), null);
	equal(safeRelativePath("a//b"), null);
});
