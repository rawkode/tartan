// tartan.changes slots: the Changes tab (the
// list), the change tabs Diff (the latest or a chosen revision against its
// range base) and Revisions (every revision, and the interdiff of a revision
// against the previous one: per-file hunks from `caps.repo.hunks`), the
// overview panel (title, state, review decision, author, revision and
// diffstat, summary, timeline and Abandon), the threads panel (comments
// grouped by file and line, resolve and reply) and the lane sidebar (the
// lane's change). Each renders only where the slot catalogue delivers its
// context: `repo.tab` takes no entity, so a change's overview is a
// `change.panel`. Renders are read-only; actions run as the
// viewer.

import {
	type ActionResult,
	type Change,
	denied,
	type ExtCtx,
	invalid,
	type SlotContext,
	type UiDoc,
	type UiNode,
} from "@tartan/contract";
import { action, json, result, ui } from "@tartan/ext-api";
import { changeDto, type RepoCtx, repoOf } from "./core.ts";
import { type CommentRow, createStore } from "./store.ts";
import { abandonChange, commentOn } from "./tools.ts";
import { capital, wordingOf } from "./wording.ts";

const REFRESH = ["changes.*", "review.*", "queue.*", "land.*"];

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";
const STATE_TONE: Readonly<Record<Change["state"], Tone>> = {
	draft: "muted",
	submitted: "info",
	approved: "success",
	queued: "info",
	landing: "warning",
	landed: "success",
	ejected: "danger",
	abandoned: "muted",
	superseded: "muted",
};

const changeHref = (repo: RepoCtx, id: string, tab?: string): string =>
	`/${repo.path}/-/changes/${id}${tab ? `/${tab}` : ""}`;

const stateBadge = (state: Change["state"]): UiNode =>
	ui.badge(state, STATE_TONE[state]);

const revisionOf = (change: Change, ctx: SlotContext) => {
	const wanted = Number(ctx.extra?.revision);
	return change.revisions.find((r) => r.n === wanted) ??
		change.revisions.at(-1);
};

const changeFromCtx = (
	x: ExtCtx,
	repo: RepoCtx,
	ctx: SlotContext,
): Change | null => {
	const id = ctx.entity?.kind === "change" ? ctx.entity.id : undefined;
	const store = createStore(x.sql);
	const row = id
		? store.change(id)
		: ctx.entity?.kind === "lane"
		? store.changeByLane(ctx.entity.id)
		: null;
	return row === null ? null : changeDto(x, repo, row);
};

const listPage = (x: ExtCtx, repo: RepoCtx): UiDoc => {
	const w = wordingOf(x.config);
	const rows = createStore(x.sql).changes({ limit: 200 });
	if (rows.length === 0) {
		return ui.doc(
			ui.empty(
				`No ${w.many} yet`,
				`Agents' lanes become draft ${w.many}; submit to start review.`,
			),
			{ refreshOn: REFRESH },
		);
	}
	const changes = rows.map((r) => changeDto(x, repo, r));
	return ui.doc(
		ui.table(
			[capital(w.one), "State", "Revision", "Author", w.work],
			changes.map((c) => [
				ui.link(c.title, changeHref(repo, c.changeId)),
				stateBadge(c.state),
				c.revisions.length,
				ui.avatar(c.author),
				c.workRef ?? "",
			]),
		),
		{ refreshOn: REFRESH },
	);
};

const overview = (x: ExtCtx, repo: RepoCtx, change: Change): UiDoc => {
	const store = createStore(x.sql);
	const latest = change.revisions.at(-1);
	const review = json.decode<{ decision?: string; revision?: number } | null>(
		store.change(change.changeId)?.review_json ?? null,
		null,
	);
	const timeline = store.timeline(change.changeId);
	return ui.doc(
		ui.stack([
			ui.heading(change.title),
			ui.row([
				stateBadge(change.state),
				...(review?.decision
					? [
						ui.badge(
							`review: ${review.decision} (r${review.revision})`,
							review.decision === "approve" ? "success" : "warning",
						),
					]
					: []),
			]),
			ui.kv([
				{ k: "Change", v: ui.code(change.changeId) },
				{
					k: "Lane",
					v: ui.link(change.laneId, `/${repo.path}/-/lanes/${change.laneId}`),
				},
				...(change.workRef ? [{ k: "Work", v: change.workRef }] : []),
				...(change.sourceRef ? [{ k: "Branch", v: change.sourceRef }] : []),
				{ k: "Author", v: ui.avatar(change.author) },
				...(latest
					? [
						{ k: "Revision", v: `${latest.n} at ${latest.head.slice(0, 12)}` },
						{ k: "Affected", v: latest.affected.join(", ") || "none" },
						{
							k: "Diffstat",
							v: `${latest.diffstat.files} files, +${latest.diffstat.additions} −${latest.diffstat.deletions}`,
						},
					]
					: [{ k: "Revision", v: "not submitted yet" }]),
				...(change.landedCommit
					? [{ k: "Landed", v: ui.code(change.landedCommit) }]
					: []),
			]),
			...(change.summary.trim() !== "" ? [ui.markdown(change.summary)] : []),
			ui.row([
				ui.link("Diff", changeHref(repo, change.changeId, "diff")),
				ui.link("Revisions", changeHref(repo, change.changeId, "revisions")),
			]),
			ui.section("Timeline", [
				timeline.length === 0
					? ui.text("Nothing yet.", { tone: "muted" })
					: ui.timeline(timeline.map((t) => ({
						at: t.at,
						text: t.text,
						...(t.actor ? { actor: t.actor } : {}),
					}))),
			]),
			...(["draft", "submitted", "approved", "ejected", "queued"].includes(
					change.state,
				)
				? [
					ui.button(
						"Abandon",
						action(
							"abandon",
							{ changeId: change.changeId },
							"Abandon this change?",
						),
						"danger",
					),
				]
				: []),
		]),
		{ refreshOn: REFRESH },
	);
};

