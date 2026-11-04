import { defineRecipe, defineSlotRecipe } from "@pandacss/dev";

const button = defineRecipe({
	className: "button",
	base: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: "1.5",
		minHeight: "11",
		paddingInline: "4",
		border: "academy-button",
		borderRadius: "academy-s",
		fontSize: "sm",
		fontWeight: "bold",
		whiteSpace: "nowrap",
		cursor: "pointer",
		transitionProperty: "background-color, border-color",
		transitionDuration: "fast",
		transitionTimingFunction: "academy-standard",
		_hover: { textDecoration: "none" },
		_disabled: { cursor: "default", opacity: "0.55" },
	},
	variants: {
		variant: {
			solid: {
				backgroundColor: "academy.accent",
				borderColor: "academy.accent",
				color: "academy.accentForeground",
			},
			outline: {
				backgroundColor: "academy.panel",
				borderColor: "academy.inputBorder",
				color: "academy.text",
				_hover: { borderColor: "academy.text" },
				_pressed: {
					backgroundColor: "academy.text",
					borderColor: "academy.text",
					color: "academy.canvas",
				},
			},
			ink: {
				backgroundColor: "transparent",
				borderColor: "academy.inkBorder",
				color: "academy.inkText",
				_hover: { borderColor: "academy.inkAccent" },
			},
		},
		size: {
			sm: { minHeight: "9", paddingInline: "3" },
			md: {},
		},
	},
	defaultVariants: { variant: "outline", size: "md" },
});

const badge = defineRecipe({
	className: "badge",
	base: {
		display: "inline-block",
		paddingInline: "1.5",
		border: "hairline",
		borderRadius: "academy-s",
		color: "academy.textSoft",
		fontFamily: "academy-mono",
		fontSize: "xs",
		whiteSpace: "nowrap",
	},
});

// A dot and its label, so colour is never the only signal.
const status = defineRecipe({
	className: "status",
	base: {
		display: "inline-flex",
		alignItems: "center",
		gap: "1.5",
		fontFamily: "academy-mono",
		fontSize: "xs",
		whiteSpace: "nowrap",
		_before: {
			content: '""',
			flex: "none",
			width: "2",
			height: "2",
			borderRadius: "full",
			backgroundColor: "currentColor",
		},
	},
	variants: {
		state: {
			neutral: { color: "academy.textMuted" },
			open: { color: "academy.statusSpruce" },
			pass: { color: "academy.statusSpruce" },
			merged: { color: "academy.statusViolet" },
			closed: { color: "academy.statusRust" },
			fail: { color: "academy.statusRust", fontWeight: "bold" },
		},
	},
	defaultVariants: { state: "neutral" },
});

const heading = defineRecipe({
	className: "heading",
	base: {
		fontFamily: "academy-display",
		fontWeight: "bold",
		letterSpacing: "academy-tight",
		lineHeight: "academy-card",
	},
	variants: {
		size: {
			xl: {
				fontSize: "academy-archive",
				fontWeight: "extrabold",
				lineHeight: "academy-title",
				textWrap: "pretty",
			},
			lg: { fontSize: "2xl" },
			md: { fontSize: "lg" },
			// Sits on a rule and names the section below it.
			rule: {
				paddingBlockEnd: "2",
				borderBlockEnd: "rule",
				fontSize: "sm",
				letterSpacing: "normal",
			},
		},
	},
	defaultVariants: { size: "md" },
});

const text = defineRecipe({
	className: "text",
	variants: {
		tone: {
			default: { color: "academy.text" },
			soft: { color: "academy.textSoft" },
			muted: { color: "academy.textMuted" },
		},
		size: {
			sm: { fontSize: "sm" },
			xs: { fontSize: "xs" },
		},
		mono: { true: { fontFamily: "academy-mono" } },
	},
});

const form = defineRecipe({
	className: "form",
	base: {
		display: "grid",
		gap: "4",
		maxWidth: "academy-copy",
		"& > button": { justifySelf: "start" },
	},
});

const panel = defineSlotRecipe({
	className: "panel",
	slots: ["root", "body", "empty"],
	base: {
		root: {
			backgroundColor: "academy.panel",
			border: "hairline",
			borderRadius: "academy-m",
		},
		body: { padding: "5" },
		empty: {
			paddingInline: "4",
			paddingBlock: "10",
			color: "academy.textMuted",
			textAlign: "center",
		},
	},
});

