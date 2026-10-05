package settings

// tartan.weave settings for repository config (docs/design/ADR-repo-config-cue.md).
// The defaults equal `config.default` in tartan.json (the approval
// self-check and src/builtins.test.ts check that they do).
#Settings: {
	// Changes per batch; Weave never takes more than its policy's maxBatch (4).
	batch: int & >=1 & <=4 | *4
	// How long Weave waits for more approved changes before a batch starts.
	debounceMs: int & >=0 & <=60000 | *2000
	// What happens to a change that conflicts at land time (M2 adds values).
	resolver:              "notify-author"
	reuseDisjointEvidence: bool | *true
	bisect:                bool | *true
}
