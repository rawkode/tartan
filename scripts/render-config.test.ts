import assert from "node:assert/strict";
import { VAR_NAMES } from "../src/env.ts";
import {
	ConfigRenderError,
	defaultOutPath,
	DOCKERFILE_IMAGE,
	EVICTION_FLAG,
	type JsonValue,
	parseCliArgs,
	parseImageKind,
	parseImageRecord,
	parseJsoncValue,
	renderConfig,
	type RenderOptions,
	RUNNER_IMAGE_RECORD,
	validateRegistryRef,
} from "./render-config.ts";

type Obj = { [key: string]: JsonValue };

const SOURCE_PATH = new URL("../wrangler.jsonc", import.meta.url);
const source = await Deno.readTextFile(SOURCE_PATH);

const options = (overrides: Partial<RenderOptions> = {}): RenderOptions => ({
	stage: "dev",
	containers: true,
	image: { kind: "dockerfile" },
	evictionFlag: true,
	sourceDir: "/repo",
	outDir: "/repo/.wrangler/deploy",
	...overrides,
});

const render = (overrides: Partial<RenderOptions> = {}, text = source): Obj =>
	parseJsoncValue(renderConfig(text, options(overrides))) as Obj;

const obj = (value: JsonValue | undefined): Obj => {
	assert.ok(
		value !== null && typeof value === "object" && !Array.isArray(value),
	);
	return value as Obj;
};
const arr = (value: JsonValue | undefined): JsonValue[] => {
	assert.ok(Array.isArray(value));
	return value;
};

const comments = (text: string): string[] =>
	text.split("\n").flatMap((line) => {
		const at = line.indexOf("//");
		// Skip "//" inside strings such as URLs: only count it after the last quote pair.
		return at !== -1 && (line.slice(0, at).split('"').length - 1) % 2 === 0
			? [line.slice(at).trim()]
			: [];
	});

const throwsRender = (fn: () => unknown, pattern: RegExp): void => {
	assert.throws(
		fn,
		(error: unknown) =>
			error instanceof ConfigRenderError && pattern.test(error.message),
	);
};

Deno.test("wrangler.jsonc has the documented bindings and settings", () => {
	const config = obj(parseJsoncValue(source));
	assert.equal(config.name, "tartan");
	assert.equal(config.main, "src/index.ts");
	assert.equal(config.compatibility_date, "2026-08-15");
	assert.deepEqual(config.compatibility_flags, [
		"nodejs_compat",
		"global_fetch_strictly_public",
		EVICTION_FLAG,
	]);
	assert.equal(config.workers_dev, true);
	assert.deepEqual(config.observability, { enabled: true });
	assert.deepEqual(config.limits, { cpu_ms: 60000 });
	assert.deepEqual(config.build, { command: "npm run build:web" });
	assert.deepEqual(config.assets, {
		directory: "web/dist",
		binding: "ASSETS",
		run_worker_first: true,
		not_found_handling: "single-page-application",
	});
	assert.deepEqual(config.artifacts, [{
		binding: "ARTIFACTS",
		namespace: "tartan",
	}]);
	assert.deepEqual(config.worker_loaders, [{ binding: "LOADER" }]);
	const classes = [
		"ForgeDO",
		"RepoDO",
		"InboxDO",
		"ExtensionDO",
		"TartanSandbox",
	];
	assert.deepEqual(
		arr(obj(config.durable_objects).bindings).map((
			b,
		) => [obj(b).name, obj(b).class_name]),
		[["FORGE", "ForgeDO"], ["REPO", "RepoDO"], ["INBOX", "InboxDO"], [
			"EXT",
			"ExtensionDO",
		], [
			"SANDBOX",
			"TartanSandbox",
		], ["BUS", "BusDO"]],
	);
	assert.deepEqual(config.migrations, [{
		tag: "v1",
		new_sqlite_classes: classes,
	}, { tag: "v2", new_sqlite_classes: ["BusDO"] }]);
	// The global log is rendered per stage only (WP26).
	assert.equal(config.k2, undefined);
	assert.equal(config.secrets_store_secrets, undefined);
	// Classic scheduling policy, no "images" map.
	assert.deepEqual(config.containers, [{
		class_name: "TartanSandbox",
		image: DOCKERFILE_IMAGE,
		instance_type: "standard-1",
		max_instances: 20,
	}]);
	assert.deepEqual(
		arr(config.workflows).map((
			w,
		) => [obj(w).name, obj(w).binding, obj(w).class_name]),
		[
			["tartan-run", "RUNS", "RunWorkflow"],
			["tartan-land", "LAND", "LandWorkflow"],
			["tartan-ingest", "INGEST", "IngestWorkflow"],
			["tartan-swarm", "SWARM", "SwarmWorkflow"],
		],
	);
	assert.deepEqual(config.r2_buckets, [{
		binding: "BLOBS",
		bucket_name: "tartan-blobs",
	}]);
	assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV" }]);
	assert.deepEqual(config.ai, { binding: "AI" });
	assert.deepEqual(config.vars, {
		TARTAN_STAGE: "default",
		TARTAN_FEATURES: "echo,oauth",
		TARTAN_DEV_TOOLS: "0",
		TARTAN_MAX_PUSH_MB: "95",
		TARTAN_JUDGE_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		OIDC_ISSUER: "",
		OIDC_CLIENT_ID: "",
	});
	// The hand-written Env lists exactly these vars.
	assert.deepEqual(Object.keys(obj(config.vars)), [...VAR_NAMES]);
	assert.ok(
		!String(obj(config.vars).TARTAN_FEATURES).split(",").includes("swarm"),
		"never swarm by default",
	);
	// Trigger shape accepted by wrangler 4.145: filter.{namespace} + targets[].
	assert.deepEqual(config.triggers, {
		crons: ["*/5 * * * *"],
		events: [{
			type: "cf.artifacts.repo.pushed",
			filter: { namespace: "tartan" },
			targets: [{ type: "workflow", workflow_name: "tartan-ingest" }],
		}],
	});
	assert.equal(config.routes, undefined);
});

