// ExtTail: the `tails` sink of every js/wasm
// Dynamic Worker. One loader id per installation, so the props name the
// installation [E TAILS]. The shim already returns each call's log lines to
// the host, which writes them to the installation console; what only a tail
// sees is the Dynamic Worker's own outcome (an uncaught exception, "code had
// hung", a CPU or memory kill) and anything logged outside a hook. Those go
// to Workers Logs tagged with the installation, so `wrangler tail` of the
// forge shows them (the parent's own tail carries no Dynamic Worker lines).
// Errors themselves are recorded host-side from the RPC rejection: a tail's
// exception text is generic for RPC throws [E TAILS].

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../../env.ts";
import { type ExtTailProps, type TailEvent, tailLines } from "./tail-lines.ts";

export type { ExtTailProps } from "./tail-lines.ts";

export class ExtTail extends WorkerEntrypoint<Env, ExtTailProps> {
	override tail(events: TraceItem[]): Promise<void> {
		for (
			const { level, line } of tailLines(
				this.ctx.props,
				events as unknown as TailEvent[],
			)
		) {
			if (level === "error") console.error(line);
			else console.log(line);
		}
		return Promise.resolve();
	}
}
