package tartan

// The CI pipeline: tartan.ci's repo policy, read at each change's base.
extensions: "tartan.ci": settings: pipeline: {
	timeout: "15m"
	jobs: {
		install: run: "pnpm install --frozen-lockfile"
		lint: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm lint", optional: true}
		test: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm test"}
	}
	on: {
		change: ["install", "lint", "test"]
		land: ["install", "test"]
		push: {branches: ["release/*"], jobs: ["install", "test"]}
	}
	lanes: ci: "on-submit"
}
