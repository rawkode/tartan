// Light/dark theme preference. "system" follows `prefers-color-scheme`; an
// explicit choice sets `data-theme` on <html> (see styles/tokens.css). The
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

export const applyThemePreference = (preference: ThemePreference): void => {
	const root = document.documentElement;
	if (preference === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", preference);
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
