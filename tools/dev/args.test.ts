import assert from "node:assert/strict";
import { certDir, defaultTls, parseArgs, quickTunnelOrigin } from "./args.ts";

Deno.test("parseArgs: defaults", () => {
	assert.deepEqual(parseArgs([]), {
		port: 8787,
		buildWeb: true,
		tunnel: false,
	});
});

Deno.test("parseArgs: --tunnel, and not with a TLS pair", () => {
	assert.equal(parseArgs(["--tunnel"]).tunnel, true);
	assert.throws(
		() => parseArgs(["--tunnel", "--tls-cert", "c", "--tls-key", "k"]),
		/plain HTTP/,
	);
});

Deno.test("quickTunnelOrigin: the trycloudflare origin in cloudflared output", () => {
	assert.equal(
		quickTunnelOrigin(
			"2026-11-03T17:40:00Z INF |  https://red-fox-blue-sky.trycloudflare.com  |",
		),
		"https://red-fox-blue-sky.trycloudflare.com",
	);
	assert.equal(quickTunnelOrigin("INF Starting tunnel"), null);
});

Deno.test("parseArgs: port, skip-web-build and a TLS pair", () => {
	assert.deepEqual(
		parseArgs([
			"--port",
			"9000",
			"--skip-web-build",
			"--tls-cert",
			"c.pem",
			"--tls-key",
			"k.pem",
		]),
		{
			port: 9000,
			buildWeb: false,
			tunnel: false,
			tls: { cert: "c.pem", key: "k.pem" },
		},
	);
});

Deno.test("parseArgs: rejects a half pair, a bad port and unknown flags", () => {
	assert.throws(() => parseArgs(["--tls-cert", "c.pem"]), /together/);
	assert.throws(() => parseArgs(["--port", "x"]), /port/);
	assert.throws(() => parseArgs(["--http"]), /unknown/);
});

Deno.test("certDir: XDG_DATA_HOME, then HOME, then none", () => {
	const env = (vars: Record<string, string>) => (name: string) => vars[name];
	assert.deepEqual(
		certDir(env({ XDG_DATA_HOME: "/x", HOME: "/h" })),
		"/x/tartan-dev",
	);
	assert.deepEqual(certDir(env({ HOME: "/h" })), "/h/.local/share/tartan-dev");
	assert.deepEqual(certDir(env({})), null);
});

Deno.test("defaultTls: mkcert's file names", () => {
	assert.deepEqual(defaultTls("/d"), {
		cert: "/d/localhost.pem",
		key: "/d/localhost-key.pem",
	});
});