const systemGrid = {
	position: "relative",
	overflow: "hidden",
	backgroundColor: "academy.ink",
	color: "academy.inkText",
	"--academy-grid-line":
		"color-mix(in srgb, var(--colors-academy-ink-border) 70%, transparent)",
	_before: {
		content: '""',
		position: "absolute",
		inset: "0",
		pointerEvents: "none",
		backgroundImage:
			"[linear-gradient(var(--academy-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--academy-grid-line) 1px, transparent 1px)]",
		backgroundSize: "[4rem 4rem]",
		backgroundPosition: "[right top]",
		maskImage:
			"[radial-gradient(120% 100% at 100% 0%, black 25%, transparent 100%)]",
	},
	"& > *": { position: "relative" },
};

const masthead = defineSlotRecipe({
	className: "masthead",
	slots: ["root", "copy", "title", "lede"],
	base: {
		root: {
			...systemGrid,
			paddingBlock: "academy-hero-tight",
			paddingInline: "edge",
		},
		copy: { display: "grid", gap: "3" },
		title: {
			color: "academy.inkText",
			fontFamily: "academy-display",
			fontWeight: "extrabold",
			fontSize: "academy-title",
			letterSpacing: "academy-display",
			lineHeight: "academy-display",
			overflowWrap: "anywhere",
		},
		lede: {
			maxWidth: "academy-lede",
			color: "academy.inkTextSoft",
			fontSize: "academy-lede",
			lineHeight: "academy-reading",
			"& a": { color: "academy.inkAccent" },
		},
	},
});

// The frame around every forge page: an ink address bar, the tree, then the page.
const shell = defineSlotRecipe({
	className: "shell",
	slots: [
		"root",
		"bar",
		"logo",
		"crumbs",
		"sep",
		"crumb",
		"account",
		"main",
		"pad",
		"banner",
		"back",
	],
	base: {
		root: { display: "flex", flexDirection: "column", minHeight: "[100dvh]" },
		bar: {
			position: "relative",
			zIndex: "2",
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			columnGap: "5",
			rowGap: "1",
			paddingInline: "5",
			paddingBlock: "2",
			backgroundColor: "academy.ink",
			color: "academy.inkText",
		},
		logo: {
			display: "flex",
			alignItems: "center",
			minHeight: "11",
			color: "academy.inkText",
			fontFamily: "academy-display",
			fontSize: "xl",
			fontWeight: "black",
			letterSpacing: "academy-display",
			_hover: { textDecoration: "none" },
		},
		crumbs: {
			flex: "[999 1 360px]",
			minWidth: "0",
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			fontFamily: "academy-mono",
			fontSize: "sm",
		},
		sep: { color: "academy.inkAccent", fontWeight: "bold" },
		crumb: {
			display: "inline-flex",
			alignItems: "center",
			minHeight: "11",
			paddingInline: "1",
			color: "academy.inkTextSoft",
			"&[aria-current]": { color: "academy.inkText", fontWeight: "bold" },
			_hover: { color: "academy.inkText" },
		},
		account: {
			display: "flex",
			alignItems: "center",
			gap: "3",
			fontSize: "sm",
			"& a:not([class*=button])": { color: "academy.inkTextSoft" },
		},
		main: {
			display: "flex",
			flexDirection: "column",
			minHeight: "full",
			_focus: { outline: "none" },
		},
		pad: {
			display: "flex",
			flexDirection: "column",
			gap: "8",
			paddingInline: "7",
			paddingBlockStart: "5",
			paddingBlockEnd: "12",
		},
		banner: {
			marginInline: "7",
			marginBlockStart: "4",
			padding: "3",
			backgroundColor: "academy.ink",
			color: "academy.inkText",
			fontFamily: "academy-mono",
			fontSize: "xs",
		},
		back: {
			paddingInline: "7",
			paddingBlockStart: "4",
			fontSize: "sm",
			fontWeight: "bold",
		},
	},
});

