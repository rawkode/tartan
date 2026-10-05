// Extension view, slot, package and installation HTTP API (WP7a). Each exported
// handler binds the Worker's facades (`depsFromEnv`) and delegates to a module
// that takes them as explicit dependencies, so the unit tests run every handler
// against fakes.
//
// - `view.ts`: `GET /-/api/view`;
// - `slots.ts`: `GET /-/api/slot/<inst>/<slot>` (read-only render) and
//   `POST …/action`, with `ctx` re-derived and confined server-side
//   (`context.ts`, K12);
// - `packages.ts`, `installations.ts`: publish, list, install, mode,
//   uninstall, the install sheet and an installation's console and
//   dead letters.

import type { RouteHandler } from "../../../router.ts";
import { depsFromEnv } from "./deps.ts";
import { handleInstallationsRequest } from "./installations.ts";
import { handlePackagesRequest } from "./packages.ts";
import { renderSlot, slotAction } from "./slots.ts";
import { handleViewRequest } from "./view.ts";

/** `GET /-/api/view?path=…&view=…`: static contributions and slot instances. */
export const handleView: RouteHandler = ({ env, req, auth }) =>
	handleViewRequest(depsFromEnv(env), req, auth);

/** `GET /-/api/slot/<installationId>/<slotId>?ctx=…`: read-only render. */
export const handleSlotRender: RouteHandler = ({ env, req, params, auth }) =>
	renderSlot(
		depsFromEnv(env),
		req,
		{ installationId: params.installation ?? "", slotId: params.slot ?? "" },
		auth,
	);

/** `POST /-/api/slot/<installationId>/<slotId>/action`. */
export const handleSlotAction: RouteHandler = ({ env, req, params, auth }) =>
	slotAction(
		depsFromEnv(env),
		req,
		{ installationId: params.installation ?? "", slotId: params.slot ?? "" },
		auth,
	);

/** `/-/api/packages[/*]`: publish and list packages. */
export const handlePackages: RouteHandler = ({ env, req, params, auth }) =>
	handlePackagesRequest(depsFromEnv(env), req, params.rest, auth);

/**
 * `/-/api/installations[/*]`: install, mode, uninstall (its ExtensionDO
 * cleanup runs after the response), sheet, console and dead letters
 * (promote, compare, replay: M2).
 */
export const handleInstallations: RouteHandler = (
	{ env, ctx, req, params, auth },
) =>
	handleInstallationsRequest(
		depsFromEnv(env),
		req,
		params.rest,
		auth,
		(work) => ctx.waitUntil(work),
	);
