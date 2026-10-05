// Gate replay: "acme.no-secrets would have vetoed 2 of
// the last 41 advances". For each of a repo's last `n` (≤ 50) done advances
// the gate input is rebuilt from the advance's range `expectOld..newSha`
// through RepoProbe (changed paths, added lines under the prefetch caps,
// `truncated` when they overflow), marked `advisory`, and the installation's
// `ref.advance` gate is called in its own ExtensionDO; the decision is the
// effective one the kernel would have taken (manifest `default` on a timeout
// or error, `onTruncated` on a truncated input). Results go to the
// repo's `gate_replays` (RepoLandFacade.recordReplay): `running`, then
// `done` with every result, or `error`.

import {
	type Advance,
	effectiveGateDecision,
	type ExtScope,
	GATE_DEFAULTS,
	GATE_INPUT_LIMITS,
	type GateDecision,
	gateOnTruncated,
	type GateReplayResponse,
	type InstallationDto,
	isTartanError,
	type Manifest,
	type RefAdvanceGateInput,
	SYS_KERNEL,
} from "@tartan/contract";
import type { GateReplayRow } from "@tartan/contract/kernel.ts";
import type { ApiDeps, LandApi, ProbeApi } from "./deps.ts";

type ReplayResult = GateReplayResponse["results"][number] & {
	readonly changeId: string;
};

/** The repo's last `n` done advances, newest first (pages through the list). */
export const lastDoneAdvances = async (
	land: Pick<LandApi, "advances">,
	n: number,
): Promise<Advance[]> => {
	const out: Advance[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20 && out.length < n; page++) {
		const res = await land.advances({
			...(cursor === undefined ? {} : { cursor }),
			limit: 50,
		});
		for (const a of res.advances) {
			if (a.state === "done" && a.newSha !== undefined) out.push(a);
			if (out.length >= n) break;
		}
		if (res.cursor === undefined || res.advances.length === 0) break;
		cursor = res.cursor;
	}
	return out;
};

/** The advisory `ref.advance` input of one past advance. */
export const replayInput = async (
	probe: ProbeApi,
	repoId: string,
	advance: Advance,
): Promise<RefAdvanceGateInput> => {
	const source = { repoId };
	const head = advance.newSha!;
	let lines: RefAdvanceGateInput["addedLines"] = [];
	let paths: string[] = [];
	let truncated = false;
	try {
		const [added, diff] = await Promise.all([
			probe.addedLines(source, advance.expectOld, head, {
				lines: GATE_INPUT_LIMITS.addedLines,
				bytes: GATE_INPUT_LIMITS.addedBytes,
			}),
			probe.diffPaths(source, advance.expectOld, head),
		]);
		lines = added.lines;
		paths = diff.paths.map((p) => p.path);
		truncated = added.truncated || diff.truncated;
	} catch {
		// The range is unreadable: the gate sees a truncated, empty input.
		truncated = true;
	}
	return {
		point: "ref.advance",
		repo: repoId,
		ref: advance.ref,
		base: advance.expectOld,
		head,
		changeId: advance.batchId,
		changedPaths: paths,
		addedLines: lines,
		truncated,
		workRefs: [],
		actor: { kind: "system", id: SYS_KERNEL },
		advisory: true,
	};
};

export const replayResponse = (row: GateReplayRow): GateReplayResponse => {
	const results = row.results_json === null
		? []
		: (JSON.parse(row.results_json) as ReplayResult[]).map((r) => ({
			advanceId: r.advanceId,
			decision: r.decision,
			message: r.message,
		}));
	const state = row.state === "done" || row.state === "error"
		? row.state
		: "running";
	return {
		replayId: row.id,
		state,
		results,
		...(state === "done"
			? {
				summary: {
					vetoed: results.filter((r) => r.decision === "veto").length,
					of: results.length,
				},
			}
			: {}),
	};
};

/** Runs a replay to the end and returns its response. */
export const runGateReplay = async (
	deps: Pick<ApiDeps, "land" | "probe" | "ext">,
	args: {
		readonly installation: InstallationDto;
		readonly manifest: Manifest;
		readonly repoId: string;
		readonly n: number;
		readonly replayId: string;
	},
): Promise<GateReplayResponse> => {
	const { installation, manifest, repoId, replayId } = args;
	const land = deps.land(repoId);
	const gate = (manifest.gates ?? []).find((g) => g.point === "ref.advance");
	const record = (
		state: "running" | "done" | "error",
		results: ReplayResult[],
	) =>
		land.recordReplay({
			id: replayId,
			installationId: installation.id,
			results,
			state,
		});
	await record("running", []);
	const results: ReplayResult[] = [];
	try {
		const scope: ExtScope = installation.storageScope === "repo"
			? { kind: "repo", repoId }
			: { kind: "node" };
		const host = deps.ext(installation.id, scope);
		const probe = deps.probe();
		for (const advance of await lastDoneAdvances(land, args.n)) {
			const input = await replayInput(probe, repoId, advance);
			let outcome: Parameters<typeof effectiveGateDecision>[0]["outcome"];
			try {
				const decision: GateDecision = await host.gate("ref.advance", input, {
					node: repoId,
					repo: repoId,
					mode: installation.mode === "shadow" ? "shadow" : "enforce",
				});
				outcome = { kind: "decision", decision };
			} catch (error) {
				outcome = isTartanError(error) && error.code === "timeout"
					? { kind: "timeout" }
					: {
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					};
			}
			const effective = effectiveGateDecision({
				installation: installation.id,
				ext: installation.extId,
				mode: installation.mode === "shadow" ? "shadow" : "enforce",
				onTruncated: gate === undefined
					? GATE_DEFAULTS["ref.advance"].onTruncated
					: gateOnTruncated(gate),
				default: gate?.default ?? GATE_DEFAULTS["ref.advance"].onTimeout,
				outcome,
			}, input.truncated);
			results.push({
				advanceId: advance.id,
				changeId: input.changeId,
				decision: effective.decision,
				message: effective.message,
			});
		}
	} catch (error) {
		await record("error", results);
		throw error;
	}
	await record("done", results);
	const row = await land.replay(replayId);
	if (row === null) {
		return {
			replayId,
			state: "done",
			results,
			summary: {
				vetoed: results.filter((r) => r.decision === "veto").length,
				of: results.length,
			},
		};
	}
	return replayResponse(row);
};
