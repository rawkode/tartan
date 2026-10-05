package settings

// tartan.review for repository config (docs/design/ADR-repo-config-cue.md).
// #Settings are an installation's settings; their defaults equal
// `config.default` in tartan.json (the self-check and
// src/builtins.test.ts check that they do).
#Settings: {
	// by-exception: low-risk changes are approved automatically.
	mode: *"by-exception" | "human-required"
	// A change whose risk is below this is low risk.
	autoThreshold: number & >=0 & <=1 | *0.35
	// Optional per-factor weights (0–100) of the risk model.
	weights?: {
		sensitive?:     number & >=0 & <=100
		blastRadius?:   number & >=0 & <=100
		size?:          number & >=0 & <=100
		weakenedTests?: number & >=0 & <=100
		radar?:         number & >=0 & <=100
		trackRecord?:   number & >=0 & <=100
	}
}

// Repo policy (`config.repoPolicy`): authored in the repository's package
// tartan as `extensions: "tartan.review": settings: owners: rules: […]` and
// read at trunk (K13). tartan.review validates the value again (at most 500
// rules).
#Policy: {
	owners?: #Owners
}

#Owners: {
	rules: [...#Rule]
}

#Rule: {
	// Globs of repository paths.
	paths: [string, ...string]
	// 0 (none) … 3 (critical).
	sensitivity?: int & >=0 & <=3
	// Handles, group names or principal ids; principal ids join the attention set.
	owners?: [...string]
}
