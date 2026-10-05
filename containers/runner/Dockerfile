# Tartan runner image.
#
# The Sandbox SDK 0.12.1 base (Ubuntu 22.04, x86_64, node 22, npm, bun; its
# git 2.34.1 cannot run `merge-tree --write-tree`), pinned by digest,
# plus:
#   - git from the git-core PPA, signing key checked by fingerprint, pinned to
#     an exact .deb version: when the PPA drops that build, `apt-get install`
#     fails and the build fails closed until the pin is bumped deliberately;
#   - an assertion that git >= 2.38 and a real `merge-tree --write-tree`;
#   - pnpm installed with npm at an exact version (the base has no corepack);
#   - the unprivileged users of the token split: `tartan-git` runs
#     everything that parses repository content or CI code (read tokens at
#     most), `tartan-push` runs only execs that carry a write token; both are
#     in group `tartan`, which owns the shared mirror root `/srv` (setgid);
#   - the repository-config evaluator (docs/design/ADR-repo-config-cue.md):
#     the official CUE release binary, downloaded in its own stage and checked
#     against a pinned sha256 per architecture (`TARGETARCH`), plus the job
#     script `cue-job.sh`. Upgrading CUE means bumping CUE_VERSION, both
#     digests and `CUE_EVALUATOR_ID` (packages/contract) together; a download
#     or digest failure fails only that stage, and with it the build;
#   - `/etc/tartan-runner.json` (base digest, git, pnpm, cue) for `/-/health`.
#
# No secrets are ever built in. Build (x86_64, also on arm64 hosts):
#   docker build --platform linux/amd64 -t tartan-runner containers/runner

ARG BASE=docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5
# CUE release pins: the digests are the release assets' sha256 as GitHub
# records them for cue-lang/cue v0.17.1 (cue_v0.17.1_linux_<arch>.tar.gz).
ARG CUE_VERSION=v0.17.1
ARG CUE_SHA256_AMD64=a39b0c97695069d95d276d99be0f5dbabb081d801bfdc9ba49b76efaf94e2369
ARG CUE_SHA256_ARM64=0d729be30d52c952ca38fc9dcb692caa09d8463fa0b64df5781312779183fbcd

# --- cue: the evaluator binary, fail closed on any mismatch -------------------
FROM ${BASE} AS cue
ARG TARGETARCH
ARG CUE_VERSION
ARG CUE_SHA256_AMD64
ARG CUE_SHA256_ARM64
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN set -eux; \
	arch="${TARGETARCH:-amd64}"; \
	case "${arch}" in \
		amd64) sum="${CUE_SHA256_AMD64}" ;; \
		arm64) sum="${CUE_SHA256_ARM64}" ;; \
		*) echo "no pinned CUE release for ${arch}" >&2; exit 1 ;; \
	esac; \
	tarball="cue_${CUE_VERSION}_linux_${arch}.tar.gz"; \
	curl -fsSL -o "/tmp/${tarball}" \
		"https://github.com/cue-lang/cue/releases/download/${CUE_VERSION}/${tarball}"; \
	echo "${sum}  /tmp/${tarball}" | sha256sum -c -; \
	install -d /out; \
	tar -xzf "/tmp/${tarball}" -C /out cue; \
	test "$(/out/cue version | sed -n '1p')" = "cue version ${CUE_VERSION}"

# --- the runner ---------------------------------------------------------------
FROM ${BASE}

ARG BASE
ARG CUE_VERSION
# Exact git-core PPA build for jammy (bump deliberately; the build fails closed).
ARG GIT_DEB=1:2.55.0-0ppa1~ubuntu22.04.2
ARG GIT_PPA_FINGERPRINT=E1DD270288B4E6030699E45FA1715D88E1DF1F24
ARG GIT_MIN=2.38
ARG PNPM_VERSION=10.34.6

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends gnupg; \
	mkdir -p /etc/apt/keyrings; \
	curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${GIT_PPA_FINGERPRINT}" \
		| gpg --dearmor -o /etc/apt/keyrings/git-core.gpg; \
	fpr="$(gpg --show-keys --with-colons /etc/apt/keyrings/git-core.gpg | awk -F: '/^fpr/ { print $10; exit }')"; \
	test "${fpr}" = "${GIT_PPA_FINGERPRINT}"; \
	echo "deb [signed-by=/etc/apt/keyrings/git-core.gpg] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu jammy main" \
		> /etc/apt/sources.list.d/git-core.list; \
	apt-get update; \
	apt-get install -y --no-install-recommends "git=${GIT_DEB}"; \
	apt-mark hold git; \
	apt-get purge -y gnupg; \
	apt-get autoremove -y; \
	rm -rf /var/lib/apt/lists/*

# git >= GIT_MIN and a real merge-tree --write-tree, or the build fails.
RUN set -eux; \
	version="$(git --version | sed -n 's/^git version //p')"; \
	if ! printf '%s\n%s\n' "${GIT_MIN}" "${version}" | sort -V -C; then \
		echo "git ${version} is older than ${GIT_MIN}" >&2; exit 1; \
	fi; \
	dir="$(mktemp -d)"; cd "${dir}"; \
	git init -q -b main .; \
	git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base; \
	git checkout -q -b other; echo o > o; git add o; \
	git -c user.name=t -c user.email=t@t commit -q -m other; \
	git checkout -q main; echo m > m; git add m; \
	git -c user.name=t -c user.email=t@t commit -q -m main; \
	git merge-tree --write-tree main other; \
	cd /; rm -rf "${dir}"

RUN set -eux; \
	npm install -g "pnpm@${PNPM_VERSION}"; \
	npm cache clean --force; \
	test "$(pnpm --version)" = "${PNPM_VERSION}"

RUN set -eux; \
	groupadd --system tartan; \
	useradd --create-home --user-group --groups tartan --shell /bin/bash tartan-git; \
	useradd --create-home --user-group --groups tartan --shell /bin/bash tartan-push; \
	install -d -m 2775 -o root -g tartan /srv; \
	install -d -m 0755 /workspace; \
	git config --system --add safe.directory '/srv/*'; \
	git config --system gc.auto 0; \
	command -v setpriv pkill base64 > /dev/null

# The repository-config evaluator: the checked binary and its job script,
# run as tartan-git by TartanSandbox (`cue:trunk`, `cue:preview:<k>`).
COPY --from=cue --chmod=0755 /out/cue /usr/local/bin/cue
COPY --chmod=0755 cue-job.sh /opt/tartan-cue/cue-job.sh
# Bundles are written by the root control server into a directory that
# tartan-git can read but never write (no planted symlinks).
RUN set -eux; \
	install -d -m 0755 -o root -g root /opt/tartan-cue/bundles; \
	test "$(cue version | sed -n '1p')" = "cue version ${CUE_VERSION}"; \
	command -v timeout setpriv node mktemp pkill > /dev/null

RUN set -eux; \
	printf '{"base":"%s","git":"%s","gitDeb":"%s","pnpm":"%s","cue":"%s"}\n' \
		"${BASE}" "$(git --version | sed -n 's/^git version //p')" "${GIT_DEB}" "${PNPM_VERSION}" \
		"$(cue version | sed -n '1s/^cue version //p')" \
		> /etc/tartan-runner.json