const jump = defineSlotRecipe({
	className: "jump",
	slots: ["root", "label", "input", "content", "item", "empty"],
	base: {
		root: {
			position: "relative",
			flex: "[1 1 300px]",
			minWidth: "0",
			display: "flex",
			alignItems: "center",
			gap: "2.5",
		},
		label: { color: "academy.inkTextSoft", fontSize: "sm", fontWeight: "bold" },
		input: {
			width: "full",
			minWidth: "0",
			height: "11",
			paddingInline: "3",
			backgroundColor: "academy.inkRaised",
			border: "hairline",
			borderColor: "academy.inkBorder",
			borderRadius: "academy-s",
			color: "academy.inkText",
			fontFamily: "academy-mono",
			fontSize: "sm",
			_placeholder: { color: "academy.inkTextMuted" },
		},
		content: {
			zIndex: "overlay",
			backgroundColor: "academy.ink",
			borderRadius: "academy-m",
			boxShadow: "lg",
			overflow: "hidden",
			outline: "none",
		},
		item: {
			paddingInline: "3.5",
			paddingBlock: "3",
			borderBlockStart: "hairline",
			borderColor: "academy.inkBorder",
			color: "academy.inkText",
			fontFamily: "academy-mono",
			fontSize: "xs",
			overflowWrap: "anywhere",
			cursor: "pointer",
			"&[data-highlighted]": {
				backgroundColor: "academy.inkRaised",
				color: "academy.inkAccent",
			},
		},
		empty: {
			position: "absolute",
			insetBlockStart: "[100%]",
			insetInline: "0",
			zIndex: "overlay",
			marginBlockStart: "2",
			padding: "3",
			backgroundColor: "academy.ink",
			borderRadius: "academy-m",
			color: "academy.inkTextSoft",
			fontSize: "sm",
		},
	},
});

// A flat accordion: depth reads from the open row and the rule closing its section, not from indentation.
const tree = defineSlotRecipe({
	className: "tree",
	slots: [
		"head",
		"row",
		"link",
		"toggle",
		"spacer",
		"section",
		"icon",
		"text",
		"name",
		"sub",
		"dot",
		"count",
		"chevron",
		"note",
		"actions",
		"foot",
	],
	base: {
		head: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "3",
			minHeight: "11",
			paddingInline: "3.5",
			borderBlockEnd: "rule",
			color: "academy.textMuted",
			fontSize: "sm",
			fontWeight: "bold",
		},
		row: {
			display: "flex",
			alignItems: "stretch",
			minHeight: "11",
			borderBlockEnd: "hairline",
			color: "academy.text",
			_hover: { backgroundColor: "academy.ground" },
			"&[data-open]": {
				backgroundColor: "academy.ground",
				"& [class*=tree__name]": { fontWeight: "bold" },
			},
			"&[data-current]": {
				backgroundColor: "academy.accent",
				color: "academy.accentForeground",
				"& [data-dim]": { color: "academy.accentForeground" },
				"& [class*=tree__name]": { fontWeight: "bold" },
			},
		},
		link: {
			flex: "[1 1 auto]",
			minWidth: "0",
			display: "flex",
			alignItems: "center",
			gap: "2.5",
			paddingBlock: "1",
			paddingInlineStart: "3.5",
			paddingInlineEnd: "2",
			color: "inherit",
			_hover: { textDecoration: "none" },
		},
		toggle: {
			flex: "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			width: "11",
			color: "inherit",
			cursor: "pointer",
			_hover: { backgroundColor: "academy.border" },
		},
		// Keeps counts in one column on rows with nothing to expand.
		spacer: { flex: "none", width: "11" },
		section: { borderBlockEnd: "rule" },
		icon: { flex: "none" },
		text: {
			flex: "[1 1 auto]",
			minWidth: "0",
			display: "flex",
			flexDirection: "column",
		},
		name: {
			fontFamily: "academy-mono",
			fontSize: "sm",
			overflowWrap: "anywhere",
		},
		sub: {
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "academy-caption",
			overflowWrap: "anywhere",
		},
		dot: {
			flex: "none",
			color: "academy.statusRust",
			fontSize: "academy-caption",
			fontWeight: "bold",
			fontFamily: "academy-mono",
		},
		count: {
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "xs",
			fontVariantNumeric: "tabular-nums",
		},
		chevron: {
			display: "flex",
			transitionProperty: "transform",
			transitionDuration: "fast",
			_motionReduce: { transitionDuration: "none" },
			"&[data-state=open]": { transform: "rotate(90deg)" },
		},
		note: {
			paddingInline: "3.5",
			paddingBlock: "3",
			color: "academy.textSoft",
			fontSize: "sm",
			textWrap: "pretty",
		},
		actions: {
			display: "flex",
			gap: "1",
			paddingInline: "3.5",
			paddingBlock: "2.5",
			"& > *": { flex: "[1 1 0]", paddingInline: "1.5" },
		},
		foot: { paddingInline: "3.5", paddingBlock: "4", fontSize: "xs" },
	},
});

