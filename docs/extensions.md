# Writing an extension

Everything people think of as "the forge" is an extension on one public contract: work items (issues), changes (pull
requests), the Kanban board, conflict radar, CI, review, the Weave and FIFO, epics and the HUD. First-party extensions
use exactly the contract that third-party ones use. This page explains the model, walks through a small JavaScript
extension and introduces the Rust SDK. `packages/contract` is the source of truth for every name below;
`@tartan/ext-api` has the helpers. [`ext/README.md`](ext/README.md) covers the build, publish and test details, and
[`ext/rust.md`](ext/rust.md) the Rust SDK.

## The model

An extension is a **package** (a manifest, code, migrations) published to the forge's registry. It does nothing until
it is **installed** on a node: a user, a group or a repository. An installation applies to that node's subtree.

- **Nearest wins.** For each interface (`work@1`, `changes@1`, `conflicts@1`, `checks@1`, `review@1`, `queue@1`) the
  installation nearest to a repository provides it there. So `acme/platform/**` can run the Weave while `acme/docs`
  runs FIFO, and the protocol an agent sees depends on where it works. Context sections for agents
  (`contributes.context`) are different: every installation in force can add one.
- **Gates add up.** Every `ref.advance` gate on the path from the root to the repository runs on every Advance, and a
  gate cannot be removed below the node that installed it. Any enforcing veto blocks.
- **A pack** is a package whose members are other packages: installing it installs a whole protocol (`Swarm`,
  `Classic`).
- **Isolation.** Each installation scope has its own Durable Object (`ExtensionDO`) with its own SQLite database, so a
  slow or failing extension stalls only itself. It reaches the kernel only through capabilities (`KernelCaps`) that are
  checked on every call against its granted permissions, the acting principal and its node.
- **Repository config.** A repository can also install approved packages and set settings from its root CUE package
  `tartan`; see [repo-config.md](repo-config.md).

## Runtimes

| Runtime   | What it is                                                                                                  | Who can use it                   |
| --------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `builtin` | TypeScript in the Worker bundle, run in the installation's own Durable Object                               | bundled `tartan.*` packages only |
| `js`      | one bundled ES module whose default export implements the hooks, run as a Dynamic Worker (Worker Loader)    | any package                      |
| `wasm`    | a WebAssembly component on the `tartan:ext@0.1.0` WIT world (`packages/contract/wit/`), loaded the same way | any package                      |

Every first-party extension runs on `builtin`. The `js` and `wasm` runtimes are built and tested with unit and workerd
tests.

On `js` and `wasm`, each installation runs as a Dynamic Worker facet of its own Durable Object, one per installation and
package version, with no network access and an empty environment. It gets its capabilities per call, and they stop
working when the call returns. Every call has a wall-clock budget (render 1 s, events and actions 5 s, tools 10 s,
gates per manifest); a call that overruns or is killed counts as a strike. Three strikes in ten minutes
open the installation's circuit breaker: gates return their declared `default`, renders show an error chip, events
wait, and an Owner is notified. After 15 minutes one call is let through. An Owner can read and reset a breaker on the
installation's page (**Extensions → the installation**) or with `GET` and `POST`
`/-/api/installations/<id>/breaker?repo=<path>`. On every runtime, setting an installation's mode to `disabled` stops
it at once.

## The package

```text
extensions/do-not-merge/
  tartan.json               the manifest
  src/index.ts              the module (bundled to main.js for the js runtime)
  migrations/0001_init.sql  forward-only migrations of the extension's own tables
  protocol.md               optional: the protocol card agents get over MCP (at most 2 KB)
```

A package is at most 10 MiB. Versions are immutable once published.

## The manifest: `tartan.json`

