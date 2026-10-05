// The kernel's ref-only receive-pack client: only advertised capabilities,
// and an empty answer is an error.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fromRpcError, ZERO_SHA } from "@tartan/contract";
import { encodeRefPush, pushRefsCompat } from "./refpush.ts";

const SHA = "a".repeat(40);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

Deno.test("the request asks for report-status and side-band-64k only", async () => {
	const body = text(
		await encodeRefPush([{
			ref: "refs/tartan/changes/x",
			old: ZERO_SHA,
			new: SHA,
		}]),
	);
	ok(
		body.includes("\0report-status side-band-64k agent=git/tartan-gitproto"),
		body,
	);
	ok(body.includes("0000PACK"), "an empty pack after the flush");
	const del = text(
		await encodeRefPush([{ ref: "refs/tartan/x", old: SHA, new: ZERO_SHA }]),
	);
	ok(del.endsWith("0000"), "delete-only: no pack");
});

Deno.test("statuses per command; an empty 200 is an error, not success", async () => {
	const answer = (body: string) => () =>
		Promise.resolve(
			new Response(body, {
				status: 200,
				headers: { "content-type": "application/x-git-receive-pack-result" },
			}),
		);
	const pkt = (s: string) =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const report = `${pkt("unpack ok\n")}${pkt("ok refs/tartan/x\n")}${
		pkt("ng refs/tartan/y stale ref\n")
	}0000`;
	deepStrictEqual(
		await pushRefsCompat(
			{
				url: "https://r",
				authorization: "Bearer t",
				fetch: answer(report) as typeof fetch,
			},
			[
				{ ref: "refs/tartan/x", old: ZERO_SHA, new: SHA },
				{ ref: "refs/tartan/y", old: ZERO_SHA, new: SHA },
			],
		),
		[
			{ ref: "refs/tartan/x", ok: true },
			{ ref: "refs/tartan/y", ok: false, reason: "stale ref" },
		],
	);
	const dropped = await pushRefsCompat(
		{
			url: "https://r",
			authorization: "Bearer t",
			fetch: answer("") as typeof fetch,
		},
		[{ ref: "refs/tartan/x", old: ZERO_SHA, new: SHA }],
	).catch((e) => fromRpcError(e));
	equal((dropped as { code: string }).code, "unavailable");
	await rejects(
		pushRefsCompat(
			{
				url: "https://r",
				authorization: "Bearer t",
				fetch: (() =>
					Promise.resolve(
						new Response("no", { status: 503 }),
					)) as typeof fetch,
			},
			[{ ref: "refs/tartan/x", old: ZERO_SHA, new: SHA }],
		),
	);
});
