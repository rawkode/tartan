// Test-only (Deno): stock git in a hermetic sandbox, and bare repositories
// served by `git http-backend` behind a CGI bridge on 127.0.0.1, standing in
// for the Artifacts git remote behind the gateway. Every upstream request is
// recorded (method, path, query, headers, body size, status), so tests can
// assert what was, and was not, forwarded.

const decoder = new TextDecoder();

/** True when a `git` binary with `http-backend` is on PATH. */
export const hasGit: boolean = (() => {
	try {
		return new Deno.Command("git", {
			args: ["--version"],
			stdout: "null",
			stderr: "null",
		}).outputSync().success;
	} catch {
		return false;
	}
})();

/** Fixed identity and dates, so object ids are reproducible. */
const FIXED_DATE = "1790000000 +0000";

export type Sandbox = {
	readonly root: string;
	readonly env: Readonly<Record<string, string>>;
	readonly cleanup: () => Promise<void>;
};

export const makeSandbox = async (): Promise<Sandbox> => {
	const root = await Deno.makeTempDir({ prefix: "tartan-gw-" });
	const config = `${root}/gitconfig`;
	await Deno.writeTextFile(
		config,
		[
			"[init]",
			"\tdefaultBranch = main",
			"[user]",
			"\tname = Tartan Test",
			"\temail = test@example.invalid",
			"[advice]",
			"\tdetachedHead = false",
			"[credential]",
			"\thelper = ",
			"[protocol]",
			"\tversion = 2",
			"",
		].join("\n"),
	);
	return {
		root,
		env: {
			PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
			HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: config,
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "Tartan Test",
			GIT_AUTHOR_EMAIL: "test@example.invalid",
			GIT_AUTHOR_DATE: FIXED_DATE,
			GIT_COMMITTER_NAME: "Tartan Test",
			GIT_COMMITTER_EMAIL: "test@example.invalid",
			GIT_COMMITTER_DATE: FIXED_DATE,
			LC_ALL: "C",
		},
		cleanup: () => Deno.remove(root, { recursive: true }),
	};
};

export type GitResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

