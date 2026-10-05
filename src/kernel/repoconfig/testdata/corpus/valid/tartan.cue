package tartan

_services: ["api", "web", "worker"]

// The project graph's configured projects and global files (kernel fields).
projects: {
	shared: root: "packages/shared"
	for s in _services {
		(s): {root: "services/\(s)", deps: ["shared"]}
	}
	api: {sensitive: true, owners: ["@platform"]}
}
global: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]

// An overlay: Weave is installed above this repository with repo overrides on.
extensions: "tartan.weave": settings: batch: 2

// An own install, approved for this repository.
extensions: "acme.no-secrets": {
	mode: "enforce"
	settings: {
		severity: "hunk"
		allow: [for s in _services if s != "worker" {"services/\(s)/fixtures/**"}]
	}
}
