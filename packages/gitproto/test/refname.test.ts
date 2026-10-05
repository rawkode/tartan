// Refname grammar: our check against stock `git check-ref-format` on a
// corpus of edge cases (receive-pack's "funny refname" rule on top).

import { equal } from "node:assert/strict";
import { checkRefnameFormat, isValidPushRefname } from "../src/index.ts";
import { git, hasGit, makeSandbox } from "./harness/git.ts";

const CORPUS = [
	"refs/heads/main",
	"refs/heads/lanes/ln_01k6abcdefghjkmnpqrstvwxyz",
	"refs/heads/feat/x",
	"refs/tags/v1.0",
	"refs/heads/a.b",
	"refs/heads/über",
	"refs/heads/emoji-🎉",
	"refs/notes/tartan",
	"refs/x",
	"refs/",
	"refs",
	"HEAD",
	"main",
	"refs/heads/",
	"refs//heads/main",
	"/refs/heads/main",
	"refs/heads/main/",
	"refs/heads/.hidden",
	"refs/heads/a..b",
	"refs/heads/a.lock",
	"refs/heads/a.lock/b",
	"refs/heads/a.",
	"refs/heads/a@{b",
	"refs/heads/@",
	"@",
	"refs/heads/a b",
	"refs/heads/a~b",
	"refs/heads/a^b",
	"refs/heads/a:b",
	"refs/heads/a?b",
	"refs/heads/a*b",
	"refs/heads/a[b",
	"refs/heads/a\\b",
	"refs/heads/a\tb",
	"refs/heads/a\x7fb",
	"refs/heads/a\x01b",
	"refs/heads/a\u0085b",
	"refs/heads/-dash",
	"refs/heads/a/.b",
	"refs/heads/a.b.",
	"refs/heads/@{",
	"refs/heads/a@b",
	"refs/heads/lanes",
	"refs/heads/LANES/x",
];

Deno.test("isValidPushRefname: fixed cases", () => {
	equal(isValidPushRefname("refs/heads/main"), true);
	equal(isValidPushRefname("refs/x"), false); // receive-pack's funny refname
	equal(isValidPushRefname("HEAD"), false);
	equal(isValidPushRefname("refs/heads/a..b"), false);
	equal(isValidPushRefname("refs/heads/a.lock"), false);
	equal(isValidPushRefname("refs/heads/a@{1}"), false);
	equal(checkRefnameFormat("heads/main"), true);
	equal(checkRefnameFormat("main"), false);
});

Deno.test({
	name: "checkRefnameFormat agrees with stock git check-ref-format",
	ignore: !hasGit,
	fn: async () => {
		const sandbox = await makeSandbox();
		try {
			for (const name of CORPUS) {
				if (name.includes("\0")) continue;
				const result = await git(sandbox, ["check-ref-format", name], {
					allowFail: true,
				});
				equal(
					checkRefnameFormat(name),
					result.code === 0,
					JSON.stringify(name),
				);
			}
		} finally {
			await sandbox.cleanup();
		}
	},
});
