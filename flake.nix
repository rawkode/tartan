{
	description = "Tartan development shell";

	inputs = {
		nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
		rust-overlay = {
			url = "github:oxalica/rust-overlay";
			inputs.nixpkgs.follows = "nixpkgs";
		};
	};

	outputs = { nixpkgs, rust-overlay, ... }:
		let
			# The pinned cue and wasm-tools releases below exist per architecture.
			pins = {
				x86_64-linux = {
					arch = "x86_64";
					cueArch = "amd64";
					# containers/runner/Dockerfile CUE_SHA256_AMD64
					cueSha256 = "a39b0c97695069d95d276d99be0f5dbabb081d801bfdc9ba49b76efaf94e2369";
					wasmToolsHash = "sha256-3NfVh7D0ZEqryFzURxy3ld6E82po7gEgHVJh+HwNY0k=";
				};
				aarch64-linux = {
					arch = "aarch64";
					cueArch = "arm64";
					# containers/runner/Dockerfile CUE_SHA256_ARM64
					cueSha256 = "0d729be30d52c952ca38fc9dcb692caa09d8463fa0b64df5781312779183fbcd";
					wasmToolsHash = "sha256-y3o656ea6z282x0G7t6nu0Xm1ceiHpYOFORdWCsrn5c=";
				};
			};

			shellFor = system: pin:
				let
					pkgs = import nixpkgs {
						inherit system;
						overlays = [ rust-overlay.overlays.default ];
					};

					# The official release the runner image and CI pin, not nixpkgs' cue,
					# which is a source build that prints `cue version (devel)`.
					cue = pkgs.stdenvNoCC.mkDerivation rec {
						pname = "cue";
						version = "0.17.1";
						src = pkgs.fetchurl {
							url = "https://github.com/cue-lang/cue/releases/download/v${version}/cue_v${version}_linux_${pin.cueArch}.tar.gz";
							sha256 = pin.cueSha256;
						};
						sourceRoot = ".";
						installPhase = "install -Dm755 cue $out/bin/cue";
					};

					# docs/extensions.md: newer releases name the component's fixup
					# imports differently, which the import check rejects.
					wasm-tools = pkgs.stdenv.mkDerivation rec {
						pname = "wasm-tools";
						version = "1.248.0";
						src = pkgs.fetchurl {
							url = "https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/wasm-tools-${version}-${pin.arch}-linux.tar.gz";
							hash = pin.wasmToolsHash;
						};
						nativeBuildInputs = [ pkgs.autoPatchelfHook ];
						buildInputs = [ pkgs.stdenv.cc.cc.lib ];
						installPhase = "install -Dm755 wasm-tools $out/bin/wasm-tools";
					};

					rust = pkgs.rust-bin.stable."1.98.1".minimal.override {
						extensions = [ "clippy" "rustfmt" ];
						targets = [ "wasm32-unknown-unknown" ];
					};
				in
				pkgs.mkShell {
					packages = [
						cue
						pkgs.deno
						pkgs.git
						pkgs.nodejs_24
						pkgs.patchelf
						rust
						wasm-tools
					];

					# Read by scripts/patch-workerd.sh.
					TARTAN_ELF_INTERPRETER = pkgs.stdenv.cc.bintools.dynamicLinker;
					TARTAN_ELF_RPATH = pkgs.lib.makeLibraryPath [
						pkgs.stdenv.cc.cc.lib
						pkgs.stdenv.cc.libc
					];

					# The flake's copy of the script, so that entering the shell works
					# from any directory; it patches the checkout the shell was entered
					# in. `deno task patch:workerd` repeats this after an npm install.
					shellHook = ''
						tartan_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
						bash ${./scripts/patch-workerd.sh} "$tartan_root"
						export PATH="$tartan_root/node_modules/.bin:$PATH"
						unset tartan_root
					'';
				};
		in
		{
			devShells = builtins.mapAttrs
				(system: pin: { default = shellFor system pin; })
				pins;
		};
}
