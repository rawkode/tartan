// runExtension: drives one extension module the way the host does: migrations,
// `init`, then each event through `onEvent` as the installation's background
// actor, timers through `onTimer`, renders read-only as the viewer (SELECT-only
// sql, every effect denied), and actions and tool calls as the interactive
// actor. Returns what it did: the effect calls, the validated renders and the
// tool results.

import {
	type Actor,
	type ContextRequest,
	type ContextSection,
	createUlid,
	type Envelope,
	type ExtCtx,
	type ExtensionModule,
	type ExtMigration,
	extPrincipalId,
	type InstallInfo,
	type Manifest,
	type SlotContext,
	type Sql,
	type ToolContext,
	type UiDoc,
	validateUi,
} from "@tartan/contract";
import {
	type CapsCall,
	createFakeKernelCaps,
	DEFAULT_CAPS_PROPS,
	type FakeKernelCaps,
	type FakeKernelCapsOptions,
} from "../caps/fake-caps.ts";
import {
	createMemoryKv,
	createRecordingLogger,
	guardSql,
	type LogLine,
} from "./memory.ts";

export type RenderRequest = {
	readonly slot: string;
	readonly ctx: SlotContext;
	readonly props?: unknown;
	/** The viewer (default: a user). */
	readonly viewer?: Actor;
};

export type ActionRequest = {
	readonly action: string;
	readonly payload?: unknown;
	readonly ctx: SlotContext;
	readonly actor?: Actor;
};

export type ToolRequest = {
	readonly name: string;
	readonly args?: unknown;
	readonly ctx: ToolContext;
};

export type RunExtensionOptions = {
	/** Grants default to `manifest.permissions`. */
	readonly manifest?: Manifest;
	readonly migrations?: readonly ExtMigration[];
	/**
	 * The extension's database. Deno: `createSqliteSql()` from
	 * `@tartan/testkit/sqlite`; workerd: a DO `ctx.storage.sql` adapter.
	 * Without one, any `x.sql` use throws.
	 */
	readonly sql?: Sql;
	readonly caps?: FakeKernelCapsOptions;
	readonly config?: unknown;
	readonly install?: Partial<InstallInfo>;
	readonly init?: boolean;
	readonly timers?: readonly string[];
	readonly renders?: readonly RenderRequest[];
	readonly actions?: readonly ActionRequest[];
	readonly tools?: readonly ToolRequest[];
	readonly context?: readonly ContextRequest[];
};

export type Outcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

export type RunExtensionResult = {
	/** Allowed effect calls, in order (events.emit, lanes.open, notify.send, …). */
	readonly effects: readonly CapsCall[];
	readonly denials: readonly CapsCall[];
	readonly calls: readonly CapsCall[];
	readonly events: readonly {
		readonly id: string;
		readonly outcome: Outcome<void>;
	}[];
	readonly renders: readonly {
		readonly slot: string;
		readonly outcome: Outcome<UiDoc>;
		/** `validateUi` errors (empty when the doc is valid tartan-ui@1). */
		readonly uiErrors: readonly string[];
	}[];
	readonly actions: readonly {
		readonly action: string;
		readonly outcome: Outcome<unknown>;
	}[];
	readonly tools: readonly {
		readonly name: string;
		readonly outcome: Outcome<unknown>;
	}[];
	readonly context: readonly Outcome<ContextSection[]>[];
	readonly logs: readonly LogLine[];
	readonly caps: FakeKernelCaps;
};

const NO_SQL: Sql = {
	exec: () => {
		throw new Error("runExtension: no sql given (pass options.sql)");
	},
	transaction: () => {
		throw new Error("runExtension: no sql given (pass options.sql)");
	},
};

const settle = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
	try {
		return { ok: true, value: await fn() };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
};

const DEFAULT_VIEWER: Actor = {
	kind: "user",
	id: "u_01k6vvvvvvvvvvvvvvvvvvvvvv",
};

