// tartan.work slots: the Work tab (`repo.tab`
// "work": the item list and a create form, or one item when the route names
// it), the item panel (`work.panel` "item": contract, claims, comments and a
// comment form), the "New work" header action and the why-blame intent
// annotation (`blame.annotation` "intent": the item whose change landed the
// annotated commit). Renders are read-only; actions run as the viewer.

import {
	type ActionResult,
	denied,
	type ExtCtx,
	invalid,
	type SlotContext,
	type UiDoc,
	type UiNode,
	type WorkItem,
} from "@tartan/contract";
import { action, result, ui } from "@tartan/ext-api";
import { itemMarkdown } from "./context.ts";
import { itemOfEntityId, type RepoCtx, repoOf, workItemOf } from "./repo.ts";
import { createStore, parseWorkRef } from "./store.ts";
import { commentOn, createItem } from "./tools.ts";
import { type Wording, wordingOf } from "./wording.ts";

const REFRESH = ["work.*", "changes.*"];

const STATE_TONE: Readonly<
	Record<
		WorkItem["state"],
		"info" | "warning" | "success" | "muted" | "neutral"
	>
> = {
	open: "neutral",
	claimed: "info",
	in_review: "warning",
	done: "success",
	abandoned: "muted",
};

const itemHref = (repo: RepoCtx, n: number): string =>
	`/${repo.path}/-/work/${n}`;

const createForm = (w: Wording): UiNode =>
	ui.section(`New ${w.one}`, [
		ui.form([
			ui.input("title", { label: "Title", required: true }),
			ui.select("kind", ["issue", "intent"], {
				label: "Kind",
				value: "issue",
			}),
			ui.textarea("why", { label: "Why" }),
			ui.textarea("acceptance", { label: "Acceptance (one per line)" }),
		], { text: "Create", action: action("create") }),
	]);

const listPage = (x: ExtCtx, repo: RepoCtx, ctx: SlotContext): UiDoc => {
	const w = wordingOf(x.config);
	const store = createStore(x.sql);
	const rows = store.items({ limit: 200 });
	const items = rows.map((r) => workItemOf(x, repo, r));
	const open = items.filter((i) =>
		i.state !== "done" && i.state !== "abandoned"
	);
	const table = items.length === 0
		? ui.empty(
			`No ${w.many} yet`,
			"Create one, or let agents propose intents.",
		)
		: ui.table(
			["#", "Title", "Kind", "State", "Claims"],
			items.map((i) => {
				const n = parseWorkRef(i.ref)!.n;
				return [
					n,
					ui.link(i.title, itemHref(repo, n)),
					i.kind,
					ui.badge(i.state.replace("_", " "), STATE_TONE[i.state]),
					i.claims.filter((c) =>
						c.state === "active" || c.state === "submitted"
					)
						.length,
				];
			}),
		);
	const viewerCanWrite = ctx.viewer !== undefined;
	return ui.doc(
		ui.stack([
			ui.row([
				ui.stat("Open", open.length),
				ui.stat("Done", items.filter((i) => i.state === "done").length),
			]),
			table,
			...(viewerCanWrite ? [createForm(w)] : []),
		]),
		{ refreshOn: REFRESH },
	);
};

const itemPage = (x: ExtCtx, repo: RepoCtx, entityId: string): UiDoc => {
	const store = createStore(x.sql);
	const row = itemOfEntityId(x, repo, entityId);
	if (row === null) {
		return ui.doc(ui.empty(`No ${wordingOf(x.config).one} ${entityId}`));
	}
	const item = workItemOf(x, repo, row);
	const comments = store.comments(row.id);
	const claims = item.claims.length === 0
		? ui.text("Not claimed yet.", { tone: "muted" })
		: ui.table(
			["Principal", "Lane", "State"],
			item.claims.map((c) => [
				ui.avatar(c.principal),
				ui.link(c.laneId, `/${repo.path}/-/lanes/${c.laneId}`),
				c.state,
			]),
		);
	return ui.doc(
		ui.stack([
			ui.row([
				ui.badge(item.kind),
				ui.badge(item.state.replace("_", " "), STATE_TONE[item.state]),
			]),
			ui.markdown(itemMarkdown(item)),
			ui.section("Claims", [claims]),
			ui.section("Comments", [
				comments.length === 0
					? ui.text("No comments.", { tone: "muted" })
					: ui.timeline(
						comments.map((c) => ({
							at: c.at,
							text: c.body_md,
							actor: c.author_id,
						})),
					),
				ui.form([ui.textarea("body", { label: "Comment", required: true })], {
					text: "Comment",
					action: action("comment", { ref: item.ref }),
				}),
			]),
		]),
		{ refreshOn: REFRESH },
	);
};

