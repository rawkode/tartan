// `/-/api/slot/<installationId>/<slotId>` render (GET) and `/action` (POST)
// (K12).
//
// Render is a cookie-authenticated GET, reachable by a cross-site top-level
// link, so it only ever calls the host's read-only `render` (the host gives the
// extension a read-only `ExtCtx`). Its result is validated again against
// `tartan-ui@1` here: the SPA receives the parsed document or the host-only
// error chip (built from the extension id, never from extension text), with
// `cursor`, the repo's event-log head read before the render, so the SPA's live
// channel replays what the render may have missed. Actions are POST-only (CSRF:
// same-origin JSON, WP2's middleware), need a signed-in viewer, re-derive and
// confine `ctx` the same way and pass the viewer's credential bounds to the
// host.
//
// Every refusal (non-2xx) and every degraded answer (error chip, failed
// action toast) is logged as one JSON line with the route, installation,
// extension, slot, status and error code, so a regression shows in
// Workers Logs and `wrangler tail`. Never ctx values, headers, payloads or
// extension text: ids from the URL are logged only when well-formed.

import {
	ActionRequestSchema,
	type ActionResult,
	denied,
	DENIED_REASONS,
	errorChipDoc,
	fromRpcError,
	type HostUiDoc,
	invalid,
	isIdOf,
	type Manifest,
	notFound,
	SLOT_ITEM_ID_RE,
	type SlotContribution,
	type SlotId,
	type SlotRenderResponse,
	SLOTS,
	validateActionResult,
	validateUi,
	type WireError,
} from "@tartan/contract";
import { actorBoundsOf, type AuthContext } from "@tartan/contract/kernel.ts";
import type { ApiDeps, ApiLogEntry } from "./deps.ts";
import { actorOf, deriveSlotContext } from "./context.ts";
import { decodeCtxParam, guard, json, readJson, requireAuth } from "./http.ts";

type SlotTarget = {
	readonly installationId: string;
	readonly slotId: string;
};

type SlotRoute = "slot.render" | "slot.action";

/** The ids a slot log line carries: URL ids only when well-formed, never ctx. */
const logIds = (target: SlotTarget, ext: string | undefined) => ({
	installation: isIdOf("installation", target.installationId)
		? target.installationId
		: "(malformed)",
	slot: SLOT_ITEM_ID_RE.test(target.slotId) ? target.slotId : "(malformed)",
	...(ext === undefined ? {} : { ext }),
});

const CAUSE_MAX = 300;

