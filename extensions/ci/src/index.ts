// tartan.ci: the `checks@1` provider.
//
// - `changes.submitted`/`changes.revised` → plan affected jobs from the
//   policy at the change's base on trunk (K13), reuse cached successes by
//   input hash, `runs.start` the rest, `checks.updated`/`checks.completed`.
// - `land.testing` → the same for the candidate with `on.land` jobs, then
//   `land.report` echoing `(attempt, candidateSha)` (K14).
// - `push.diffed` on canonical branches matching `on.push.branches` → a push
//   run (internal checks; `checks@1` subjects are changes and candidates).
// - `run.*`/`job.*` → check states; a `poll:<runId>` timer is the safety net.
// - `repo.config.resolved` → plan again what waited for its base's Tartan
//   config (the pipeline is repo policy in package `tartan`, ADR repo config).
// - Tools `checks_get`, `checks_rerun`; slots `change.sidebar` checks,
//   `repo.tab` CI (beside the kernel Runs view), `repo.sidebar` projects;
//   `context@1` test commands.

import {
	CHECKS_TOOLS,
	type ContextRequest,
	type ContextSection,
	type ExtCtx,
	invalid,
	type UiDoc,
} from "@tartan/contract";
import { defineExtension, result, ui } from "@tartan/ext-api";
import { createCi } from "./ci.ts";
import { isUnder } from "./pipeline/index.ts";
import { renderChecks, renderProjects, renderRuns } from "./ui.ts";

export { migrations } from "./migrations.ts";
export { settingsCue } from "./settings-cue.ts";
/** Protocol card (`contributes.protocol`); none: agents see checks in results. */
export const protocol: string | undefined = undefined;

const CONTEXT_MAX_PROJECTS = 12;

/** context@1 "test-commands": what CI runs for the projects in play (policy from trunk). */
const testCommandsContext = (
	req: ContextRequest,
	x: ExtCtx,
): ContextSection[] => {
	const ci = createCi(x);
	const policy = ci.store.policy();
	if (policy === null) return [];
	const paths = req.paths ?? [];
	const relevant = paths.length === 0
		? policy.commands
		: policy.commands.filter((c) => paths.some((p) => isUnder(p, c.root)));
	const shown = relevant.slice(0, CONTEXT_MAX_PROJECTS);
	if (shown.length === 0) return [];
	const lines = [
		`CI runs these commands (policy read from trunk at ${
			policy.sha.slice(0, 7)
		}, ${
			policy.mode === "zero" ? "zero-config" : "package tartan"
		}); run them before you submit:`,
		...shown.flatMap((c) =>
			c.commands.map((cmd) =>
				`- ${c.project}: \`${cmd.run}\`${cmd.cwd ? ` (in ${cmd.cwd})` : ""}`
			)
		),
		...(relevant.length > shown.length
			? [`- … and ${relevant.length - shown.length} more projects`]
			: []),
	];
	let md = lines.join("\n");
	if (new TextEncoder().encode(md).length > req.maxBytes) {
		md = md.slice(0, Math.max(0, req.maxBytes - 2)) + " …";
	}
	return [{
		id: "test-commands",
		title: "Test commands",
		priority: "hints",
		md,
	}];
};

export const extension = defineExtension({
	onEvent: async (ev, x) => {
		const ci = createCi(x);
		switch (ev.type) {
			case "changes.submitted":
			case "changes.revised":
				return await ci.onChange(ev);
			case "land.testing":
				return await ci.onLandTesting(ev);
			case "push.diffed":
				return await ci.onPushDiffed(ev);
			case "repo.config.resolved":
				return await ci.onConfigResolved(ev);
			default:
				if (ev.type.startsWith("run.") || ev.type.startsWith("job.")) {
					return await ci.onRunEvent(ev);
				}
		}
	},
	onTimer: async (key, x) => await createCi(x).onTimer(key),
	render: async (slot, ctx, _props, x): Promise<UiDoc> => {
		const ci = createCi(x);
		switch (slot) {
			case "checks":
				return await renderChecks(ci, ctx, x);
			case "ci":
				return await renderRuns(ci, ctx, x);
			case "projects":
				return renderProjects(ci);
			default:
				return ui.doc(ui.empty(`unknown slot ${slot}`));
		}
	},
	onAction: async (action, payload, _ctx, x) => {
		if (action !== "rerun") throw invalid(`unknown action ${action}`);
		const changeId = (payload as { changeId?: unknown } | null)?.changeId;
		if (typeof changeId !== "string") throw invalid("changeId required");
		const out = await createCi(x).rerun({ kind: "change", id: changeId });
		return result.toast(
			"info",
			out.runId ? `Re-running checks (${out.runId})` : "Checks re-planned",
		);
	},
	callTool: async (name, args, _ctx, x) => {
		const ci = createCi(x);
		if (name === "checks_get") {
			const parsed = CHECKS_TOOLS.checks_get.input.safeParse(args);
			if (!parsed.success) throw invalid("checks_get: invalid arguments");
			const a = parsed.data as {
				changeId?: string;
				subject?: { kind: string; id: string };
				sha?: string;
			};
			return { checks: ci.checksOf(ci.subjectOf(a), a.sha).checks };
		}
		if (name === "checks_rerun") {
			const parsed = CHECKS_TOOLS.checks_rerun.input.safeParse(args);
			if (!parsed.success) throw invalid("checks_rerun: invalid arguments");
			return await ci.rerun(
				ci.subjectOf(
					parsed.data as {
						changeId?: string;
						subject?: { kind: string; id: string };
					},
				),
			);
		}
		throw invalid(`tartan.ci has no tool ${name}`);
	},
	context: (req, x) => Promise.resolve(testCommandsContext(req, x)),
});

export default extension;