// Ark's splitter sets these as inline styles, so the narrow layout has to out-rank them.
const stacked = "@media (max-width: 831px)";

const split = defineSlotRecipe({
	className: "split",
	slots: ["root", "side", "main", "trigger"],
	base: {
		root: {
			flex: "1",
			height: "auto !important",
			overflow: "visible !important",
			[stacked]: { flexDirection: "column !important" },
		},
		side: {
			[stacked]: {
				order: "1",
				flex: "none !important",
				maxWidth: "none !important",
				borderBlockStart: "rule",
			},
		},
		main: {
			overflow: "visible !important",
			[stacked]: { flex: "none !important", minWidth: "0 !important" },
		},
		trigger: {
			position: "relative",
			zIndex: "1",
			width: "[9px]",
			marginInline: "[-4px]",
			cursor: "col-resize",
			_before: {
				content: '""',
				position: "absolute",
				insetBlock: "0",
				insetInlineStart: "[4px]",
				width: "[1px]",
				backgroundColor: "academy.text",
				transitionProperty: "background-color, width, inset-inline-start",
				transitionDuration: "fast",
			},
			"&:hover::before, &[data-dragging]::before, &:focus-visible::before": {
				insetInlineStart: "[3px]",
				width: "[3px]",
				backgroundColor: "academy.accent",
			},
			_focusVisible: { outline: "none" },
			[stacked]: { display: "none" },
		},
	},
});

const pageHead = defineSlotRecipe({
	className: "page-head",
	slots: ["root", "kind", "title", "dim", "mark", "lede"],
	base: {
		root: {
			display: "flex",
			flexDirection: "column",
			gap: "1.5",
			paddingInline: "7",
			paddingBlockStart: "6",
			paddingBlockEnd: "4.5",
		},
		kind: {
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "xs",
		},
		title: {
			fontFamily: "academy-display",
			fontSize: "academy-archive",
			fontWeight: "extrabold",
			letterSpacing: "academy-display",
			lineHeight: "academy-title",
			overflowWrap: "anywhere",
		},
		dim: { color: "academy.textMuted", fontWeight: "medium" },
		mark: { color: "academy.accent" },
		lede: {
			maxWidth: "academy-copy",
			color: "academy.textSoft",
			textWrap: "pretty",
		},
	},
});

const tabs = defineSlotRecipe({
	className: "tabs",
	slots: ["root", "tab", "count"],
	base: {
		root: {
			display: "flex",
			gap: "6",
			paddingInline: "7",
			overflowX: "auto",
			borderBlockEnd: "rule",
		},
		tab: {
			display: "inline-flex",
			alignItems: "center",
			gap: "2",
			minHeight: "11",
			borderBlockEnd: "academy-tab",
			borderColor: "transparent",
			color: "academy.textSoft",
			whiteSpace: "nowrap",
			_hover: { color: "academy.text", textDecoration: "none" },
			"&[aria-current]": {
				borderColor: "academy.accent",
				color: "academy.text",
				fontWeight: "bold",
			},
		},
		count: {
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "xs",
			fontVariantNumeric: "tabular-nums",
		},
	},
});

// One line of a list. Wraps instead of truncating, so an address is always readable.
const line = defineSlotRecipe({
	className: "line",
	slots: ["root", "id", "where", "title", "age", "chips", "empty", "icon"],
	base: {
		root: {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			columnGap: "3.5",
			rowGap: "1",
			width: "full",
			minHeight: "[46px]",
			paddingBlock: "2",
			paddingInline: "2.5",
			borderBlockEnd: "hairline",
			color: "academy.text",
			"&:is(a)": {
				_hover: { backgroundColor: "academy.ground", textDecoration: "none" },
			},
		},
		id: {
			maxWidth: "full",
			fontFamily: "academy-mono",
			fontSize: "xs",
			fontWeight: "bold",
			overflowWrap: "anywhere",
			"&[data-full]": { flex: "[1 1 100%]" },
		},
		where: { color: "academy.textMuted", fontWeight: "normal" },
		title: { flex: "[999 1 240px]", minWidth: "0", fontWeight: "semibold" },
		age: {
			flex: "[0 0 3ch]",
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "xs",
			textAlign: "end",
		},
		chips: {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			gap: "1",
			fontSize: "xs",
		},
		empty: {
			paddingBlock: "3",
			paddingInline: "2.5",
			color: "academy.textMuted",
		},
		icon: { flex: "none", "&[data-closed]": { fill: "currentColor" } },
	},
});

