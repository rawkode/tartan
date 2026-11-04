#!/usr/bin/env bash
# Points every workerd binary under node_modules at the Nix store's dynamic
# linker and libraries. workerd ships as a generic Linux binary, which NixOS
# refuses to start ("Could not start dynamically linked executable"), and an
# npm install puts the stock binary back, so this runs on every entry to the
# dev shell (flake.nix) and through `deno task patch:workerd`.
#
# Safe to repeat: a binary that is already patched is left alone, as is a
# checkout with no node_modules.
#
# Usage: scripts/patch-workerd.sh [checkout]   (default: the current directory)
set -euo pipefail

root="${1:-$PWD}"
modules="$root/node_modules"

if [ -z "${TARTAN_ELF_INTERPRETER:-}" ] || [ -z "${TARTAN_ELF_RPATH:-}" ]; then
	echo "patch-workerd: run this in the dev shell: nix develop -c deno task patch:workerd" >&2
	exit 1
fi

[ -e "$modules" ] || exit 0

# A symlinked node_modules belongs to another checkout, whose running forge
# would be rewritten underneath it.
if [ -L "$modules" ]; then
	echo "patch-workerd: skipped: $modules is a symlink, patch the checkout it points at" >&2
	exit 0
fi

patched=0
while IFS= read -r -d '' binary; do
	# npm leaves a JavaScript launcher at some of these paths; only ELF counts.
	[ "$(head -c 4 "$binary" | tail -c 3)" = "ELF" ] || continue
	if [ "$(patchelf --print-interpreter "$binary")" = "$TARTAN_ELF_INTERPRETER" ] &&
		[ "$(patchelf --print-rpath "$binary")" = "$TARTAN_ELF_RPATH" ]; then
		continue
	fi
	patchelf --set-interpreter "$TARTAN_ELF_INTERPRETER" --set-rpath "$TARTAN_ELF_RPATH" "$binary"
	echo "patch-workerd: patched ${binary#"$root"/}" >&2
	patched=$((patched + 1))
done < <(find "$modules" -type f -name workerd -path '*/bin/workerd' -print0)

if [ "$patched" -gt 0 ]; then
	echo "patch-workerd: $patched binaries patched" >&2
fi
