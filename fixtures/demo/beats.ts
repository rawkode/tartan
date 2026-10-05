// The demo's seed states, one per beat. Data only; `fixtures/demo/seed.ts`
// applies it through the
// forge's public API, MCP and git, and `scripts/seed.ts` is the CLI.
//
// Every beat starts from the same base: the owner's namespace with the HUD,
// the demo repo (a mirror of a public monorepo, `mirror.ts`) under
// `rawkode/platform/edge` with the Swarm pack on `rawkode/platform`, and
// `rawkode/docs/site` under the Classic pack. Each beat then adds what its
// first frame needs. Seeded actors are agents named `seeded-…` with model
// `seeded`; the swarm's agents carry model `sim`. Both are labelled on screen.
//
// Paths and footprints follow the demo repo's layout. They are data: adjust
// them here when the mirror's layout changes (`--fixture` overrides at run time).

export type DemoWorkItem = {
	readonly key: string;
	readonly title: string;
	readonly why: string;
	readonly acceptance: readonly string[];
	readonly projects: readonly string[];
	readonly prefixes: readonly string[];
};

export type ScriptedChange = {
	/** Seeded actor (`seeded-<n>`). */
	readonly actor: string;
	readonly item: string;
	/** Files the change writes (path → content appended to trunk's, or new). */
	readonly edits: readonly { readonly path: string; readonly append: string }[];
	readonly submit: boolean;
};

export type Beat = {
	readonly n: number;
	readonly name: string;
	readonly answers: string;
	/** Work items to open (created by the owner over MCP). */
	readonly items: readonly string[];
	/** Changes seeded actors push and submit (beat 2's queue and conflict). */
	readonly changes: readonly ScriptedChange[];
	/** Start a swarm on the sim repos (`/-/api/swarm`). */
	readonly swarm?: {
		readonly agents: number;
		readonly minutes: number;
		readonly workItems: number;
	};
	/** Seeded advances through WP10's audited dev-only `seedHistory`. */
	readonly seededAdvances?: number;
	readonly notes: string;
};

export type DemoFixture = {
	readonly namespace: string;
	readonly platformGroup: string;
	/** The demo repo: `<platformGroup>/edge/router`. */
	readonly repo: string;
	readonly docsRepo: string;
	readonly agents: readonly {
		readonly name: string;
		readonly tool: "claude-code" | "codex" | "other";
		readonly model?: string;
	}[];
	readonly items: Readonly<Record<string, DemoWorkItem>>;
	readonly beats: readonly Beat[];
};

const API = "services/api";

export const DEMO: DemoFixture = {
	namespace: "rawkode",
	platformGroup: "rawkode/platform",
	repo: "rawkode/platform/edge/router",
	docsRepo: "rawkode/docs/site",
	agents: [
		{ name: "claude-code", tool: "claude-code", model: "claude" },
		{ name: "codex", tool: "codex", model: "gpt-5-codex" },
	],
	items: {
		limits: {
			key: "limits",
			title: "Per-tenant rate limiting",
			why:
				"One noisy tenant can starve the others: each tenant gets its own budget.",
			acceptance: [
				"requests over a tenant's budget answer 429",
				"other tenants are unaffected",
			],
			projects: ["@demo/api"],
			prefixes: [`${API}/src/middleware/`],
		},
		quota: {
			key: "quota",
			title: "Tenant quota headers",
			why: "Clients should see how much of their budget is left.",
			acceptance: ["responses carry X-RateLimit-Remaining"],
			projects: ["@demo/api"],
			prefixes: [`${API}/src/middleware/`],
		},
		cache: {
			key: "cache",
			title: "Cache catalogue reads",
			why: "Catalogue pages are read far more often than they change.",
			acceptance: ["a second read within a minute is served from cache"],
			projects: ["@demo/api"],
			prefixes: [`${API}/src/`],
		},
	},
	beats: [
		{
			n: 0,
			name: "Cold open: the cloth",
			answers: "concurrency, originality",
			items: ["limits", "quota"],
			changes: [],
			swarm: { agents: 300, minutes: 10, workItems: 600 },
			notes:
				"The HUD on rawkode with a 300-agent swarm (labelled simulated) running for 10 minutes on rawkode/sim.",
		},
		{
			n: 1,
			name: "Q1: who is doing what?",
			answers: "Q1",
			items: ["limits", "quota"],
			changes: [],
			notes:
				"Two open items in the same prefix; Claude Code claims #limits, Codex #quota, and both get their own lanes.",
		},
		{
			n: 2,
			name: "Q2: when work truly conflicts",
			answers: "Q2",
			items: ["limits", "quota", "cache"],
			changes: [
				...Array.from({ length: 9 }, (_, i): ScriptedChange => ({
					actor: `seeded-${i + 1}`,
					item: "cache",
					edits: [{
						path: `${API}/src/seeded/change-${i + 1}.ts`,
						append: `export const change${i + 1} = ${i + 1};\n`,
					}],
					submit: true,
				})),
				// The scripted conflict: two actors rewrite the same line.
				{
					actor: "seeded-10",
					item: "cache",
					edits: [{
						path: `${API}/src/seeded/shared.ts`,
						append: "export const ttl = 60;\n",
					}],
					submit: true,
				},
				{
					actor: "seeded-11",
					item: "cache",
					edits: [{
						path: `${API}/src/seeded/shared.ts`,
						append: "export const ttl = 300;\n",
					}],
					submit: true,
				},
			],
			notes:
				"Ten approved changes queued by seeded actors, two of them writing the same file: the Weave lands one and ejects the other with a resolver item.",
		},
		{
			n: 3,
			name: "Q3: review everything",
			answers: "Q3",
			items: [],
			changes: [],
			seededAdvances: 41,
			notes:
				"41 advances written by WP10's audited dev-only seedHistory (labelled seeded), 2 carrying fake keys, for the shadow replay.",
		},
		{
			n: 4,
			name: "Q4: why is this line here?",
			answers: "Q4",
			items: ["limits", "quota", "cache"],
			changes: [],
			notes:
				"The state after beats 1–2: run beat 2's seed, let the Weave land, then open why-blame.",
		},
		{
			n: 5,
			name: "The coordination model is replaceable",
			answers: "originality",
			items: [],
			changes: [],
			notes:
				"rawkode/docs/site under the Classic pack; Kanban is installed on rawkode/platform live, on screen.",
		},
	],
};

export const beatOf = (fixture: DemoFixture, n: number): Beat => {
	const beat = fixture.beats.find((b) => b.n === n);
	if (!beat) {
		throw new Error(
			`no beat ${n} (beats: ${fixture.beats.map((b) => b.n).join(", ")})`,
		);
	}
	return beat;
};