/** Runs stock git; throws on a non-zero exit unless `allowFail`. */
export const git = async (
	sandbox: Sandbox,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env?: Readonly<Record<string, string>>;
		readonly allowFail?: boolean;
	} = {},
): Promise<GitResult> => {
	const out = await new Deno.Command("git", {
		args: [...args],
		cwd: options.cwd ?? sandbox.root,
		env: { ...sandbox.env, ...options.env },
		clearEnv: true,
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
	}).output();
	const result = {
		code: out.code,
		stdout: decoder.decode(out.stdout),
		stderr: decoder.decode(out.stderr),
	};
	if (result.code !== 0 && !options.allowFail) {
		throw new Error(
			`git ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
		);
	}
	return result;
};

/** `<root>/srv/<name>.git`, bare, receive-pack enabled. */
export const initBare = async (
	sandbox: Sandbox,
	name: string,
): Promise<string> => {
	const dir = `${sandbox.root}/srv/${name}.git`;
	await Deno.mkdir(`${sandbox.root}/srv`, { recursive: true });
	await git(sandbox, ["init", "-q", "--bare", "--initial-branch=main", dir]);
	await git(sandbox, ["config", "http.receivepack", "true"], { cwd: dir });
	await git(sandbox, ["config", "uploadpack.allowAnySHA1InWant", "true"], {
		cwd: dir,
	});
	return dir;
};

/** A working repository with `commits` linear commits on `main`. */
export const initWork = async (
	sandbox: Sandbox,
	name: string,
	commits = 1,
): Promise<string> => {
	const dir = `${sandbox.root}/work/${name}`;
	await Deno.mkdir(dir, { recursive: true });
	await git(sandbox, ["init", "-q", "--initial-branch=main", dir]);
	for (let i = 0; i < commits; i++) {
		await commitFile(sandbox, dir, `file-${i}.txt`, `content ${i}\n`);
	}
	return dir;
};

export const commitFile = async (
	sandbox: Sandbox,
	dir: string,
	path: string,
	content: string | Uint8Array,
	message = `add ${path}`,
): Promise<string> => {
	const full = `${dir}/${path}`;
	await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
	if (typeof content === "string") await Deno.writeTextFile(full, content);
	else await Deno.writeFile(full, content);
	await git(sandbox, ["add", "--", path], { cwd: dir });
	await git(sandbox, ["commit", "-q", "-m", message], { cwd: dir });
	return await revParse(sandbox, dir, "HEAD");
};

export const revParse = async (
	sandbox: Sandbox,
	dir: string,
	rev: string,
): Promise<string> =>
	(await git(sandbox, ["rev-parse", rev], { cwd: dir })).stdout.trim();

/** The refs of a bare repository (`for-each-ref`), ref → sha. */
export const bareRefs = async (
	sandbox: Sandbox,
	dir: string,
): Promise<Record<string, string>> => {
	const out = await git(sandbox, [
		"for-each-ref",
		"--format=%(objectname) %(refname)",
	], { cwd: dir });
	return Object.fromEntries(
		out.stdout.trim().split("\n").filter((l) => l !== "").map((line) => {
			const [sha, ref] = line.split(" ");
			return [ref, sha];
		}),
	);
};

export type UpstreamRecord = {
	readonly method: string;
	readonly path: string;
	readonly query: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyBytes: number;
	/** The first bytes of the body, decoded leniently (`command=fetch`, `want …`). */
	readonly bodyHead: string;
	status: number;
};

export type GitBackend = {
	/** `http://127.0.0.1:<port>` */
	readonly url: string;
	readonly requests: UpstreamRecord[];
	close(): Promise<void>;
};

const GIT_PATH =
	/^\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const runBackend = async (
	sandbox: Sandbox,
	request: Request,
	url: URL,
	body: Uint8Array,
): Promise<Response> => {
	const env: Record<string, string> = {
		PATH: sandbox.env.PATH,
		HOME: sandbox.root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: sandbox.env.GIT_CONFIG_GLOBAL,
		GIT_PROJECT_ROOT: `${sandbox.root}/srv`,
		GIT_HTTP_EXPORT_ALL: "1",
		PATH_INFO: url.pathname,
		QUERY_STRING: url.search.replace(/^\?/, ""),
		REQUEST_METHOD: request.method,
		CONTENT_TYPE: request.headers.get("content-type") ?? "",
		REMOTE_USER: "tartan",
		REMOTE_ADDR: "127.0.0.1",
	};
	if (request.method === "POST") env.CONTENT_LENGTH = String(body.length);
	const protocol = request.headers.get("git-protocol");
	if (protocol) env.GIT_PROTOCOL = protocol;
	const encoding = request.headers.get("content-encoding");
	if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
	const child = new Deno.Command("git", {
		args: ["http-backend"],
		env,
		clearEnv: true,
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	const writer = child.stdin.getWriter();
	await writer.write(body);
	await writer.close();
	const out = await child.output();
	const raw = out.stdout;
	let split = -1;
	for (let i = 0; i + 3 < raw.length; i++) {
		if (
			raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 &&
			raw[i + 3] === 10
		) {
			split = i;
			break;
		}
	}
	if (split < 0) {
		return new Response(`http-backend failed: ${decoder.decode(out.stderr)}`, {
			status: 500,
		});
	}
	let status = 200;
	const headers = new Headers();
	for (const line of decoder.decode(raw.subarray(0, split)).split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key.toLowerCase() === "status") status = parseInt(value, 10);
		else headers.set(key, value);
	}
	return new Response(raw.slice(split + 4), { status, headers });
};

/**
 * Serves `<root>/srv/*.git` with `git http-backend`. `authorize` checks the
 * upstream `Authorization` header (the kernel's injected token) and answers
 * 401 when it returns false.
 */
export const startBackend = (
	sandbox: Sandbox,
	authorize: (header: string | null) => boolean = () => true,
): GitBackend => {
	const requests: UpstreamRecord[] = [];
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		async (request) => {
			const url = new URL(request.url);
			let body: Uint8Array;
			try {
				body = new Uint8Array(await request.arrayBuffer());
			} catch {
				// The gateway aborted the upload (a body over the limit).
				return new Response("aborted\n", { status: 400 });
			}
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const record: UpstreamRecord = {
				method: request.method,
				path: url.pathname,
				query: url.search,
				headers,
				bodyBytes: body.length,
				bodyHead: decoder.decode(body.subarray(0, 256)),
				status: 0,
			};
			requests.push(record);
			if (!GIT_PATH.test(url.pathname)) {
				record.status = 404;
				return new Response("not found", { status: 404 });
			}
			if (!authorize(request.headers.get("authorization"))) {
				record.status = 401;
				return new Response("unauthorized", { status: 401 });
			}
			const response = await runBackend(sandbox, request, url, body);
			record.status = response.status;
			return response;
		},
	);
	return {
		url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
		requests,
		close: () => server.shutdown(),
	};
};
