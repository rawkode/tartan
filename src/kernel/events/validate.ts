// Append-time validation of the per-repo log (WP6). Caps already checks
// `mayEmit` against the manifest's `provides`; RepoDO re-checks what it can
// know on its own: the envelope fields, the depth guard, the type namespace for
// the producer and the payload schema, plus the 16 KB data cap.

import { z } from "zod";
import {
	ActorSchema,
	byteLength,
	denied,
	EntityRefSchema,
	EVENT_DATA_MAX_BYTES,
	EventSourceSchema,
	EventTypeSchema,
	extensionEventPrefix,
	interfaceOfEventType,
	invalid,
	isExtensionEventType,
	isKernelEventType,
	isKernelNamespace,
	KERNEL_EVENT_STREAMS,
	MAX_EVENT_DEPTH,
	tartanError,
	UlidSchema,
	validateEventData,
} from "@tartan/contract";
import type { AppendInput, EventSource } from "@tartan/contract";

const AppendInputSchema = z.strictObject({
	type: EventTypeSchema,
	v: z.number().int().min(1).max(1000).optional(),
	source: EventSourceSchema,
	actor: ActorSchema,
	node: UlidSchema,
	repo: UlidSchema.optional(),
	subject: EntityRefSchema.optional(),
	causedBy: UlidSchema.optional(),
	correlation: z.string().max(256).optional(),
	depth: z.number().int().min(0),
	shadow: z.boolean(),
	sim: z.boolean().optional(),
	data: z.unknown(),
	idemKey: z.string().min(1).max(512),
});

/** The validated, normalized input of one append. */
export type ValidAppend = {
	readonly type: string;
	readonly v: number;
	readonly source: EventSource;
	readonly actor: z.infer<typeof ActorSchema>;
	readonly node: string;
	readonly repo: string;
	readonly subject?: z.infer<typeof EntityRefSchema>;
	readonly causedBy?: string;
	readonly correlation?: string;
	readonly depth: number;
	readonly shadow: boolean;
	readonly sim: boolean;
	readonly dataJson: string;
	readonly idemKey: string;
};

const issuesText = (error: z.ZodError): string =>
	error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("; ");

/** `<extId>` of an installation source's `ext` (`<extId>@<version>`). */
export const extIdOf = (ext: string): string => {
	const at = ext.lastIndexOf("@");
	return at > 0 ? ext.slice(0, at) : ext;
};

/**
 * K10's namespace rule as far as the log can check it: the kernel appends
 * kernel types of a repo stream; an installation never appends a kernel
 * namespace, its private events are `x.<its extId>.<name>`, and anything
 * else must be an interface event (caps checks `provides`).
 */
export const namespaceIssue = (
	source: EventSource,
	type: string,
): string | null => {
	if (source.kind === "kernel") {
		if (!isKernelEventType(type)) return `kernel cannot emit ${type}`;
		return KERNEL_EVENT_STREAMS[type] === "forge"
			? `${type} belongs to the forge stream`
			: null;
	}
	if (isKernelNamespace(type)) return `${type} is a kernel namespace`;
	if (type.startsWith("x.")) {
		return isExtensionEventType(type, extIdOf(source.ext))
			? null
			: `${type} is outside ${extensionEventPrefix(extIdOf(source.ext))}*`;
	}
	return interfaceOfEventType(type) === null
		? `${type} is not an interface event`
		: null;
};

/**
 * Validates one append. `repoId` (the RepoDO's own repo, when known) must be
 * the event's node and repo. `causeDepth` is the depth of `causedBy` when it
 * is in this log: the stored depth is never below it + 1, so a producer
 * cannot reset the loop guard (K10).
 */
export const validateAppend = (
	input: AppendInput,
	context: {
		readonly repoId: string | null;
		readonly causeDepth: (id: string) => number | null;
	},
): ValidAppend => {
	const parsed = AppendInputSchema.safeParse(input);
	if (!parsed.success) {
		throw invalid(`invalid event: ${issuesText(parsed.error)}`);
	}
	const p = parsed.data;
	const repo = p.repo ?? p.node;
	if (repo !== p.node) {
		throw invalid("a repo event's node must be its repo");
	}
	if (context.repoId !== null && repo !== context.repoId) {
		throw invalid(`event for repo ${repo} appended to ${context.repoId}`);
	}
	const causeDepth = p.causedBy === undefined
		? null
		: context.causeDepth(p.causedBy);
	const depth = causeDepth === null
		? p.depth
		: Math.max(p.depth, causeDepth + 1);
	if (depth > MAX_EVENT_DEPTH) {
		throw denied("depth", `event depth ${depth} exceeds ${MAX_EVENT_DEPTH}`);
	}
	const issue = namespaceIssue(p.source, p.type);
	if (issue !== null) throw denied("namespace", issue);
	const data = validateEventData(p.type, p.data);
	if (!data.ok) {
		throw invalid(`invalid ${p.type} data: ${data.errors.join("; ")}`);
	}
	const dataJson = JSON.stringify(data.data ?? null);
	if (byteLength(dataJson) > EVENT_DATA_MAX_BYTES) {
		throw tartanError(
			"payload_too_large",
			`event data exceeds ${EVENT_DATA_MAX_BYTES} bytes`,
		);
	}
	return {
		type: p.type,
		v: p.v ?? 1,
		source: p.source,
		actor: p.actor,
		node: p.node,
		repo,
		...(p.subject ? { subject: p.subject } : {}),
		...(p.causedBy ? { causedBy: p.causedBy } : {}),
		...(p.correlation !== undefined ? { correlation: p.correlation } : {}),
		depth,
		shadow: p.shadow,
		sim: p.sim ?? false,
		dataJson,
		idemKey: p.idemKey,
	};
};
