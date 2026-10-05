// Agent-to-agent messages (`inbox_send`, WP6): the
// one implementation of the membership rule, shared by `/-/api/inbox/send`
// and WP11's MCP tool. The recipient must hold a role on the repo; the body
// is at most 2 KB of UTF-8 (rejected, never truncated), stripped of
// control characters and delivered as a `message` notice whose source is the
// sender, so it is shown fenced with the sender's label.

import {
	byteLength,
	denied,
	INBOX_BODY_MAX_BYTES,
	invalid,
	isPrincipalId,
	LaneIdSchema,
	sanitizeInboxBody,
	ULID_RE,
} from "@tartan/contract";
import type { EffectiveRole } from "@tartan/contract";
import type { InboxApi } from "./module.ts";

export type InboxSendDeps = {
	/** The recipient's effective role on the repo (0 = none). */
	roleOn(principal: string, repoId: string): Promise<EffectiveRole>;
	inbox(principal: string): Pick<InboxApi, "deliver">;
};

export type InboxSendInput = {
	/** The sending principal (already authorized on the repo by the caller). */
	readonly from: string;
	/** Shown as the notice's source label (the sender's handle). */
	readonly fromLabel?: string;
	/** The recipient's principal id. */
	readonly to: string;
	readonly body: string;
	readonly repoId: string;
	readonly laneId?: string;
};

export const createInboxSend = (deps: InboxSendDeps) =>
async (
	input: InboxSendInput,
): Promise<{ id: string; created: boolean }> => {
	if (!isPrincipalId(input.from)) throw invalid("from is a principal id");
	if (!isPrincipalId(input.to)) throw invalid("to is a principal id");
	if (!ULID_RE.test(input.repoId)) throw invalid("repo is a repo id");
	if (
		input.laneId !== undefined && !LaneIdSchema.safeParse(input.laneId).success
	) throw invalid("laneId");
	if (typeof input.body !== "string" || input.body.trim() === "") {
		throw invalid("body is required");
	}
	if (byteLength(input.body) > INBOX_BODY_MAX_BYTES) {
		throw invalid(`body exceeds ${INBOX_BODY_MAX_BYTES} bytes of UTF-8`);
	}
	if ((await deps.roleOn(input.to, input.repoId)) <= 0) {
		throw denied("role", "the recipient has no role on this repo");
	}
	return await deps.inbox(input.to).deliver({
		repoId: input.repoId,
		...(input.laneId !== undefined ? { laneId: input.laneId } : {}),
		kind: "message",
		severity: "info",
		text: sanitizeInboxBody(input.body),
		source: input.from,
		...(input.fromLabel !== undefined ? { sourceLabel: input.fromLabel } : {}),
	});
};
