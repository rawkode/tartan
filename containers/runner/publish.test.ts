import { equal, match, throws } from "node:assert/strict";
import {
	digestRef,
	pushName,
	recordJson,
	requireDigestRef,
} from "./publish.ts";
import { parseImageRecord } from "../../scripts/render-config.ts";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

Deno.test("render-config reads the record publish writes (WP9 → WP21 convention)", () => {
	const ref = digestRef(pushName(COMMIT, new Uint8Array(8)), DIGEST);
	const text = recordJson({ ref, commit: COMMIT, builtAt: "now" });
	equal(
		JSON.stringify(parseImageRecord(text, "runner-image.json")),
		JSON.stringify({ kind: "registry", ref }),
	);
});

Deno.test("publish refuses to emit a tag reference", () => {
	for (
		const ref of [
			"ttl.sh/tartan-runner-x:24h",
			"ttl.sh/tartan-runner-x",
			`ttl.sh/tartan-runner-x:24h@${DIGEST}`,
			`ttl.sh/x@sha256:${"a".repeat(63)}`,
			"docker.io/cloudflare/sandbox:0.12.1",
		]
	) {
		throws(() => requireDigestRef(ref), /only a digest reference/, ref);
		throws(
			() => recordJson({ ref, commit: COMMIT, builtAt: "now" }),
			/only a digest reference/,
		);
	}
	equal(requireDigestRef(`ttl.sh/x@${DIGEST}`), `ttl.sh/x@${DIGEST}`);
});

Deno.test("the push name is unguessable and the recorded ref is digest-only", () => {
	const name = pushName(COMMIT, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	equal(name, "ttl.sh/tartan-runner-0123456789ab-0102030405060708:24h");
	const ref = digestRef(name, DIGEST);
	equal(ref, `ttl.sh/tartan-runner-0123456789ab-0102030405060708@${DIGEST}`);
	match(
		recordJson({ ref, commit: COMMIT, builtAt: "2026-10-02T00:00:00Z" }),
		/"ref": "ttl\.sh\/tartan-runner-[0-9a-f-]+@sha256:[0-9a-f]{64}"/,
	);
	throws(() => pushName(COMMIT, new Uint8Array(4)), /64 random bits/);
	throws(() => digestRef(name, "sha256:short"), /bad digest/);
});
