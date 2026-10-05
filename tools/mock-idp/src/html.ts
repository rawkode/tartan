// Server-rendered pages of the e2e mock IdP: the sign-in form, an error page
// and the signed-out page. No script and no external resource. The form
// carries only the opaque `req` id of the stored authorization request, so
// nothing the browser posts back can change the client, redirect URI, PKCE
// challenge or nonce. Tests reach the form with `getByLabel("Username")`,
// `getByLabel("Password")` and `getByRole("button", "Sign in")`.

export const IDP_TITLE = "Tartan e2e IdP";
export const WRONG_PASSWORD = "Wrong username or password";

export const escapeHtml = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const page = (title: string, body: string): string =>
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

export const signInPage = (input: {
	readonly req: string;
	readonly username?: string;
	readonly error?: string;
}): string =>
	page(
		`Sign in · ${IDP_TITLE}`,
		`<h1>${IDP_TITLE}</h1>
<p>Synthetic test users only. This identity provider serves the dev-e2e forge.</p>
${
			input.error === undefined
				? ""
				: `<p role="alert">${escapeHtml(input.error)}</p>\n`
		}<form method="post" action="/authorize">
<input type="hidden" name="req" value="${escapeHtml(input.req)}">
<p><label for="u">Username</label>
<input id="u" name="username" autocomplete="username" spellcheck="false" value="${
			escapeHtml(input.username ?? "")
		}"></p>
<p><label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password"></p>
<p><button type="submit">Sign in</button></p>
</form>`,
	);

export const errorPage = (title: string, message: string): string =>
	page(
		`${title} · ${IDP_TITLE}`,
		`<h1>${escapeHtml(title)}</h1>
<p role="alert">${escapeHtml(message)}</p>`,
	);

export const signedOutPage = (): string =>
	page(
		`Signed out · ${IDP_TITLE}`,
		`<h1>Signed out</h1>
<p>This identity provider keeps no session. You can close this page.</p>`,
	);