const stats = defineSlotRecipe({
	className: "stats",
	slots: ["root", "stat", "numeral", "unit"],
	base: {
		root: {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
			borderBlockEnd: "hairline",
		},
		stat: {
			display: "flex",
			flexDirection: "column",
			gap: "1.5",
			paddingBlock: "3",
			paddingInline: "2.5",
			color: "academy.text",
			"&:is(a)": {
				_hover: { backgroundColor: "academy.ground", textDecoration: "none" },
			},
		},
		numeral: {
			fontFamily: "academy-display",
			fontSize: "academy-numeral",
			fontWeight: "extrabold",
			letterSpacing: "academy-tight",
			lineHeight: "none",
			fontVariantNumeric: "tabular-nums",
		},
		unit: { color: "academy.textMuted", fontSize: "sm" },
	},
});

const facts = defineSlotRecipe({
	className: "facts",
	slots: ["root", "row", "term", "value"],
	base: {
		root: { borderBlockStart: "rule" },
		row: {
			display: "grid",
			gridTemplateColumns: "104px minmax(0, 1fr)",
			gap: "3",
			alignItems: "center",
			minHeight: "11",
			paddingBlock: "1.5",
			borderBlockEnd: "hairline",
		},
		term: { color: "academy.textMuted", fontSize: "sm" },
		value: {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			columnGap: "2.5",
			rowGap: "1",
			fontFamily: "academy-mono",
			fontSize: "xs",
			overflowWrap: "anywhere",
		},
	},
});

// A command to copy, or anything else read as terminal output.
const terminal = defineRecipe({
	className: "terminal",
	base: {
		display: "block",
		padding: "3",
		backgroundColor: "academy.ink",
		borderRadius: "academy-s",
		color: "academy.inkText",
		fontFamily: "academy-mono",
		fontSize: "xs",
		lineHeight: "academy-reading",
		overflowWrap: "anywhere",
		whiteSpace: "pre-wrap",
	},
});

const segmented = defineSlotRecipe({
	className: "segmented",
	slots: ["root", "label", "item", "text"],
	base: {
		root: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1" },
		label: {
			marginInlineEnd: "2.5",
			color: "academy.textMuted",
			fontSize: "sm",
		},
		item: {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			minHeight: "11",
			paddingInline: "3.5",
			borderRadius: "academy-s",
			fontSize: "sm",
			fontWeight: "semibold",
			cursor: "pointer",
			_hover: { backgroundColor: "academy.ground" },
			"&[data-state=checked]": {
				backgroundColor: "academy.text",
				color: "academy.canvas",
			},
			"&[data-focus-visible]": {
				outline: "focus",
				outlineColor: "academy.accent",
				outlineOffset: "focus",
			},
		},
		text: {},
	},
});

const table = defineSlotRecipe({
	className: "table",
	slots: ["scroll", "head", "row", "cell", "name", "sub", "num"],
	base: {
		scroll: { overflowX: "auto" },
		head: {
			display: "grid",
			columnGap: "3",
			alignItems: "center",
			minHeight: "10",
			borderBlock: "rule",
			color: "academy.textMuted",
			fontSize: "sm",
		},
		row: {
			display: "grid",
			columnGap: "3",
			alignItems: "center",
			minHeight: "[50px]",
			borderBlockEnd: "hairline",
			color: "academy.text",
			"&:is(a)": {
				_hover: { backgroundColor: "academy.ground", textDecoration: "none" },
			},
		},
		cell: {
			display: "flex",
			flexDirection: "column",
			minWidth: "0",
			paddingInlineStart: "2.5",
		},
		name: {
			fontFamily: "academy-mono",
			fontSize: "sm",
			fontWeight: "bold",
			overflowWrap: "anywhere",
		},
		sub: {
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "academy-caption",
			overflowWrap: "anywhere",
		},
		num: {
			fontFamily: "academy-mono",
			fontSize: "xs",
			overflowWrap: "anywhere",
		},
	},
	variants: {
		columns: {
			projects: {
				head: {
					gridTemplateColumns:
						"minmax(150px, 1.3fr) 112px 46px 78px 70px 224px",
					minWidth: "[794px]",
				},
				row: {
					gridTemplateColumns:
						"minmax(150px, 1.3fr) 112px 46px 78px 70px 224px",
					minWidth: "[794px]",
				},
			},
			list: {
				head: {
					gridTemplateColumns: "minmax(220px, 1fr) 130px 46px 78px",
					minWidth: "[522px]",
				},
				row: {
					gridTemplateColumns: "minmax(220px, 1fr) 130px 46px 78px",
					minWidth: "[522px]",
				},
			},
		},
	},
});

