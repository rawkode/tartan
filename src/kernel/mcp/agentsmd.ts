// `GET /-/agents.md[?path=<node>]` (WP11): the protocol
// in force at a scope as plain markdown, for inclusion in a repo's
// `AGENTS.md` or `CLAUDE.md`: the kernel card, every protocol card in force
// (nearest installation first, not truncated), and how to connect Claude Code
// and Codex CLI to that scope.

import type { ProtocolCard } from "./ports.ts";
import { kernelCard, mcpUrlOf } from "./protocol.ts";

/**
 * At the forge scope (no `?path=`) the MCP URL serves the kernel's tools
 * only: a group's or a repo's protocol tools (work, changes, lanes) answer
 * at that node's own scope, so the page says where to look.
 */
const forgeScopeNote = (origin: string): string[] => [
	"This is the forge scope: its MCP URL serves the kernel's tools only. The tools of a protocol (work items, changes, lanes) answer at the scope of the group or repo that installs it: open `" +
	`${origin.replace(/\/+$/, "")}/-/agents.md?path=<group-or-repo>` +
	"` for that scope's protocol and MCP URL, and connect there.",
	"",
];

const connectSection = (origin: string, path: string): string => {
	const url = mcpUrlOf(origin, path);
	const host = new URL(origin).host;
	return [
		"## Connect",
		"",
		...(path === "" ? forgeScopeNote(origin) : []),
		"Claude Code:",
		"",
		"```sh",
		`claude mcp add --transport http tartan ${url} --header "Authorization: Bearer $TARTAN_TOKEN"`,
		"```",
		"",
		"Codex CLI (`~/.codex/config.toml`):",
		"",
		"```toml",
		"[mcp_servers.tartan]",
		`url = "${url}"`,
		'bearer_token_env_var = "TARTAN_TOKEN"',
		"```",
		"",
		`Git (every repo and lane remote on ${host}): send the token with plain git, as a header or as the password of any user name:`,
		"",
		"```sh",
		`git -c http.extraHeader="Authorization: Bearer $TARTAN_TOKEN" clone ${
			origin.replace(/\/+$/, "")
		}/<repo path>.git`,
		`git config --global credential.${
			origin.replace(/\/+$/, "")
		}.helper '!f() { echo username=agent; echo "password=$TARTAN_TOKEN"; }; f'`,
		"```",
		"",
		"The `tartan` CLI (built from Tartan's source, `tools/cli`) does the same with `tartan credential`, and `tartan hooks install --git` adds a pre-push check; neither is needed.",
	].join("\n");
};

/** The markdown body of `/-/agents.md` for one scope (`path` `""` = the forge). */
export const agentsMarkdown = (
	origin: string,
	path: string,
	cards: readonly ProtocolCard[],
): string =>
	[
		kernelCard(origin, path),
		...cards.map((c) =>
			[`<!-- ${c.ext} (${c.installation}) -->`, c.md.trim()].join("\n")
		),
		connectSection(origin, path),
	].join("\n\n---\n\n") + "\n";
