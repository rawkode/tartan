// Dynamic Worker sources for the runtime smoke (B1–B5, Tails), loaded with
// `env.LOADER` at the pinned compatibility date with `globalOutbound: null`
// unless a test says otherwise.

export const DYN_COMPAT = "2026-08-15";

export const code = (
	src: string,
	extra: Partial<WorkerLoaderWorkerCode> = {},
	modules: WorkerLoaderWorkerCode["modules"] = {},
): WorkerLoaderWorkerCode => ({
	compatibilityDate: DYN_COMPAT,
	mainModule: "main.js",
	modules: { "main.js": src, ...modules },
	globalOutbound: null,
	...extra,
});

/** B1: fetch + RPC, per-isolate identity, egress and sockets probes. */
export const B1_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
let iso; let calls = 0;
function ident() { if (!iso) iso = crypto.randomUUID(); calls++; return { dynIsolate: iso, dynCalls: calls }; }
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/egress") {
      const t = Date.now();
      try { const r = await fetch("https://example.com/"); return Response.json({ egressOk: true, status: r.status, ms: Date.now() - t }); }
      catch (e) { return Response.json({ egressOk: false, error: String(e && e.message || e), ms: Date.now() - t }); }
    }
    if (u.pathname === "/connect") {
      try { const s = connect("example.com:443"); await s.opened; return Response.json({ connectOk: true }); }
      catch (e) { return Response.json({ connectOk: false, error: String(e) }); }
    }
    return Response.json({ hello: "from dynamic fetch", tag: env.TAG, ...ident() });
  }
};
export class Api extends WorkerEntrypoint {
  ping(x) { return { pong: x, tag: this.env.TAG, ...ident() }; }
}
`;

/** B2: a Rust module passed as `{wasm: bytes}`; compile inside the dynamic Worker is refused. */
export const B2_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
import mod from "./smoke.wasm";
const inst = new WebAssembly.Instance(mod, {});
const ex = inst.exports;
function transform(obj) {
  const input = new TextEncoder().encode(JSON.stringify(obj));
  const p = ex.alloc(input.length);
  new Uint8Array(ex.memory.buffer, p, input.length).set(input);
  const packed = ex.transform(p, input.length);
  ex.dealloc(p, input.length);
  const outPtr = Number(packed >> 32n), outLen = Number(packed & 0xffffffffn);
  const out = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, outPtr, outLen).slice());
  ex.dealloc(outPtr, outLen);
  return JSON.parse(out);
}
async function compileInside(bytes) {
  const r = {};
  try { await WebAssembly.compile(bytes); r.compile = "ALLOWED"; } catch (e) { r.compile = "rejected: " + e; }
  try { new WebAssembly.Module(bytes); r.newModule = "ALLOWED"; } catch (e) { r.newModule = "rejected: " + e; }
  return r;
}
export default { async fetch() { return Response.json({ add: ex.add(40, 2) }); } };
export class Api extends WorkerEntrypoint {
  add(a, b) { return ex.add(a, b); }
  transform(obj) { return transform(obj); }
  compileInside(bytes) { return compileInside(bytes); }
}
`;

/** B3: what a dynamic Worker can learn about a capability stub. */
export const B3_SRC = `
export default {
  async fetch(req, env, ctx) {
    const out = {};
    try { out.whoami = await env.CAP.whoami(); } catch (e) { out.whoami = "ERR " + e; }
    out.typeofCap = typeof env.CAP;
    try { out.capKeys = Object.keys(env.CAP); } catch (e) { out.capKeys = "ERR " + e; }
    try { out.capJson = JSON.stringify(env.CAP); } catch (e) { out.capJson = "ERR " + e; }
    try { out.envJson = JSON.stringify(env); } catch (e) { out.envJson = "ERR " + e; }
    try { out.awaitProps = JSON.stringify(await env.CAP.props); } catch (e) { out.awaitProps = "ERR " + e; }
    try { out.awaitCtxProps = JSON.stringify(await env.CAP.ctx.props); } catch (e) { out.awaitCtxProps = "ERR " + e; }
    try { out.awaitEnv = JSON.stringify(await env.CAP.env); } catch (e) { out.awaitEnv = "ERR " + e; }
    return Response.json(out);
  }
};
`;

/** B3-arg: a capability minted per call and passed as an RPC argument to one shared id. */
export const B3ARG_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
let iso; let n = 0;
async function probe(cap) {
  const out = {};
  try { out.whoami = await cap.whoami(); } catch (e) { out.whoami = "ERR " + e; }
  try { out.capKeys = Object.keys(cap); } catch (e) { out.capKeys = "ERR " + e; }
  try { out.capJson = JSON.stringify(cap); } catch (e) { out.capJson = "ERR " + e; }
  try { out.awaitProps = JSON.stringify(await cap.props); } catch (e) { out.awaitProps = "ERR " + e; }
  return out;
}
export class Api extends WorkerEntrypoint {
  async use(cap, label) {
    if (!iso) iso = crypto.randomUUID(); n++;
    return { label, dynIsolate: iso, dynCalls: n, envKeys: Object.keys(this.env || {}), ...(await probe(cap)) };
  }
  async keep(cap) { globalThis.__kept = cap; return "kept"; }
  async useKept() { try { return await globalThis.__kept.whoami(); } catch (e) { return "ERR " + e; } }
}
export default { fetch() { return new Response("b3arg"); } };
`;

/** B4: a facet class with its own SQLite, a capability sink, spin and sleep. */
export const EXT_DO_SRC = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class ExtDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rows(id INTEGER PRIMARY KEY, v TEXT)"); }
  info() {
    const sql = this.ctx.storage.sql;
    return {
      rows: sql.exec("SELECT v FROM rows ORDER BY id").toArray().map(r => r.v),
      tables: sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray().map(r => r.name),
      ctxIdName: this.ctx.id && this.ctx.id.name || null,
      ctxIdStr: this.ctx.id ? String(this.ctx.id) : null,
      dbSize: sql.databaseSize,
      hasKv: !!this.ctx.storage.kv,
    };
  }
  add(v) { this.ctx.storage.sql.exec("INSERT INTO rows(v) VALUES (?)", v); return this.info(); }
  async useCap(cap) { try { return { whoami: await cap.whoami(), json: JSON.stringify(cap) }; } catch (e) { return "ERR " + e; } }
  spin(ms) { const t = Date.now(); let x = 0; while (Date.now() - t < ms) { for (let i = 0; i < 1e5; i++) x += i; } return { spun: Date.now() - t, x }; }
  async sleep(ms) { await new Promise(r => setTimeout(r, ms)); return { slept: ms }; }
}
export class Api extends WorkerEntrypoint {
  spinPerf(iters) { let x = 0; for (let i = 0; i < iters; i++) x = (x * 31 + i) % 1000003; return { x }; }
}
export default { fetch() { return new Response("ext"); } };
`;

/** B5: a slow fetch, to hold an invocation open. */
export const SLOW_SRC = `
export default { async fetch() { await new Promise(r => setTimeout(r, 400)); return new Response("ok"); } };
`;

/** Tails: logs and an exception from two ids, attributed by tail props. */
export const TAIL_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Api extends WorkerEntrypoint {
  hello(install, k) { console.log("hello from install=" + install + " call=" + k); return { install, k }; }
  boom(install) { console.error("about to throw " + install); throw new Error("boom " + install); }
}
export default { fetch() { return new Response("tail"); } };
`;
