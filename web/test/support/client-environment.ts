// A Node test environment that transforms modules like the browser build
// (Vite's `client` environment), so `.vue` files compile for the client
// renderer instead of SSR. No DOM globals are installed: tests mount with
// the in-memory renderer (`renderer.ts`) or render to strings.

import type { Environment } from "vitest/environments";

const environment: Environment = {
	name: "tartan-client",
	viteEnvironment: "client",
	setup: () => ({ teardown: () => {} }),
};

export default environment;
