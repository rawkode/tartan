// The fixture monorepo: a pnpm workspace with
// `packages/shared` (`@acme/shared`), `services/api` (`@acme/api`) and
// `apps/web` (`@acme/web`); api and web depend on shared. It is the source of
// the demo seed (WP20) and of the scripted conflict scenarios
// (`scenarios.ts`). Kept as data so it loads in workerd as well as Deno.

import type { FileMap } from "../git/store.ts";

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

export type FixtureProject = {
	readonly name: string;
	readonly path: string;
	readonly dependsOn: readonly string[];
};

export const MONOREPO_PROJECTS: readonly FixtureProject[] = [
	{ name: "@acme/shared", path: "packages/shared", dependsOn: [] },
	{ name: "@acme/api", path: "services/api", dependsOn: ["@acme/shared"] },
	{ name: "@acme/web", path: "apps/web", dependsOn: ["@acme/shared"] },
];

export const MONEY_TS = `// Money helpers shared by the API and the web app.

export type Currency = "EUR" | "GBP" | "USD";

export type Money = {
	readonly amount: number;
	readonly currency: Currency;
};

const SYMBOLS: Record<Currency, string> = {
	EUR: "€",
	GBP: "£",
	USD: "$",
};

export const money = (amount: number, currency: Currency): Money => ({
	amount,
	currency,
});

export const formatMoney = (m: Money): string =>
	\`\${SYMBOLS[m.currency]}\${(m.amount / 100).toFixed(2)}\`;

export const addMoney = (a: Money, b: Money): Money => {
	if (a.currency !== b.currency) {
		throw new Error("currency mismatch");
	}
	return money(a.amount + b.amount, a.currency);
};

export const sumMoney = (items: readonly Money[], currency: Currency): Money =>
	items.reduce(addMoney, money(0, currency));

export const applyDiscount = (m: Money, percent: number): Money =>
	money(Math.round(m.amount * (1 - percent / 100)), m.currency);

export const isZero = (m: Money): boolean => m.amount === 0;
`;

export const SLUG_TS = `// URL slugs for products and orders.

export const slugify = (text: string): string =>
	text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export const isSlug = (text: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(text);
`;

export const ORDERS_TS = `// Order routes for the API service.

import { formatMoney, money, sumMoney } from "@acme/shared";

export type OrderLine = { readonly sku: string; readonly cents: number };

export type Order = {
	readonly id: string;
	readonly lines: readonly OrderLine[];
};

export const orderTotal = (order: Order) =>
	sumMoney(order.lines.map((l) => money(l.cents, "EUR")), "EUR");

export const describeOrder = (order: Order): string =>
	\`order \${order.id}: \${order.lines.length} line(s), \${formatMoney(orderTotal(order))}\`;

export const handleGetOrder = (orders: Map<string, Order>, id: string) => {
	const order = orders.get(id);
	if (!order) return { status: 404, body: "not found" };
	return { status: 200, body: describeOrder(order) };
};
`;

export const CART_TS = `// Shopping cart for the web app.

import { applyDiscount, formatMoney, money, sumMoney } from "@acme/shared";

export type CartItem = { readonly sku: string; readonly cents: number; readonly qty: number };

export const cartTotal = (items: readonly CartItem[]) =>
	sumMoney(items.map((i) => money(i.cents * i.qty, "EUR")), "EUR");

export const cartLabel = (items: readonly CartItem[]): string =>
	\`\${items.length} item(s): \${formatMoney(cartTotal(items))}\`;

export const discounted = (items: readonly CartItem[], percent: number) =>
	formatMoney(applyDiscount(cartTotal(items), percent));
`;

export const LEGACY_TS =
	`// Legacy checkout banner, kept until the new checkout ships.

export const legacyBanner = (): string => "The old checkout is still available.";
`;

