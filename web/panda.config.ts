import { defineConfig } from "@pandacss/dev";
// Panda CSS for the forge shell and design system. Its CSS sits in cascade layers
// (`src/styles/panda.css`) and everything Tartan's own views would otherwise feel
// is scoped to `[data-forge]`: the preflight reset and the element styles below.
// Tartan's element rules sit in the lower `tartan-base` layer (`src/styles/base.css`).
//
// Dark mode is Panda's `.dark` condition; `src/theme.ts` keeps that class on <html>
// in step with Tartan's `data-theme` and the system preference.

import {
	keyframes,
	semanticColors,
	tokens,
} from "./src/design-system/theme/academy.ts";
import { recipes, slotRecipes } from "./src/design-system/theme/recipes.ts";

const gutter = "clamp(20px, 4vw, 48px)";

export default defineConfig({
	presets: ["@pandacss/preset-base", "@pandacss/preset-panda"],
	preflight: { scope: "[data-forge]", level: "parent" },
	strictTokens: true,
	include: ["./src/forge/**/*.{ts,vue}", "./src/design-system/**/*.{ts,vue}"],
	exclude: [],
	outdir: "styled-system",
	// Variants are often chosen by a prop at runtime, so emit every one of them.
	staticCss: { recipes: "*" },
	theme: {
		extend: {
			tokens: {
				...tokens,
				// The strong rule under a section heading or between columns.
				borders: {
					...tokens.borders,
					rule: { value: "1px solid {colors.academy.text}" },
				},
				spacing: {
					...tokens.spacing,
					// Full-bleed bands pad to this so their content lines up on the 1180px shell.
					edge: {
						value: `max(${gutter}, calc((100vw - 1180px) / 2 + ${gutter}))`,
					},
				},
			},
			keyframes,
			semanticTokens: { colors: semanticColors },
			recipes,
			slotRecipes,
		},
	},
	globalCss: {
		"[data-forge]": {
			backgroundColor: "academy.canvas",
			color: "academy.text",
			fontFamily: "academy-text",
			lineHeight: "body",
			"& a": {
				color: "academy.accent",
				_hover: { textDecoration: "underline" },
			},
			"& code": { fontFamily: "academy-mono", fontSize: "sm" },
			"& ::selection": {
				backgroundColor: "academy.accent",
				color: "academy.accentForeground",
			},
			"& :focus-visible": {
				outline: "focus",
				outlineColor: "academy.accent",
				outlineOffset: "focus",
			},
		},
		// The role decides which controls exist, not what is allowed: the kernel still
		// answers for every action. Set on <html> from the session (`src/auth/role.ts`).
		"html:not([data-role='owner']) .owner-only, html[data-role='owner'] .not-owner, html[data-role='anon'] .member-only, html:not([data-role='anon']) .anon-only":
			{ display: "none !important" },
	},
});
