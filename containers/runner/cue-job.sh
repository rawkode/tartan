#!/bin/bash
# Tartan repository-config evaluator job (docs/design/ADR-repo-config-cue.md,
# "The evaluator job"). TartanSandbox (`cue:trunk`,
# `cue:preview:<k>`) runs it as `tartan-git`, one job at a time:
#
#   cue-job.sh <bundle.json>
#
# The bundle is `{"v":1,"files":{"<module path>":"<base64>"}}`: the forge's
# schema package (`cue.mod/pkg/tartan.dev/ext/**`), its binding file
# `~tartan.cue` and the repository's validated root `<name>.cue` files, of
# any CUE package. The job
#   1. wipes stale job directories of earlier runs;
#   2. unpacks the bundle into a fresh private `mktemp -d`, re-checking every
#      name and the size before anything is written, and writes
#      `cue.mod/module.cue` with a module path fresh for this job
#      (`tartan.local/j<128 random bits>@v0`), so no repository file can
#      import the job's own directory;
#   3. runs `cue export -E --out json .:tartan` in that module root (the CLI's
#      loader selects package `tartan`) under
#        timeout --foreground -s KILL <t>   (wall clock)
#        ulimit -v <kib>                    (RLIMIT_AS)
#        ulimit -f <kib>                    (the -o file AND the stderr file)
#        ulimit -c 0, ulimit -u <n>         (no core files; a process cap)
#        oom_score_adj 1000                 (the instance OOM killer takes cue first)
#        env -i ... CUE_REGISTRY=none       (empty environment, no module fetches)
#      with cue's stdout discarded, so only this script writes the result line;
#   4. prints ONE JSON line on stdout, with the job directory and the module
#      path replaced in the error text (`<module>`):
#        {"job":2,"cue":"v0.17.1","rc":<n>,"ms":<n>,"out":"<json>","outBytes":<n>,
#         "err":"<first stderr bytes>","errBytes":<n>}
#   5. removes the job directory (trap).
#
# Exit codes in `rc` (and the script's own status): cue's (0 ok, 1 CUE
# errors), 2 Go runtime fatal (out of memory under RLIMIT_AS), 70 setup,
# 71 bundle rejected, 124 wall clock (normalized: coreutils reports a KILL
# timeout as 124 or 137 by version), 137 any other SIGKILL (the instance OOM
# killer), 153 the file cap: SIGXFSZ, or an export that reached the cap
# (normalized: cue's Go runtime ignores SIGXFSZ, so its write of the output
# file fails with EFBIG and cue exits 1). An
# error stream that reaches the cap is cut there and cue's own status stays.
# No token or secret ever reaches the container: files in, JSON out.
#
# Inputs (environment, set by the kernel's exec): CUE_JOB_TIMEOUT_S,
# CUE_JOB_VM_KIB, CUE_JOB_FSIZE_KIB, CUE_JOB_OUT_BYTES, CUE_JOB_ERR_BYTES,
# CUE_JOB_NPROC (the process cap of `tartan-git`, default 256: cue's Go
# runtime threads count against it).
# CUE_BIN, NODE_BIN and CUE_JOB_ROOT exist for the container tests.

set -u

readonly JOB_VERSION=4
# The forge module's CUE language version: the pinned release's major.minor
# (CUE_LANGUAGE_VERSION in packages/contract); bumped with CUE_VERSION.
readonly CUE_LANGUAGE=v0.17.0
bundle=${1:-}
t=${CUE_JOB_TIMEOUT_S:-10}
vm=${CUE_JOB_VM_KIB:-2097152}
fs=${CUE_JOB_FSIZE_KIB:-4096}
outmax=${CUE_JOB_OUT_BYTES:-262144}
errmax=${CUE_JOB_ERR_BYTES:-65536}
nproc=${CUE_JOB_NPROC:-256}
cue_bin=${CUE_BIN:-/usr/local/bin/cue}
node_bin=${NODE_BIN:-node}
root=${CUE_JOB_ROOT:-/tmp/tartan-cue-$(id -u)}
bundle_max=786432

