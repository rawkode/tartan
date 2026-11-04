// `deno task poc:e2e`: the whole POC, through headless Chrome and stock git,
// against a forge `deno task poc` just seeded (real Worker, real WASM, workerd).
// Each check prints PASS or FAIL with what it saw; it exits 1 when any fails. It
// creates issues, a group and a repo, so a second run needs a fresh forge.
//
// Usage: deno task poc:e2e --session .wrangler/poc/8801/session.json \
//          [--shots <dir>] [--chrome <path>]
//
// It runs under node, like the other Playwright suites, not deno.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright";

type Session = {
	readonly origin: string;
	readonly cookie: string;
	readonly token: string;
	readonly handle: string;
};

const argOf = (name: string): string | undefined => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
};

const usage = (): never => {
	throw new Error("usage: poc:e2e --session <session.json> [--shots <dir>]");
};
const sessionPath = argOf("session") ?? usage();
const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
const ORIGIN = session.origin;
const SHOTS = argOf("shots") ?? mkdtempSync(join(tmpdir(), "poc-shots-"));
mkdirSync(SHOTS, { recursive: true });
const CHROME = argOf("chrome") ??
	execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim();

const KILN = "/oss/devtools/build/kiln";
const TIMEOUT_MS = 15_000;

let failures = 0;
const passed: string[] = [];
const failed: string[] = [];

const check = (name: string, ok: boolean, got?: unknown): void => {
	if (ok) passed.push(name);
	else {
		failures++;
		failed.push(name);
	}
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${
			ok ? "" : `\n      got ${JSON.stringify(got)}`
		}`,
	);
};

/** A step's own failure, as one failed check, so the rest still run. */
const step = async (name: string, work: () => Promise<void>): Promise<void> => {
	console.log(`\n## ${name}`);
	try {
		await work();
	} catch (e) {
		check(`${name} ran to the end`, false, String(e).slice(0, 600));
	}
};

// ---------------------------------------------------------------------------
// The browser side: every page is watched for console and CSP errors.
// ---------------------------------------------------------------------------

const problems: string[] = [];

/**
 * The answers a page can't avoid asking for: whether Issues is installed on a
 * repo (404 not_installed), whether the viewer may read it (403 denied), and
 * whether an issue exists (404 not_found) only come from the tools, and Chrome
 * logs any 4xx. A Reporter's close is refused the same way (403 denied). The UI
 * shows each as a state, which the checks below assert.
 */
const expectedRefusal = (url: string, status: number): boolean => {
	const tool = new URL(url).pathname.match(
		/\/-\/api\/repos\/[^/]+\/ext\/rawkode\.issues\/tools\/(\w+)$/,
	)?.[1];
	if (tool === "close") return status === 403;
	return (tool === "list" || tool === "get") && [403, 404].includes(status);
};

const watched = (page: Page, who: string): Page => {
	const refused = new Set<string>();
	page.on("response", (response) => {
		if (expectedRefusal(response.url(), response.status())) {
			refused.add(response.url());
		}
	});
	page.on("console", (message) => {
		if (message.type() !== "error" && message.type() !== "warning") return;
		const at = message.location().url;
		if (message.text().startsWith("Failed to load") && refused.has(at)) return;
		problems.push(`${who} ${page.url()}: ${message.text()} (${at})`);
	});
	page.on("pageerror", (error) => {
		problems.push(`${who} ${page.url()}: ${error.message}`);
	});
	return page;
};

const go = async (page: Page, path: string): Promise<void> => {
	await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle" });
};

const main = (page: Page) => page.locator("#main");
const textOf = (page: Page) => main(page).innerText();
const shot = (page: Page, name: string) =>
	page.screenshot({ path: join(SHOTS, `${name}.png`) });

const see = async (page: Page, text: string): Promise<boolean> => {
	try {
		await main(page).getByText(text, { exact: false }).first().waitFor({
			state: "visible",
			timeout: TIMEOUT_MS,
		});
		return true;
	} catch {
		return false;
	}
};

const tabs = (page: Page) =>
	page.getByRole("navigation", { name: "Views" }).locator("a");
