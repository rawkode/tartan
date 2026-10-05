// The SPA shell's Content-Security-Policy and a check
// for markup that would violate it. Shared by `vite.config.ts` (build guard,
// preview headers) and the tests; no imports, so both can load it.

/** The SPA shell's CSP; the Worker sends the same header. */
export const SHELL_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
].join("; ");

/** Problems that would violate the shell CSP or the safe-rendering rules in an HTML document. */
export const cspProblems = (html: string): string[] => {
	const problems: string[] = [];
	for (
		const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)
	) {
		const attrs = match[1] ?? "";
		const body = match[2] ?? "";
		if (!/\bsrc\s*=/.test(attrs) || body.trim() !== "") {
			problems.push("inline <script>");
		}
	}
	if (/\son[a-z]+\s*=/i.test(html)) {
		problems.push("inline event handler attribute");
	}
	if (/\sstyle\s*=/i.test(html)) problems.push("style attribute");
	if (/javascript:/i.test(html)) problems.push("javascript: URL");
	return problems;
};
