// Environment hardening of the e2e launcher. It runs first, on the
// launcher's own environment, so every child inherits it: deploy, destroy,
// wrangler, playwright, the e2e CLI and its workers (`denoRun` and
// `Deno.Command` pass the parent environment through).
//
// - Telemetry off everywhere: e2e (`E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK`)
//   and wrangler (`WRANGLER_SEND_METRICS`, `WRANGLER_SEND_ERROR_REPORTS`).
// - No model can be reached: provider keys and stored subscription logins
//   are removed (the config declares no agents either).
// - Nothing in the user's shell can override the run's credentials or
//   secrets: `E2E_USER_*` and `E2E_SECRET_*` are removed, and so are stale
//   `TARTAN_E2E_*` values (the launcher sets its own per child).

export const TELEMETRY_OFF: Readonly<Record<string, string>> = {
	DO_NOT_TRACK: "1",
	E2E_TELEMETRY_DISABLED: "1",
	WRANGLER_SEND_METRICS: "false",
	WRANGLER_SEND_ERROR_REPORTS: "false",
};

/** Variables an AI SDK provider or e2e's subscription models would read. */
export const MODEL_ENV: readonly string[] = [
	"AI_GATEWAY_API_KEY",
	"VERCEL_OIDC_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"ANTHROPIC_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GEMINI_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
	"DEEPSEEK_API_KEY",
	"AZURE_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"E2E_OAUTH_CREDENTIALS",
];

const STRIPPED_PREFIXES = ["E2E_USER_", "E2E_SECRET_", "TARTAN_E2E_"];

/** Telemetry-fleet attribution is pointless with telemetry off; drop it too. */
const STRIPPED_EXTRA = ["E2E_TELEMETRY_FLEET", "E2E_TELEMETRY_DEBUG"];

export type EnvPort = {
	toObject(): Record<string, string>;
	set(name: string, value: string): void;
	delete(name: string): void;
};

export const shouldStrip = (name: string): boolean =>
	MODEL_ENV.includes(name) || STRIPPED_EXTRA.includes(name) ||
	STRIPPED_PREFIXES.some((p) => name.startsWith(p));

/** Hardens `env` in place; returns the names it removed (never values). */
export const hardenEnv = (env: EnvPort): string[] => {
	const removed = Object.keys(env.toObject()).filter(shouldStrip).sort();
	for (const name of removed) env.delete(name);
	for (const [name, value] of Object.entries(TELEMETRY_OFF)) {
		env.set(name, value);
	}
	return removed;
};
