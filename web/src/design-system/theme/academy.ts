// Rawkode Academy design tokens, copied because the package is private and unpublished.
// Source: rawkode-academy/rawkode-academy packages/design-system/panda.config.ts @ 07b82f91
// Change values there first. Page-specific tokens (editorial, KubeTrack, masthead) are left out.

export const tokens = {
	colors: {
		academyBase: {
			ground: { value: "#0a1220" },
			"ground-raised": { value: "#0d1728" },
			"grid-line": { value: "#142136" },
			panel: { value: "#111d31" },
			border: { value: "#22324d" },
			text: { value: "#e8eef8" },
			"text-soft": { value: "#bfcbdd" },
			"text-muted": { value: "#8fa0b8" },
			accent: { value: "#ff7ab6" },
			"accent-foreground": { value: "#2a0616" },
			input: { value: "#0a1220" },
			"input-border": { value: "#64768f" },
			"segment-off": { value: "#2f4262" },
		},
	},
	fonts: {
		"academy-display": {
			value:
				'var(--font-red-hat-display, "Red Hat Display"), "Helvetica Neue", Arial, sans-serif',
		},
		"academy-text": {
			value:
				'var(--font-red-hat-text, "Red Hat Text"), "Helvetica Neue", Arial, sans-serif',
		},
		"academy-mono": {
			value:
				'var(--font-red-hat-mono, "Red Hat Mono"), ui-monospace, "SFMono-Regular", Menlo, monospace',
		},
	},
	radii: {
		xs: { value: "2px" },
		sm: { value: "2px" },
		md: { value: "3px" },
		"academy-s": { value: "3px" },
		"academy-m": { value: "4px" },
		"academy-l": { value: "6px" },
		"academy-pill": { value: "999px" },
	},
	borders: {
		hairline: { value: "1px solid {colors.academy.border}" },
		focus: { value: "2px solid" },
		"academy-button": { value: "1px solid transparent" },
		"academy-tab": { value: "2px solid" },
	},
	spacing: {
		focus: { value: "2px" },
		"focus-inset": { value: "-2px" },
		"academy-gutter": { value: "clamp(20px, 4vw, 48px)" },
		"academy-gutter-wide": { value: "48px" },
		"academy-section": { value: "64px" },
		"academy-section-wide": { value: "88px" },
		"academy-hero-tight": { value: "clamp(2rem, 4vw, 3.5rem)" },
		"academy-masthead-top": { value: "4rem" },
	},
	sizes: {
		"academy-lede": { value: "42ch" },
		"academy-shell": { value: "1180px" },
		"academy-content": { value: "1084px" },
		"academy-copy": { value: "680px" },
		"academy-command-list": { value: "50dvh" },
		"academy-masthead": { value: "24rem" },
		"academy-masthead-copy": { value: "48rem" },
	},
	fontSizes: {
		"academy-poster": { value: "clamp(3.5rem, 11.5vw, 10rem)" },
		"academy-masthead": { value: "clamp(2.75rem, 9vw, 7.5rem)" },
		"academy-numeral": { value: "clamp(2.25rem, 4.5vw, 3.75rem)" },
		"academy-archive": { value: "clamp(1.75rem, 3.2vw, 2.75rem)" },
		"academy-lede": { value: "clamp(1.125rem, 1.4vw, 1.375rem)" },
		"academy-title": { value: "clamp(2.4rem, 5vw, 4rem)" },
		"academy-section": { value: "clamp(2.25rem, 4vw, 3.5rem)" },
		"academy-caption": { value: "0.6875rem" },
	},
	letterSpacings: {
		"academy-display": { value: "-0.035em" },
		"academy-poster": { value: "-0.05em" },
		"academy-tight": { value: "-0.02em" },
	},
	lineHeights: {
		"academy-display": { value: "1.04" },
		"academy-poster": { value: "0.9" },
		"academy-title": { value: "1.15" },
		"academy-card": { value: "1.3" },
		"academy-reading": { value: "1.65" },
		body: { value: "1.5" },
	},
	durations: {
		none: { value: "0s" },
		fast: { value: "120ms" },
		base: { value: "200ms" },
		slow: { value: "320ms" },
		reveal: { value: "720ms" },
	},
	easings: {
		"academy-out": { value: "cubic-bezier(0.22, 1, 0.36, 1)" },
		"academy-standard": { value: "cubic-bezier(0.4, 0, 0.2, 1)" },
	},
	animations: {
		none: { value: "none" },
		"academy-rise": {
			value: "academy-rise 720ms cubic-bezier(0.22, 1, 0.36, 1) both",
		},
	},
	zIndex: {
		overlay: { value: 1000 },
	},
};