| Field                            | Meaning                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `api`                  | `1` and `tartan:ext@0.1.0`                                                                                                                                  |
| `id`, `name`, `version`          | a dotted id (`tartan.*` is reserved for bundled packages), a display name, semver                                                                           |
| `kind`                           | `extension` (default) or `pack` (then `members` lists the packages and their config)                                                                        |
| `runtime`, `entry`               | `builtin`, `js` (`entry.js`) or `wasm` (`entry.js` glue plus `entry.wasm` modules)                                                                          |
| `storage`                        | `scope` (`node` or `repo`: one database per installation, or per installation and repository), `mode` (`sql` or `kv`), `migrations`, `quotaMB`              |
| `provides`, `requires`           | interfaces it implements or needs (`queue@1`, `review@1`, …)                                                                                                |
| `permissions`                    | what it may ask the kernel for: `repo: "read"`, `lanes`, `land` (queue providers only), `runs`, `notes`, `notify`, `events.read`, `interfaces.call`         |
| `subscribe`                      | the events it wants, by type or pattern (`ref.advanced`, `changes.*`), with an optional `filter`                                                            |
| `backfill`                       | `none`, `30d` or `all`: replay history when installed on an existing node                                                                                   |
| `gates`                          | `point` (`ref.advance`, `lane.open`; `push` is accepted but not called yet), `inputs`, `timeoutMs`, `default` (`allow` or `veto` on timeout), `onTruncated` |
| `echo`                           | at most one hook on `push.accepted` that returns lines for the pusher's `git push` output (the gateway does not deliver them yet)                           |
| `contributes.slots`              | UI contributions: `slot`, `id`, `label`, `title`, `icon`, `route`, `when`, `dynamic`, `refreshOn`, `role`, `cache`, `order`                                 |
| `contributes.tools`              | MCP tools: `name`, `description`, `input` (a JSON Schema), minimum `role`                                                                                   |
| `contributes.context`            | sections for `context_get` (`id`, `maxBytes`, `priority`)                                                                                                   |
| `contributes.protocol`           | the protocol card file                                                                                                                                      |
| `contributes.settings`, `config` | a settings form (JSON Schema), defaults, and the CUE schema repository config is checked against                                                            |
| `limits`, `onError`              | CPU budgets per hook (defence in depth) and whether a failing event handler skips or blocks the stream                                                      |

The installer sees every permission on the install sheet. A Maintainer can install at a node. An Owner is needed for a
provider of `checks@1`, `review@1` or `queue@1`, for `land` permissions, for a background role above Reporter, for a
locked installation and for an installation at a root node.

## Hooks

