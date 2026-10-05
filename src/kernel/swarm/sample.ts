// The sim repos' content (WP20): a small pnpm monorepo
// with the demo repo's shape (`packages/shared`, `services/api`, `apps/web`),
// written onto each sim repo's trunk once, and the work templates and hot
// files the simulated agents use. Data only.

export type SampleProject = {
	readonly name: string;
	readonly path: string;
};

export const SAMPLE_PROJECTS: readonly SampleProject[] = [
	{ name: "@sim/shared", path: "packages/shared" },
	{ name: "@sim/api", path: "services/api" },
	{ name: "@sim/web", path: "apps/web" },
];

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

const pkg = (name: string, deps: Record<string, string> = {}) =>
	json({
		name,
		version: "0.0.0",
		private: true,
		type: "module",
		...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
	});

/** Path → content of the scaffold commit. */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
	"README.md":
		"# Simulated swarm repository\n\nWritten by Tartan's swarm for simulated agents (dev stages only). Every lane and change here belongs to a simulated agent.\n",
	"package.json": json({
		name: "sim-router",
		private: true,
		packageManager: "pnpm@10.34.6",
	}),
	"pnpm-workspace.yaml":
		"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
	"packages/shared/package.json": pkg("@sim/shared"),
	"packages/shared/src/money.ts":
		'export type Money = { readonly amount: number; readonly currency: "EUR" | "USD" };\n\nexport const addMoney = (a: Money, b: Money): Money => ({\n\tamount: a.amount + b.amount,\n\tcurrency: a.currency,\n});\n',
	"packages/shared/src/limits.ts":
		"export const DEFAULT_LIMIT = 100;\n\nexport const clamp = (n: number, max = DEFAULT_LIMIT): number =>\n\tMath.max(0, Math.min(max, n));\n",
	"services/api/package.json": pkg("@sim/api", {
		"@sim/shared": "workspace:*",
	}),
	"services/api/src/server.ts":
		'import { route } from "./router.ts";\n\nexport const handle = (path: string): string => route(path);\n',
	"services/api/src/router.ts":
		'const routes: Record<string, string> = {\n\t"/": "home",\n\t"/health": "ok",\n};\n\nexport const route = (path: string): string => routes[path] ?? "not found";\n',
	"services/api/src/middleware/rate-limit.ts":
		'import { clamp } from "@sim/shared/src/limits.ts";\n\nexport const limitFor = (tenant: string): number => clamp(tenant.length * 10);\n',
	"apps/web/package.json": pkg("@sim/web", { "@sim/shared": "workspace:*" }),
	"apps/web/src/main.ts":
		'import { theme } from "./theme.ts";\n\nexport const boot = (): string => `web (${theme})`;\n',
	"apps/web/src/theme.ts": 'export const theme = "light";\n',
};

/**
 * Files many agents edit (the overlap knob makes an edit land on one of
 * these), in order: `hotFiles: n` uses the first n.
 */
export const HOT_FILES: readonly string[] = [
	"services/api/src/router.ts",
	"packages/shared/src/money.ts",
	"apps/web/src/theme.ts",
	"services/api/src/middleware/rate-limit.ts",
	"packages/shared/src/limits.ts",
	"services/api/src/server.ts",
	"apps/web/src/main.ts",
];

export type WorkTemplate = {
	readonly title: string;
	readonly why: string;
	readonly project: SampleProject;
	readonly acceptance: readonly string[];
};

const [SHARED, API, WEB] = SAMPLE_PROJECTS as [
	SampleProject,
	SampleProject,
	SampleProject,
];

export const WORK_TEMPLATES: readonly WorkTemplate[] = [
	{
		title: "Add a route",
		why: "A simulated agent adds an API route.",
		project: API,
		acceptance: ["the route answers", "no route is registered twice"],
	},
	{
		title: "Tune the rate limit",
		why: "A simulated agent adjusts per-tenant limits.",
		project: API,
		acceptance: ["limits stay within bounds"],
	},
	{
		title: "Format money",
		why: "A simulated agent adds a money helper.",
		project: SHARED,
		acceptance: ["helpers stay pure"],
	},
	{
		title: "Theme tweak",
		why: "A simulated agent adjusts the web theme.",
		project: WEB,
		acceptance: ["the app still boots"],
	},
];
