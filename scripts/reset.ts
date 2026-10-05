// Reset the demo on a dev stage (WP20), then optionally seed a
// beat: `reset` + `seed --beat N` reach the beat's start state. Dev stages
// only (the stage's `/-/health` must name a `^dev` stage), and `--yes` is
// required: the demo and docs repos and the sim group move to
// `<namespace>/attic` and are archived.
//
//   deno run -A scripts/reset.ts --origin https://<dev host> --yes \
//     [--beat <n> [seed options…]]
//
// TARTAN_TOKEN: the forge Owner's PAT (`api`, `admin`, `mcp`), never printed.

import { DEMO } from "../fixtures/demo/beats.ts";
import { assertDevStage, createForgeClient } from "../fixtures/demo/client.ts";
import { resetDemo } from "../fixtures/demo/reset.ts";
import { main as seedMain } from "./seed.ts";

export type ResetArgs = {
	readonly origin: string;
	readonly yes: boolean;
	/** Seed arguments for the beat to seed afterwards, if any. */
	readonly seed?: readonly string[];
};

export const parseResetArgs = (args: readonly string[]): ResetArgs => {
	const i = args.indexOf("--origin");
	const origin = i === -1 ? undefined : args[i + 1];
	if (!origin) throw new Error("--origin is required");
	const url = new URL(origin);
	if (url.protocol !== "https:") throw new Error("--origin must be https");
	const rest = args.filter((a) => a !== "--yes");
	return {
		origin: url.origin,
		yes: args.includes("--yes"),
		...(args.includes("--beat") ? { seed: rest } : {}),
	};
};

export const main = async (args: readonly string[]): Promise<number> => {
	const parsed = parseResetArgs(args);
	if (!parsed.yes) {
		throw new Error(
			"reset moves the demo repos aside and archives them: pass --yes to go ahead",
		);
	}
	const token = Deno.env.get("TARTAN_TOKEN");
	if (!token) throw new Error("TARTAN_TOKEN is unset");
	const client = createForgeClient({ origin: parsed.origin, token });
	assertDevStage((await client.health()).stage);
	const started = Date.now();
	await resetDemo(
		{ client, log: (line) => console.log(line), now: () => Date.now() },
		DEMO,
	);
	if (parsed.seed) await seedMain(parsed.seed);
	console.log(
		`reset: done in ${((Date.now() - started) / 1000).toFixed(1)} s`,
	);
	return 0;
};

if (import.meta.main) {
	try {
		Deno.exit(await main(Deno.args));
	} catch (error) {
		console.error(`reset: ${error instanceof Error ? error.message : error}`);
		Deno.exit(1);
	}
}
