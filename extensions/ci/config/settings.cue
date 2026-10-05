package settings

// tartan.ci for repository config (docs/design/ADR-repo-config-cue.md).
// #Settings are an installation's settings; their defaults equal
// `config.default` in tartan.json (the self-check and
// src/builtins.test.ts check that they do).
#Settings: {
	// The runner image id, part of every CI input hash.
	image: string | *"tartan-runner"
}

// Repo policy (`config.repoPolicy`): authored in the repository's package
// tartan as `extensions: "tartan.ci": settings: pipeline: {…}` and read at
// each change's base on trunk (K13). CUE gives shape and positions; tartan.ci
// validates the value again (at most 32 jobs, timeouts up to 60m).
#Policy: {
	pipeline?: #Pipeline
}

#Duration: =~"^[0-9]{1,7}(ms|s|m|h)$"

#Pipeline: {
	// The run's wall clock (default 15m, at most 60m).
	timeout?: #Duration
	jobs: [=~"^[a-z0-9][a-z0-9-]{0,29}$"]: #Job
	// Which jobs run for a change, a land candidate and a push (default: all).
	on?: {
		change?: [...string]
		land?: [...string]
		push?: {
			branches: [...string]
			jobs: [...string]
		}
	}
	// When CI runs for a lane: on every push, on submit, or never.
	lanes?: ci?: "on-push" | "on-submit" | "none"
}

#Job: {
	run: string
	needs?: [...string]
	// Run once per affected project (or every project), with
	// {{project.root}} and {{project.name}} in run and cwd.
	each?:     "affected" | "all"
	cwd?:      string
	optional?: bool
	timeout?:  #Duration
	env?: [=~"^[A-Z_][A-Z0-9_]{0,63}$"]: string | number | bool
}
