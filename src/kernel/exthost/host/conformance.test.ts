// The extension conformance suite (testing/conformance.ts) on the in-memory
// host, for the builtin runtime, for an isolated in-process runtime (the
// breaker path) and for the `js` runtime in an in-memory facet (the dynamic
// loader, the shipped facet core, the capability bridge).

import { CONFORMANCE } from "./testing/conformance.ts";
import { createTestHost } from "./testing/memory.ts";

const RUNTIMES = [
	{ label: "builtin", isolated: false, facet: false },
	{ label: "isolated", isolated: true, facet: false },
	{ label: "js facet", isolated: false, facet: true },
] as const;

for (const runtime of RUNTIMES) {
	for (const c of CONFORMANCE) {
		Deno.test(`conformance (${runtime.label}): ${c.name}`, async () => {
			const t = await createTestHost({
				...c.options,
				isolated: runtime.isolated,
				facet: runtime.facet,
			});
			try {
				await c.run(t);
			} finally {
				t.close();
			}
		});
	}
}