export const keyframes = {
	"academy-rise": {
		from: { opacity: "0", transform: "translateY(0.75rem)" },
		to: { opacity: "1", transform: "translateY(0)" },
	},
};

export const semanticColors = {
	academy: {
		canvas: {
			value: { base: "#f4f7fb", _dark: "{colors.academyBase.ground}" },
		},
		ground: {
			value: { base: "#eaf0f8", _dark: "{colors.academyBase.ground-raised}" },
		},
		grid: {
			value: { base: "#dbe4f0", _dark: "{colors.academyBase.grid-line}" },
		},
		panel: { value: { base: "#ffffff", _dark: "{colors.academyBase.panel}" } },
		border: {
			value: { base: "#cfdae8", _dark: "{colors.academyBase.border}" },
		},
		text: { value: { base: "#0c1626", _dark: "{colors.academyBase.text}" } },
		textSoft: {
			value: { base: "#33425a", _dark: "{colors.academyBase.text-soft}" },
		},
		textMuted: {
			value: { base: "#526178", _dark: "{colors.academyBase.text-muted}" },
		},
		accent: {
			value: { base: "#c2185b", _dark: "{colors.academyBase.accent}" },
		},
		accentForeground: {
			value: {
				base: "#ffffff",
				_dark: "{colors.academyBase.accent-foreground}",
			},
		},
		statusSky: { value: { base: "#0369a1", _dark: "#7dd3fc" } },
		statusViolet: { value: { base: "#6d28d9", _dark: "#c4b5fd" } },
		statusAmber: { value: { base: "#9a5800", _dark: "#f2b53d" } },
		statusRust: { value: { base: "#b23b26", _dark: "#ef8f78" } },
		statusSpruce: { value: { base: "#16785d", _dark: "#6ed2ac" } },
		input: { value: { base: "#ffffff", _dark: "{colors.academyBase.input}" } },
		inputBorder: {
			value: { base: "#6d7c93", _dark: "{colors.academyBase.input-border}" },
		},
		segmentOff: {
			value: { base: "#c3d0e2", _dark: "{colors.academyBase.segment-off}" },
		},
		ink: {
			value: { base: "#0c1626", _dark: "{colors.academyBase.ground-raised}" },
		},
		inkRaised: {
			value: { base: "#152238", _dark: "{colors.academyBase.panel}" },
		},
		inkBorder: {
			value: {
				base: "oklch(1 0 0 / 0.14)",
				_dark: "{colors.academyBase.border}",
			},
		},
		inkText: { value: { base: "#f4f7fb", _dark: "{colors.academyBase.text}" } },
		inkTextSoft: {
			value: { base: "#c5d0e0", _dark: "{colors.academyBase.text-soft}" },
		},
		inkTextMuted: {
			value: { base: "#8fa0b8", _dark: "{colors.academyBase.text-muted}" },
		},
		inkAccent: {
			value: {
				base: "{colors.academyBase.accent}",
				_dark: "{colors.academyBase.accent}",
			},
		},
		inkAccentForeground: {
			value: {
				base: "{colors.academyBase.accent-foreground}",
				_dark: "{colors.academyBase.accent-foreground}",
			},
		},
	},
};
