// What an extension module implements (builtin and js) and what it receives.

import type { Actor, InstallMode } from "./common.ts";
import type { KernelCaps } from "./caps.ts";
import type { Envelope } from "./events.ts";
import type {
	GateDecision,
	GateInput,
	GatePoint,
	PrefetchedInputs,
} from "./gates.ts";
import type { ContextRequest, ContextSection } from "./interfaces.ts";
import type { Manifest } from "./manifest.ts";
import type { SlotContext, ToolContext } from "./slots.ts";
import type { ActionResult, UiDoc } from "./ui.ts";

/** SQLite values as DO SQLite stores them. */
export type SqlValue = ArrayBuffer | string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlCursor<T extends SqlRow = SqlRow> {
	toArray(): T[];
	/** Exactly one row, else throws. */
	one(): T;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	[Symbol.iterator](): IterableIterator<T>;
}

/**
 * Synchronous SQL over the extension's own database (the ExtensionDO for
 * builtins, facet SQLite for js/wasm). Statements naming `_*` or `sqlite_*`
 * tables are rejected; in a read-only ExtCtx only `SELECT`/`WITH … SELECT` run.
 */
export interface Sql {
	exec<T extends SqlRow = SqlRow>(
		query: string,
		...bindings: SqlValue[]
	): SqlCursor<T>;
	/** Runs `fn` atomically (DO `transactionSync`). */
	transaction<T>(fn: () => T): T;
}

/** Synchronous kv: the DO's (builtin) or facet's (js/wasm) synchronous `storage.kv`. */
export interface Kv {
	get(key: string): Uint8Array | null;
	put(key: string, value: Uint8Array): void;
	delete(key: string): boolean;
	listKeys(prefix: string, limit: number): string[];
}

export interface Logger {
	debug(msg: string, data?: unknown): void;
	info(msg: string, data?: unknown): void;
	warn(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
}

export type InstallInfo = {
	readonly id: string;
	readonly extId: string;
	readonly version: string;
	/** The installation's node, as in `CapsProps.node`. */
	readonly node: { readonly id: string; readonly path: string };
	readonly scopeKey: string;
	readonly mode: InstallMode;
};

export interface ExtCtx {
	caps: KernelCaps;
	sql: Sql;
	kv: Kv;
	/** Installation config (settings form), validated against the manifest's config schema. */
	config: unknown;
	log: Logger;
	install: InstallInfo;
	/**
	 * The acting principal: `x_<inst>` in background hooks (init,
	 * onEvent, onTimer, gate, echo); the viewer, user or agent in render,
	 * onAction, callTool and context. In onEvent the event's own actor is
	 * `ev.actor` (informational, never acted as).
	 */
	actor: Actor;
	/** True for render and context: SELECT-only sql, every effect denied. */
	readOnly: boolean;
}

/**
 * The module an extension exports. All hooks are optional; WIT has no
 * optional exports, so the Rust SDK supplies defaults.
 */
export interface ExtensionModule {
	init?(x: ExtCtx): Promise<void>;
	onEvent?(ev: Envelope, x: ExtCtx): Promise<void>;
	onTimer?(key: string, x: ExtCtx): Promise<void>;
	gate?(point: GatePoint, input: GateInput, x: ExtCtx): Promise<GateDecision>;
	echo?(ev: Envelope, input: PrefetchedInputs, x: ExtCtx): Promise<string[]>;
	/**
	 * `slot` is the contribution id (`contributes.slots[].id`, unique per
	 * manifest), e.g. `position`; `ctx.slot` is its catalogue slot.
	 */
	render?(
		slot: string,
		ctx: SlotContext,
		props: unknown,
		x: ExtCtx,
	): Promise<UiDoc>;
	onAction?(
		action: string,
		payload: unknown,
		ctx: SlotContext,
		x: ExtCtx,
	): Promise<ActionResult>;
	callTool?(
		name: string,
		args: unknown,
		ctx: ToolContext,
		x: ExtCtx,
	): Promise<unknown>;
	context?(req: ContextRequest, x: ExtCtx): Promise<ContextSection[]>;
}

/** Extension-owned migration (numbered inside the extension's own DB). */
export type ExtMigration = {
	readonly n: number;
	readonly name: string;
	readonly sql: string;
};

/**
 * A bundled package as registered in `src/builtins.ts`:
 * the manifest (`extensions/<name>/tartan.json`), the module, its migrations
 * (the files named in `manifest.storage.migrations`) and its protocol card.
 */
export type BuiltinPackage = {
	readonly manifest: Manifest;
	readonly module: ExtensionModule;
	readonly migrations: readonly ExtMigration[];
	readonly protocol?: string;
	/** The `config.cue` text (repository config), embedded like the protocol card. */
	readonly settingsCue?: string;
};

/** Default host-side wall-clock budgets per method. */
export const HOST_TIMEOUTS_MS = {
	render: 1000,
	event: 5000,
	action: 5000,
	tool: 10000,
	context: 300,
	echo: 1500,
} as const;