Deno.test("stage substitution renames every derived name and keeps the rest", () => {
	const config = render({ stage: "dev-wp04" });
	assert.equal(config.name, "tartan-dev-wp04");
	assert.deepEqual(config.artifacts, [{
		binding: "ARTIFACTS",
		namespace: "tartan-dev-wp04",
	}]);
	assert.deepEqual(arr(config.workflows).map((w) => obj(w).name), [
		"tartan-dev-wp04-run",
		"tartan-dev-wp04-land",
		"tartan-dev-wp04-ingest",
		"tartan-dev-wp04-swarm",
	]);
	assert.deepEqual(config.r2_buckets, [{
		binding: "BLOBS",
		bucket_name: "tartan-dev-wp04-blobs",
	}]);
	const event = obj(arr(obj(config.triggers).events)[0]);
	assert.deepEqual(event.filter, { namespace: "tartan-dev-wp04" });
	assert.deepEqual(event.targets, [{
		type: "workflow",
		workflow_name: "tartan-dev-wp04-ingest",
	}]);
	assert.equal(obj(config.vars).TARTAN_STAGE, "dev-wp04");
	assert.equal(obj(config.vars).TARTAN_DEV_TOOLS, "0");
	assert.deepEqual(config.compatibility_flags, [
		"nodejs_compat",
		"global_fetch_strictly_public",
		EVICTION_FLAG,
	]);
	assert.equal(config.compatibility_date, "2026-08-15");
	assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV" }]);
	assert.equal(config.routes, undefined);
	// Unrelated keys are untouched.
	const original = obj(parseJsoncValue(source));
	for (
		const key of [
			"durable_objects",
			"migrations",
			"worker_loaders",
			"ai",
			"limits",
			"observability",
			"build",
		]
	) {
		assert.deepEqual(config[key], original[key], key);
	}
});

Deno.test("relative paths are rebased onto the rendered file's directory", () => {
	const config = render();
	assert.equal(
		config.$schema,
		"../../node_modules/wrangler/config-schema.json",
	);
	assert.equal(config.main, "../../src/index.ts");
	assert.equal(obj(config.assets).directory, "../../web/dist");
	assert.equal(
		obj(arr(config.containers)[0]).image,
		"../../containers/runner/Dockerfile",
	);

	const same = render({ outDir: "/repo" });
	assert.equal(same.main, "src/index.ts");
	assert.equal(obj(arr(same.containers)[0]).image, DOCKERFILE_IMAGE);

	const outside = render({ outDir: "/tmp/elsewhere" });
	assert.equal(outside.main, "/repo/src/index.ts");
	assert.equal(
		obj(arr(outside.containers)[0]).image,
		"/repo/containers/runner/Dockerfile",
	);
});