The module exports any of these hooks; all are optional. Each gets an `ExtCtx` (`x`) with `caps`, `sql`, `kv`,
`config`, `log`, `install` (the installation's id, node and mode), `actor` and `readOnly`.

| Hook                                | Called when                                             | Acts as               |
| ----------------------------------- | ------------------------------------------------------- | --------------------- |
| `init(x)`                           | the installation starts (after its migrations)          | the installation      |
| `onEvent(ev, x)`                    | a subscribed event arrives, in order per repository     | the installation      |
| `onTimer(key, x)`                   | a timer set with `x.caps.timers.set(key, atMs)` fires   | the installation      |
| `gate(point, input, x)`             | a gated operation needs a decision                      | the installation      |
| `echo(ev, inputs, x)`               | a push was accepted (not delivered yet, see `echo`)     | the installation      |
| `render(slot, ctx, props, x)`       | the web UI shows one of its slot contributions          | the viewer, read-only |
| `onAction(action, payload, ctx, x)` | a viewer presses a button or submits a form it rendered | the viewer            |
| `callTool(name, args, ctx, x)`      | an agent or person calls one of its MCP tools           | the caller            |
| `context(req, x)`                   | `context_get` assembles an agent's context              | the caller, read-only |

In `render` and `context`, `sql` runs only `SELECT` statements and every effect is denied, so a page view can never
change state.

**Events.** Delivery is ordered per repository, with dedupe, retries and dead letters per installation. Kernel events
cover nodes, extensions, repositories and their config, pushes, refs, lanes, lands, runs and gate decisions
(`push.accepted`, `lane.opened`, `land.completed`, `ref.advanced`, `gate.decided`, …). An installation may emit its
own events as `x.<extId>.<name>` and the events of the interfaces it provides (`changes.submitted`, `review.decided`,
`queue.ejected`, …) with `x.caps.events.emit`.

**Gates.** A gate answers `{decision: "allow" | "advise" | "veto", message, annotations?}`. Its inputs are prefetched
(`diff`, `added-lines`, `changed-paths`, `file:<path>`), so it needs no I/O; `input.truncated` says they overflowed the
limits (2,000 added lines or 256 KiB), and a `ref.advance` gate that did not see the whole change vetoes by default
unless it answers `fullScan: true`. Gate decisions are recorded in the why-note. A replayed input is marked `advisory`;
a gate must not record anything for it.

## Shadow mode, replay and promote

Install a gate in **shadow** mode first. It is called beside the enforced gates and its decision is recorded, but it
never blocks, and the installation cannot notify, open lanes, start runs or submit lands. Then:

1. **Replay** it over real history: `POST /-/api/installations/<id>/replay` with `{"repo": "<path>", "n": 41}` rebuilds
   the `ref.advance` input of each of the repository's last `n` (at most 50) Advances, calls the gate and answers, for
   example, `{"summary": {"vetoed": 2, "of": 41}}`: "would have vetoed 2 of the last 41".
2. **Promote** it: `POST /-/api/installations/<id>/promote` makes the shadow installation the enforced one and disables
   the previous enforced copy of the same extension at that node, in one step.

The **Policy compare** page (`/-/extensions/<installation>/compare`) does both from the UI, for an Owner.

## Slots

Slots are named places in the web UI. A contribution is static (a tab, a navigation entry, a header button) or
`dynamic` (rendered by the `render` hook). The kernel derives the render context on the server from the page, confines
it to the installation's subtree, and passes it as `ctx`; values from the browser are never trusted.

| Slot                                                          | Where                                              | Context                |
| ------------------------------------------------------------- | -------------------------------------------------- | ---------------------- |
| `nav.global`, `home.section`                                  | global navigation, the home page                   | viewer                 |
| `node.tab`, `node.section`                                    | a user or group page                               | node                   |
| `repo.tab`, `repo.sidebar`, `repo.header.action`              | a repository                                       | repo, ref              |
| `file.banner`                                                 | above a file                                       | repo, ref, path        |
| `lane.badge`, `lane.sidebar`                                  | a lane                                             | lane                   |
| `work.panel`, `work.sidebar`                                  | a work item                                        | work                   |
| `change.tab`, `change.panel`, `change.sidebar`, `change.gate` | a change, and its gate chips                       | change, revision, gate |
| `blame.annotation`                                            | why-blame for a line range                         | repo, ref, path, lines |
| `hud.metric`                                                  | the HUD                                            | forge                  |
| `settings.page`                                               | the installation's settings                        | installation           |
| `agent.context`                                               | markdown for agents, through `contributes.context` | work, lane             |

A `when` expression (`node.kind == 'repo'`, a viewer role) hides a static contribution where it does not apply, and
`role` sets the minimum role to see it.

## Server-driven UI: `tartan-ui@1`

Extensions never run in the browser. `render` returns a JSON document and the web UI draws it with its own components:

```json
{ "v": 1, "root": { "t": "stack", "children": [...] }, "refreshOn": ["ref.advanced"] }
```

Node types: `stack`, `row`, `grid`, `section`, `card`, `tabs`, `divider`, `heading`, `text`, `markdown`, `code`,
`badge`, `label`, `avatar`, `icon`, `link`, `empty`, `progress`, `kv`, `stat`, `alert`, `button`, `menu`, `form`,
`input`, `textarea`, `select`, `checkbox`, `table`, `list`, `timeline`, `diff`, `board`, `matrix`, `sparkline`.

The schema is closed: an unknown property (`style`, `onClick`, `innerHTML`) fails validation, links must be same-origin
paths or `https://` URLs, markdown is rendered without raw HTML, and a document has at most 500 nodes, 64 KB and a
depth of 16. The kernel validates every document again before it reaches the browser; a render that fails or times out
(1 second) shows an error chip instead.

A `button`, `menu`, `form`, `board` move or `matrix` cell carries an action `{id, payload?, confirm?}`. Pressing it
calls `onAction` with the viewer as the actor, and the hook answers `{v: 1, toast?, render?, navigate?, refresh?}`:
a message, a replacement document, a same-origin page to open, or slot ids to re-render. `@tartan/ext-api` has
builders for both (`ui.*`, `action(…)`, `result.*`).

## Capabilities

`x.caps` is the extension's only way to reach the kernel. Each namespace needs the matching permission:

| Namespace                       | Methods (examples)                                                                  | Permission                |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| `repo`                          | `info`, `readFile`, `readTree`, `log`, `diff`, `projectGraph`, `affected`, `policy` | `repo: "read"`            |
| `lanes`                         | `open`, `close`, `archive`, `sync`, `delegate`, `get`, `list`                       | `lanes: [...]`            |
| `land`                          | `submit`, `status`, `report`                                                        | `land` (queue providers)  |
| `runs`                          | `start`, `get`, `cancel`, `logs`                                                    | `runs: ["start", ...]`    |
| `notes`                         | `contribute` (a section of the why-note, at most 8 KB)                              | `notes: true`             |
| `events`                        | `emit`, `read`                                                                      | `events.read` for reading |
| `notify`                        | `send` (a notice to a principal with a role in the subtree)                         | `notify: true`            |
| `interfaces`                    | `call` (another provider's tool, such as `work_create`)                             | `interfaces.call`         |
| `authz`, `principals`, `timers` | `check`, `get`, `presence`, `set`, `clear`                                          | none                      |

Everything an installation names must resolve to its own node or a descendant. No extension ever receives an Artifacts
token, and none can move trunk except a `queue@1` provider through `land.submit`, which goes through the Advance.

## Example: a "do not merge" gate with a sidebar panel (JavaScript)

This extension vetoes an Advance that adds a line containing `DO NOT MERGE`, and shows how many Advances landed on the
repository in the last 24 hours. It uses an event subscription, a gate, a dynamic slot and its own table.

`tartan.json`:

```json
{
	"schema": 1,
	"id": "acme.do-not-merge",
	"name": "Do Not Merge",
	"description": "Vetoes an Advance that adds a DO NOT MERGE marker; counts recent Advances",
	"version": "0.1.0",
	"api": "tartan:ext@0.1.0",
	"runtime": "js",
	"entry": { "js": "main.js" },
	"storage": { "scope": "repo", "migrations": ["migrations/0001_init.sql"] },
	"permissions": {},
	"subscribe": [{ "event": "ref.advanced" }],
	"gates": [
		{ "point": "ref.advance", "inputs": ["added-lines"], "default": "veto" }
	],
	"contributes": {
		"slots": [
			{
				"slot": "repo.sidebar",
				"id": "landed",
				"title": "Landed",
				"dynamic": true,
				"refreshOn": ["ref.advanced"]
			}
		]
	}
}
```

`migrations/0001_init.sql`:

```sql
CREATE TABLE advances (id TEXT PRIMARY KEY, ref TEXT NOT NULL, at INTEGER NOT NULL);
```

`src/index.ts`:

```ts
import type {
	Envelope,
	ExtCtx,
	GateInput,
	GatePoint,
	SlotContext,
} from "@tartan/contract";
import { defineExtension, ui } from "@tartan/ext-api";

const MARKER = "DO NOT MERGE";
const DAY_MS = 24 * 60 * 60 * 1000;

type Advanced = { readonly ref: string; readonly advanceId: string };

export default defineExtension({
	// Background hook: record every Advance of this repository.
	onEvent: (ev: Envelope, x: ExtCtx) => {
		if (ev.type === "ref.advanced") {
			const data = ev.data as Advanced;
			x.sql.exec(
				"INSERT OR IGNORE INTO advances (id, ref, at) VALUES (?, ?, ?)",
				data.advanceId,
				data.ref,
				ev.at,
			);
		}
		return Promise.resolve();
	},

	// Gate: inputs are prefetched, so no I/O is needed. It records nothing,
	// so replays (`advisory` inputs) are safe.
	gate: (_point: GatePoint, input: GateInput, _x: ExtCtx) => {
		if (input.point !== "ref.advance") {
			return Promise.resolve({ decision: "allow", message: "not gated" });
		}
		const hits = input.addedLines.filter((l) => l.text.includes(MARKER));
		if (hits.length === 0) {
			return Promise.resolve({ decision: "allow", message: "no marker" });
		}
		return Promise.resolve({
			decision: "veto",
			message: `${hits.length} added line(s) say ${MARKER}`,
			annotations: hits.slice(0, 20).map((l) => ({
				path: l.path,
				line: l.line,
				text: `remove the ${MARKER} marker`,
			})),
		});
	},

	// Read-only render of the `landed` contribution (repo.sidebar).
	render: (_slot: string, _ctx: SlotContext, _props: unknown, x: ExtCtx) => {
		const since = Date.now() - DAY_MS;
		const { n } = x.sql.exec<{ n: number }>(
			"SELECT count(*) AS n FROM advances WHERE at >= ?",
			since,
		).one();
		return Promise.resolve(
			ui.doc(
				ui.section("Landed", [
					ui.stat("Advances in the last 24 hours", n),
					ui.text(`Advances that add "${MARKER}" are vetoed.`, {
						tone: "muted",
					}),
				]),
				{ refreshOn: ["ref.advanced"] },
			),
		);
	},
});
```

Build and publish it (a forge admin; a personal access token needs the `api` and `admin` scopes):

```sh
deno task build:ext do-not-merge          # → extensions/do-not-merge/dist/ (never committed)
curl -X PUT https://git.example.com/-/api/packages \
  -H "Authorization: Bearer $TARTAN_PAT" -H "content-type: application/json" \
  --data-binary @extensions/do-not-merge/dist/publish.json
```

`build:ext` bundles `src/index.ts` into `main.js` with esbuild and writes `publish.json`, the `PUT /-/api/packages`
body, already checked by the kernel's own validation. Then install it in shadow mode, check its recorded decisions
(`gate.decided` events, the gate section of each why-note, or a replay), and promote it. Installing needs Maintainer at
the node, and a personal access token with the `api` and `admin` scopes; agent tokens cannot install, uninstall or
change the mode of an extension.

```sh
curl -X POST https://git.example.com/-/api/installations \
  -H "Authorization: Bearer $TARTAN_PAT" -H "content-type: application/json" \
  -d '{"extId": "acme.do-not-merge", "version": "0.1.0", "node": "acme/platform", "mode": "shadow"}'
```

**Extensions** in the web UI shows each installation's mode, details, approved permissions, settings and breaker, and
changes its mode (`enforce`, `shadow` or `disabled`).

## Rust and WebAssembly: `tartan-ext` and `acme.no-secrets`

`sdk/rust/tartan-ext` is the Rust SDK for the `tartan:ext@0.1.0` world: it supplies a default for every export, UI
builders, an SQL helper and gate decisions. Today it is a path dependency in this repository, not a published crate.
[`ext/rust.md`](ext/rust.md) has a minimal extension and the module reference.

`extensions/acme-no-secrets` is the worked example: a third-party Rust → WASM gate that vetoes an Advance adding AWS
keys, PEM private keys or a `.env` file, shows masked findings in the change sidebar and a gate chip, has a **Secrets**
repository tab and an MCP tool (`no_secrets_scan`), and keeps its own tables. It is not installed by default:

```sh
cargo test --manifest-path extensions/acme-no-secrets/Cargo.toml
deno task build:ext acme-no-secrets       # or: deno task deploy -- --stage <stage> --build-ext
```

The build needs `cargo` with the `wasm32-unknown-unknown` target, `wasm-tools` and jco. An admin then publishes
`dist/publish.json`, installs it in shadow mode on a group or repository, replays it over that repository's history on
the Policy compare page, and promotes it. Its component runs through the real host in the Deno and workerd tests
described in [`ext/README.md`](ext/README.md#testing).

## First-party extensions

| Extension                                  | Provides                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `tartan.work`                              | `work@1`: work items (issues and intents) with claims and footprints                                |
| `tartan.changes`                           | `changes@1`: changes (the pull-request equivalent) and their revisions                              |
| `tartan.board`                             | the Kanban board, rebuilt from history when installed on an existing node                           |
| `tartan.radar`                             | `conflicts@1`: conflict prediction between lanes and trunk                                          |
| `tartan.ci`                                | `checks@1`: affected-only CI in Workflows and Sandbox containers                                    |
| `tartan.review`                            | `review@1`: review by exception (or a person for every change), and the gate that enforces it       |
| `tartan.weave`, `tartan.fifo`              | `queue@1`: the Weave (batches composed with `git merge-tree`) or first in, first out                |
| `tartan.epics`                             | epics that roll up work items across repositories                                                   |
| `tartan.hud`                               | the HUD: active lanes, predicted and avoided conflicts, landings per hour, changes needing a person |
| `tartan.pack.swarm`, `tartan.pack.classic` | the Swarm and Classic packs                                                                         |
