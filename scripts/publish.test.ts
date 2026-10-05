import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { isPublicEmail } from "./check-public.ts";
import {
	identityEnv,
	parseIdentity,
	parsePublishArgs,
	snapshotMessage,
} from "./publish.ts";

Deno.test("publish: arguments default to main on origin without a push", () => {
	deepStrictEqual(parsePublishArgs([]), {
		ref: "main",
		remote: "origin",
		push: false,
		identity: null,
	});
	deepStrictEqual(
		parsePublishArgs([
			"--ref",
			"v1",
			"--remote",
			"up",
			"--identity",
			"A <a@users.noreply.github.com>",
			"--push",
		]),
		{
			ref: "v1",
			remote: "up",
			push: true,
			identity: "A <a@users.noreply.github.com>",
		},
	);
	deepStrictEqual(parsePublishArgs(["--", "--push"]).push, true);
	throws(() => parsePublishArgs(["--ref"]), /needs a value/);
	throws(() => parsePublishArgs(["--ref", "--push"]), /needs a value/);
	throws(() => parsePublishArgs(["--identity"]), /needs a value/);
	throws(() => parsePublishArgs(["--force"]), /unknown argument/);
});

Deno.test("publish: the identity is a name and a noreply address, for author and committer", () => {
	const identity = parseIdentity(
		"Tartan Maintainer <maint@users.noreply.github.com>",
	);
	deepStrictEqual(identity, {
		name: "Tartan Maintainer",
		email: "maint@users.noreply.github.com",
	});
	deepStrictEqual(identityEnv(identity), {
		GIT_AUTHOR_NAME: "Tartan Maintainer",
		GIT_AUTHOR_EMAIL: "maint@users.noreply.github.com",
		GIT_COMMITTER_NAME: "Tartan Maintainer",
		GIT_COMMITTER_EMAIL: "maint@users.noreply.github.com",
	});
	equal(parseIdentity("X <noreply@example.org>").email, "noreply@example.org");
	throws(() => parseIdentity("Someone <someone@example.org>"), /noreply/);
	throws(() => parseIdentity("no address"), /Name <email>/);
	throws(
		() => parseIdentity("<maint@users.noreply.github.com>"),
		/Name <email>/,
	);
});

Deno.test("publish: only noreply addresses are public emails", () => {
	ok(isPublicEmail("12345+maint@users.noreply.github.com"));
	ok(isPublicEmail("noreply@github.com"));
	ok(!isPublicEmail("maint@example.org"));
	ok(!isPublicEmail("maint@users.noreply.github.com.example.org"));
	ok(!isPublicEmail(""));
});

Deno.test("publish: snapshot messages are neutral and carry no source commit", () => {
	const initial = snapshotMessage(true);
	equal(initial.split("\n")[0], "Tartan: initial public snapshot");
	const later = snapshotMessage(false);
	equal(later.split("\n")[0], "Tartan: public snapshot");
	ok(later.includes("Co-Authored-By: Claude Opus 5.5"));
	ok(!/[0-9a-f]{40}/.test(later));
	equal(later.split("\n").filter((line) => line.startsWith("- ")).length, 0);
});