// One column per recent commit. Tall where the commit touched this project.
const ticks = defineSlotRecipe({
	className: "ticks",
	slots: ["root", "cell", "bar"],
	base: {
		root: { display: "flex", alignSelf: "stretch", minHeight: "[50px]" },
		cell: {
			flex: "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			width: "2",
		},
		bar: {
			display: "block",
			width: "[5px]",
			height: "[2px]",
			backgroundColor: "academy.segmentOff",
			"&[data-on]": { height: "full", backgroundColor: "academy.text" },
			"&[data-selected]": {
				height: "full",
				backgroundColor:
					"[color-mix(in srgb, var(--colors-academy-accent) 25%, transparent)]",
			},
			"&[data-selected][data-on]": { backgroundColor: "academy.accent" },
		},
	},
});

const diff = defineSlotRecipe({
	className: "diff",
	slots: ["root", "file", "lines", "line", "sign", "text", "number"],
	base: {
		root: {
			display: "flex",
			flexDirection: "column",
			border: "hairline",
			borderRadius: "academy-s",
			margin: "0",
		},
		file: {
			display: "flex",
			flexWrap: "wrap",
			justifyContent: "space-between",
			columnGap: "4",
			paddingInline: "3",
			paddingBlock: "2",
			borderBlockEnd: "hairline",
			fontFamily: "academy-mono",
			fontSize: "xs",
			fontWeight: "semibold",
			overflowWrap: "anywhere",
		},
		lines: {
			overflowX: "auto",
			paddingBlock: "1.5",
			fontFamily: "academy-mono",
			fontSize: "xs",
			lineHeight: "academy-reading",
		},
		line: {
			display: "flex",
			minWidth: "[max-content]",
			'&[data-sign="+"]': {
				backgroundColor:
					"[color-mix(in srgb, var(--colors-academy-status-sky) 16%, transparent)]",
			},
			'&[data-sign="-"]': {
				backgroundColor:
					"[color-mix(in srgb, var(--colors-academy-status-rust) 16%, transparent)]",
			},
		},
		sign: {
			flex: "[0 0 3ch]",
			color: "academy.textMuted",
			textAlign: "center",
			whiteSpace: "pre",
		},
		text: { paddingInlineEnd: "4", whiteSpace: "pre" },
		number: {
			flex: "[0 0 5ch]",
			paddingInlineEnd: "[1ch]",
			color: "academy.textMuted",
			textAlign: "end",
		},
	},
});