const diffTab = (repo: RepoCtx, change: Change, ctx: SlotContext): UiDoc => {
	const rev = revisionOf(change, ctx);
	if (rev === undefined) {
		return ui.doc(
			ui.empty(
				"No revision yet",
				"The diff appears once the change is submitted.",
			),
		);
	}
	return ui.doc(
		ui.stack([
			ui.text(
				`Revision ${rev.n}: ${rev.base.slice(0, 12)}…${rev.head.slice(0, 12)}`,
				{ mono: true },
			),
			ui.diff({
				repo: repo.path,
				base: rev.base,
				head: rev.head,
				source: `lane ${change.laneId}, revision ${rev.n}`,
				// A `repo` lane's head is in its lane repo until it lands: the host
				// compares within the lane (members only).
				lane: change.laneId,
			}),
		]),
		{ refreshOn: ["changes.*"] },
	);
};

const revisionsTab = async (
	x: ExtCtx,
	repo: RepoCtx,
	change: Change,
	ctx: SlotContext,
): Promise<UiDoc> => {
	if (change.revisions.length === 0) {
		return ui.doc(ui.empty("No revisions yet"));
	}
	const table = ui.table(
		["Revision", "Head", "Base", "Affected", "Files", "At"],
		change.revisions.map((r) => [
			ui.link(`r${r.n}`, changeHref(repo, change.changeId, "revisions")),
			ui.code(r.head.slice(0, 12)),
			ui.code(r.base.slice(0, 12)),
			r.affected.join(", "),
			r.diffstat.files,
			new Date(r.at).toISOString(),
		]),
	);
	const rev = revisionOf(change, ctx);
	const prev = rev
		? change.revisions.find((r) => r.n === rev.n - 1)
		: undefined;
	if (rev === undefined || prev === undefined) {
		return ui.doc(ui.stack([table]), { refreshOn: ["changes.*"] });
	}
	// Interdiff: what changed between the two revision heads.
	const source = { repoId: repo.id, laneId: change.laneId };
	let interdiff: UiNode;
	try {
		const paths = await x.caps.repo.diffPaths(source, prev.head, rev.head);
		const hunks = await x.caps.repo.hunks(
			source,
			prev.head,
			rev.head,
			paths.paths.slice(0, 200).map((p) => p.path),
		);
		interdiff = hunks.length === 0
			? ui.text("The revisions have the same tree.", { tone: "muted" })
			: ui.table(
				["File", "Hunks"],
				hunks.map((f) => [
					f.path,
					f.binary
						? "binary"
						: f.pathLevel
						? "changed"
						: f.hunks.map((h) =>
							`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`
						).join(" "),
				]),
			);
	} catch {
		interdiff = ui.text("Interdiff unavailable.", { tone: "muted" });
	}
	return ui.doc(
		ui.stack([
			table,
			ui.section(`Interdiff r${prev.n} → r${rev.n}`, [
				interdiff,
				ui.diff({
					repo: repo.path,
					base: prev.head,
					head: rev.head,
					source: `r${prev.n} → r${rev.n}`,
					lane: change.laneId,
				}),
			]),
		]),
		{ refreshOn: ["changes.*"] },
	);
};

const threadKey = (c: CommentRow): string =>
	c.path ? `${c.path}:${c.line ?? 0}` : "";