Deno.test("comments and layout survive rendering", () => {
	const rendered = renderConfig(source, options({ domain: "git.example.com" }));
	assert.match(rendered, /^\/\/ GENERATED by scripts\/render-config\.ts/);
	assert.match(
		rendered,
		/stage=dev domain=git\.example\.com containers=dockerfile eviction_flag=on/,
	);
	for (const comment of comments(source)) {
		assert.ok(rendered.includes(comment), `lost comment: ${comment}`);
	}
	// Only the edited lines differ (plus the header and the appended route).
	const before = source.split("\n");
	const after = rendered.split("\n").slice(2);
	assert.equal(after.length, before.length + 1);
	assert.ok(
		after.includes(
			'\t"routes": [{ "pattern": "git.example.com", "custom_domain": true }]',
		),
	);
	assert.ok(
		after.includes(
			"\t}, // one IngestWorkflow instance per ref update, r-* and l-* repos [E A5]",
		),
	);
});

Deno.test("--no-containers drops the containers entry but keeps TartanSandbox as a DO class", () => {
	const text = renderConfig(source, options({ containers: false }));
	const config = obj(parseJsoncValue(text));
	assert.equal(config.containers, undefined);
	assert.ok(
		arr(obj(config.durable_objects).bindings).some((b) =>
			obj(b).class_name === "TartanSandbox"
		),
	);
	assert.ok(
		arr(obj(arr(config.migrations)[0]).new_sqlite_classes).includes(
			"TartanSandbox",
		),
	);
	assert.match(text, /\t\/\/ "containers" omitted \(--no-containers\)/);
	assert.ok(
		!text.includes("classic (default) scheduling policy"),
		"the containers comment goes with it",
	);
	assert.match(text, /containers=none/);
	// Everything after it is intact.
	assert.equal(arr(config.workflows).length, 4);
	// Lanes need no containers: the lane vars are left alone.
	assert.equal(obj(config.vars).TARTAN_LANE_MODE, undefined);
	assert.equal(obj(config.vars).TARTAN_STAGE, "dev");
	assert.equal(obj(config.vars).TARTAN_MAX_PUSH_MB, "95");
	// An existing value is replaced, not duplicated.
	const preset = source.replace(
		'"OIDC_CLIENT_ID": ""',
		`"OIDC_CLIENT_ID": "",\n\t\t"TARTAN_LANE_MODE": "import"`,
	);
	assert.notEqual(preset, source);
	const presetVars = obj(
		render({ containers: false, laneMode: "branch" }, preset).vars,
	);
	assert.equal(presetVars.TARTAN_LANE_MODE, "branch");
	assert.equal(
		renderConfig(preset, options({ containers: false, laneMode: "branch" }))
			.split("TARTAN_LANE_MODE").length,
		2,
	);
});

const DIGEST_REF = `ttl.sh/tartan-runner-0123abc-9f8e7d6c5b4a3921@sha256:${
	"a".repeat(64)
}`;

Deno.test("--image picks dockerfile or the digest-pinned registry variant", () => {
	const image = (overrides: Partial<RenderOptions>) =>
		obj(arr(render(overrides).containers)[0]).image;
	assert.equal(image({ outDir: "/repo" }), DOCKERFILE_IMAGE);
	const registry = { kind: "registry", ref: DIGEST_REF } as const;
	assert.equal(image({ image: registry }), DIGEST_REF);
	assert.match(
		renderConfig(source, options({ image: registry })),
		/containers=registry/,
	);
	assert.equal(parseImageKind("dockerfile"), "dockerfile");
	assert.equal(parseImageKind("registry"), "registry");
	for (const bad of ["sandbox", "Registry", DIGEST_REF, ""]) {
		throwsRender(() => parseImageKind(bad), /invalid --image/);
	}
	throwsRender(
		() => render({ containers: false, image: registry }),
		/--no-containers/,
	);
});