const detail = defineSlotRecipe({
	className: "detail",
	slots: [
		"head",
		"id",
		"dim",
		"mark",
		"title",
		"columns",
		"main",
		"aside",
		"event",
		"age",
		"note",
		"eventText",
		"prose",
		"ref",
	],
	base: {
		head: {
			display: "flex",
			flexDirection: "column",
			gap: "2.5",
			paddingInline: "7",
			paddingBlockStart: "3",
			paddingBlockEnd: "5",
		},
		id: {
			fontFamily: "academy-mono",
			fontSize: "lg",
			fontWeight: "extrabold",
			letterSpacing: "academy-tight",
			overflowWrap: "anywhere",
		},
		dim: { color: "academy.textMuted", fontWeight: "medium" },
		mark: { color: "academy.accent" },
		title: {
			maxWidth: "[30ch]",
			fontFamily: "academy-display",
			fontSize: "academy-archive",
			fontWeight: "extrabold",
			letterSpacing: "academy-display",
			lineHeight: "academy-title",
			textWrap: "pretty",
		},
		columns: {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "flex-start",
			gap: "9",
			paddingInline: "7",
			paddingBlockEnd: "12",
		},
		main: {
			flex: "[999 1 460px]",
			minWidth: "0",
			display: "flex",
			flexDirection: "column",
			gap: "8",
			paddingBlockStart: "5",
		},
		aside: {
			flex: "[1 1 300px]",
			minWidth: "0",
			display: "flex",
			flexDirection: "column",
			gap: "8",
			paddingBlockStart: "5",
		},
		event: {
			display: "grid",
			gridTemplateColumns: "44px minmax(0, 1fr)",
			columnGap: "3.5",
			paddingBlock: "3",
			borderBlockEnd: "hairline",
		},
		age: {
			paddingBlockStart: "0.5",
			color: "academy.textMuted",
			fontFamily: "academy-mono",
			fontSize: "xs",
		},
		note: { maxWidth: "[68ch]", whiteSpace: "pre-line", textWrap: "pretty" },
		eventText: {
			minWidth: "0",
			color: "academy.textSoft",
			fontSize: "sm",
			overflowWrap: "anywhere",
			"& code": {
				color: "academy.text",
				fontSize: "xs",
				fontWeight: "semibold",
			},
		},
		prose: {
			display: "flex",
			flexDirection: "column",
			gap: "3.5",
			maxWidth: "academy-copy",
			"& code": { fontSize: "xs" },
			"& ol": { listStyleType: "decimal", paddingInlineStart: "5.5" },
		},
		ref: {
			fontFamily: "academy-mono",
			fontSize: "xs",
			textDecoration: "underline",
		},
	},
});

const control = {
	width: "full",
	minHeight: "11",
	paddingInline: "3",
	paddingBlock: "2",
	backgroundColor: "academy.input",
	border: "hairline",
	borderColor: "academy.inputBorder",
	borderRadius: "academy-s",
	color: "academy.text",
	fontWeight: "normal",
};

const field = defineSlotRecipe({
	className: "field",
	slots: ["root", "label", "input", "helper", "error"],
	base: {
		root: { display: "grid", gap: "1" },
		label: { fontSize: "sm", fontWeight: "bold" },
		input: { ...control, _invalid: { borderColor: "academy.statusRust" } },
		helper: { color: "academy.textMuted", fontSize: "sm" },
		error: {
			color: "academy.statusRust",
			fontSize: "sm",
			fontWeight: "semibold",
		},
	},
	variants: {
		mono: { true: { input: { fontFamily: "academy-mono" } } },
	},
});

const popup = {
	zIndex: "overlay",
	padding: "1",
	backgroundColor: "academy.panel",
	border: "hairline",
	borderRadius: "academy-m",
	boxShadow: "lg",
	outline: "none",
	maxHeight: "academy-command-list",
	overflowY: "auto",
};

const popupItem = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "3",
	paddingInline: "2.5",
	paddingBlock: "1.5",
	borderRadius: "academy-s",
	color: "academy.text",
	fontSize: "sm",
	cursor: "pointer",
	_hover: { textDecoration: "none" },
	"&[data-highlighted]": { backgroundColor: "academy.ground" },
};

const select = defineSlotRecipe({
	className: "select",
	slots: [
		"root",
		"label",
		"control",
		"trigger",
		"indicator",
		"content",
		"item",
	],
	base: {
		root: { display: "grid", gap: "1" },
		label: { fontSize: "sm", fontWeight: "bold" },
		trigger: {
			...control,
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "2",
			cursor: "pointer",
			textAlign: "start",
		},
		indicator: { color: "academy.textMuted", fontSize: "xs" },
		content: popup,
		item: popupItem,
	},
	variants: {
		size: {
			sm: {
				root: { display: "inline-flex", alignItems: "center", gap: "2" },
				label: {
					color: "academy.textMuted",
					fontFamily: "academy-mono",
					fontSize: "xs",
					fontWeight: "normal",
					whiteSpace: "nowrap",
				},
				control: { minWidth: "32" },
				trigger: { minHeight: "8", paddingBlock: "1", fontSize: "sm" },
			},
			md: {},
		},
	},
	defaultVariants: { size: "md" },
});

export const recipes = { button, badge, status, heading, text, form, terminal };
export const slotRecipes = {
	panel,
	masthead,
	shell,
	jump,
	tree,
	split,
	pageHead,
	tabs,
	line,
	stats,
	facts,
	segmented,
	table,
	ticks,
	diff,
	detail,
	field,
	select,
};
