// Repos without a cuenv module (WP25's off-mode goldens): a pnpm workspace,
// a Bun workspace whose package has a `check` script and no `test`, and a
// Cargo workspace. Their graphs must be identical with `TARTAN_PROJECTS`
// off and scan, and with it off byte-identical to the detector before WP25
// (the keys in `cuenv.test.ts` were computed by `main`'s detector).

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

export const GOLDEN_REPOS: Readonly<
	Record<"pnpm" | "bun" | "cargo", Readonly<Record<string, string>>>
> = {
	pnpm: {
		"package.json": json({ name: "sample", private: true }),
		"pnpm-workspace.yaml":
			"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		"packages/shared/package.json": json({
			name: "shared",
			scripts: { test: "vitest" },
		}),
		"packages/shared/src/index.ts": "export const x = 1;\n",
		"services/api/package.json": json({
			name: "api",
			dependencies: { shared: "workspace:*" },
			scripts: { test: "vitest" },
		}),
		"apps/web/package.json": json({
			name: "web",
			dependencies: { shared: "workspace:^" },
			scripts: { test: "vitest" },
		}),
	},
	bun: {
		"package.json": json({
			name: "bun-sample",
			private: true,
			workspaces: ["packages/*"],
		}),
		"bun.lock": '{\n\t"lockfileVersion": 1\n}\n',
		"packages/ui/package.json": json({
			name: "@acme/ui",
			scripts: { check: "tsc --noEmit" },
		}),
		"packages/app/package.json": json({
			name: "@acme/app",
			dependencies: { "@acme/ui": "workspace:*" },
			scripts: { test: "bun test" },
		}),
	},
	cargo: {
		"Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
		"Cargo.lock": "version = 3\n",
		"crates/core/Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\n',
		"crates/cli/Cargo.toml":
			'[package]\nname = "cli"\nversion = "0.1.0"\n\n[dependencies]\ncore = { path = "../core" }\n',
	},
};