Deno.test("the registry variant renders a digest and refuses a tag", () => {
	assert.equal(validateRegistryRef(DIGEST_REF), DIGEST_REF);
	assert.equal(
		validateRegistryRef(`localhost:5000/runner@sha256:${"b".repeat(64)}`),
		`localhost:5000/runner@sha256:${"b".repeat(64)}`,
	);
	for (
		const tagged of [
			"ttl.sh/tartan-runner-0123abc:24h",
			`ttl.sh/tartan-runner-0123abc:24h@sha256:${"a".repeat(64)}`,
			"docker.io/cloudflare/sandbox:0.12.1",
		]
	) {
		throwsRender(() => validateRegistryRef(tagged), /carries a tag/);
		throwsRender(
			() => render({ image: { kind: "registry", ref: tagged } }),
			/carries a tag/,
		);
	}
	for (
		const bad of [
			"ttl.sh/tartan-runner",
			`ttl.sh/tartan-runner@sha256:${"A".repeat(64)}`,
			`ttl.sh/tartan-runner@sha256:${"a".repeat(63)}`,
			`https://ttl.sh/x@sha256:${"a".repeat(64)}`,
			`x@sha256:${"a".repeat(64)}`,
			"",
		]
	) {
		throwsRender(() => validateRegistryRef(bad), /invalid registry image/);
	}
	// The record containers/runner/publish.ts writes.
	assert.deepEqual(
		parseImageRecord(
			JSON.stringify({ ref: DIGEST_REF, pushedAt: "2026-10-02T00:00:00Z" }),
			"r.json",
		),
		{ kind: "registry", ref: DIGEST_REF },
	);
	throwsRender(
		() =>
			parseImageRecord(
				JSON.stringify({ ref: "ttl.sh/tartan-runner-0123abc:24h" }),
				"r.json",
			),
		/carries a tag/,
	);
	throwsRender(() => parseImageRecord("{", "r.json"), /r\.json: not JSON/);
	throwsRender(() => parseImageRecord("{}", "r.json"), /no "ref" string/);
	throwsRender(() => parseImageRecord("null", "r.json"), /no "ref" string/);
});

Deno.test("--domain adds a custom-domain route, replacing an existing routes value", () => {
	const config = render({ domain: "Git.Rawkode.Dev" });
	assert.deepEqual(config.routes, [{
		pattern: "git.rawkode.dev",
		custom_domain: true,
	}]);
	assert.equal(
		config.workers_dev,
		true,
		"workers.dev stays on for the health poll",
	);

	const triggersEnd =
		"\t} // one IngestWorkflow instance per ref update, r-* and l-* repos [E A5]";
	const withRoutes = source.replace(
		triggersEnd,
		`\t},${
			triggersEnd.slice(2)
		}\n\t"routes": [{ "pattern": "old.example.com", "custom_domain": true }]`,
	);
	assert.notEqual(withRoutes, source);
	assert.deepEqual(render({ domain: "git.example.com" }, withRoutes).routes, [
		{ pattern: "git.example.com", custom_domain: true },
	]);
	for (
		const bad of [
			"https://git.example.com",
			"git.example.com/x",
			"*.example.com",
			"localhost",
			"git.example.com:8443",
			"-a.example.com",
		]
	) {
		throwsRender(() => render({ domain: bad }), /invalid --domain/);
	}
});

Deno.test("--no-eviction-flag drops only the eviction flag", () => {
	const text = renderConfig(source, options({ evictionFlag: false }));
	assert.deepEqual(obj(parseJsoncValue(text)).compatibility_flags, [
		"nodejs_compat",
		"global_fetch_strictly_public",
	]);
	assert.match(text, /eviction_flag=off/);
});

Deno.test("--dev-tools sets TARTAN_DEV_TOOLS=1 on dev stages only", () => {
	const vars = (o: Partial<RenderOptions>) => obj(render(o).vars);
	assert.equal(vars({ stage: "dev", devTools: true }).TARTAN_DEV_TOOLS, "1");
	assert.equal(
		vars({ stage: "dev-wp09", devTools: true }).TARTAN_DEV_TOOLS,
		"1",
	);
	assert.equal(vars({ stage: "dev" }).TARTAN_DEV_TOOLS, "0");
	assert.match(
		renderConfig(source, options({ stage: "dev", devTools: true })),
		/dev_tools=on/,
	);
	for (const stage of ["prod", "devx", "demo"]) {
		throwsRender(
			() => renderConfig(source, options({ stage, devTools: true })),
			/--dev-tools needs a dev or dev-\* stage/,
		);
	}
	assert.equal(parseCliArgs(["--stage", "dev", "--dev-tools"])?.devTools, true);
	assert.equal(parseCliArgs(["--stage", "dev"])?.devTools, false);
	throwsRender(
		() => parseCliArgs(["--stage", "prod", "--dev-tools"]),
		/--dev-tools needs a dev or dev-\* stage/,
	);
});