const tabNames = async (
	page: Page,
): Promise<
	string[]
> => (await tabs(page).evaluateAll((links) =>
	links.filter((a) => (a as HTMLElement).offsetParent !== null)
		.map((a) => (a.textContent ?? "").trim().split(/\s+/)[0]!)
));

const overflow = (page: Page) =>
	page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));

const visibleText = async (page: Page, selector: string): Promise<string[]> =>
	await page.locator(selector).evaluateAll((items) =>
		items.filter((e) => (e as HTMLElement).offsetParent !== null)
			.map((e) => (e.textContent ?? "").trim())
	);

// ---------------------------------------------------------------------------
// Stock git, with the token in a header so it lands in no config file.
// ---------------------------------------------------------------------------

const git = (
	dir: string,
	token: string,
	args: readonly string[],
): { readonly code: number; readonly output: string } => {
	const run = spawnSync("git", [
		"-c",
		"credential.helper=",
		"-c",
		`http.extraHeader=Authorization: Bearer ${token}`,
		...args,
	], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_SSL_NO_VERIFY: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "e2e",
			GIT_AUTHOR_EMAIL: "e2e@tartan-dev.test",
			GIT_COMMITTER_NAME: "e2e",
			GIT_COMMITTER_EMAIL: "e2e@tartan-dev.test",
		},
	});
	return {
		code: run.status ?? 1,
		output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
	};
};

const workdir = (name: string) =>
	mkdtempSync(join(tmpdir(), `poc-e2e-${name}-`));

// ---------------------------------------------------------------------------

const contextFor = (browser: Browser, width = 1440): Promise<BrowserContext> =>
	browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width, height: 900 },
	});

const signIn = async (browser: Browser): Promise<BrowserContext> => {
	const context = await contextFor(browser);
	const page = watched(await context.newPage(), "owner");
	await go(page, "/-/auth/login?return_to=/");
	await page.close();
	return context;
};

