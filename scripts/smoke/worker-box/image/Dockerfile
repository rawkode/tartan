# S7b: Sandbox 0.12.1 base (ubuntu 22.04, git 2.34) + modern git from the git-core PPA (>= 2.38 for merge-tree --write-tree).
FROM docker.io/cloudflare/sandbox:0.12.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xE1DD270288B4E6030699E45FA1715D88E1DF1F24' | gpg --dearmor -o /etc/apt/keyrings/git-core.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/git-core.gpg] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu jammy main" > /etc/apt/sources.list.d/git-core.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends git \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && git --version