Deno.test("--repo-config on sets TARTAN_REPO_CONFIG=on; absent means off; it needs containers", () => {
	const vars = (o: Partial<RenderOptions>) => obj(render(o).vars);
	assert.equal(vars({ repoConfig: true }).TARTAN_REPO_CONFIG, "on");
	assert.equal(vars({}).TARTAN_REPO_CONFIG, undefined);
	assert.match(
		renderConfig(source, options({ repoConfig: true })),
		/repo_config=on/,
	);
	throwsRender(
		() =>
			renderConfig(
				source,
				options({ repoConfig: true, containers: false }),
			),
		/--repo-config on needs containers/,
	);
	assert.equal(
		parseCliArgs(["--stage", "dev", "--repo-config", "on"])?.repoConfig,
		true,
	);
	assert.equal(parseCliArgs(["--stage", "dev"])?.repoConfig, false);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--repo-config", "yes"]),
		/--repo-config is on or off/,
	);
	throwsRender(
		() =>
			parseCliArgs([
				"--stage",
				"dev",
				"--repo-config",
				"on",
				"--no-containers",
			]),
		/cannot be combined with --no-containers/,
	);
});

Deno.test("--k2-stream renders the producer binding, the stream var and the token's Secrets Store binding", () => {
	const stream = "0123456789abcdef0123456789abcdef";
	const store = "0123456789abcdef0123456789abcdef";
	const config = render({
		stage: "dev-wp26",
		k2: {
			streamId: stream,
			token: { storeId: store, secretName: "k2-consumer" },
		},
	});
	assert.deepEqual(config.k2, [{ binding: "EVENT_LOG", stream, remote: true }]);
	assert.deepEqual(config.secrets_store_secrets, [{
		binding: "TARTAN_K2_TOKEN",
		store_id: store,
		secret_name: "k2-consumer",
	}]);
	assert.equal(obj(config.vars).TARTAN_K2_STREAM, stream);
	const produceOnly = render({ k2: { streamId: stream } });
	assert.deepEqual(arr(produceOnly.k2).length, 1);
	assert.equal(produceOnly.secrets_store_secrets, undefined);
	const header = renderConfig(source, options({ k2: { streamId: stream } }))
		.split("\n")[1];
	assert.ok(header.includes("k2=produce-only"));
	const none = render();
	assert.equal(none.k2, undefined);
	assert.equal(obj(none.vars).TARTAN_K2_STREAM, undefined);
	throwsRender(
		() => render({ k2: { streamId: "tartan_dev_log" } }),
		/invalid --k2-stream "tartan_dev_log": give the stream id/,
	);
	throwsRender(
		() =>
			render({
				k2: { streamId: stream, token: { storeId: "x", secretName: "k" } },
			}),
		/invalid --k2-token-store/,
	);
	throwsRender(
		() => render({}, source.replace('"ai":', '"k2": [], "ai":')),
		/"k2" is rendered per stage/,
	);
	const parsed = parseCliArgs([
		"--stage",
		"dev-wp26",
		"--k2-stream",
		stream,
		"--k2-token-store",
		store,
		"--k2-token-secret",
		"k2-consumer",
	]);
	assert.deepEqual(parsed?.k2, {
		streamId: stream,
		token: { storeId: store, secretName: "k2-consumer" },
	});
	throwsRender(
		() =>
			parseCliArgs([
				"--stage",
				"dev",
				"--k2-stream",
				stream,
				"--k2-token-store",
				store,
			]),
		/go together/,
	);
	throwsRender(
		() =>
			parseCliArgs([
				"--stage",
				"dev",
				"--k2-token-store",
				store,
				"--k2-token-secret",
				"k",
			]),
		/needs --k2-stream/,
	);
});

