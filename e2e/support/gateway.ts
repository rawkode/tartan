// What the gateway suites (tests/gateway/) read and check, as pure
// functions: the receive-pack capability allowlist and the echo switch from
// this checkout's sources (the drift guard keeps them equal to the deployed
// forge), git's refusal lines, the control characters no terminal may get,
// and hand-built receive-pack bodies for the fail-closed parser probes.
//
// Pure module (node:fs only): the Deno unit tests import it too.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** The array literal `export const <name> = [ … ]` of a source file, as strings. */
export const constArray = (source: string, name: string): string[] => {
	const m = new RegExp(
		`export const ${name}(?::[^=]+)? = \\[([^\\]]*)\\]`,
	).exec(source);
	if (m === null) throw new Error(`no array ${name}`);
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

/** The receive-pack capabilities the gateway advertises (`@tartan/gitproto`). */
export const receivePackAllowlist = (root: string = ROOT): string[] =>
	constArray(
		readFileSync(
			path.join(root, "packages", "gitproto", "src", "capabilities.ts"),
			"utf8",
		),
		"RECEIVE_PACK_CAPABILITIES",
	);

/** `ECHO_ENABLED` in src/constants.ts: band-2 guidance and echo lines. */
export const echoEnabled = (root: string = ROOT): boolean => {
	const m = /export const ECHO_ENABLED = (true|false)\b/.exec(
		readFileSync(path.join(root, "src", "constants.ts"), "utf8"),
	);
	if (m === null) throw new Error("no ECHO_ENABLED in src/constants.ts");
	return m[1] === "true";
};

/**
 * Band-2 guidance on the stage under test: its rendered `TARTAN_ECHO`
 * (`stage up --echo on|off`), else the compiled `ECHO_ENABLED`.
 */
export const echoOn = (
	switches: { readonly echo: "on" | "off" | null },
	root: string = ROOT,
): boolean =>
	switches.echo === "on"
		? true
		: switches.echo === "off"
		? false
		: echoEnabled(root);

/**
 * Control characters a terminal must never get from the forge: ESC
 * (the start of CSI and OSC sequences), BEL (an OSC terminator), the C1
 * controls (CSI is also U+009B) and every other C0 except tab, newline and
 * carriage return (git's own progress output uses \r).
 */
// deno-lint-ignore no-control-regex -- finding control characters is the point
export const CONTROL_RE = new RegExp(
	"[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
);

/** The control characters of `text`, as `U+00XX` names (none: []). */
export const controlsIn = (text: string): string[] =>
	[...new Set([...text].filter((c) => CONTROL_RE.test(c)))].map((c) =>
		`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
	);

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// git prints the short name (refs/heads/, refs/tags/ and refs/remotes/
// stripped, as its prettify_refname does) and, for a deletion, no
// `<src> ->` part: ` ! [remote rejected] lanes/x (use-lanes-close)`.
// `reasonRe` is a regular-expression source for the reason.
const refusalIn = (output: string, ref: string, reasonRe: string): boolean => {
	const short = ref.replace(/^refs\/(?:heads|tags|remotes)\//, "");
	const human = new RegExp(
		`^\\s*!\\s+\\[remote rejected\\]\\s+(?:\\S+\\s+->\\s+)?(?:${
			escapeRegExp(ref)
		}|${escapeRegExp(short)})\\s+\\(${reasonRe}\\)`,
		"m",
	);
	const porcelain = new RegExp(
		`^!\\t[^\\t]*:${
			escapeRegExp(ref)
		}\\t\\[remote rejected\\] \\(${reasonRe}\\)`,
		"m",
	);
	return human.test(output) || porcelain.test(output);
};

/**
 * True when git's output reports `ref` refused by the remote with `reason`:
 * ` ! [remote rejected] <src> -> <dst> (<reason>)`, or with `--porcelain`
 * `!\t<src>:<ref>\t[remote rejected] (<reason>)`.
 */
export const refusedWith = (
	output: string,
	ref: string,
	reason: string,
): boolean => refusalIn(output, ref, escapeRegExp(reason));

/** True when git's output reports `ref` refused by the remote, for any reason. */
export const refusedWithAny = (output: string, ref: string): boolean =>
	refusalIn(output, ref, "[^)\\r\\n]+");

/** The `remote: tartan ▸ …` lines of git's output (band 2 from Tartan). */
export const tartanRemoteLines = (output: string): string[] =>
	output.split(/\r?\n/).filter((l) => /^remote: tartan ▸/.test(l));

// ---------------------------------------------------------------------------
// Hand-built receive-pack requests (fail-closed parser probes)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** One pkt-line: four hex digits of length (itself included), then the data. */
export const pktLine = (data: string): string =>
	`${(encoder.encode(data).length + 4).toString(16).padStart(4, "0")}${data}`;

export const FLUSH = "0000";
export const DELIM = "0001";

export type ProbeCommand = {
	readonly old: string;
	readonly new: string;
	readonly ref: string;
};

/** A command section: the first command carries `caps` after a NUL, then a flush. */
export const commandSection = (
	commands: readonly ProbeCommand[],
	caps: readonly string[],
): string =>
	commands.map((c, i) =>
		pktLine(
			`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0${caps.join(" ")}` : ""}\n`,
		)
	).join("") + FLUSH;

/** The fail-closed parser probes: each body must be refused before anything reaches upstream. */
export const PARSER_PROBES = (
	command: ProbeCommand,
): readonly { readonly name: string; readonly body: string }[] => [
	{
		name: "a capability outside the allowlist (push-options)",
		body: commandSection([command], ["report-status", "push-options"]),
	},
	{
		name: "a push certificate",
		body: pktLine("push-cert\0report-status\n") +
			pktLine("certificate version 0.1\n") + pktLine("push-cert-end\n") +
			FLUSH,
	},
	{
		name: "a shallow line",
		body: pktLine(`shallow ${command.old}\n`) +
			commandSection([command], ["report-status"]),
	},
	{
		name: "a delimiter packet (0001)",
		body: DELIM + commandSection([command], ["report-status"]),
	},
	{
		name: "a truncated pkt-line",
		body: `00ff${command.old} ${command.new}`,
	},
	{
		name: "a length that is not hex",
		body: `zz12${command.old}`,
	},
];
