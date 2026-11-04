// The forge shell's pure parts (addresses, role, theme) and a render of the real
// components to a string. Ark UI's behaviour needs a DOM, so it is not covered here.

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import { createMemoryHistory } from "vue-router";
import { SESSION } from "../src/app/context.ts";
import { forgeRole } from "../src/auth/role.ts";
import type { Session } from "../src/auth/session.ts";
import {
	parseUrl,
	projectFile,
	trailAt,
	urlFor,
} from "../src/forge/data/index.ts";
import ForgeApp from "../src/forge/ForgeApp.vue";
import { formatAddress, parseAddress } from "../src/router/address.ts";
import { createAppRouter } from "../src/router/index.ts";
import { resolvesDark } from "../src/theme.ts";

const session = (status: Session["state"]["status"], admin = false): Session =>
	({
		state: { status, me: null, error: null },
		isAdmin: () => admin,
		principal: () => null,
		loginUrl: (to: string) => `/-/auth/login?return_to=${to}`,
		logout: () => Promise.resolve(),
		load: () => Promise.resolve(),
	}) as Session;

describe("addresses", () => {
	it("splits a project from its repo", () => {
		expect(parseAddress("oss/devtools/build/kiln:lsp")).toEqual({
			path: "oss/devtools/build/kiln",
			project: "lsp",
		});
		expect(parseAddress("oss/kiln")).toEqual({
			path: "oss/kiln",
			project: null,
		});
		expect(parseAddress("kiln:a.b-c")).toEqual({
			path: "kiln",
			project: "a.b-c",
		});
		expect(parseAddress("")).toEqual({ path: "", project: null });
	});

	it("rejects malformed addresses", () => {
		for (
			const bad of ["a:", ":a", "a:b:c", "a:b/c", "a//b", "/a", "a/", "a/:b"]
		) {
			expect([bad, parseAddress(bad)]).toEqual([bad, null]);
		}
	});

	it("formats what it parses", () => {
		for (const address of ["oss/kiln:lsp", "oss/kiln", ""]) {
			expect(formatAddress(parseAddress(address)!)).toBe(address);
		}
	});

	it("reads a page off a URL", () => {
		expect(parseUrl("/oss/kiln:lsp/-/issues/128")).toEqual({
			addr: "oss/kiln:lsp",
			tab: "issues",
			detail: { type: "issue", n: 128 },
		});
		expect(parseUrl("/-/new/group")).toEqual({
			addr: "",
			tab: "overview",
			detail: { type: "new-node", kind: "group" },
		});
		expect(parseUrl("/oss/-/nope").unknown).toBe(true);
		expect(parseUrl("/%E0%A4%A").unknown).toBe(true);
		expect(urlFor("oss/kiln:lsp", "issues")).toBe("/oss/kiln:lsp/-/issues");
		expect(urlFor("", "projects")).toBe("/-/projects");
		expect(urlFor("")).toBe("/");
	});

	it("only reaches a project through a colon", () => {
		const kiln = "oss/devtools/build/kiln";
		expect(trailAt(`${kiln}:lsp`)?.at(-1)?.kind).toBe("project");
		expect(trailAt(`${kiln}/lsp`)).toBeNull();
		expect(trailAt("oss:devtools")).toBeNull();
		expect(trailAt("nothing/here")).toBeNull();
		expect(trailAt("")?.at(-1)?.name).toBe("~");
	});
});

describe("project files", () => {
	it("writes a name only when it differs from the directory", () => {
		const lsp = trailAt("oss/devtools/build/kiln:lsp")!.at(-1)!;
		expect(projectFile(lsp)).toEqual({
			path: "crates/lsp/forge.cue",
			source: 'package tartan\n\ndeps: ["core"]',
		});
		const deploy = trailAt("infra/cloud/platform:deploy")!.at(-1)!;
		expect(projectFile(deploy)?.source).toBe(
			'package tartan\n\nname: "deploy"',
		);
	});

	it("has none for the implicit root project", () => {
		const root = trailAt("oss/devtools/build/kiln:root")!.at(-1)!;
		expect(projectFile(root)).toBeNull();
	});
});

describe("role", () => {
	it("comes from the session and fails closed", () => {
		expect(forgeRole(session("signed-in", true))).toBe("owner");
		expect(forgeRole(session("signed-in", false))).toBe("contributor");
		for (
			const status of ["unknown", "loading", "anonymous", "error"] as const
		) {
			expect(forgeRole(session(status, true))).toBe("anon");
		}
	});
});

describe("theme", () => {
	it("resolves the same way as tokens.css", () => {
		expect(resolvesDark("dark", false)).toBe(true);
		expect(resolvesDark("light", true)).toBe(false);
		expect(resolvesDark("system", true)).toBe(true);
		expect(resolvesDark("system", false)).toBe(false);
	});
});

describe("ForgeApp", () => {
	const render = async (path: string): Promise<string> => {
		const router = createAppRouter({ history: createMemoryHistory() });
		await router.push(path);
		await router.isReady();
		const app = createSSRApp(ForgeApp);
		app.use(router);
		app.provide(SESSION, session("anonymous"));
		return await renderToString(app);
	};

	it("renders a project at its address, with its file from its directory", async () => {
		const html = await render("/oss/devtools/build/kiln:lsp");
		expect(html).toContain("data-forge");
		expect(html).toContain("Tartan");
		expect(html).toContain("crates/lsp/forge.cue");
		expect(html).toContain("package tartan");
		expect(html).not.toContain("projects.cue");
	});

	it("says projects are discovered, on a monorepo", async () => {
		const html = await render("/oss/devtools/build/kiln");
		expect(html).toContain("Discovered from package tartan files");
		expect(html).toContain("on every push to main");
	});

	it("says when nothing is at an address", async () => {
		const html = await render("/oss/devtools/build/kiln/lsp");
		expect(html).toContain("Nothing at that address.");
	});

	it("renders the root, issue and new-node pages", async () => {
		expect(await render("/")).toContain("Open issues");
		expect(await render("/oss/devtools/build/kiln:lsp/-/issues/128"))
			.toContain("Go-to-definition fails across workspace members");
		expect(await render("/oss/-/new/repo")).toContain("New repo in oss");
		expect(await render("/-/issues/new")).toContain(
			"Issues belong to a repo or a project.",
		);
	});
});