Deno.test("--projects scan sets TARTAN_PROJECTS=scan; absent means off; no containers needed", () => {
	const vars = (o: Partial<RenderOptions>) => obj(render(o).vars);
	assert.equal(vars({ projects: true }).TARTAN_PROJECTS, "scan");
	assert.equal(vars({}).TARTAN_PROJECTS, undefined);
	assert.equal(
		vars({ projects: true, containers: false }).TARTAN_PROJECTS,
		"scan",
	);
	assert.match(
		renderConfig(source, options({ projects: true })),
		/projects=scan/,
	);
	assert.equal(
		parseCliArgs(["--stage", "dev", "--projects", "scan"])?.projects,
		true,
	);
	assert.equal(
		parseCliArgs(["--stage", "dev", "--projects", "off"])?.projects,
		false,
	);
	assert.equal(parseCliArgs(["--stage", "dev"])?.projects, false);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--projects", "eval"]),
		/--projects is off or scan/,
	);
});

Deno.test("stage validation", () => {
	for (
		const good of [
			"dev",
			"dryrun",
			"ci",
			"dev-wp04",
			"judge-rec",
			"a".repeat(32),
		]
	) render({ stage: good });
	for (
		const bad of [
			"",
			"Dev",
			"1dev",
			"dev_1",
			"dev-",
			"-dev",
			"de--v",
			"a".repeat(33),
			"dev/x",
			"dev x",
		]
	) {
		throwsRender(() => render({ stage: bad }), /invalid --stage/);
	}
});

Deno.test("source drift fails loudly instead of rendering a half-renamed config", () => {
	throwsRender(
		() => render({}, source.replace('"tartan-blobs"', '"other-blobs"')),
		/r2_buckets\[0\]\.bucket_name "other-blobs" does not start with "tartan"/,
	);
	throwsRender(
		() =>
			render(
				{},
				source.replace(
					'"filter": { "namespace": "tartan" }',
					'"filter": { "namespace": "tartan-x" }',
				),
			),
		/names no declared Artifacts namespace/,
	);
	throwsRender(
		() =>
			render(
				{},
				source.replace(
					'"workflow_name": "tartan-ingest"',
					'"workflow_name": "tartan-nope"',
				),
			),
		/names no declared Workflow/,
	);
	throwsRender(
		() =>
			render(
				{},
				source.replace(
					'{ "name": "SANDBOX", "class_name": "TartanSandbox" }',
					'{ "name": "X", "class_name": "X" }',
				),
			),
		/must declare TartanSandbox/,
	);
	throwsRender(
		() => render({}, '{ "name": "tartan", '),
		/JSONC parse error at line 1/,
	);
});

Deno.test("JSONC edits handle trailing commas, same-line braces and missing keys", () => {
	const minimal = `{
	"name": "tartan", // c1
	/* block */ "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "TartanSandbox" },] },
	"compatibility_flags": ["nodejs_compat", "${EVICTION_FLAG}",],
	"main": "src/index.ts",
}
`;
	const text = renderConfig(
		minimal,
		options({
			containers: false,
			evictionFlag: false,
			domain: "a.example.com",
		}),
	);
	const config = obj(parseJsoncValue(text));
	assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
	assert.deepEqual(config.vars, { TARTAN_STAGE: "dev" });
	assert.deepEqual(config.routes, [{
		pattern: "a.example.com",
		custom_domain: true,
	}]);
	assert.ok(text.includes("// c1") && text.includes("/* block */"));

	const oneLine =
		'{ "name": "tartan", "durable_objects": { "bindings": [{ "class_name": "TartanSandbox" }] }, "vars": {} }';
	const flat = obj(
		parseJsoncValue(
			renderConfig(
				oneLine,
				options({ containers: false, domain: "b.example.com" }),
			),
		),
	);
	assert.deepEqual(flat.vars, { TARTAN_STAGE: "dev" });
	assert.deepEqual(flat.routes, [{
		pattern: "b.example.com",
		custom_domain: true,
	}]);
});

Deno.test("rendering is deterministic", () => {
	assert.equal(
		renderConfig(source, options()),
		renderConfig(source, options()),
	);
});

