// Refname grammar: git's `check_refname_format` (refs.c) with flags 0, plus
// receive-pack's own rule that a pushed name starts with `refs/` and has at
// least two components after it ("funny refname" otherwise). The policy
// tables (case collisions, reserved names)
// are WP4's; this is only what git itself would accept.

/**
 * One refname component (git refs.c): non-empty, not starting with `.`, not
 * ending with `.lock`, no `..`, no `@{`, no ASCII control character, space,
 * DEL or any of `~^:?*[\`.
 */
const isValidComponent = (component: string): boolean => {
	if (component.length === 0 || component.startsWith(".")) return false;
	if (component.endsWith(".lock")) return false;
	if (component.includes("..") || component.includes("@{")) return false;
	for (let i = 0; i < component.length; i++) {
		const c = component.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return false;
		if (" ~^:?*[\\".includes(component[i])) return false;
	}
	return true;
};

/** git `check_refname_format(name, 0)`: at least two components, none bad. */
export const checkRefnameFormat = (name: string): boolean => {
	if (name.length === 0 || name === "@") return false;
	if (name.endsWith(".") || name.endsWith("/") || name.startsWith("/")) {
		return false;
	}
	const components = name.split("/");
	if (components.length < 2) return false;
	return components.every(isValidComponent);
};

/**
 * A name receive-pack would update: `refs/` followed by a name that passes
 * `check_refname_format` with at least two components (`refs/heads/x`, never
 * `refs/x`, `HEAD` or a bare name).
 */
export const isValidPushRefname = (name: string): boolean =>
	name.startsWith("refs/") && checkRefnameFormat(name.slice(5));
