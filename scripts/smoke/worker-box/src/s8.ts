// S8 shell scripts (land operations in a sandbox against Artifacts). Auth
// comes only from GIT_CONFIG_COUNT/KEY/VALUE (`http.<repo-url>.extraHeader`)
// in each exec's environment, never from argv or files. The second repo is
// a scratch repo created with `create()` for the push steps.

const PRELUDE = `set -u
export HOME=/tmp/s8home; mkdir -p $HOME
export GIT_AUTHOR_NAME="Tartan Smoke" GIT_AUTHOR_EMAIL=smoke@tartan.invalid GIT_COMMITTER_NAME="Tartan Smoke" GIT_COMMITTER_EMAIL=smoke@tartan.invalid
now() { date +%s%3N; }
step() { local l="$1"; shift; local t0=$(now); "$@"; local rc=$?; echo "STEP $l rc=$rc ms=$(( $(now) - t0 ))"; return $rc; }
echo "git: $(git --version)"
`;

export const S8_SEED = PRELUDE + `
rm -rf /tmp/s8; mkdir -p /tmp/s8; cd /tmp/s8
git init -q -b main seed; cd seed
printf 'a\\n' > a.txt; printf 'b\\n' > b.txt; git add .; git commit -qm "base"
echo "BASE=$(git rev-parse HEAD)"
step push-base git push --porcelain "$TRUNK_URL" HEAD:refs/heads/main 2>&1
step push-scratch-base git push --porcelain "$SCRATCH_URL" HEAD:refs/heads/main 2>&1
`;

export const S8_LANES = PRELUDE + `
cd /tmp/s8/seed
git checkout -q -b lane1 "$BASE"; printf 'a-lane\\n' > a.txt; git commit -qam "lane1: edit a"; echo "L1=$(git rev-parse HEAD)"
git checkout -q -b lane2 "$BASE"; printf 'b-lane\\n' > b.txt; git commit -qam "lane2: edit b"; echo "L2=$(git rev-parse HEAD)"
git checkout -q -b t1 "$BASE"; printf 'b-trunk\\n' > b.txt; git commit -qam "trunk: edit b"; echo "T1=$(git rev-parse HEAD)"
step ls-remote-scratch git ls-remote "$SCRATCH_URL" 2>&1
step push-scratch-branches git push --porcelain "$SCRATCH_URL" lane1:refs/heads/lane1 lane2:refs/heads/lane2 2>&1
step push-trunk-advance git push --porcelain "$TRUNK_URL" t1:refs/heads/main 2>&1
`;

