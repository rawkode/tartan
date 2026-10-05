// Local stock-git harness (Deno only): bare repositories served by
// `git http-backend` behind a tiny CGI bridge on 127.0.0.1, plus helpers that
// run the stock git client against it with a hermetic environment. Every
// request is recorded (method, path, headers, raw body, response), and a test
// can intercept a request to answer it itself (a synthesized report-status, a
// rewritten advertisement, a relayed response).
//
// Used by the interop tests (`*.git.test.ts`) and by `capture.ts`, which
// records the golden request bodies under `test/goldens/`.

const decoder = new TextDecoder();

/** True when a `git` binary with `http-backend` is on PATH. */
export const hasGit: boolean = (() => {
	try {
		const out = new Deno.Command("git", {
			args: ["--version"],
			stdout: "piped",
			stderr: "null",
		}).outputSync();
		return out.success;
	} catch {
		return false;
	}
})();

/** Fixed identity and dates, so object ids are reproducible. */
export const FIXED_DATE = "1790000000 +0000";

export type Sandbox = {
	readonly root: string;
	/** The environment every git command runs with (hermetic config). */
	readonly env: Readonly<Record<string, string>>;
	readonly cleanup: () => Promise<void>;
};

/** A temp directory with an empty global config and fixed identities. */
export const makeSandbox = async (): Promise<Sandbox> => {
	const root = await Deno.makeTempDir({ prefix: "gitproto-" });
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
			"",
		].join("\n"),
	);
	const env: Record<string, string> = {
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
	};
	return {
		root,
		env,
		cleanup: () => Deno.remove(root, { recursive: true }),
	};
};

export type GitResult = {
	readonly code: number;
	readonly stdout: Uint8Array;
	readonly stderr: string;
	readonly text: string;
};

