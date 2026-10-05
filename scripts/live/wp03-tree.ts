// WP3 live acceptance: on a claimed stage, create a
// 4-level path ending in a repo, import a public repo, browse tree, blob and
// raw (with the sandbox CSP), and move a group to see the 301.
//
//   deno task live -- --stage dev wp03 --origin https://tartan-dev.example.workers.dev \
//     --parent <an existing node path the token may create under> \
//     [--import-url https://github.com/<owner>/<small-public-repo>.git] [--keep]
//
// Credentials come from the environment and are never printed:
//   TARTAN_TOKEN  a PAT with the `api`, `repo:read` and `repo:write` scopes
//                 (plus `admin` for the final archive) of a Maintainer+ at
//                 --parent; an Owner there for the move.
//
// Checks (each prints `wp03: ok …` or exits 1 with `wp03: FAIL …`):
//   1. groups <parent>/wp03-<id>/platform/edge and the repo …/edge/router;
//   2. the repo's tree at main lists README.md; its blob is text;
//   3. raw README.md is text/plain with `CSP: sandbox; default-src 'none'`
//      and `nosniff`;
//   4. an import of --import-url (if given) has a non-empty tree;
//   5. renaming platform → core answers 301 for the old raw path;
//   6. the test group is archived (unless --keep).

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};

const fail = (message: string): never => {
	console.error(`wp03: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const parent = arg("parent") ?? fail("--parent is required");
const importUrl = arg("import-url");
const keep = Deno.args.includes("--keep");
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");

const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};

const api = async (
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
	const res = await fetch(`${origin}${path}`, {
		method,
		headers,
		redirect: "manual",
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : {} };
};

const expectStatus = (
	what: string,
	got: { status: number; json: Record<string, unknown> },
	want: number,
) => {
	if (got.status !== want) {
		fail(`${what}: ${got.status} ${JSON.stringify(got.json).slice(0, 300)}`);
	}
};

const suffix = crypto.randomUUID().slice(0, 8);
const base = `${parent}/wp03-${suffix}`;

// 1. Groups and the repo.
expectStatus(
	"group",
	await api("POST", "/-/api/nodes", {
		parent,
		kind: "group",
		slug: `wp03-${suffix}`,
	}),
	201,
);
for (
	const [under, slug] of [[base, "platform"], [`${base}/platform`, "edge"]]
) {
	expectStatus(
		`group ${slug}`,
		await api("POST", "/-/api/nodes", { parent: under, kind: "group", slug }),
		201,
	);
}
const repoPath = `${base}/platform/edge/router`;
const created = await api("POST", "/-/api/nodes/repos", {
	parent: `${base}/platform/edge`,
	slug: "router",
});
expectStatus("repo create", created, 201);
console.log(`wp03: ok created ${repoPath}`);

// 2. Tree and blob.
const q = (params: Record<string, string>) =>
	new URLSearchParams(params).toString();
const tree = await api("GET", `/-/api/tree?${q({ repo: repoPath })}`);
expectStatus("tree", tree, 200);
const entries = (tree.json.entries ?? []) as { name: string }[];
if (!entries.some((e) => e.name === "README.md")) fail("no README.md at main");
const blob = await api(
	"GET",
	`/-/api/blob?${q({ repo: repoPath, path: "README.md" })}`,
);
expectStatus("blob", blob, 200);
if (typeof blob.json.text !== "string") fail("README.md is not inline text");
console.log(`wp03: ok tree and blob at ${tree.json.sha}`);

// 3. Raw.
const raw = await fetch(`${origin}/${repoPath}/-/raw/main/README.md`, {
	headers: { authorization: `Bearer ${token}` },
	redirect: "manual",
});
await raw.arrayBuffer();
if (raw.status !== 200) fail(`raw ${raw.status}`);
if (raw.headers.get("content-type") !== "text/plain; charset=utf-8") {
	fail(`raw content-type ${raw.headers.get("content-type")}`);
}
if (
	raw.headers.get("content-security-policy") !== "sandbox; default-src 'none'"
) {
	fail(`raw CSP ${raw.headers.get("content-security-policy")}`);
}
if (raw.headers.get("x-content-type-options") !== "nosniff") {
	fail("raw without nosniff");
}
console.log("wp03: ok raw with CSP sandbox and nosniff");

// 4. Import.
if (importUrl !== undefined) {
	const started = performance.now();
	const imported = await api("POST", "/-/api/nodes/repos", {
		parent: base,
		slug: "imported",
		import: { url: importUrl },
	});
	expectStatus("import", imported, 201);
	const importedTree = await api(
		"GET",
		`/-/api/tree?${q({ repo: `${base}/imported` })}`,
	);
	expectStatus("imported tree", importedTree, 200);
	if (((importedTree.json.entries ?? []) as unknown[]).length === 0) {
		fail("the imported repo's tree is empty");
	}
	console.log(
		`wp03: ok imported in ${(performance.now() - started).toFixed(0)} ms`,
	);
}

// 5. Rename platform → core: the old raw path answers 301.
expectStatus(
	"move",
	await api("POST", "/-/api/nodes/move", {
		node: `${base}/platform`,
		slug: "core",
	}),
	200,
);
const old = await fetch(`${origin}/${repoPath}/-/raw/main/README.md`, {
	headers: { authorization: `Bearer ${token}` },
	redirect: "manual",
});
await old.arrayBuffer();
const location = old.headers.get("location");
if (
	old.status !== 301 ||
	location !== `/${base}/core/edge/router/-/raw/main/README.md`
) {
	fail(`old path ${old.status} → ${location}`);
}
console.log("wp03: ok 301 from the old path");

// 6. Clean up (the API has no delete; archive the test group).
if (!keep) {
	expectStatus(
		"archive",
		await api("POST", "/-/api/nodes/archive", { node: base }),
		204,
	);
	console.log(`wp03: ok archived ${base}`);
}
