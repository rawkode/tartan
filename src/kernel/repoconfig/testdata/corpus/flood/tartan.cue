package tartan

import "list"

// 5,000 errors (about 430 KB of text, over the 64 KiB the host reads) well
// inside the wall clock: every generated settings key is a `field not
// allowed`. CUE v0.17.1 collects errors in time that grows with their
// square, so a much larger flood is stopped by the wall clock (TIMEOUT)
// instead.
extensions: "acme.no-secrets": settings: {
	for i in list.Range(0, 5000, 1) {"k\(i)": i}
}