/** The fixture tree at its first commit. */
export const MONOREPO_FILES: FileMap = {
	"README.md":
		"# acme\n\nA small pnpm monorepo used by Tartan's tests and demo.\n",
	"package.json": json({
		name: "acme",
		private: true,
		packageManager: "pnpm@10.18.0",
		scripts: { build: "pnpm -r build", test: "pnpm -r test" },
	}),
	"pnpm-workspace.yaml":
		"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
	"tsconfig.base.json": json({
		compilerOptions: { strict: true, module: "ESNext", target: "ES2023" },
	}),
	"packages/shared/package.json": json({
		name: "@acme/shared",
		version: "1.0.0",
		type: "module",
		main: "src/index.ts",
		scripts: { build: "tsc -p .", test: "node --test" },
	}),
	"packages/shared/src/index.ts":
		'export * from "./money.ts";\nexport * from "./slug.ts";\n',
	"packages/shared/src/money.ts": MONEY_TS,
	"packages/shared/src/slug.ts": SLUG_TS,
	"services/api/package.json": json({
		name: "@acme/api",
		version: "1.0.0",
		type: "module",
		dependencies: { "@acme/shared": "workspace:*" },
		scripts: { build: "tsc -p .", test: "node --test" },
	}),
	"services/api/src/server.ts":
		'import { handleGetOrder } from "./routes/orders.ts";\n\nexport const routes = { "GET /orders/:id": handleGetOrder };\n',
	"services/api/src/routes/orders.ts": ORDERS_TS,
	"apps/web/package.json": json({
		name: "@acme/web",
		version: "1.0.0",
		type: "module",
		dependencies: { "@acme/shared": "workspace:*" },
		scripts: { build: "vite build", test: "node --test" },
	}),
	"apps/web/src/main.ts":
		'import { cartLabel } from "./cart.ts";\n\nconsole.log(cartLabel([]));\n',
	"apps/web/src/cart.ts": CART_TS,
	"apps/web/src/legacy.ts": LEGACY_TS,
};

/**
 * The demo's Tartan config (ADR repo config): the root CUE
 * package `tartan` split across `ci.cue` (the CI pipeline) and `review.cue`
 * (the owners rules), beside another tool's package (cuenv's `env.cue`),
 * which the forge leaves alone. Kept apart from `MONOREPO_FILES`, whose
 * commit ids the recorded git captures pin; `seedMonorepo(…, {tartanConfig:
 * true})` adds them.
 */
export const MONOREPO_TARTAN_FILES: Readonly<Record<string, string>> = {
	"ci.cue": [
		"package tartan",
		"",
		'extensions: "tartan.ci": settings: pipeline: {',
		'\ttimeout: "15m"',
		"\tjobs: {",
		'\t\tinstall: run: "pnpm install --frozen-lockfile"',
		'\t\ttest: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm test"}',
		"\t}",
		'\ton: {change: ["install", "test"], land: ["install", "test"]}',
		'\tlanes: ci: "on-submit"',
		"}",
		"",
	].join("\n"),
	"review.cue": [
		"package tartan",
		"",
		'extensions: "tartan.review": settings: owners: rules: [',
		'\t{paths: ["services/api/**"], sensitivity: 2},',
		'\t{paths: ["packages/shared/**"], sensitivity: 1},',
		"]",
		"",
	].join("\n"),
	"env.cue": [
		"package cuenv",
		"",
		'env: NODE_ENV: "test"',
		"",
	].join("\n"),
};

/** The project a repo path belongs to (longest matching project path), or null. */
export const projectOf = (path: string): string | null =>
	MONOREPO_PROJECTS.filter((p) => path.startsWith(`${p.path}/`))
		.sort((a, b) => b.path.length - a.path.length)[0]?.name ?? null;

/** Projects affected by `paths`: owners plus their transitive dependents. */
export const affectedProjects = (paths: readonly string[]): string[] => {
	const owners = new Set(
		paths.map(projectOf).filter((p): p is string => p !== null),
	);
	let grew = true;
	while (grew) {
		grew = false;
		for (const p of MONOREPO_PROJECTS) {
			if (!owners.has(p.name) && p.dependsOn.some((d) => owners.has(d))) {
				owners.add(p.name);
				grew = true;
			}
		}
	}
	return MONOREPO_PROJECTS.map((p) => p.name).filter((n) => owners.has(n));
};
