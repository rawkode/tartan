// WP10 live acceptance: the real Advance on
// a deployed dev stage with containers and dev tools (`TARTAN_STAGE ^dev`,
// `TARTAN_DEV_TOOLS=1`), against real Artifacts and the runner image.
//
//   1. setup: a canonical repo, RepoDO init and the in-Worker genesis commit
//   2. three branch lanes (three agents), each with one commit
//   3. land them in one batch (`testPolicy: none`): compose in the runner,
//      candidate, lock, notes, trunk, change refs, complete
//   4. verify in the runner with a stock clone: a linear chain of three
//      squash commits with kernel trailers, one why note each
//      (`git log --notes=tartan`), and `refs/tartan/changes/<id>` = the
//      landed lane heads
//   5. a conflict: two lanes adding the same file differently in one batch;
//      the first lands, the second is `conflicted` with its lane released
//   6. archive a lane (an attic ref written in the Worker) and GC the
//      closed lanes (branch-lane refs deleted by the in-Worker `refWrite`)
//
// Every response body is scanned for `art_v<n>_` tokens. Requests go to the
// dev-only route `/-/dev/land` with the dev key (`x-tartan-dev-key` =
// hex(HMAC-SHA256(TARTAN_SECRET, "tartan:dev:land"))) from TARTAN_DEV_KEY;
// it is never printed. `--evidence <file>` writes the run's JSON evidence.
//
// Usage:
//   TARTAN_DEV_KEY=… deno task live -- --stage dev-wp10 wp10 \
//     --base https://tartan-dev-wp10.<sub>.workers.dev [--evidence <file>]

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
};

const base = arg("base");
const evidencePath = arg("evidence");
const key = Deno.env.get("TARTAN_DEV_KEY");
if (!base || !key) {
	console.error(
		"usage: TARTAN_DEV_KEY=… wp10-land.ts --base <url> [--evidence <file>]",
	);
	Deno.exit(2);
}

const LEAK = /art_v[0-9]+_(?!<redacted>)/;
const leaks: string[] = [];
const evidence: Record<string, unknown> = {
	base,
	startedAt: new Date().toISOString(),
};
const results: { step: string; ok: boolean; detail: string }[] = [];

const record = (step: string, ok: boolean, detail: string) => {
	results.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};