/** Runs stock git; throws on a non-zero exit unless `allowFail`. */
export const git = async (
	sandbox: Sandbox,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly stdin?: Uint8Array;
		readonly env?: Readonly<Record<string, string>>;
		readonly allowFail?: boolean;
	} = {},
): Promise<GitResult> => {
	const child = new Deno.Command("git", {
		args: [...args],
		cwd: options.cwd ?? sandbox.root,
		env: { ...sandbox.env, ...options.env },
		clearEnv: true,
		stdin: options.stdin ? "piped" : "null",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (options.stdin) {
		const writer = child.stdin.getWriter();
		await writer.write(options.stdin);
		await writer.close();
	}
	const out = await child.output();
	const result = {
		code: out.code,
		stdout: out.stdout,
		stderr: decoder.decode(out.stderr),
		text: decoder.decode(out.stdout),
	};
	if (result.code !== 0 && !options.allowFail) {
		throw new Error(
			`git ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
		);
	}
	return result;
};

/** Creates `<root>/srv/<name>.git` (bare, receive-pack enabled). */
export const initBare = async (
	sandbox: Sandbox,
	name: string,
): Promise<string> => {
	const dir = `${sandbox.root}/srv/${name}.git`;
	await Deno.mkdir(`${sandbox.root}/srv`, { recursive: true });
	await git(sandbox, ["init", "-q", "--bare", "--initial-branch=main", dir]);
	await git(sandbox, ["config", "http.receivepack", "true"], { cwd: dir });
	return dir;
};

/** Creates a working repository with `commits` linear commits on `main`. */
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

/** Writes one file and commits it. Returns the new commit id. */
export const commitFile = async (
	sandbox: Sandbox,
	dir: string,
	path: string,
	content: string,
	message = `add ${path}`,
): Promise<string> => {
	const full = `${dir}/${path}`;
	const slash = full.lastIndexOf("/");
	await Deno.mkdir(full.slice(0, slash), { recursive: true });
	await Deno.writeTextFile(full, content);
	await git(sandbox, ["add", "--", path], { cwd: dir });
	await git(sandbox, ["commit", "-q", "-m", message], { cwd: dir });
	return await revParse(sandbox, dir, "HEAD");
};

export const revParse = async (
	sandbox: Sandbox,
	dir: string,
	rev: string,
): Promise<string> =>
	(await git(sandbox, ["rev-parse", rev], { cwd: dir })).text.trim();

export type Recorded = {
	readonly method: string;
	readonly path: string;
	readonly query: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
	status: number;
	response: Uint8Array;
	intercepted: boolean;
};

export type InterceptRequest = {
	readonly method: string;
	/** `info/refs`, `git-upload-pack` or `git-receive-pack`. */
	readonly op: string;
	readonly repo: string;
	readonly query: string;
	readonly headers: Headers;
	readonly body: Uint8Array;
	/**
	 * Runs the request through `git http-backend` and returns its response;
	 * `override` replaces the body or headers (what a gateway forwards).
	 */
	readonly backend: (
		override?: { readonly body?: Uint8Array; readonly headers?: Headers },
	) => Promise<Response>;
};

export type GitServer = {
	/** `http://127.0.0.1:<port>` */
	readonly url: string;
	readonly requests: Recorded[];
	/** Replaces the interceptor (undefined: everything goes to http-backend). */
	setIntercept(
		fn:
			| ((req: InterceptRequest) => Promise<Response | undefined>)
			| undefined,
	): void;
	close(): Promise<void>;
};

const GIT_PATH =
	/^\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const runBackend = async (
	sandbox: Sandbox,
	method: string,
	path: string,
	query: string,
	headers: Headers,
	body: Uint8Array,
): Promise<Response> => {
	const env: Record<string, string> = {
		PATH: sandbox.env.PATH,
		HOME: sandbox.root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: sandbox.env.GIT_CONFIG_GLOBAL,
		GIT_PROJECT_ROOT: `${sandbox.root}/srv`,
		GIT_HTTP_EXPORT_ALL: "1",
		PATH_INFO: path,
		QUERY_STRING: query.replace(/^\?/, ""),
		REQUEST_METHOD: method,
		CONTENT_TYPE: headers.get("content-type") ?? "",
		REMOTE_USER: "tartan",
		REMOTE_ADDR: "127.0.0.1",
	};
	if (method === "POST") env.CONTENT_LENGTH = String(body.length);
	const protocol = headers.get("git-protocol");
	if (protocol) env.GIT_PROTOCOL = protocol;
	const encoding = headers.get("content-encoding");
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
	const responseHeaders = new Headers();
	for (const line of decoder.decode(raw.subarray(0, split)).split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key.toLowerCase() === "status") status = parseInt(value, 10);
		else responseHeaders.set(key, value);
	}
	return new Response(raw.slice(split + 4), {
		status,
		headers: responseHeaders,
	});
};

/** Serves `<root>/srv/*.git` on 127.0.0.1 with `git http-backend`. */
export const startServer = (sandbox: Sandbox): GitServer => {
	const requests: Recorded[] = [];
	let intercept:
		| ((req: InterceptRequest) => Promise<Response | undefined>)
		| undefined;
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		async (request) => {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const record: Recorded = {
				method: request.method,
				path: url.pathname,
				query: url.search,
				headers,
				body,
				status: 0,
				response: new Uint8Array(0),
				intercepted: false,
			};
			requests.push(record);
			const match = GIT_PATH.exec(url.pathname);
			if (!match) return new Response("not found", { status: 404 });
			const backend = (
				override: { readonly body?: Uint8Array; readonly headers?: Headers } =
					{},
			) =>
				runBackend(
					sandbox,
					request.method,
					url.pathname,
					url.search,
					override.headers ?? request.headers,
					override.body ?? body,
				);
			let response = intercept
				? await intercept({
					method: request.method,
					op: match[2],
					repo: match[1],
					query: url.search,
					headers: request.headers,
					body,
					backend,
				})
				: undefined;
			if (response) record.intercepted = true;
			response ??= await backend();
			const bytes = new Uint8Array(await response.arrayBuffer());
			record.status = response.status;
			record.response = bytes;
			return new Response(bytes, {
				status: response.status,
				headers: response.headers,
			});
		},
	);
	const port = (server.addr as Deno.NetAddr).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		setIntercept(fn) {
			intercept = fn;
		},
		close: () => server.shutdown(),
	};
};

/** Runs `body` with a sandbox and a server, always cleaning up both. */
export const withGitServer = async <T>(
	body: (sandbox: Sandbox, server: GitServer) => Promise<T>,
): Promise<T> => {
	const sandbox = await makeSandbox();
	const server = startServer(sandbox);
	try {
		return await body(sandbox, server);
	} finally {
		await server.close();
		await sandbox.cleanup();
	}
};
