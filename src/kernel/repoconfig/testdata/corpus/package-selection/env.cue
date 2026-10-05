package cuenv

// Another tool's package in the same directory: never selected by
// `cue export .:tartan`, so its unreachable import is never resolved.
import "github.com/cuenv/cuenv/schema"

schema.#Env & {
	env: NODE_ENV: "production"
}
