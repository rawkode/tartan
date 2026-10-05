// Migration runner for thin DO classes. Migrations are numbered SQL strings,
// applied in ascending order, each inside its own `transactionSync` together
// with its `_migrations` row, so a failing migration leaves neither its schema
// change nor its record. Applied numbers are skipped, so a migration added
// later with a lower number than one already applied still runs. Each module
// owns a number range; the runner refuses (before touching storage) a module
// whose migrations leave its range or collide with another module's.

import {
	type Clock,
	COMMON_DDL,
	type DoModule,
	type Migration,
	MIGRATION_RANGES,
	migrationIssues,
	type MigrationRange,
} from "@tartan/contract/kernel.ts";

/** Common migrations owned by WP0 (range 1–99). */
export const COMMON_MIGRATIONS = {
	/** Every DO that uses the host: `meta` and the `_timers` multiplexer table. */
	base: {
		n: 1,
		name: "meta, _timers",
		sql: `${COMMON_DDL.meta};\n${COMMON_DDL.timers}`,
	},
	/** ForgeDO only (setup and API rate limits). */
	rateLimits: {
		n: 2,
		name: "rate_limits",
		sql: COMMON_DDL.rateLimits,
	},
} as const satisfies Record<string, Migration>;

export type MigrationSource = {
	readonly name: string;
	readonly range: MigrationRange;
	readonly migrations: readonly Migration[];
};

const overlaps = (a: MigrationRange, b: MigrationRange): boolean =>
	a[0] <= b[1] && b[0] <= a[1];

/** Every problem with a set of migration sources; empty means valid. */
export const migrationSourceIssues = (
	sources: readonly MigrationSource[],
): string[] => {
	const ranges = sources.flatMap((source) =>
		migrationIssues(source.name, source.range, source.migrations)
	);
	const collisions = sources.flatMap((a, i) =>
		sources.slice(i + 1)
			.filter((b) => overlaps(a.range, b.range))
			.map((b) =>
				`${a.name} range ${a.range[0]}–${a.range[1]} overlaps ${b.name} range ${
					b.range[0]
				}–${b.range[1]}`
			)
	);
	const numbered = sources.flatMap((source) =>
		source.migrations.map((m) => ({ n: m.n, owner: source.name }))
	);
	const duplicates = numbered.flatMap((entry) => {
		const first = numbered[numbered.findIndex((other) => other.n === entry.n)];
		return first !== entry && first.owner !== entry.owner
			? [
				`migration ${entry.n} defined by both ${first.owner} and ${entry.owner}`,
			]
			: [];
	});
	return [...ranges, ...collisions, ...duplicates];
};

/** The common source (1–99) plus each module's own source. */
export const migrationSources = (
	common: readonly Migration[],
	modules: readonly Pick<
		DoModule<unknown, unknown>,
		"name" | "range" | "migrations"
	>[],
): MigrationSource[] => [
	{ name: "common", range: MIGRATION_RANGES.common, migrations: common },
	...modules.map((m) => ({
		name: m.name,
		range: m.range,
		migrations: m.migrations,
	})),
];

export type MigrationStorage = Pick<
	DurableObjectStorage,
	"sql" | "transactionSync"
>;

/**
 * Applies every pending migration of `sources` (validated first) and returns
 * the numbers it applied, in order. Synchronous: call it inside
 * `blockConcurrencyWhile` from the DO constructor.
 */
export const runMigrations = (
	storage: MigrationStorage,
	sources: readonly MigrationSource[],
	clock: Clock,
): number[] => {
	const issues = migrationSourceIssues(sources);
	if (issues.length > 0) {
		throw new Error(`invalid migrations: ${issues.join("; ")}`);
	}
	storage.sql.exec(COMMON_DDL.migrations);
	const applied = new Set(
		storage.sql.exec<{ n: number }>("SELECT n FROM _migrations").toArray()
			.map((row) => row.n),
	);
	const pending = sources
		.flatMap((source) =>
			source.migrations.map((migration) => ({ source, migration }))
		)
		.filter(({ migration }) => !applied.has(migration.n))
		.sort((a, b) => a.migration.n - b.migration.n);
	for (const { source, migration } of pending) {
		storage.transactionSync(() => {
			storage.sql.exec(migration.sql);
			storage.sql.exec(
				"INSERT INTO _migrations (n, name, at) VALUES (?, ?, ?)",
				migration.n,
				`${source.name}: ${migration.name}`,
				clock.now(),
			);
		});
	}
	return pending.map(({ migration }) => migration.n);
};