const causeOf = (error: unknown): string =>
	(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
		.slice(0, CAUSE_MAX);

const KNOWN_REASONS: ReadonlySet<string> = new Set(DENIED_REASONS);

/**
 * The refusal reason a log line may carry: the kernel's own, or one of the
 * contract's denied reasons. An extension's refusal reaches the kernel as
 * `<code>(<reason>): <text>` over RPC, so its reason is extension text of
 * any length (a form value, say) and is logged as `(extension)`.
 */
const loggedReason = (
	reason: string | undefined,
	fromExtension: boolean,
): string | undefined =>
	reason === undefined || reason === ""
		? undefined
		: !fromExtension || KNOWN_REASONS.has(reason)
		? reason
		: "(extension)";

/** What a handler learned before it failed, for its log line. */
type Seen = {
	ext?: string;
	/** The refusal is the extension's own (passed through): its text and free-text reason are not logged. */
	fromExtension?: boolean;
};

/** `guard`'s `onError` for the slot routes: one line per refusal. */
const logRefusal = (
	deps: ApiDeps,
	route: SlotRoute,
	target: SlotTarget,
	seen: Seen,
) =>
(wire: WireError, status: number, error: unknown): void => {
	const reason = loggedReason(wire.reason, seen.fromExtension === true);
	const entry: ApiLogEntry = {
		level: status >= 500 ? "error" : "warn",
		event: "slot.refused",
		route,
		...logIds(target, seen.ext),
		status,
		code: wire.error,
		...(seen.fromExtension
			? { origin: "extension" }
			: { message: wire.message }),
		...(reason === undefined ? {} : { reason }),
		// The wire hides an internal error's text; the operator needs it.
		...(wire.error === "internal" ? { cause: causeOf(error) } : {}),
	};
	deps.log(entry);
};

/** A degraded answer (error chip, failed-action toast): 200 to the SPA, logged here. */
const logDegraded = (
	deps: ApiDeps,
	route: SlotRoute,
	target: SlotTarget,
	ext: string,
	what: {
		readonly outcome: "host_error" | "invalid_output";
		readonly error?: unknown;
	},
): void =>
	deps.log({
		level: "warn",
		event: "slot.degraded",
		route,
		...logIds(target, ext),
		outcome: what.outcome,
		// The code only: an extension's error text is not the kernel's to log.
		...(what.error === undefined
			? {}
			: { code: fromRpcError(what.error).code }),
	});

const findSlot = async (deps: ApiDeps, target: SlotTarget) => {
	if (
		!isIdOf("installation", target.installationId) ||
		!SLOT_ITEM_ID_RE.test(target.slotId)
	) {
		throw notFound("slot");
	}
	const installation = await deps.registry().installation(
		target.installationId,
	);
	if (installation === null || installation.mode === "disabled") {
		throw notFound("slot");
	}
	const pkg = (await deps.registry().packages(installation.extId)).find((p) =>
		p.version === installation.version
	);
	if (pkg === undefined) throw notFound("slot");
	const manifest: Manifest = pkg.manifest;
	const contribution = (manifest.contributes?.slots ?? []).find((s) =>
		s.id === target.slotId
	) as SlotContribution | undefined;
	if (contribution === undefined) throw notFound("slot");
	return { installation, manifest, contribution };
};

/** Static slots render nothing; dynamic contributions and routed tab pages do. */
const renderable = (c: SlotContribution): boolean => {
	const kind = SLOTS[c.slot as SlotId]?.kind;
	return c.dynamic || kind === "static+route" || kind === "static+dynamic";
};

/**
 * Re-validates a host render: the host-only error chip is rebuilt from
 * the extension id; anything else must pass `validateUi`, and only the
 * parsed copy is returned.
 */
export const sanitizeRender = (out: unknown, ext: string): HostUiDoc =>
	checkRender(out, ext).doc;

/** `sanitizeRender`, also telling whether the host's output was invalid. */
const checkRender = (
	out: unknown,
	ext: string,
): { readonly doc: HostUiDoc; readonly invalid: boolean } => {
	if (
		out !== null && typeof out === "object" &&
		(out as { root?: { t?: unknown } }).root?.t === "error-chip"
	) {
		return { doc: errorChipDoc(ext), invalid: false };
	}
	const result = validateUi(out);
	return result.ok
		? { doc: result.doc, invalid: false }
		: { doc: errorChipDoc(ext), invalid: true };
};

/**
 * The repo's event-log head before a render runs (`SlotRenderResponse.cursor`):
 * the SPA's live channel replays from it. Best effort: without it the SPA
 * subscribes from the socket's `hello`, as before.
 */
const cursorOf = async (
	deps: ApiDeps,
	repoId: string | undefined,
): Promise<number | undefined> => {
	if (repoId === undefined) return undefined;
	try {
		const head = await deps.events(repoId).head();
		return Number.isSafeInteger(head) && head >= 0 ? head : undefined;
	} catch {
		return undefined;
	}
};

export const renderSlot = (
	deps: ApiDeps,
	req: Request,
	target: SlotTarget,
	auth: AuthContext | null,
): Promise<Response> => {
	const seen: Seen = {};
	return guard(async () => {
		const { installation, contribution } = await findSlot(deps, target);
		seen.ext = installation.extId;
		if (!renderable(contribution)) throw notFound("slot");
		const hints = decodeCtxParam(new URL(req.url).searchParams.get("ctx"));
		const derived = await deriveSlotContext(deps, {
			installation,
			contribution,
			hints,
			auth,
		});
		// Read before the render, so every event the render may have missed
		// is after the cursor (the viewer reads this repo: checked above).
		const cursor = await cursorOf(deps, derived.ctx.repo);
		let doc: HostUiDoc;
		try {
			const out = await deps.ext(installation.id, derived.scope).render(
				contribution.id,
				derived.ctx,
				{
					...(auth ? { actor: actorOf(auth) } : {}),
					role: derived.role,
					kind: auth?.kind ?? "anonymous",
				},
			);
			const checked = checkRender(out, installation.extId);
			if (checked.invalid) {
				logDegraded(deps, "slot.render", target, installation.extId, {
					outcome: "invalid_output",
				});
			}
			doc = checked.doc;
		} catch (error) {
			// Errors and timeouts become the error chip; the page never breaks.
			logDegraded(deps, "slot.render", target, installation.extId, {
				outcome: "host_error",
				error,
			});
			doc = errorChipDoc(installation.extId);
		}
		return json(
			(cursor === undefined
				? doc
				: { ...doc, cursor }) satisfies SlotRenderResponse,
		);
	}, logRefusal(deps, "slot.render", target, seen));
};

const PASSED_THROUGH: ReadonlySet<string> = new Set([
	"denied",
	"invalid",
	"conflict",
	"not_found",
	"stale",
	"rate_limited",
]);

const actionFailed = (ext: string): ActionResult => ({
	v: 1,
	toast: { tone: "danger", text: `${ext}: action failed` },
});

export const slotAction = (
	deps: ApiDeps,
	req: Request,
	target: SlotTarget,
	authIn: AuthContext | null,
): Promise<Response> => {
	const seen: Seen = {};
	return guard(async () => {
		const auth = requireAuth(authIn);
		const { installation, contribution } = await findSlot(deps, target);
		seen.ext = installation.extId;
		if (installation.mode !== "enforce") {
			throw denied("shadow", "a shadow installation takes no actions");
		}
		const body = ActionRequestSchema.safeParse(await readJson(req));
		if (!body.success) {
			const ctxIssue = body.error.issues.some((i) => i.path[0] === "ctx");
			throw invalid(ctxIssue ? "invalid ctx" : "invalid action request", {
				issues: body.error.issues.map((i) =>
					`${i.path.join(".") || "(root)"}: ${i.message}`
				),
			});
		}
		const derived = await deriveSlotContext(deps, {
			installation,
			contribution,
			hints: body.data.ctx ?? {},
			auth,
		});
		let out: unknown;
		try {
			out = await deps.ext(installation.id, derived.scope).action(
				contribution.id,
				body.data.action,
				body.data.payload ?? null,
				derived.ctx,
				actorOf(auth),
				actorBoundsOf(auth),
			);
		} catch (error) {
			// Typed refusals reach the caller; failures and timeouts are a toast.
			const e = fromRpcError(error);
			if (PASSED_THROUGH.has(e.code)) {
				seen.fromExtension = true;
				throw e;
			}
			logDegraded(deps, "slot.action", target, installation.extId, {
				outcome: "host_error",
				error,
			});
			return json(actionFailed(installation.extId));
		}
		const result = validateActionResult(out);
		if (!result.ok) {
			logDegraded(deps, "slot.action", target, installation.extId, {
				outcome: "invalid_output",
			});
		}
		return json(result.ok ? result.result : actionFailed(installation.extId));
	}, logRefusal(deps, "slot.action", target, seen));
};