/** Builds a kernel event envelope with test defaults. */
export const makeEvent = <T>(
	type: string,
	data: T,
	overrides: Partial<Envelope<T>> = {},
): Envelope<T> => {
	const id = overrides.id ?? createUlid()();
	return {
		id,
		seq: 1,
		stream: "repo:01k6rrrrrrrrrrrrrrrrrrrrrr",
		type,
		v: 1,
		source: { kind: "kernel" },
		actor: { kind: "agent", id: "a_01k6aaaaaaaaaaaaaaaaaaaaaa" },
		node: "01k6rrrrrrrrrrrrrrrrrrrrrr",
		repo: "01k6rrrrrrrrrrrrrrrrrrrrrr",
		depth: 0,
		shadow: false,
		at: Date.now(),
		...overrides,
		data,
	};
};

export const runExtension = async (
	module: ExtensionModule,
	events: readonly Envelope[] = [],
	options: RunExtensionOptions = {},
): Promise<RunExtensionResult> => {
	const base = createFakeKernelCaps({
		...options.caps,
		props: {
			...(options.manifest ? { grants: options.manifest.permissions } : {}),
			...options.caps?.props,
		},
	});
	const inst = options.install?.id ?? options.caps?.props?.inst ??
		DEFAULT_CAPS_PROPS.inst;
	const install: InstallInfo = {
		id: inst,
		extId: options.manifest?.id ?? "test.ext",
		version: options.manifest?.version ?? "0.0.0",
		node: options.caps?.props?.node ?? DEFAULT_CAPS_PROPS.node,
		scopeKey: "node",
		mode: options.caps?.props?.mode ?? "enforce",
		...options.install,
	};
	const background: Actor = { kind: "ext", id: extPrincipalId(inst) };
	const kv = createMemoryKv();
	const log = createRecordingLogger();
	const sql = options.sql ?? NO_SQL;
	const ctx = (
		caps: FakeKernelCaps,
		actor: Actor,
		readOnly: boolean,
	): ExtCtx => ({
		caps,
		sql: guardSql(sql, readOnly),
		kv,
		config: options.config ?? {},
		log,
		install,
		actor,
		readOnly,
	});
	const bg = ctx(base, background, false);

	for (const m of [...(options.migrations ?? [])].sort((a, b) => a.n - b.n)) {
		sql.exec(m.sql);
	}
	if ((options.init ?? true) && module.init) await module.init(bg);

	const eventOutcomes = [];
	for (const ev of events) {
		eventOutcomes.push({
			id: ev.id,
			outcome: await settle(async () => {
				await module.onEvent?.(ev, bg);
			}),
		});
	}
	for (const key of options.timers ?? []) {
		await module.onTimer?.(key, bg);
	}

	const renders = [];
	for (const r of options.renders ?? []) {
		const viewer = r.viewer ?? DEFAULT_VIEWER;
		const x = ctx(base.with({ readOnly: true }), viewer, true);
		const outcome = await settle(async () => {
			if (!module.render) throw new Error("module has no render");
			return await module.render(r.slot, r.ctx, r.props ?? {}, x);
		});
		const checked = outcome.ok ? validateUi(outcome.value) : null;
		renders.push({
			slot: r.slot,
			outcome,
			uiErrors: checked && !checked.ok ? [...checked.errors] : [],
		});
	}

	const actions = [];
	for (const a of options.actions ?? []) {
		const actor = a.actor ?? DEFAULT_VIEWER;
		actions.push({
			action: a.action,
			outcome: await settle(async () => {
				if (!module.onAction) throw new Error("module has no onAction");
				return await module.onAction(
					a.action,
					a.payload ?? {},
					a.ctx,
					ctx(base, actor, false),
				);
			}),
		});
	}

	const tools = [];
	for (const t of options.tools ?? []) {
		tools.push({
			name: t.name,
			outcome: await settle(async () => {
				if (!module.callTool) throw new Error("module has no callTool");
				return await module.callTool(
					t.name,
					t.args ?? {},
					t.ctx,
					ctx(base, t.ctx.actor, false),
				);
			}),
		});
	}

	const context = [];
	for (const req of options.context ?? []) {
		context.push(
			await settle(async () => {
				if (!module.context) throw new Error("module has no context");
				return await module.context(
					req,
					ctx(base.with({ readOnly: true }), DEFAULT_VIEWER, true),
				);
			}),
		);
	}

	return {
		effects: base.effects(),
		denials: base.denials(),
		calls: base.calls,
		events: eventOutcomes,
		renders,
		actions,
		tools,
		context,
		logs: log.lines,
		caps: base,
	};
};
