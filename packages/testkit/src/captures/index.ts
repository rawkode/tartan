// Protocol captures:
// - `stock-git.json`: stock git's requests (clone v0/v2, `ls-remote` with a
//   lane pattern, `fetch` of one lane ref, push update, ref-only create with
//   an empty pack, delete, and a push above `http.postBuffer` with the
//   `0000` probe and a chunked body), recorded against FakeArtifacts' server
//   by `scripts/record-captures.ts`. Requests are git's bytes; responses are
//   the fake's.
// - `push-event-payloads.json`: the shape of `cf.artifacts.repo.pushed`
//   payloads, one per ref update, with synthetic values.
// - The importer's two capability-route requests: `GET info/refs`, then
//   `POST git-upload-pack` with one v0 `want`, a flush and `done` (73 bytes
//   for one SHA), with the importer's user agent and no `Git-Protocol`.

import { fromBase64 } from "../bytes.ts";
import { importerRequestBody } from "../git/client.ts";
import type { FakePushEvent } from "../artifacts/events.ts";
import { IMPORTER_USER_AGENT } from "../artifacts/importer.ts";
import stockGit from "../../captures/stock-git.json" with { type: "json" };
import pushEvents from "../../captures/push-event-payloads.json" with {
	type: "json",
};

export type CaptureExchange = {
	readonly method: string;
	readonly path: string;
	readonly requestHeaders: Readonly<Record<string, string>>;
	readonly request: Uint8Array;
	readonly status: number;
	readonly response: Uint8Array;
};

export type StockGitCapture = {
	readonly id: string;
	readonly title: string;
	readonly command: string;
	readonly exchanges: readonly CaptureExchange[];
};

export const STOCK_GIT_VERSION: string = stockGit.gitVersion;

export const STOCK_GIT_CAPTURES: readonly StockGitCapture[] = stockGit.captures
	.map((c) => ({
		id: c.id,
		title: c.title,
		command: c.command,
		exchanges: c.exchanges.map((e) => ({
			method: e.method,
			path: e.path,
			requestHeaders: e.requestHeaders as Record<string, string>,
			request: fromBase64(e.requestBody),
			status: e.status,
			response: fromBase64(e.responseBody),
		})),
	}));

export const stockGitCapture = (id: string): StockGitCapture => {
	const found = STOCK_GIT_CAPTURES.find((c) => c.id === id);
	if (!found) throw new Error(`unknown capture ${id}`);
	return found;
};

export const PUSH_EVENT_PAYLOADS: readonly {
	readonly label: string;
	readonly event: FakePushEvent;
}[] = pushEvents.events as unknown as {
	label: string;
	event: FakePushEvent;
}[];

/** The importer's requests for a capability URL whose advertised `main` is at `want`. */
export const importerRequests = (capabilityUrl: string, want: string) => [
	new Request(`${capabilityUrl}/info/refs?service=git-upload-pack`, {
		headers: { "user-agent": IMPORTER_USER_AGENT },
	}),
	new Request(`${capabilityUrl}/git-upload-pack`, {
		method: "POST",
		headers: {
			"user-agent": IMPORTER_USER_AGENT,
			"content-type": "application/x-git-upload-pack-request",
			accept: "application/x-git-upload-pack-result",
		},
		body: importerRequestBody(want),
	}),
];

/** The importer's POST body length for one SHA (one want, a flush, done). */
export const IMPORTER_POST_BYTES = 73;
