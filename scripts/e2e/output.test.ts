// What leaves an e2e run: masked child output, trace unzipping, the leak
// scan over the output directory, and the session sweep of retained traces.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { scanOutput, scanText, sessionCookiesInZip } from "./leakscan.ts";
import { createMasker, MASK, pipeMasked } from "./mask.ts";
import { writeZip } from "./testing/zipwriter.ts";
import { sweepTraces } from "./traces.ts";
import { readZip, ZipError } from "./zip.ts";

const TPAT = `tpat_${"A".repeat(43)}`;
const TAGT = `tagt_${"b".repeat(42)}-`;
const SESSION = "s".repeat(43);
const OTHER_SESSION = "t".repeat(43);

Deno.test("the masker hides tokens, cookies, bearer values, codes and known secrets", () => {
	const mask = createMasker(["hunter2-password-value", "short"]);
	const text = [
		`token ${TPAT} and ${TAGT}`,
		`cookie: __Host-tartan-session=${SESSION}; __Host-tartan-login-0a1b=${SESSION}`,
		"Authorization: Bearer abcdefghijklmnop",
		"https://tartan-dev-e2e.x.workers.dev/-/setup#t=SECRET-SETUP-TOKEN",
		"https://tartan-dev-e2e.x.workers.dev/-/auth/callback?code=ccccccccccccccccccccc&state=s",
		"password hunter2-password-value and short",
	].join("\n");
	const out = mask(text);
	for (
		const secret of [
			TPAT,
			TAGT,
			SESSION,
			"abcdefghijklmnop",
			"SECRET-SETUP-TOKEN",
			"ccccccccccccccccccccc",
			"hunter2-password-value",
		]
	) {
		equal(out.includes(secret), false, secret);
	}
	ok(out.includes(`__Host-tartan-session=${MASK}`));
	ok(out.includes("Bearer <redacted>"));
	ok(out.includes("and short"), "values under 6 characters are left alone");
});

Deno.test("masked piping never splits a secret across writes", async () => {
	const mask = createMasker();
	const chunks = [`first ${TPAT.slice(0, 20)}`, `${TPAT.slice(20)} end\nlast`];
	const encoder = new TextEncoder();
	const source = new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
			c.close();
		},
	});
	const written: string[] = [];
	await pipeMasked(source, {
		write: (p) => {
			written.push(new TextDecoder().decode(p));
			return Promise.resolve(p.length);
		},
	}, mask);
	equal(written.join(""), `first ${MASK} end\nlast`);
});

Deno.test("the zip reader reads stored and deflate entries", async () => {
	for (const deflate of [false, true]) {
		const zip = await writeZip({
			"trace.network": "line one\nline two",
			"resources/": "",
			"resources/a.json": '{"a":1}',
		}, { deflate });
		const entries = await readZip(zip);
		deepStrictEqual(
			entries.map((e) => e.name),
			["trace.network", "resources/a.json"],
		);
		equal(new TextDecoder().decode(entries[0].data), "line one\nline two");
	}
	await rejects(
		readZip(new TextEncoder().encode("not a zip at all")),
		ZipError,
	);
});

Deno.test("report files: any token, session cookie, code or known secret is a leak", () => {
	const ctx = {
		secrets: ["owner-password-0123456789"],
		revoked: new Set([SESSION]),
	};
	const rules = (text: string) =>
		scanText("summary.md", text, "report", ctx).leaks.map((l) => l.rule);
	deepStrictEqual(rules(`minted ${TPAT}`), ["tartan-token"]);
	deepStrictEqual(rules(`__Host-tartan-session=${SESSION}`), [
		"session-cookie",
	]);
	deepStrictEqual(rules(`callback?code=${"c".repeat(43)}&state=x`), [
		"idp-code",
	]);
	deepStrictEqual(rules("typed owner-password-0123456789"), ["known-secret"]);
	deepStrictEqual(
		rules("value <secret:owner.password> and Bearer <secret:owner-pat>"),
		[],
	);
	deepStrictEqual(
		rules('claude mcp add … --header "Authorization: Bearer $TARTAN_TOKEN"'),
		[],
	);
	deepStrictEqual(rules(`"/-/setup#t=${"x".repeat(43)}"`), ["setup-url-token"]);
});