export const S8_LAND = PRELUDE + `
rm -rf /tmp/s8/land; git init -q -b main /tmp/s8/land; cd /tmp/s8/land
echo "== fetch trunk + lanes by SHA (fresh repo)"
step fetch-trunk git fetch -q "$TRUNK_URL" refs/heads/main:refs/work/trunk 2>&1
step fetch-lane1-by-sha git fetch -q "$SCRATCH_URL" "$L1":refs/work/lane1 2>&1
step fetch-lane2-by-sha git fetch -q "$SCRATCH_URL" "$L2":refs/work/lane2 2>&1
TRUNK=$(git rev-parse refs/work/trunk); echo "trunk=$TRUNK expectT1=$T1"

echo "== merge-tree clean"
TREE=$(git merge-tree --write-tree refs/work/trunk refs/work/lane1); echo "merge-tree-clean rc=$? tree=$TREE"
git ls-tree $TREE
echo "== merge-tree conflict"
git merge-tree --write-tree --name-only refs/work/trunk refs/work/lane2; echo "merge-tree-conflict rc=$?"

echo "== commit-tree with trailers"
C1=$(git commit-tree "$TREE" -p "$TRUNK" -m "lane1: edit a" -m "Tartan-Change: chg_01SMOKE
Tartan-Lane: lane1
Tartan-Gate: pass")
echo "C1=$C1"
git log -1 --format=%B "$C1" | git interpret-trailers --parse

echo "== commit with change-id header"
TS=$(date +%s)
RAW=$(printf 'tree %s\\nparent %s\\nauthor Tartan Smoke <smoke@tartan.invalid> %s +0000\\ncommitter Tartan Smoke <smoke@tartan.invalid> %s +0000\\nchange-id zyxwvutsrqponmlkzyxwvutsrqponmlk\\n\\nchange-id header commit\\n' "$TREE" "$C1" "$TS" "$TS")
C2=$(printf '%s\\n' "$RAW" | git hash-object -t commit -w --stdin 2>&1); echo "hash-object rc=$?"
echo "C2=$C2"
git cat-file -p "$C2"
git fsck --no-dangling 2>&1 | head -5

echo "== push --force-with-lease to main (fresh lease = T1)"
step push-lease-ok git push --porcelain --force-with-lease=refs/heads/main:"$TRUNK" "$TRUNK_URL" "$C2":refs/heads/main 2>&1
echo "== push --force-with-lease with stale lease (expects T1, remote is now C2)"
STALE=$(git commit-tree "$TREE" -p "$TRUNK" -m "stale candidate")
step push-lease-stale git push --porcelain --force-with-lease=refs/heads/main:"$TRUNK" "$TRUNK_URL" "$STALE":refs/heads/main 2>&1

echo "== notes + hidden refs (multi-ref push)"
git notes --ref=tartan add -m '{"gate":"pass","run":"r_smoke","why":"land C2"}' "$C2"
git update-ref refs/tartan/x "$C1"
step push-notes-and-hidden git push --porcelain "$TRUNK_URL" refs/notes/tartan:refs/notes/tartan refs/tartan/x:refs/tartan/x 2>&1
echo "== atomic multi-ref push"
step push-atomic git push --porcelain --atomic "$TRUNK_URL" "$C1":refs/tartan/y "$C1":refs/tartan/z 2>&1
echo "== push to refs/heads/tartan/fallback (namespace fallback)"
step push-heads-tartan git push --porcelain "$TRUNK_URL" "$C1":refs/heads/tartan/fallback 2>&1

echo "== server-side CAS: raw receive-pack delete of refs/tartan/z with WRONG old sha, then with right old sha"
cat > /tmp/s8/cas.mjs <<'EOF'
const url = process.env.TRUNK_URL.replace(/\\/$/, "") + "/git-receive-pack";
const pkt = (s) => (s.length + 4).toString(16).padStart(4, "0") + s;
async function del(oldSha, label) {
  const zero = "0".repeat(40);
  const body = pkt(oldSha + " " + zero + " refs/tartan/z\\0 report-status delete-refs agent=tartan-smoke\\n") + "0000";
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result", authorization: process.env.TRUNK_AUTH }, body });
  const txt = Buffer.from(await r.arrayBuffer()).toString("latin1").replace(/[^\\x20-\\x7e\\n]/g, ".");
  console.log("CAS " + label + " http=" + r.status + " ms=" + (Date.now() - t0) + " body=" + JSON.stringify(txt));
}
await del(process.env.WRONG, "wrong-old");
await del(process.env.RIGHT, "right-old");
EOF
WRONG=$TRUNK RIGHT=$C1 node /tmp/s8/cas.mjs 2>&1

echo "== readback via fresh clone"
rm -rf /tmp/s8/rb
step clone-readback git clone -q "$TRUNK_URL" /tmp/s8/rb 2>&1
cd /tmp/s8/rb
step fetch-notes-hidden git fetch -q origin 'refs/notes/*:refs/notes/*' 'refs/tartan/*:refs/tartan/*' 2>&1
echo "-- ls-remote"; git ls-remote "$TRUNK_URL" 2>&1
echo "-- log --notes=tartan"; git log --notes=tartan -3 --format='%H %s%n  notes: %N' 2>&1
echo "-- cat-file C2 header"; git cat-file -p "$C2" 2>&1 | grep -E '^(tree|parent|change-id)' || echo "C2 missing"
echo "-- trailers of C1"; git log -1 --format=%B "$C1" 2>&1 | git interpret-trailers --parse
echo "-- main is"; git rev-parse origin/main
echo "C1=$C1"
echo "C2=$C2"
`;