const run = async (browser: Browser): Promise<void> => {
	const owner = await signIn(browser);
	const page = watched(await owner.newPage(), "owner");

	await step("Sign in", async () => {
		await go(page, "/");
		const role = await page.evaluate(() =>
			document.documentElement.dataset["role"]
		);
		check("the Owner signs in and the page knows", role === "owner", role);
		check(
			"the account shows the handle",
			(await page.locator("header").innerText()).includes(session.handle),
		);
		await shot(page, "owner-root");
	});

	await step("Navigate the tree", async () => {
		const tree = page.getByRole("navigation", { name: "Tree" });
		for (const href of ["/oss", "/oss/devtools", "/oss/devtools/build", KILN]) {
			const link = tree.locator(`a[href="${href}"]`);
			await link.waitFor({ state: "visible", timeout: TIMEOUT_MS });
			await link.click();
			await page.waitForURL(`${ORIGIN}${href}`, { timeout: TIMEOUT_MS });
		}
		check(
			"each level opens from the tree, read lazily",
			await see(page, "Discovered from package tartan files"),
			await textOf(page),
		);
		const lsp = tree.locator(`a[href="${KILN}:lsp"]`);
		await lsp.waitFor({ state: "visible", timeout: TIMEOUT_MS });
		check("the tree lists a repo's projects", await lsp.isVisible());
		await shot(page, "owner-tree-kiln");
	});

	await step("Resize the sidebar, then reload", async () => {
		const trigger = page.locator("[data-part='resize-trigger']").first();
		const side = page.locator("[data-part='panel']").first();
		const before = (await side.boundingBox())!.width;
		const handle = (await trigger.boundingBox())!;
		const x = handle.x + handle.width / 2;
		const y = handle.y + handle.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 60, y, { steps: 4 });
		await page.mouse.move(x + 120, y, { steps: 4 });
		await page.mouse.up();
		const dragged = (await side.boundingBox())!.width;
		check(
			"dragging widens it",
			Math.abs(dragged - before - 120) < 12,
			{ before, dragged },
		);
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(200);
		const after = (await side.boundingBox())!.width;
		check(
			"the width survives a reload",
			Math.abs(after - dragged) < 4,
			{ dragged, after },
		);
	});

	await step("The Projects tab", async () => {
		await go(page, "/-/projects");
		const rootRows = await visibleText(
			page,
			"#main a[href*=':'], #main a[href$='remote-cache'], #main a[href$='/blog'], #main a[href$='/dotfiles']",
		);
		check(
			"the root lists all 12 projects, with single-project repos",
			rootRows.length === 12,
			rootRows,
		);
		await shot(page, "owner-projects-root");
		await go(page, "/oss/devtools/build/-/projects");
		const groupText = await textOf(page);
		check(
			"a group lists only what is below it",
			groupText.includes("kiln:lsp") && groupText.includes("remote-cache") &&
				!groupText.includes("platform:"),
			groupText,
		);
		check(
			"the Projects tab shows its real count on the group",
			(await tabs(page).filter({ hasText: "Projects" }).innerText()).includes(
				"7",
			),
			await tabs(page).allInnerTexts(),
		);
		await shot(page, "owner-projects-group");
	});

	await step("Open kiln and kiln:lsp", async () => {
		await go(page, KILN);
		const text = await textOf(page);
		for (const name of ["cli", "core", "lsp", "vscode", "registry", "docs"]) {
			check(`kiln lists ${name}`, text.includes(name), text);
		}
		check(
			"kiln names the file each project came from",
			text.includes("editors/vscode/tartan.cue"),
			text,
		);
		check(
			"kiln shows no made-up CI or releases",
			!/\bCI\b|Release|Passing/.test(text),
			text,
		);
		await shot(page, "owner-kiln");

		await go(page, `${KILN}:lsp`);
		check(
			"the address bar keeps the colon",
			new URL(page.url()).pathname === `${KILN}:lsp`,
			page.url(),
		);
		check(
			"kiln:lsp shows its forge.cue from the repo",
			await see(page, 'deps: ["core"]') &&
				(await textOf(page)).includes("crates/lsp/forge.cue"),
			await textOf(page),
		);
		check(
			"kiln:lsp shows commits filtered to its path",
			(await textOf(page)).includes(
				"feat(lsp): serve diagnostics to editors",
			) &&
				!(await textOf(page)).includes("docs: add the documentation site"),
			await textOf(page),
		);
		await shot(page, "owner-kiln-lsp");
	});

	const title = `E2E: hover shows the wrong type ${Date.now()}`;
	let issueUrl = "";
	await step("An issue on kiln:lsp, through the UI", async () => {
		await go(page, `${KILN}:lsp/-/issues`);
		await page.getByRole("link", { name: "New issue" }).click();
		await page.getByLabel("Title").fill(title);
		await page.getByLabel("Description").fill("Seen in the end-to-end run.");
		await page.getByRole("button", { name: "Open issue" }).click();
		await page.waitForURL(/kiln:lsp\/-\/issues\/\d+$/, { timeout: TIMEOUT_MS });
		issueUrl = new URL(page.url()).pathname;
		check("it opens on its page", await see(page, title));
		check(
			"it shows its description",
			await see(page, "Seen in the end-to-end run."),
		);
		await shot(page, "owner-issue-new");

		await go(page, `${KILN}:lsp/-/issues`);
		check("it is in kiln:lsp's list", await see(page, title));
		await go(page, `${KILN}/-/issues`);
		check("it is in the repo-wide list", await see(page, title));
		await shot(page, "owner-issues-repo");
		await go(page, `${KILN}:core/-/issues`);
		await see(page, "Open");
		check(
			"it is not in kiln:core's list",
			!(await textOf(page)).includes(title),
			await textOf(page),
		);
	});

	await step("Close and reopen", async () => {
		await go(page, issueUrl);
		await page.getByRole("button", { name: "Close issue" }).click();
		check("closing shows Closed", await see(page, "Closed"));
		await page.getByRole("button", { name: "Reopen issue" }).waitFor({
			timeout: TIMEOUT_MS,
		});
		await go(page, `${KILN}:lsp/-/issues`);
		await see(page, "Open");
		check(
			"a closed issue leaves the open list",
			!(await textOf(page)).includes(title),
			await textOf(page),
		);
		await page.getByText(/^Closed \d+$/).click();
		check("and joins the closed list", await see(page, title));
		await shot(page, "owner-issues-closed");

		await go(page, issueUrl);
		await page.getByRole("button", { name: "Reopen issue" }).click();
		await page.getByRole("button", { name: "Close issue" }).waitFor({
			timeout: TIMEOUT_MS,
		});
		check("reopening shows Open", await see(page, "Open"));
		await go(page, `${KILN}:lsp/-/issues`);
		check("and it is back in the open list", await see(page, title));
	});

	await step("Where Issues is off", async () => {
		await go(page, `${KILN}:docs`);
		await see(page, "site/docs");
		const docs = await tabNames(page);
		check("kiln:docs has no Issues tab", !docs.includes("Issues"), docs);
		await go(page, `${KILN}:docs/-/issues`);
		check(
			"kiln:docs's Issues page says why",
			await see(page, "turned off for this project"),
			await textOf(page),
		);
		await shot(page, "owner-kiln-docs-off");
		await go(page, "/dotfiles");
		await see(page, "single project");
		await page.waitForTimeout(300);
		const dotfiles = await tabNames(page);
		check(
			"a repo with no install has no Issues tab",
			!dotfiles.includes("Issues"),
			dotfiles,
		);
		await go(page, "/dotfiles/-/issues");
		check(
			"and says so at the address",
			await see(page, "not installed on this repo"),
			await textOf(page),
		);
	});

	await step("Activity and file browsing", async () => {
		await go(page, `${KILN}/-/activity`);
		check(
			"a repo's activity comes from its event log",
			await see(page, "Pushed to main") && await see(page, "Repo created"),
			await textOf(page),
		);
		await shot(page, "owner-activity");
		await go(page, KILN);
		await tabs(page).filter({ hasText: "Files" }).click();
		await page.waitForURL(/\/-\/tree\/main/, { timeout: TIMEOUT_MS });
		await page.getByText("crates", { exact: false }).first().waitFor({
			timeout: TIMEOUT_MS,
		});
		check("Files opens Tartan's file browser", true);
		await shot(page, "owner-files");
	});

	const slug = `e2e-${Date.now().toString(36)}`;
	const repoPath = `/oss/${slug}/widgets`;
	await step("Create a group and a repo", async () => {
		await go(page, "/oss");
		await page.getByRole("navigation", { name: "Tree" }).getByRole("link", {
			name: "New group",
		}).click();
		await page.getByLabel("Name").fill(slug);
		await page.getByLabel("Description").fill("Made by the end-to-end run");
		await page.getByRole("button", { name: "Create group" }).click();
		await page.waitForURL(`${ORIGIN}/oss/${slug}`, { timeout: TIMEOUT_MS });
		check("the group exists at its address", await see(page, "Group created"));

		await page.getByRole("navigation", { name: "Tree" }).getByRole("link", {
			name: "New repo",
		}).click();
		await page.getByLabel("Name").fill("widgets");
		await page.getByRole("button", { name: "Create repo" }).click();
		await page.waitForURL(`${ORIGIN}${repoPath}`, { timeout: TIMEOUT_MS });
		check("the repo exists at its address", await see(page, "Repo created"));
		check(
			"and starts as a single project",
			await see(page, "a single project"),
			await textOf(page),
		);
		await shot(page, "owner-new-repo");
	});

	await step("A repo at the top of the tree", async () => {
		await go(page, "/");
		await page.getByRole("navigation", { name: "Tree" }).getByRole("link", {
			name: "New repo",
		}).last().click();
		await page.waitForURL(`${ORIGIN}/-/new/repo`, { timeout: TIMEOUT_MS });
		await page.getByLabel("Name").fill(`${slug}-top`);
		await page.getByRole("button", { name: "Create repo" }).click();
		await page.waitForURL(`${ORIGIN}/${slug}-top`, { timeout: TIMEOUT_MS });
		check("it exists with no group above it", await see(page, "Repo created"));
		const dir = workdir("top");
		const url = `${ORIGIN}/${slug}-top.git`;
		const cloned = git(dir, session.token, ["clone", url, "."]);
		check("the Owner clones it", cloned.code === 0, cloned.output);
		mkdirSync(join(dir, "svc"), { recursive: true });
		writeFileSync(join(dir, "svc/forge.cue"), "package tartan\n");
		git(dir, session.token, ["add", "."]);
		git(dir, session.token, ["commit", "-m", "feat: add the svc project"]);
		const pushed = git(dir, session.token, ["push", "origin", "HEAD:main"]);
		check("and pushes to its main", pushed.code === 0, pushed.output);
		await go(page, `/${slug}-top:svc`);
		check(
			"and its project has an address",
			await see(page, "package tartan"),
			await textOf(page),
		);
	});

	await step("A private repo", async () => {
		await go(page, `/oss/${slug}/-/new/repo`);
		await page.getByLabel("Name").fill("secret");
		await page.getByText("Private", { exact: true }).click();
		await page.getByRole("button", { name: "Create repo" }).click();
		await page.waitForURL(`${ORIGIN}/oss/${slug}/secret`, {
			timeout: TIMEOUT_MS,
		});
		const anon = await contextFor(browser);
		const stranger = watched(await anon.newPage(), "anon");
		await go(stranger, `/oss/${slug}/secret`);
		check(
			"a stranger gets the same answer as for nothing at all",
			await see(stranger, "Nothing at that address"),
			await textOf(stranger),
		);
		await anon.close();
	});

	await step("Stock git: a new project appears and goes", async () => {
		const dir = workdir("project");
		const url = `${ORIGIN}${repoPath}.git`;
		const cloned = git(dir, session.token, ["clone", url, "."]);
		check("the Owner clones with stock git", cloned.code === 0, cloned.output);
		await go(page, repoPath);

		mkdirSync(join(dir, "tools/gadget"), { recursive: true });
		writeFileSync(
			join(dir, "tools/gadget/forge.cue"),
			"package tartan\n\ndeps: []\n",
		);
		git(dir, session.token, ["add", "."]);
		git(dir, session.token, ["commit", "-m", "feat: add the gadget project"]);
		const pushed = git(dir, session.token, ["push", "origin", "HEAD:main"]);
		check("the Owner pushes to main", pushed.code === 0, pushed.output);

		await page.reload({ waitUntil: "networkidle" });
		check(
			"after a reload the new project is there",
			await see(page, "tools/gadget/forge.cue") &&
				await see(page, "Monorepo · 1 project"),
			await textOf(page),
		);
		await shot(page, "owner-pushed-project");
		await go(page, `${repoPath}:gadget`);
		check(
			"its page shows the pushed file",
			await see(page, "package tartan"),
			await textOf(page),
		);

		git(dir, session.token, ["rm", "-r", "tools/gadget"]);
		git(dir, session.token, [
			"commit",
			"-m",
			"feat: remove the gadget project",
		]);
		const removed = git(dir, session.token, ["push", "origin", "HEAD:main"]);
		check("the Owner pushes the removal", removed.code === 0, removed.output);

		await page.reload({ waitUntil: "networkidle" });
		check(
			"after a reload its address is gone",
			await see(page, "Nothing at that address"),
			await textOf(page),
		);
		await go(page, repoPath);
		check(
			"and the repo is a single project again",
			await see(page, "a single project") &&
				!(await textOf(page)).includes("gadget/forge.cue"),
			await textOf(page),
		);
	});

	const invitee = await contextFor(browser);
	const other = watched(await invitee.newPage(), "contributor");
	await step("A contributor", async () => {
		const invited = await owner.request.post(`${ORIGIN}/-/api/invites`, {
			headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
			data: { node: "oss", role: 30, note: "e2e" },
		});
		const { url } = await invited.json() as { url: string };
		check("the Owner writes an invite", invited.status() === 201, url);
		await other.goto(url, { waitUntil: "networkidle" });
		await other.getByRole("link", { name: "Accept and sign in" }).click();
		await other.waitForLoadState("networkidle");
		const role = await other.evaluate(() =>
			document.documentElement.dataset["role"]
		);
		check(
			"the invitee signs in as a contributor",
			role === "contributor",
			role,
		);

		await go(other, "/oss");
		await see(other, "Open issues");
		const buttons = await visibleText(
			other,
			"a[href$='/-/new/group'], a[href$='/-/new/repo']",
		);
		check("they are offered no create actions", buttons.length === 0, buttons);
		await shot(other, "contributor-group");
		await go(other, "/oss/-/new/group");
		check(
			"the create page refuses them",
			await see(other, "Only the owner can create groups and repos"),
			await textOf(other),
		);
		await shot(other, "contributor-new-refused");
		const made = await invitee.request.post(`${ORIGIN}/-/api/nodes`, {
			headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
			data: { parent: "oss", kind: "group", slug: "not-theirs" },
		});
		check(
			"the kernel refuses them a group too",
			made.status() === 403,
			{ status: made.status(), body: await made.text() },
		);
		const madeRepo = await invitee.request.post(`${ORIGIN}/-/api/nodes/repos`, {
			headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
			data: { parent: "oss", slug: "not-theirs" },
		});
		check(
			"and a repo",
			madeRepo.status() === 403,
			{ status: madeRepo.status(), body: await madeRepo.text() },
		);

		const tokenReply = await invitee.request.post(`${ORIGIN}/-/api/tokens`, {
			headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
			data: {
				name: "e2e",
				scopes: ["repo:read", "repo:write"],
				expiresInDays: 1,
			},
		});
		const { token } = await tokenReply.json() as { token: string };
		check("they make a git token", tokenReply.status() === 201);
		const dir = workdir("refused");
		const cloned = git(dir, token, ["clone", `${ORIGIN}${KILN}.git`, "."]);
		check("they clone with stock git", cloned.code === 0, cloned.output);
		writeFileSync(join(dir, "CHANGE"), "not allowed\n");
		git(dir, token, ["add", "."]);
		git(dir, token, ["commit", "-m", "chore: try the trunk"]);
		const pushed = git(dir, token, ["push", "origin", "HEAD:main"]);
		check(
			"their push to main is refused",
			pushed.code !== 0 &&
				/woven-by-tartan|rejected|remote rejected/.test(pushed.output),
			pushed.output,
		);

		await go(other, `${KILN}:lsp/-/issues`);
		check("they see the issues", await see(other, title), await textOf(other));
		await shot(other, "contributor-issues");

		await go(other, "/writing/blog/-/issues");
		check(
			"where they have no role, the list says so",
			await see(other, "do not have access to the issues here"),
			await textOf(other),
		);
		await shot(other, "contributor-denied");

		const reporter = await owner.request.post(`${ORIGIN}/-/api/invites`, {
			headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
			data: { node: "infra", role: 20, note: "e2e reporter" },
		});
		const invite = await reporter.json() as { url: string };
		const second = await contextFor(browser);
		const low = watched(await second.newPage(), "reporter");
		await low.goto(invite.url, { waitUntil: "networkidle" });
		await low.getByRole("link", { name: "Accept and sign in" }).click();
		await low.waitForLoadState("networkidle");
		await go(low, "/infra/cloud/platform/-/issues");
		await low.locator("#main a[href*='/-/issues/']:not([href$='/new'])").first()
			.click();
		await low.getByRole("button", { name: "Close issue" }).click();
		check(
			"a Reporter's close is refused, and the page says why",
			await low.getByRole("alert").first().waitFor({ timeout: TIMEOUT_MS })
				.then(() => true, () => false),
			await textOf(low),
		);
		check(
			"and the issue stays open",
			(await textOf(low)).includes("Open"),
			await textOf(low),
		);
		await shot(low, "reporter-close-refused");
		await second.close();
	});

	await step("No grant or token makes anyone the owner", async () => {
		const same = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
		const invited = await owner.request.post(`${ORIGIN}/-/api/invites`, {
			headers: same,
			data: { node: "oss", role: 40, note: "e2e maintainer" },
		});
		const { url } = await invited.json() as { url: string };
		check("the Owner invites a Maintainer", invited.status() === 201, url);
		const high = await contextFor(browser);
		const view = watched(await high.newPage(), "maintainer");
		await view.goto(url, { waitUntil: "networkidle" });
		await view.getByRole("link", { name: "Accept and sign in" }).click();
		await view.waitForLoadState("networkidle");
		const me = await (await high.request.get(`${ORIGIN}/-/api/me`)).json() as {
			readonly principal: { readonly id: string };
		};
		const tryCreating = async (
			who: string,
			context: BrowserContext,
			headers: Record<string, string>,
		): Promise<void> => {
			const group = await context.request.post(`${ORIGIN}/-/api/nodes`, {
				headers,
				data: { parent: "oss", kind: "group", slug: "not-theirs" },
			});
			check(`${who}: no group`, group.status() === 403, group.status());
			const repo = await context.request.post(
				`${ORIGIN}/-/api/nodes/repos`,
				{ headers, data: { parent: "oss", slug: "not-theirs" } },
			);
			check(`${who}: no repo`, repo.status() === 403, repo.status());
			const top = await context.request.post(`${ORIGIN}/-/api/nodes/repos`, {
				headers,
				data: { slug: "not-theirs" },
			});
			check(`${who}: no repo at the top`, top.status() === 403, top.status());
		};
		await tryCreating("a Maintainer", high, same);

		const granted = await owner.request.post(`${ORIGIN}/-/api/nodes/grants`, {
			headers: same,
			data: { node: "oss", principal: me.principal.id, role: 50 },
		});
		check("the Owner grants them Owner", granted.status() === 204);
		await tryCreating("someone with an Owner grant", high, same);
		const tokenReply = await high.request.post(`${ORIGIN}/-/api/tokens`, {
			headers: same,
			data: {
				name: "e2e-owner-grant",
				scopes: ["repo:read", "repo:write"],
				maxRole: 50,
				expiresInDays: 1,
			},
		});
		const { token } = await tokenReply.json() as { token: string };
		check("they make a git token", tokenReply.status() === 201);
		const tryPushing = (who: string, name: string, credential: string) => {
			const dir = workdir(name);
			git(dir, credential, ["clone", `${ORIGIN}${KILN}.git`, "."]);
			writeFileSync(join(dir, "CHANGE"), "not allowed\n");
			git(dir, credential, ["add", "."]);
			git(dir, credential, ["commit", "-m", "chore: try the trunk"]);
			const pushed = git(dir, credential, ["push", "origin", "HEAD:main"]);
			check(
				`${who}: their push to main is refused`,
				pushed.code !== 0 &&
					/woven-by-tartan|agents-lanes-only/.test(pushed.output),
				pushed.output,
			);
		};
		tryPushing("someone with an Owner grant", "owner-grant", token);

		const made = await owner.request.post(`${ORIGIN}/-/api/agents`, {
			headers: same,
			data: {
				name: "e2e-bot",
				tool: "claude-code",
				node: "oss",
				maxRole: 50,
				ttlDays: 1,
			},
		});
		const agent = await made.json() as { token: string };
		check("the Owner makes an agent", made.status() === 201, agent);
		const bare = await contextFor(browser);
		await tryCreating("the Owner's agent", bare, {
			authorization: `Bearer ${agent.token}`,
		});
		tryPushing("the Owner's agent", "agent", agent.token);
		await bare.close();
		await high.close();
	});

	const anon = await contextFor(browser);
	const stranger = watched(await anon.newPage(), "anon");
	await step("Anonymous", async () => {
		await go(stranger, KILN);
		check(
			"public repos read without an account",
			await see(stranger, "Discovered from package tartan files"),
			await textOf(stranger),
		);
		await shot(stranger, "anon-kiln");
		const made = await visibleText(
			stranger,
			"a[href$='/-/new/group'], a[href$='/-/new/repo']",
		);
		check("no create actions", made.length === 0, made);
		await go(stranger, `${KILN}/-/issues`);
		check(
			"issues ask for a sign-in",
			await see(stranger, "to see the issues here"),
			await textOf(stranger),
		);
		await shot(stranger, "anon-issues");
	});

	await step("No horizontal overflow", async () => {
		const addresses = [
			"/",
			"/-/projects",
			"/oss/devtools/build",
			"/oss/devtools/build/-/projects",
			KILN,
			`${KILN}:lsp`,
			`${KILN}:lsp/-/issues`,
			issueUrl,
			`${KILN}:lsp/-/issues/new`,
			`${KILN}/-/issues`,
			`${KILN}/-/activity`,
			"/dotfiles",
			"/oss/-/new/group",
			"/oss/-/new/repo",
		];
		const viewers: readonly [string, BrowserContext][] = [
			["owner", owner],
			["contributor", invitee],
			["anon", anon],
		];
		for (const [who, context] of viewers) {
			for (const width of [375, 768, 1440]) {
				const view = watched(await context.newPage(), who);
				await view.setViewportSize({ width, height: 900 });
				const bad: unknown[] = [];
				for (const address of addresses) {
					await go(view, address);
					const { scroll, client } = await overflow(view);
					if (scroll > client) bad.push({ address, scroll, client });
				}
				await shot(view, `${who}-${width}`);
				await go(view, `${KILN}:lsp`);
				await shot(view, `${who}-${width}-kiln-lsp`);
				check(`${who} at ${width}px fits every page`, !bad.length, bad);
				await view.close();
			}
		}
	});

	await step("The Jump box and missing addresses", async () => {
		await go(page, "/");
		await page.getByRole("combobox").fill("o/d/k:l");
		const option = page.getByRole("option", { name: `~${KILN}:lsp` });
		await option.waitFor({ timeout: TIMEOUT_MS });
		await option.click();
		await page.waitForURL(`${ORIGIN}${KILN}:lsp`, { timeout: TIMEOUT_MS });
		check("o/d/k:l jumps to kiln:lsp", true);
		await go(page, "/nothing/here");
		check(
			"an unknown address says so",
			await see(page, "Nothing at that address"),
			await textOf(page),
		);
		await go(page, `${KILN}/lsp`);
		check(
			"a project is only reached through a colon",
			await see(page, "Nothing at that address"),
			await textOf(page),
		);
		await go(page, `${KILN}/-/issues/abc`);
		check(
			"a page below Issues that isn't an issue says so",
			await see(page, "Nothing at that address"),
			await textOf(page),
		);
		await go(page, `${KILN}:lsp/-/issues/9999`);
		check(
			"an unknown issue says so",
			await see(page, "Nothing at that address"),
			await textOf(page),
		);
	});

	await step("No dead links", async () => {
		const pages = [
			"/",
			"/oss/devtools/build",
			"/-/projects",
			KILN,
			`${KILN}:lsp`,
			`${KILN}:lsp/-/issues`,
			issueUrl,
			`${KILN}/-/activity`,
		];
		const links = new Set<string>();
		for (const address of pages) {
			await go(page, address);
			const here = await page.locator("[data-forge] a[href^='/']").evaluateAll(
				(items) => items.map((a) => a.getAttribute("href")!),
			);
			for (const link of here) links.add(link);
		}
		const dead: unknown[] = [];
		const view = watched(await owner.newPage(), "owner");
		for (const link of links) {
			if (link.startsWith("/-/auth/")) continue;
			const answer = await view.goto(`${ORIGIN}${link}`, {
				waitUntil: "networkidle",
			});
			const body = await view.locator("body").innerText();
			if (
				!answer?.ok() ||
				/Nothing at that address|Page not found|Not found|Could not/.test(body)
			) {
				dead.push({ link, status: answer?.status(), body: body.slice(0, 200) });
			}
		}
		await view.close();
		check(
			`all ${links.size} links on these pages lead somewhere`,
			!dead.length,
			dead,
		);
	});

	await step("Console and CSP", () => {
		check(
			"no console errors, page errors or CSP violations anywhere",
			problems.length === 0,
			problems,
		);
		return Promise.resolve();
	});
};

const browser = await chromium.launch({
	executablePath: CHROME,
	headless: true,
	args: ["--no-sandbox"],
});
try {
	await run(browser);
} finally {
	await browser.close();
}

console.log(`\n${passed.length} passed, ${failed.length} failed`);
console.log(`screenshots: ${SHOTS}`);
if (failures > 0) process.exit(1);
