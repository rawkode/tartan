package tartan

import "strings"

// A 1 GiB string from a one-line expression.
extensions: "acme.no-secrets": settings: allow: [strings.Repeat("x", 1073741824)]
