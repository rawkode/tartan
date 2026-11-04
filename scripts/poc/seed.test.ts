import { deepStrictEqual, throws } from "node:assert/strict";
import { commitDates, parsePocArgs } from "./seed.ts";

Deno.test("parsePocArgs: boots on 8801 by default", () => {
	deepStrictEqual(parsePocArgs([]), {
		port: 8801,
		skipWebBuild: false,
		skipExtBuild: false,
	});
	deepStrictEqual(
		parsePocArgs(["--port", "8802", "--skip-web-build", "--skip-ext-build"]),
		{ port: 8802, skipWebBuild: true, skipExtBuild: true },
	);
});

Deno.test("parsePocArgs: --origin targets a running forge and needs --log", () => {
	deepStrictEqual(
		parsePocArgs(["--origin", "https://localhost:8803/", "--log", "dev.log"]),
		{
			port: 8803,
			target: { origin: "https://localhost:8803", log: "dev.log" },
			skipWebBuild: false,
			skipExtBuild: false,
		},
	);
	throws(() => parsePocArgs(["--origin", "https://localhost:8803"]));
	throws(() => parsePocArgs(["--log", "dev.log"]));
	throws(() => parsePocArgs(["--port", "x"]));
	throws(() => parsePocArgs(["--what"]));
});

Deno.test("commitDates: a day apart, ending now", () => {
	const dates = commitDates(3, 1_000_000_000_000);
	deepStrictEqual(dates.map((d) => d.getTime()), [
		1_000_000_000_000 - 2 * 86_400_000,
		1_000_000_000_000 - 86_400_000,
		1_000_000_000_000,
	]);
});
