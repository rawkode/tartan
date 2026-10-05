// @tartan/ext-api: what an extension imports besides `@tartan/contract`
//
// - `defineExtension` and the ExtCtx helpers (`isBackground`,
//   `requireInteractiveActor` for the K12 actor rule);
// - `ui` builders for `tartan-ui@1` and `result` helpers for `onAction`;
// - SQL helpers (`db`, `json`, `bool`, `inList`) and the statement guard the
//   host enforces on a builtin's `sql` handle (`checkSql`).
//
// Test helpers live in `@tartan/ext-api/testing.ts` (Deno only, never
// bundled: it imports `node:sqlite`).

export {
	actingPrincipals,
	defineExtension,
	EXTENSION_HOOKS,
	type ExtensionHook,
	isActorRequiredTool,
	isBackground,
	requireInteractiveActor,
} from "./define.ts";
export { action, result, ui } from "./ui.ts";
export { bool, type Db, db, inList, json } from "./sql.ts";
export {
	ALLOWED_FIRST_KEYWORDS,
	checkSql,
	RESERVED_SQL_NAME_RE,
	type SqlCheck,
} from "./sqlguard.ts";