const intentAnnotation = (
	x: ExtCtx,
	repo: RepoCtx,
	ctx: SlotContext,
): UiDoc => {
	const sha = ctx.ref;
	const row = sha ? createStore(x.sql).itemByCommit(sha) : null;
	if (row === null) return ui.doc(ui.empty("No recorded intent"));
	const item = workItemOf(x, repo, row);
	return ui.doc(
		ui.stack([
			ui.link(`${item.ref}: ${item.title}`, itemHref(repo, row.number)),
			...(item.why.trim() !== "" ? [ui.text(item.why.slice(0, 500))] : []),
		]),
	);
};

export const render = async (
	slot: string,
	ctx: SlotContext,
	_props: unknown,
	x: ExtCtx,
): Promise<UiDoc> => {
	const repo = await repoOf(x, ctx.repo);
	const entity = ctx.entity?.kind === "work" ? ctx.entity.id : undefined;
	switch (slot) {
		case "work":
			return entity !== undefined
				? itemPage(x, repo, entity)
				: listPage(x, repo, ctx);
		case "item":
			return entity !== undefined
				? itemPage(x, repo, entity)
				: ui.doc(ui.empty(`No ${wordingOf(x.config).one} selected`));
		case "intent":
			return intentAnnotation(x, repo, ctx);
		default:
			return ui.doc(ui.empty(`tartan.work has no slot ${slot}`));
	}
};

const field = (payload: unknown, name: string): string => {
	const value = (payload as Record<string, unknown> | null)?.[name];
	return typeof value === "string" ? value.trim() : "";
};

export const onAction = async (
	name: string,
	payload: unknown,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<ActionResult> => {
	const repo = await repoOf(x, ctx.repo);
	switch (name) {
		case "create": {
			const allowed = await x.caps.authz.check(
				x.actor.id,
				{ id: repo.id },
				"submit",
			);
			if (!allowed) throw denied("role", "creating work needs Developer");
			const title = field(payload, "title");
			if (title === "" || title.length > 200) {
				throw invalid("a title of 1 to 200 characters is required");
			}
			const kind = field(payload, "kind") === "intent" ? "intent" : "issue";
			const acceptance = field(payload, "acceptance").split("\n")
				.map((l) => l.trim()).filter((l) => l !== "").slice(0, 50);
			const item = await createItem(x, repo, {
				kind,
				title,
				why: field(payload, "why").slice(0, 8000),
				acceptance,
			});
			return result.navigate(itemHref(repo, parseWorkRef(item.ref)!.n));
		}
		case "new-work":
			return result.navigate(`/${repo.path}/-/work`);
		case "comment": {
			const ref = field(payload, "ref");
			const body = field(payload, "body");
			if (body === "" || body.length > 8000) {
				throw invalid("a comment of 1 to 8000 characters is required");
			}
			await commentOn(x, repo, ref, body);
			// The item re-rendered with its new comment: the panel never waits
			// on the live feed for the viewer's own comment (e2e).
			return {
				...result.toast("success", "Comment added"),
				render: itemPage(
					x,
					repo,
					ctx.entity?.kind === "work" ? ctx.entity.id : ref,
				),
			};
		}
		default:
			throw invalid(`tartan.work has no action ${name}`);
	}
};
