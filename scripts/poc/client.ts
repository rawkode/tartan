// What the seed and the proof share: a client for one local forge's session,
// and git against it.

export type Session = {
	readonly origin: string;
	readonly cookie: string;
	readonly token: string;
	readonly handle: string;
};

/** A tool route's reply, in either refusal shape the UI has to handle. */
export type ToolReply = {
	readonly status: number;
	readonly result?: unknown;
	/** `{error: {code}}` from the handler, `{error: "<code>"}` from the router. */
	readonly code?: string;
};

export const ISSUES_ID = "rawkode.issues";

export const createClient = (session: Session) => {
	const request = (method: string, path: string, body?: unknown) =>
		fetch(new URL(path, session.origin), {
			method,
			headers: {
				cookie: session.cookie,
				origin: session.origin,
				"sec-fetch-site": "same-origin",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	/** A call that has to work: its JSON, or an error naming the reply. */
	const must = async <T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> => {
		const response = await request(method, path, body);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`${method} ${path}: ${response.status} ${text.slice(0, 500)}`,
			);
		}
		return JSON.parse(text) as T;
	};

	const tool = async (
		repoId: string,
		name: string,
		args: Record<string, unknown>,
		project?: string,
		extension: string = ISSUES_ID,
	): Promise<ToolReply> => {
		const response = await request(
			"POST",
			`/-/api/repos/${repoId}/ext/${extension}/tools/${name}`,
			{ args, ...(project === undefined ? {} : { project }) },
		);
		const body = await response.json() as {
			readonly result?: unknown;
			readonly error?: string | { readonly code: string };
		};
		if (body.error === undefined) {
			return { status: response.status, result: body.result };
		}
		return {
			status: response.status,
			code: typeof body.error === "string" ? body.error : body.error.code,
		};
	};

	return { request, must, tool };
};

export type GitWork = {
	/** Runs git in the work tree; throws with its stderr, never the token. */
	readonly run: (args: readonly string[], date?: Date) => Promise<string>;
};

/**
 * git against the forge in `dir`, as the Owner: the token goes in a header, so
 * it lands in no remote URL or config file, and no global git setting applies.
 */
export const gitFor = (session: Session, dir: string): GitWork => ({
	run: async (args, date) => {
		const at = date?.toISOString();
		const { code, stdout, stderr } = await new Deno.Command("git", {
			args: [
				"-c",
				"credential.helper=",
				"-c",
				`http.extraHeader=Authorization: Bearer ${session.token}`,
				...args,
			],
			cwd: dir,
			env: {
				GIT_SSL_NO_VERIFY: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_AUTHOR_NAME: session.handle,
				GIT_AUTHOR_EMAIL: `${session.handle}@tartan-dev.test`,
				GIT_COMMITTER_NAME: session.handle,
				GIT_COMMITTER_EMAIL: `${session.handle}@tartan-dev.test`,
				...(at === undefined
					? {}
					: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
			},
			stdout: "piped",
			stderr: "piped",
		}).output();
		if (code !== 0) {
			throw new Error(
				`git ${args[0]} failed (exit ${code}): ${
					new TextDecoder().decode(stderr).trim()
				}`,
			);
		}
		return new TextDecoder().decode(stdout).trim();
	},
});