ms() { local e=$EPOCHREALTIME; echo $(( ${e%.*} * 1000 + 10#${e#*.} / 1000 )); }

# The result line, written by node so every string is JSON-escaped. Reads at
# most outmax+1 bytes of the output and errmax bytes of stderr, and strips
# the module root, the job directory around it (the output file's path) and
# the per-job module path from stderr, so no host path or random path
# reaches issue text (cached messages stay stable).
read -r -d '' PACK <<'JS'
const fs = require("node:fs");
const [job, rc, ms, cue, outPath, errPath, strip, outmax, errmax] = process.argv.slice(1);
const head = (p, max) => {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return { text: buf.subarray(0, n).toString("utf8"), size: fs.fstatSync(fd).size };
    } finally { fs.closeSync(fd); }
  } catch { return { text: "", size: 0 }; }
};
const o = head(outPath, Number(outmax) + 1);
const e = head(errPath, Number(errmax));
const unhost = (t, d) => d.length > 1 ? t.split(d + "/").join("").split(d).join(".") : t;
const jobDir = strip.slice(0, strip.lastIndexOf("/"));
const err = (strip === "" ? e.text : unhost(unhost(e.text, strip), jobDir))
  .replace(/tartan\.local\/j[0-9a-f]{32}(?:@v0)?/g, "<module>");
process.stdout.write(JSON.stringify({
  job: Number(job), cue: cue === "" ? null : cue, rc: Number(rc), ms: Number(ms),
  out: o.size <= Number(outmax) ? o.text : "", outBytes: o.size,
  err, errBytes: e.size,
}) + "\n");
JS

# Unpacks the bundle; any rule failure exits 71 before anything is written.
# Then writes cue.mod/module.cue with a fresh module path.
read -r -d '' UNPACK <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [bundlePath, dest, max, language] = process.argv.slice(1);
const RE = /^(cue\.mod\/pkg\/tartan\.dev\/ext\/ext\.cue|cue\.mod\/pkg\/tartan\.dev\/ext\/x\/[a-z0-9_]{1,64}\/settings\.cue|~tartan\.cue|[A-Za-z0-9_.-]+\.cue)$/;
const fail = (m) => { process.stderr.write(m + "\n"); process.exit(71); };
let raw;
try {
  if (fs.statSync(bundlePath).size > Number(max)) fail("bundle too large");
  raw = fs.readFileSync(bundlePath, "utf8");
} catch (e) { fail("bundle unreadable"); }
let b;
try { b = JSON.parse(raw); } catch { fail("bundle is not JSON"); }
if (b === null || typeof b !== "object" || b.v !== 1 || b.files === null || typeof b.files !== "object") fail("bundle shape");
const entries = Object.entries(b.files);
if (!entries.some(([p]) => p === "~tartan.cue")) fail("bundle has no ~tartan.cue");
let total = 0;
const files = [];
for (const [p, b64] of entries) {
  if (!RE.test(p)) fail("bundle path refused: " + JSON.stringify(p).slice(0, 200));
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail("bundle content refused: " + p);
  const buf = Buffer.from(b64, "base64");
  total += buf.length;
  if (total > Number(max)) fail("bundle content too large");
  files.push([p, buf]);
}
for (const [p, buf] of files) {
  const full = path.join(dest, p);
  if (!full.startsWith(dest + "/")) fail("bundle path escapes: " + p);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  fs.writeFileSync(full, buf, { flag: "wx", mode: 0o600 });
}
const module = "tartan.local/j" + crypto.randomBytes(16).toString("hex") + "@v0";
fs.mkdirSync(path.join(dest, "cue.mod"), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(dest, "cue.mod", "module.cue"),
  "module: " + JSON.stringify(module) + "\nlanguage: version: " + JSON.stringify(language) + "\n",
  { flag: "wx", mode: 0o600 },
);
JS

umask 077
# No core dump of a crashed evaluator (it would hold another job's input).
ulimit -c 0
cuever=$("$cue_bin" version 2>/dev/null | sed -n '1s/^cue version //p')
result() { # rc ms out err strip
	"$node_bin" -e "$PACK" "$JOB_VERSION" "$1" "$2" "$cuever" "$3" "$4" "$5" "$outmax" "$errmax" ||
		printf '{"job":%d,"cue":null,"rc":70,"ms":0,"out":"","outBytes":0,"err":"result packing failed","errBytes":0}\n' "$JOB_VERSION"
}

if [ -z "$bundle" ] || ! mkdir -p "$root" || ! chmod 700 "$root"; then
	result 70 0 /dev/null /dev/null ""
	exit 70
fi
# Job directories of runs that were killed with the container.
find "$root" -mindepth 1 -maxdepth 1 -mmin +5 -exec rm -rf {} + 2>/dev/null
dir=$(mktemp -d "$root/job.XXXXXXXXXX") || { result 70 0 /dev/null /dev/null ""; exit 70; }
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/m" "$dir/home" "$dir/cache"

if ! "$node_bin" -e "$UNPACK" "$bundle" "$dir/m" "$bundle_max" "$CUE_LANGUAGE" 2> "$dir/err.txt"; then
	result 71 0 /dev/null "$dir/err.txt" "$dir/m"
	exit 71
fi

start=$(ms)
(
	cd "$dir/m" || exit 70
	ulimit -v "$vm" || exit 70
	ulimit -f "$fs" || exit 70
	ulimit -c 0 || exit 70
	ulimit -u "$nproc" || exit 70
	echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true
	exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$dir/home" \
		XDG_CACHE_HOME="$dir/cache" CUE_CACHE_DIR="$dir/cache" CUE_REGISTRY=none \
		timeout --foreground -s KILL "$t" \
		"$cue_bin" export -E --out json --force -o "$dir/out.json" .:tartan \
		> /dev/null 2> "$dir/err.txt"
)
rc=$?
elapsed=$(( $(ms) - start ))
if [ "$rc" -eq 137 ] && [ "$elapsed" -ge $(( t * 1000 )) ]; then rc=124; fi
# The output file at the cap after cue exited 1: its write hit RLIMIT_FSIZE.
if [ "$rc" -eq 1 ] && [ -f "$dir/out.json" ] &&
	[ "$(wc -c < "$dir/out.json")" -ge $(( fs * 1024 )) ]; then
	rc=153
fi

result "$rc" "$elapsed" "$dir/out.json" "$dir/err.txt" "$dir/m"
exit "$rc"
