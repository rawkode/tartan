// S11: a Workers AI judge returning schema-valid JSON. Each call
// judges one of five small diffs; validity is checked against the schema
// by hand (no extra keys, bounded score and risks).

export const JUDGE_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["approve", "request_changes", "reject"] },
		score: { type: "integer", minimum: 0, maximum: 10 },
		risks: { type: "array", items: { type: "string" }, maxItems: 5 },
		summary: { type: "string" },
	},
	required: ["verdict", "score", "risks", "summary"],
	additionalProperties: false,
} as const;

const DIFFS = [
	"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@\n-  if (token.exp < now) throw new Error('expired');\n+  // TODO: re-enable expiry check\n",
	"--- a/src/math.ts\n+++ b/src/math.ts\n@@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n",
	"--- a/README.md\n+++ b/README.md\n@@\n-Instal with npm\n+Install with npm\n",
	"--- a/src/db.ts\n+++ b/src/db.ts\n@@\n-  db.prepare('SELECT * FROM u WHERE id = ?').bind(id)\n+  db.prepare(`SELECT * FROM u WHERE id = ${id}`)\n",
	"--- a/src/cache.ts\n+++ b/src/cache.ts\n@@\n+  for (const k of keys) await kv.delete(k); // was: bulk delete\n",
];

/** Null when `o` matches the judge schema, else the first problem. */
export const judgeProblem = (o: unknown): string | null => {
	if (!o || typeof o !== "object") return "not object";
	const v = o as Record<string, unknown>;
	if (!["approve", "request_changes", "reject"].includes(v.verdict as string)) {
		return "verdict";
	}
	if (
		!Number.isInteger(v.score) || (v.score as number) < 0 ||
		(v.score as number) > 10
	) {
		return "score";
	}
	if (
		!Array.isArray(v.risks) || v.risks.some((r) => typeof r !== "string") ||
		v.risks.length > 5
	) {
		return "risks";
	}
	if (typeof v.summary !== "string") return "summary";
	const extra = Object.keys(v).filter((k) =>
		!["verdict", "score", "risks", "summary"].includes(k)
	);
	return extra.length > 0 ? `extra keys ${extra}` : null;
};

const pct = (xs: readonly number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

type AiLike = { run(model: string, inputs: unknown): Promise<unknown> };

export const s11 = async (ai: AiLike, url: URL) => {
	const model = url.searchParams.get("model") ??
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast";
	const n = Math.min(10, Number(url.searchParams.get("n") ?? "10"));
	const results: {
		i: number;
		ms: number;
		valid: boolean;
		invalid?: string | null;
		error?: string;
	}[] = [];
	for (let i = 0; i < n; i++) {
		const diff = DIFFS[i % DIFFS.length];
		const t0 = Date.now();
		try {
			const r = await ai.run(model, {
				messages: [
					{
						role: "system",
						content:
							"You are a strict code-review judge for an agent-native git forge. Respond only with JSON matching the schema.",
					},
					{
						role: "user",
						content:
							`Judge this change. Give a verdict, a 0-10 quality score, up to 5 concrete risks, and a one-sentence summary.\n\n${diff}`,
					},
				],
				response_format: { type: "json_schema", json_schema: JUDGE_SCHEMA },
				max_tokens: 400,
			}) as {
				response?: unknown;
				choices?: { message?: { content?: unknown } }[];
			};
			const ms = Date.now() - t0;
			const resp = r?.response ?? r?.choices?.[0]?.message?.content ?? r;
			let parsed: unknown = resp;
			let parseErr: string | null = null;
			if (typeof resp === "string") {
				try {
					parsed = JSON.parse(resp);
				} catch (e) {
					parseErr = String((e as Error).message);
				}
			}
			const invalid = parseErr ?? judgeProblem(parsed);
			results.push({ i, ms, valid: !invalid, invalid });
		} catch (e) {
			results.push({
				i,
				ms: Date.now() - t0,
				valid: false,
				error: String((e as Error).message ?? e).slice(0, 300),
			});
		}
	}
	const lat = results.map((r) => r.ms);
	return {
		model,
		n,
		valid: results.filter((r) => r.valid).length,
		p50: pct(lat, 50),
		p95: pct(lat, 95),
		max: Math.max(...lat),
		results,
	};
};