Deno.test("CLI argument parsing", () => {
	const parsed = parseCliArgs(["--stage", "dryrun", "--no-containers"]);
	assert.ok(parsed);
	assert.equal(parsed.stage, "dryrun");
	assert.equal(parsed.containers, false);
	assert.equal(parsed.evictionFlag, true);
	assert.equal(parsed.image, "dockerfile");
	assert.equal(parsed.imageRecordPath, RUNNER_IMAGE_RECORD);
	assert.equal(parsed.sourcePath, "wrangler.jsonc");
	assert.equal(parsed.outPath, ".wrangler/deploy/wrangler.dryrun.jsonc");
	assert.equal(
		defaultOutPath("conf/wrangler.jsonc", "x"),
		"conf/.wrangler/deploy/wrangler.x.jsonc",
	);

	const full = parseCliArgs([
		"--stage=prod",
		"--domain",
		"GIT.example.com",
		"--image",
		"registry",
		"--image-record",
		"/tmp/runner-image.json",
		"--no-eviction-flag",
		"--out",
		"/tmp/out.jsonc",
	]);
	assert.ok(full);
	assert.equal(full.domain, "git.example.com");
	assert.equal(full.image, "registry");
	assert.equal(full.imageRecordPath, "/tmp/runner-image.json");
	assert.equal(
		parseCliArgs([
			"--stage",
			"x",
			"--source",
			"conf/wrangler.jsonc",
			"--image",
			"registry",
		])
			?.imageRecordPath,
		"conf/.wrangler/deploy/runner-image.json",
	);
	assert.equal(full.evictionFlag, false);
	assert.equal(full.outPath, "/tmp/out.jsonc");
	assert.equal(full.outDir, "/tmp");

	assert.equal(parseCliArgs(["--help"]), undefined);
	throwsRender(() => parseCliArgs([]), /--stage is required/);
	throwsRender(() => parseCliArgs(["--stage"]), /--stage needs a value/);
	throwsRender(
		() => parseCliArgs(["--stage", "--no-containers"]),
		/--stage needs a value/,
	);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--bogus"]),
		/unknown argument "--bogus"/,
	);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--no-containers=1"]),
		/takes no value/,
	);
	throwsRender(
		() =>
			parseCliArgs([
				"--stage",
				"dev",
				"--no-containers",
				"--image",
				"registry",
			]),
		/--no-containers/,
	);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--image", "sandbox"]),
		/invalid --image "sandbox"/,
	);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--image-record", "r.json"]),
		/--image-record needs --image registry/,
	);
	throwsRender(() => parseCliArgs(["--stage", "Dev"]), /invalid --stage/);
});

Deno.test("--lane-mode and --workload-transport render the stage's switch overrides; absent keeps the compiled defaults", () => {
	const stream = "0123456789abcdef0123456789abcdef";
	const store = "0123456789abcdef0123456789abcdef";
	const k2 = {
		streamId: stream,
		token: { storeId: store, secretName: "k2-consumer" },
	};
	const vars = (o: Partial<RenderOptions>) => obj(render(o).vars);
	assert.equal(vars({}).TARTAN_LANE_MODE, undefined);
	assert.equal(vars({}).TARTAN_WORKLOAD_TRANSPORT, undefined);
	assert.equal(vars({ laneMode: "import" }).TARTAN_LANE_MODE, "import");
	assert.equal(
		vars({ k2, workloadTransport: "k2" }).TARTAN_WORKLOAD_TRANSPORT,
		"k2",
	);
	assert.equal(
		vars({ workloadTransport: "local" }).TARTAN_WORKLOAD_TRANSPORT,
		"local",
	);
	const header = renderConfig(
		source,
		options({ laneMode: "import", k2, workloadTransport: "k2" }),
	).split("\n")[1];
	assert.ok(header.includes("lane_mode=import"), header);
	assert.ok(header.includes("workload_transport=k2"), header);
	// k2 needs the global log with its consume token.
	throwsRender(
		() => render({ workloadTransport: "k2" }),
		/--workload-transport k2 needs the global log/,
	);
	throwsRender(
		() => render({ k2: { streamId: stream }, workloadTransport: "k2" }),
		/--workload-transport k2 needs the global log/,
	);
	assert.equal(
		vars({ laneMode: "import", containers: false }).TARTAN_LANE_MODE,
		"import",
	);
	assert.equal(
		parseCliArgs(["--stage", "dev", "--lane-mode", "import"])?.laneMode,
		"import",
	);
	assert.equal(
		parseCliArgs(["--stage", "dev", "--workload-transport", "k2"])
			?.workloadTransport,
		"k2",
	);
	assert.equal(parseCliArgs(["--stage", "dev"])?.laneMode, undefined);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--lane-mode", "bogus"]),
		/--lane-mode is import, branch/,
	);
	throwsRender(
		() => parseCliArgs(["--stage", "dev", "--workload-transport", "queue"]),
		/--workload-transport is local or k2/,
	);
});