const api = async (
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; ms: number }> => {
	const started = Date.now();
	const res = await fetch(`${base}/-/dev/land/${path}`, {
		method,
		headers: {
			"x-tartan-dev-key": key,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	if (LEAK.test(text)) leaks.push(`${method} ${path}`);
	let json: Record<string, unknown> = {};
	try {
		json = text.length > 0 ? JSON.parse(text) : {};
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	return { status: res.status, json, ms: Date.now() - started };
};

const ulid = (): string => {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	let time = Date.now();
	let t = "";
	for (let i = 0; i < 10; i++) {
		t = alphabet[time % 32] + t;
		time = Math.floor(time / 32);
	}
	const random = crypto.getRandomValues(new Uint8Array(16));
	return t + [...random].map((b) => alphabet[b % 32]).join("");
};

const AGENTS = [
	"a_01k6aaaaaaaaaaaaaaaaaaaaaa",
	"a_01k6bbbbbbbbbbbbbbbbbbbbbb",
	"a_01k6cccccccccccccccccccccc",
];

type Status = {
	status: {
		state: string;
		attempt: number;
		changes: {
			changeId: string;
			laneId: string;
			outcome: string;
			commit?: string;
		}[];
	};
	lanes: { laneId: string; state: string | null }[];
	refs: { ref: string; sha: string }[];
};

const waitLanded = async (repo: string, batchId: string): Promise<Status> => {
	const deadline = Date.now() + 10 * 60 * 1000;
	let last: Status | null = null;
	while (Date.now() < deadline) {
		const r = await api("GET", `${repo}/status?batch=${batchId}`);
		if (r.status === 200) {
			last = r.json as unknown as Status;
			const state = last.status.state;
			if (
				["landed", "conflicted", "vetoed", "failed", "cancelled"].includes(
					state,
				)
			) {
				return last;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}
	throw new Error(`batch ${batchId} did not end: ${JSON.stringify(last)}`);
};

const repo = arg("repo") ?? ulid();
evidence.repo = repo;

// 1. setup
const setup = await api("POST", `${repo}/setup`, { path: `dev/wp10/${repo}` });
record(
	"setup",
	setup.status === 201,
	`${setup.status} trunk=${setup.json.trunk} (${setup.ms} ms)`,
);
evidence.setup = setup.json;

/** Writes the evidence so far and exits non-zero. */
const bail = async (why: string): Promise<never> => {
	evidence.results = results;
	evidence.aborted = why;
	if (evidencePath) {
		await Deno.writeTextFile(evidencePath, JSON.stringify(evidence, null, 2));
	}
	console.error(`aborted: ${why}`);
	Deno.exit(1);
};
if (setup.status !== 201) await bail("setup failed");

// 2. three lanes
const lanes: { laneId: string; head: string }[] = [];
for (const [i, owner] of AGENTS.entries()) {
	const lane = await api("POST", `${repo}/lane`, {
		owner,
		files: { [`feature-${i + 1}.txt`]: `feature ${i + 1} by ${owner}\n` },
		message: `feature ${i + 1}`,
	});
	record(
		`lane ${i + 1}`,
		lane.status === 201,
		`${lane.status} ${lane.json.laneId} head=${lane.json.head} (${lane.ms} ms)`,
	);
	if (lane.status !== 201) {
		await bail(`lane ${i + 1}: ${JSON.stringify(lane.json)}`);
	}
	lanes.push(lane.json as unknown as { laneId: string; head: string });
}
evidence.lanes = lanes;

// 3. land the three in one batch
const t0 = Date.now();
const submitted = await api("POST", `${repo}/submit`, {
	lanes: lanes.map((l) => l.laneId),
	testPolicy: "none",
});
record(
	"submit",
	submitted.status === 201,
	`${submitted.status} ${submitted.json.batchId}`,
);
evidence.submit = submitted.json;
if (submitted.status !== 201) await bail("submit failed");
const batchId = String(submitted.json.batchId);
const landed = await waitLanded(repo, batchId);
const landMs = Date.now() - t0;
const commits = landed.status.changes.map((c) => c.commit ?? "");
record(
	"land 3",
	landed.status.state === "landed" && commits.every((c) => c.length === 40),
	`${landed.status.state} attempt=${landed.status.attempt} in ${landMs} ms; lanes ${
		landed.lanes.map((l) => l.state).join(",")
	}`,
);
evidence.landed = landed;
evidence.landMs = landMs;

// 4. verify with a stock clone in the runner
const verify = await api("GET", `${repo}/verify`);
const v = verify.json as Record<
	string,
	{ exitCode: number; stdout: string; stderr: string }
>;
evidence.verify = v;
const log = v.log?.stdout ?? "";
const notes = (log.match(/note \{"v":1/g) ?? []).length;
record(
	"stock clone",
	v.clone?.exitCode === 0 && v.fetch?.exitCode === 0,
	`clone ${v.clone?.exitCode} fetch ${v.fetch?.exitCode}`,
);
record(
	"git log --notes=tartan",
	notes === 3,
	`${notes} why notes in the last commits`,
);
const chain = [
	...log.matchAll(/^commit ([0-9a-f]{40})\nparents ([0-9a-f ]*)$/gm),
].map((m) => ({
	commit: m[1],
	parents: m[2].trim().split(" ").filter((p) => p.length > 0),
}));
const linear = commits.every((c, i) => {
	const entry = chain.find((e) => e.commit === c);
	return entry !== undefined && entry.parents.length === 1 &&
		(i === 0 || entry.parents[0] === commits[i - 1]);
});
record(
	"linear chain",
	linear,
	chain.slice(0, 4).map((e) => e.commit.slice(0, 8)).join(" ← "),
);
for (
	const trailer of [
		"Change-Id: I",
		"Tartan-Agent: a_01k6",
		"Tartan-Advance: adv_",
		"Tartan-Change: ",
	]
) {
	const n = log.split(trailer).length - 1;
	record(`trailer ${trailer.trim()}`, n >= 3, `${n} occurrences`);
}
const changeRefs = (v.changes?.stdout ?? "").trim().split("\n").filter((l) =>
	l.length > 0
);
const headsOk = lanes.every((l) =>
	changeRefs.some((line) => line.endsWith(` ${l.head}`))
);
record(
	"refs/tartan/changes/<id>",
	headsOk,
	`${changeRefs.length} change refs; landed heads kept`,
);

// 5. a conflict
const c1 = await api("POST", `${repo}/lane`, {
	owner: AGENTS[0],
	files: { "shared.txt": "one\n" },
});
const c2 = await api("POST", `${repo}/lane`, {
	owner: AGENTS[1],
	files: { "shared.txt": "two\n" },
});
const conflictBatch = await api("POST", `${repo}/submit`, {
	lanes: [c1.json.laneId, c2.json.laneId],
	testPolicy: "none",
});
const conflicted = await waitLanded(repo, String(conflictBatch.json.batchId));
const outcomes = conflicted.status.changes.map((c) => c.outcome);
record(
	"conflict",
	conflicted.status.state === "landed" && outcomes[0] === "landed" &&
		outcomes[1] === "conflicted" &&
		conflicted.lanes[1]?.state === "submitted",
	`${conflicted.status.state}: ${outcomes.join(",")}; second lane ${
		conflicted.lanes[1]?.state
	}`,
);
evidence.conflict = conflicted;

// 6. archive a lane, then GC the closed lanes
const shelved = await api("POST", `${repo}/lane`, {
	owner: AGENTS[2],
	files: { "shelved.txt": "shelved\n" },
});
const attic = `refs/tartan/attic/ln_${ulid()}`;
const archived = await api("POST", `${repo}/archive`, {
	laneId: shelved.json.laneId,
	atticRef: attic,
});
record(
	"archive (attic ref in the Worker)",
	archived.status === 200 && archived.json.kind === "ref" &&
		archived.json.head === shelved.json.head,
	`${archived.status} ${JSON.stringify(archived.json)}`,
);
const gc = await api("POST", `${repo}/gc`);
const deleted = (gc.json.deleted as string[] | undefined) ?? [];
record(
	"lane GC (refWrite lane-gc)",
	gc.status === 200 && lanes.every((l) => deleted.includes(l.laneId)),
	`${gc.status} deleted ${deleted.length}: ${JSON.stringify(gc.json)}`,
);
evidence.gc = gc.json;
const after = await api("GET", `${repo}/verify`);
const remote =
	(after.json as Record<string, { stdout: string }>).lsRemote?.stdout ?? "";
evidence.lsRemoteAfterGc = remote;
record(
	"lane refs gone, attic and change refs kept",
	lanes.every((l) => !remote.includes(`refs/heads/lanes/${l.laneId}`)) &&
		remote.includes(attic) && lanes.every((l) => remote.includes(l.head)),
	`${remote.trim().split("\n").length} refs upstream`,
);

record(
	"leak scan",
	leaks.length === 0,
	leaks.length === 0 ? "no art_v tokens in any response" : leaks.join(", "),
);
evidence.results = results;
evidence.finishedAt = new Date().toISOString();
if (evidencePath) {
	await Deno.writeTextFile(evidencePath, JSON.stringify(evidence, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} PASS`);
Deno.exit(failed.length === 0 ? 0 : 1);
