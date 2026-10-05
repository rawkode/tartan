package tartan

import "list"

// 4,000 x 4,000 = 16,000,000 generated strings.
extensions: "acme.no-secrets": settings: allow: [
	for i in list.Range(0, 4000, 1)
	for j in list.Range(0, 4000, 1) {"p\(i)-\(j)"},
]
