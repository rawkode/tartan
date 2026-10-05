// tartan.radar: conflicts@1 provider: Conflict Radar (owned by WP13).
//
// M1, path level: lane touches are each lane's range `rangeBase..head` (K17,
// from `push.diffed`), joined on path and project against every other
// active lane, plus declared footprints at claim and trunk drift after
// landings. Notices go to both owners with a suggestion (proceed,
// coordinate, stack, rebase, yield); stats count predicted, avoided and
// materialized conflicts. Tools: conflicts_check/list/ack. Context:
// neighbourhood. Slots: lane badge, file banner, change sidebar, repo tab
// and a HUD metric.
//
// M2 (not here): hunk and diff3 classification (`adjacent`, `textual`),
// echo lines on `git push`, the lanes × lanes matrix.

import type { ExtensionModule } from "@tartan/contract";
import { neighbourhood } from "./context.ts";
import { onAction, render } from "./render.ts";
import { handleEvent, handleTimer, seedLanes } from "./sync.ts";
import { callTool } from "./tools.ts";

export { migrations } from "./migrations.ts";
export { protocol } from "./protocol.ts";

export const extension: ExtensionModule = {
	init: (x) => seedLanes(x),
	onEvent: (ev, x) => handleEvent(ev, x),
	onTimer: (key, x) => handleTimer(key, x),
	render: (slot, ctx, _props, x) => render(slot, ctx, x),
	onAction: (name, payload, ctx, x) => onAction(name, payload, ctx, x),
	callTool: (name, args, ctx, x) => callTool(name, args, ctx, x),
	context: (req, x) => neighbourhood(req, x),
};

export default extension;
