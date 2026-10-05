// WP19 live check: every coordination view's page is
// served by the SPA and every API it reads answers on a seeded dev stage, so
// a recorded walkthrough cannot hit a dead screen. HTTP only (the browser
// walkthrough is recorded by hand or with the e2e suite).
//
//   TARTAN_TOKEN=… deno task live -- --stage dev wp19 \
//     --origin https://<dev host> [--repo rawkode/platform/edge/router] \
//     [--file services/api/src/server.ts]
//
// TARTAN_TOKEN: a PAT with the `api` scope of a member of the repo, never
// printed. Exit code 0 only when every check passes.

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const fail = (message: string): never => {
	console.error(`wp19: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");
const repo = arg("repo") ?? "rawkode/platform/edge/router";
const file = arg("file") ?? "README.md";
const ns = repo.split("/")[0]!;
const q = encodeURIComponent;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const get = async (path: string, auth = true) => {
	const res = await fetch(`${origin}${path}`, {
		headers: auth ? { authorization: `Bearer ${token}` } : {},
		redirect: "manual",
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// HTML or text
	}
	return { status: res.status, body };
};

// The SPA shell answers every view route (the router is client-side).
for (
	const page of [
		"/",
		`/-/hud?node=${q(ns)}`,
		`/${repo}/-/lanes`,
		`/${repo}/-/runs`,
		`/${repo}/-/advances`,
		`/${repo}/-/blame/main/${file}`,
	]
) {
	const res = await fetch(`${origin}${page}`, { redirect: "manual" });
	await res.body?.cancel();
	check(
		`page ${page}`,
		res.status === 200 || res.status === 302,
		String(res.status),
	);
}

const view = await get(`/-/api/view?path=${q(repo)}&view=`);
check("repo view", view.status === 200, String(view.status));
const repoId = (view.body as { repo?: { id: string } }).repo?.id ?? "";

const hud = await get(`/-/api/view?path=${q(ns)}&view=hud`);
check("HUD view (namespace)", hud.status === 200, String(hud.status));
const metrics = ((hud.body as { slots?: { slot: string }[] }).slots ?? [])
	.filter((s) => s.slot === "hud.metric");
check("HUD metrics in force", metrics.length >= 5, `${metrics.length} metrics`);
const home = await get(`/-/api/view?path=${q(ns)}&view=home`);
check("home view (namespace)", home.status === 200, String(home.status));

const lanes = await get(
	`/-/api/lanes?repo=${q(repo)}&state=${
		q("opening,open,submitted,landing")
	}&limit=200`,
);
check(
	"Lanes / Change Graph: lanes",
	lanes.status === 200,
	String(lanes.status),
);
const events = await get(`/-/api/events?repo=${q(repoId)}&limit=1`);
check(
	"Lanes / Change Graph: event log",
	events.status === 200,
	String(events.status),
);
const runs = await get(`/-/api/runs/${q(repoId)}?limit=50`);
check("Runs", runs.status === 200, String(runs.status));
const advances = await get(`/-/api/advances?repo=${q(repo)}&limit=50`);
check("Advances", advances.status === 200, String(advances.status));
const log = await get(`/-/api/log?repo=${q(repo)}&ref=main&path=${q(file)}`);
check("Why-blame: file history", log.status === 200, String(log.status));
const why = await get(`/-/api/why?repo=${q(repo)}&path=${q(file)}`);
check(
	"Why-blame: why answer (404 when nothing landed yet)",
	why.status === 200 || why.status === 404,
	String(why.status),
);

const failed = results.filter((r) => !r.ok);
console.log(`wp19: ${results.length - failed.length}/${results.length} passed`);
Deno.exit(failed.length === 0 ? 0 : 1);
