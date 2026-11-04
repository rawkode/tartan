// `deno task dev:bootstrap`: takes a fresh `deno task dev` forge through setup
// and the dev sign-in, then mints a token. The launcher keeps state in memory,
// so this is what a restart needs.
//
// It prints one JSON object on stdout: `{ origin, cookie, token, handle }`.
// The cookie and the token are only good for this forge, and die with it.
//
// Usage: deno task dev:bootstrap --origin https://localhost:8801 --log dev.log
// `--log` is a file holding the launcher's output, where the setup code is
// printed. A forge that is already set up is not supported: restart it.

export const DEV_IDP_ISSUER = "https://idp.tartan-dev.test";
const TOKEN_SCOPES = [
	"repo:read",
	"repo:write",
	"lanes",
	"mcp",
	"api",
	"admin",
];
const SETUP_CODE_MARKER = "setup code: ";

/** The last setup code in the launcher's output, or null. */
export const setupCodeIn = (log: string): string | null => {
	const at = log.lastIndexOf(SETUP_CODE_MARKER);
	if (at < 0) return null;
	const code = log.slice(at + SETUP_CODE_MARKER.length).split(/\s/, 1)[0];
	return code === "" ? null : code;
};

/** `name=value` of each `set-cookie`, added to `jar` (a name set again wins). */
export const storeCookies = (
	jar: Map<string, string>,
	setCookies: readonly string[],
): void => {
	for (const line of setCookies) {
		const pair = line.split(";", 1)[0];
		const eq = pair.indexOf("=");
		if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
};

export type BootstrapArgs = {
	readonly origin: string;
	readonly log: string;
};

export const parseBootstrapArgs = (argv: readonly string[]): BootstrapArgs => {
	const value = (flag: string): string => {
		const at = argv.indexOf(flag);
		const found = at < 0 ? undefined : argv[at + 1];
		if (found === undefined) throw new Error(`${flag} is required`);
		return found;
	};
	return { origin: new URL(value("--origin")).origin, log: value("--log") };
};

const waitForSetupCode = async (log: string): Promise<string> => {
	for (let attempt = 0; attempt < 50; attempt++) {
		const text = await Deno.readTextFile(log).catch(() => "");
		const code = setupCodeIn(text);
		if (code !== null) return code;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`no setup code in ${log}`);
};

export const bootstrap = async ({ origin, log }: BootstrapArgs) => {
	const jar = new Map<string, string>();
	const request = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set("origin", origin);
		headers.set(
			"cookie",
			[...jar].map(([name, value]) => `${name}=${value}`).join("; "),
		);
		const response = await fetch(new URL(path, origin), {
			...init,
			headers,
			redirect: "manual",
		});
		storeCookies(jar, response.headers.getSetCookie());
		return response;
	};
	const post = async (path: string, body?: unknown) => {
		const response = await request(path, {
			method: "POST",
			...(body === undefined ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`POST ${path}: ${response.status} ${text}`);
		}
		return JSON.parse(text);
	};

	await post("/-/setup/code");
	await post("/-/setup/unlock", { token: await waitForSetupCode(log) });
	await post("/-/setup/name", {
		forgeName: "Tartan dev",
		canonicalOrigin: origin,
	});
	await post("/-/setup/idp/register", { issuer: DEV_IDP_ISSUER });

	// The front door answers the IdP redirect with the callback, so this stays
	// on the forge's origin until the callback's redirect to `return_to`.
	let path = "/-/auth/login?return_to=/";
	for (let hop = 0; hop < 5; hop++) {
		const response = await request(path);
		await response.body?.cancel();
		const location = response.headers.get("location");
		if (location === null || new URL(location, origin).pathname === "/") break;
		const next = new URL(location, origin);
		if (next.origin !== origin) {
			throw new Error(`sign-in left the forge: ${next.origin}`);
		}
		path = next.pathname + next.search;
	}

	const me = await (await request("/-/api/me")).json() as {
		readonly principal: { readonly handle: string } | null;
	};
	const handle = me.principal?.handle;
	if (handle === undefined) {
		throw new Error(`sign-in failed: ${JSON.stringify(me)}`);
	}
	const { token } = await post("/-/api/tokens", {
		name: "dev-bootstrap",
		scopes: TOKEN_SCOPES,
		expiresInDays: 1,
	});
	return {
		origin,
		cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
		token,
		handle,
	};
};

if (import.meta.main) {
	console.log(
		JSON.stringify(await bootstrap(parseBootstrapArgs(Deno.args)), null, "\t"),
	);
}