Deno.test("traces: revoked sessions and spent codes pass, anything else leaks", () => {
	const ctx = { secrets: [], revoked: new Set([SESSION]) };
	const verdict = (text: string) =>
		scanText("trace.zip!/trace.network", text, "trace", ctx);
	const ok1 = verdict(
		`{"name":"cookie","value":"__Host-tartan-session=${SESSION}"} ?code=${
			"c".repeat(43)
		}`,
	);
	equal(ok1.leaks.length, 0);
	equal(ok1.revoked, 1);
	equal(ok1.spent, 1);
	equal(
		verdict(`__Host-tartan-session=${OTHER_SESSION}`).leaks[0]?.rule,
		"session-cookie",
	);
	equal(verdict(`Bearer ${TPAT}`).leaks.length > 0, true);
});

Deno.test("scanOutput unzips traces and reports unreadable ones", async () => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-e2e-scan-" });
	try {
		await Deno.mkdir(`${dir}/artifacts/t1/trace`, { recursive: true });
		await Deno.writeFile(
			`${dir}/artifacts/t1/trace/trace.zip`,
			await writeZip({
				"trace.network":
					`{"value":"__Host-tartan-session=${SESSION}"}\n{"value":"__Host-tartan-session=${OTHER_SESSION}"}`,
			}, { deflate: true }),
		);
		await Deno.writeTextFile(
			`${dir}/artifacts/t1/trace/broken.zip`,
			"PK\u0003\u0004 nope",
		);
		await Deno.writeTextFile(`${dir}/summary.md`, "# 3 passed\n");
		const result = await scanOutput(dir, {
			secrets: [],
			revoked: new Set([SESSION]),
		});
		equal(result.revokedSessions, 1);
		equal(result.leaks.length, 1);
		equal(result.leaks[0].rule, "session-cookie");
		ok(result.leaks[0].file.endsWith("trace.zip!/trace.network"));
		equal(result.leaks[0].file.includes(OTHER_SESSION), false);
		equal(result.unreadable.length, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("the trace sweep ends every session it finds and deletes traces when one fails", async () => {
	const files = new Map<string, Uint8Array>([
		[
			"out/artifacts/a/trace/trace.zip",
			await writeZip({
				"0-trace.network": `cookie: __Host-tartan-session=${SESSION}`,
			}),
		],
		[
			"out/artifacts/b/trace/trace.zip",
			await writeZip({
				"0-trace.network":
					`cookie: __Host-tartan-session=${OTHER_SESSION}; x=1`,
			}),
		],
		["out/summary.md", new TextEncoder().encode("ok")],
	]);
	const fs = {
		walk: (dir: string) =>
			Promise.resolve([...files.keys()].filter((f) => f.startsWith(dir))),
		read: (f: string) => Promise.resolve(files.get(f) ?? new Uint8Array()),
		remove: (f: string) => {
			files.delete(f);
			return Promise.resolve();
		},
	};
	const ended: string[] = [];
	const kept = await sweepTraces({
		fs,
		outputDir: "out",
		signOut: (s) => {
			ended.push(s);
			return Promise.resolve(true);
		},
		drop: false,
		log: () => {},
	});
	equal(kept.traces, 2);
	equal(kept.revoked.size, 2);
	equal(kept.deleted, false);
	deepStrictEqual(ended.sort(), [SESSION, OTHER_SESSION].sort());

	const failing = await sweepTraces({
		fs,
		outputDir: "out",
		signOut: (s) => Promise.resolve(s === SESSION),
		drop: false,
		log: () => {},
	});
	equal(failing.failed, 1);
	equal(failing.deleted, true);
	equal([...files.keys()].some((f) => f.endsWith(".zip")), false);
	ok(files.has("out/summary.md"));
	deepStrictEqual(
		[...await sessionCookiesInZip(await writeZip({ x: "no cookies" }))],
		[],
	);
});
