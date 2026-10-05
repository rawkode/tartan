// The Workers Logs lines of ExtTail (tail.ts): pure, so the Deno tests
// reach it without `cloudflare:workers`.

/** Props the host passes when it wires the tail for one installation. */
export type ExtTailProps = {
	readonly inst: string;
	readonly extId: string;
	readonly version: string;
	/** `node` or `repo` (the installation's storage scope). */
	readonly scopeKey: string;
};

type TailLog = { readonly level?: string; readonly message?: unknown };
type TailException = { readonly name?: string; readonly message?: string };
export type TailEvent = {
	readonly outcome?: string;
	readonly eventTimestamp?: number | null;
	readonly event?: { readonly rpcMethod?: string } | null;
	readonly logs?: readonly TailLog[];
	readonly exceptions?: readonly TailException[];
};

const MAX_LINE = 2048;

const text = (value: unknown): string => {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

/** The Workers Logs lines for one batch of tail events, in event order. */
export const tailLines = (
	props: ExtTailProps | undefined,
	events: readonly TailEvent[],
): { readonly level: "log" | "error"; readonly line: string }[] => {
	const tag = props === undefined
		? "[ext ?]"
		: `[ext ${props.inst} ${props.extId}@${props.version} ${props.scopeKey}]`;
	return [...events]
		.sort((a, b) => (a.eventTimestamp ?? 0) - (b.eventTimestamp ?? 0))
		.flatMap((e) => {
			const method = e.event?.rpcMethod ?? "-";
			const lines: { level: "log" | "error"; line: string }[] = (e.logs ?? [])
				.map((l) => ({
					level: l.level === "error" || l.level === "warn" ? "error" : "log",
					line: `${tag} tail ${method} ${l.level ?? "log"}: ${
						(Array.isArray(l.message) ? l.message.map(text).join(" ") : text(
							l.message,
						)).slice(0, MAX_LINE)
					}`,
				}));
			for (const x of e.exceptions ?? []) {
				lines.push({
					level: "error",
					line: `${tag} tail ${method} exception: ${x.name ?? "Error"}: ${
						(x.message ?? "").slice(0, MAX_LINE)
					}`,
				});
			}
			if (e.outcome !== undefined && e.outcome !== "ok") {
				lines.push({
					level: "error",
					line: `${tag} tail ${method} outcome: ${e.outcome}`,
				});
			}
			return lines;
		});
};
