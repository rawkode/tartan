// WP6 live acceptance: the `/-/live` WebSocket through the
// deployed (custom) domain and the chain verification endpoint.
//
//   deno task live -- --stage dev wp06 --origin https://code.example.com \
//     --repo <repoUlid> [--min-events 10000]
//
// Credentials come from the environment and are never printed:
//   TARTAN_SESSION  value of the `__Host-tartan-session` cookie (for /-/live)
//   TARTAN_TOKEN    a PAT with the `api` scope (for /-/api/events)
//
// Checks:
//   1. an upgrade with a foreign Origin is refused (no 101);
//   2. an upgrade with the canonical Origin answers `hello` with the head;
//   3. `/-/api/events?verify=1` verifies the whole chain in pages of
//      VERIFY_MAX_RANGE positions, and the head is ≥ --min-events.
// Exit code 0 only when every check passes.

const VERIFY_PAGE = 100_000;

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};

const fail = (message: string): never => {
	console.error(`wp06: FAIL ${message}`);
	Deno.exit(1);
};

const origin = arg("origin") ?? fail("--origin is required");
const repo = arg("repo") ?? fail("--repo is required");
const minEvents = Number(arg("min-events") ?? "0");
const session = Deno.env.get("TARTAN_SESSION") ?? fail("TARTAN_SESSION unset");
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");

const liveUrl = `${origin.replace(/^http/, "ws")}/-/live?repo=${repo}&since=0`;

type DenoSocketInit = { headers: Record<string, string> };
const open = (
	headerOrigin: string,
): Promise<{ hello?: unknown; refused?: string }> =>
	new Promise((resolve) => {
		const ws = new (WebSocket as unknown as new (
			url: string,
			init: DenoSocketInit,
		) => WebSocket)(liveUrl, {
			headers: {
				origin: headerOrigin,
				cookie: `__Host-tartan-session=${session}`,
			},
		});
		const timer = setTimeout(() => {
			ws.close();
			resolve({ refused: "timeout" });
		}, 10_000);
		ws.onmessage = (e) => {
			clearTimeout(timer);
			ws.close(1000, "done");
			resolve({ hello: JSON.parse(String(e.data)) });
		};
		ws.onerror = () => {
			clearTimeout(timer);
			resolve({ refused: "error" });
		};
	});

const foreign = await open("https://attacker.example");
if (foreign.hello !== undefined) fail("a foreign Origin was accepted");
console.log("wp06: ok foreign Origin refused");

const own = await open(origin);
const hello = own.hello as { t?: string; head?: number } | undefined;
if (hello?.t !== "hello") fail(`no hello frame (${own.refused ?? "?"})`);
console.log(`wp06: ok hello, head ${hello?.head}`);

const api = async (query: string) => {
	const res = await fetch(`${origin}/-/api/events?repo=${repo}&${query}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!res.ok) fail(`/-/api/events ${query} → ${res.status}`);
	return await res.json();
};

const { head } = await api("limit=1") as { head: number };
if (head < minEvents) fail(`head ${head} < --min-events ${minEvents}`);
const started = performance.now();
for (let from = 1; from <= head; from += VERIFY_PAGE) {
	const to = Math.min(head, from + VERIFY_PAGE - 1);
	const verdict = await api(`verify=1&from=${from}&to=${to}`) as {
		ok: boolean;
		brokenAt?: number;
	};
	if (!verdict.ok) fail(`chain broken at ${verdict.brokenAt}`);
}
console.log(
	`wp06: ok chain verified over ${head} events in ${
		(performance.now() - started).toFixed(0)
	} ms`,
);