const threadsPanel = (x: ExtCtx, change: Change): UiDoc => {
	const comments = createStore(x.sql).comments(change.changeId);
	const threads = new Map<string, CommentRow[]>();
	for (const c of comments) {
		const key = threadKey(c);
		threads.set(key, [...(threads.get(key) ?? []), c]);
	}
	const sections: UiNode[] = [...threads.entries()].map(([key, list]) => {
		const head = list[0];
		const open = list.some((c) => c.resolved === 0);
		return ui.card([
			ui.row([
				ui.label(
					key === ""
						? "General"
						: `${head.path}${head.line ? ` L${head.line}` : ""}`,
				),
				ui.badge(open ? "open" : "resolved", open ? "warning" : "success"),
			]),
			ui.timeline(
				list.map((c) => ({ at: c.at, text: c.body_md, actor: c.author_id })),
			),
			...(open && key !== ""
				? [ui.button("Resolve", action("resolve", { commentId: head.id }))]
				: []),
		]);
	});
	return ui.doc(
		ui.stack([
			...(sections.length === 0
				? [ui.text("No comments yet.", { tone: "muted" })]
				: sections),
			ui.form([
				ui.textarea("body", { label: "Comment", required: true }),
				ui.input("path", { label: "File (optional)" }),
				ui.input("line", { label: "Line (optional)" }),
			], {
				text: "Comment",
				action: action("comment", { changeId: change.changeId }),
			}),
		]),
		{ refreshOn: ["changes.*"] },
	);
};

const laneSidebar = (repo: RepoCtx, change: Change | null): UiDoc => {
	if (change === null) return ui.doc(ui.empty("No change for this lane yet"));
	const latest = change.revisions.at(-1);
	return ui.doc(
		ui.stack([
			ui.link(change.title, changeHref(repo, change.changeId)),
			ui.row([
				stateBadge(change.state),
				...(latest ? [ui.badge(`r${latest.n}`)] : []),
			]),
		]),
		{ refreshOn: ["changes.*"] },
	);
};

export const render = async (
	slot: string,
	ctx: SlotContext,
	_props: unknown,
	x: ExtCtx,
): Promise<UiDoc> => {
	const repo = await repoOf(x, ctx.repo);
	const change = changeFromCtx(x, repo, ctx);
	switch (slot) {
		case "changes":
			return listPage(x, repo);
		case "overview":
			return change
				? overview(x, repo, change)
				: ui.doc(ui.empty("No change selected"));
		case "diff":
			return change
				? diffTab(repo, change, ctx)
				: ui.doc(ui.empty("No change selected"));
		case "revisions":
			return change
				? await revisionsTab(x, repo, change, ctx)
				: ui.doc(ui.empty("No change selected"));
		case "threads":
			return change
				? threadsPanel(x, change)
				: ui.doc(ui.empty("No change selected"));
		case "change":
			return laneSidebar(repo, change);
		default:
			return ui.doc(ui.empty(`tartan.changes has no slot ${slot}`));
	}
};

const text = (payload: unknown, name: string): string => {
	const v = (payload as Record<string, unknown> | null)?.[name];
	return typeof v === "string"
		? v.trim()
		: typeof v === "number"
		? String(v)
		: "";
};

export const onAction = async (
	name: string,
	payload: unknown,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<ActionResult> => {
	const repo = await repoOf(x, ctx.repo);
	const store = createStore(x.sql);
	switch (name) {
		case "comment": {
			const body = text(payload, "body");
			if (body === "" || body.length > 8000) {
				throw invalid("a comment of 1 to 8000 characters is required");
			}
			const path = text(payload, "path");
			const line = Number(text(payload, "line"));
			await commentOn(x, repo, {
				changeId: text(payload, "changeId"),
				body,
				...(path ? { path } : {}),
				...(path && Number.isInteger(line) && line > 0 ? { line } : {}),
			});
			return result.toast("success", "Comment added");
		}
		case "resolve": {
			const comment = store.comment(text(payload, "commentId"));
			if (comment === null) throw invalid("no such comment");
			const allowed = comment.author_id === x.actor.id ||
				(await x.caps.authz.check(x.actor.id, { id: repo.id }, "approve")) ||
				store.change(comment.change_id)?.author_id === x.actor.id;
			if (!allowed) {
				throw denied(
					"role",
					"the commenter, the change's author or a Maintainer resolves",
				);
			}
			store.resolveThread(comment);
			return result.toast("success", "Resolved");
		}
		case "abandon":
			await abandonChange(
				x,
				repo,
				text(payload, "changeId"),
				"abandoned in the UI",
			);
			return result.toast(
				"success",
				`${capital(wordingOf(x.config).one)} abandoned`,
			);
		default:
			throw invalid(`tartan.changes has no action ${name}`);
	}
};
