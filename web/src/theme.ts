// Light/dark theme preference. "system" follows `prefers-color-scheme`; an
// explicit choice sets `data-theme` on <html> (see styles/tokens.css). Panda's
// `_dark` condition is a `.dark` class, so <html> also carries that class whenever
// the resolved theme is dark, and the two systems cannot disagree. The
// preference is a per-browser convenience, so storage failures are ignored.

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "tartan.theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

const isPreference = (value: unknown): value is ThemePreference =>
	value === "system" || value === "light" || value === "dark";

export const readThemePreference = (): ThemePreference => {
	try {
		const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
		return isPreference(stored) ? stored : "system";
	} catch {
		return "system";
	}
};

/** Whether a preference resolves to dark, given the system's own setting. */
export const resolvesDark = (
	preference: ThemePreference,
	systemDark: boolean,
): boolean => preference === "dark" || (preference === "system" && systemDark);

const DARK_QUERY = "(prefers-color-scheme: dark)";

const syncDarkClass = (root: Element, preference: ThemePreference): void => {
	root.classList.toggle(
		"dark",
		resolvesDark(preference, globalThis.matchMedia(DARK_QUERY).matches),
	);
};

let current: ThemePreference = "system";
let listening = false;

/** Follows the system setting for as long as the preference is "system". */
const listenForSystemChanges = (root: Element): void => {
	if (listening) return;
	listening = true;
	globalThis.matchMedia(DARK_QUERY).addEventListener(
		"change",
		() => syncDarkClass(root, current),
	);
};

export const applyThemePreference = (preference: ThemePreference): void => {
	const root = document.documentElement;
	current = preference;
	if (preference === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", preference);
	syncDarkClass(root, preference);
	listenForSystemChanges(root);
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, preference);
	} catch {
		// Private mode or blocked storage: the choice lasts for this page only.
	}
};

export const nextThemePreference = (
	current: ThemePreference,
): ThemePreference =>
	ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "system";
