<script setup lang="ts">
// The design system gallery: tokens, recipes and components, in one page.
import { ref } from "vue";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import {
	form,
	heading,
	line,
	panel,
	shell,
	terminal,
	text,
} from "../../styled-system/recipes";
import {
	Badge,
	Button,
	Field,
	Masthead,
	Segmented,
	Select,
	Status,
} from "../design-system/index.ts";
import { useForgeNav } from "./nav.ts";

// Written out because Panda extracts classes statically.
const colors = [
	{ name: "canvas", swatch: css({ backgroundColor: "academy.canvas" }) },
	{ name: "ground", swatch: css({ backgroundColor: "academy.ground" }) },
	{ name: "grid", swatch: css({ backgroundColor: "academy.grid" }) },
	{ name: "panel", swatch: css({ backgroundColor: "academy.panel" }) },
	{ name: "border", swatch: css({ backgroundColor: "academy.border" }) },
	{ name: "text", swatch: css({ backgroundColor: "academy.text" }) },
	{ name: "textSoft", swatch: css({ backgroundColor: "academy.textSoft" }) },
	{ name: "textMuted", swatch: css({ backgroundColor: "academy.textMuted" }) },
	{ name: "accent", swatch: css({ backgroundColor: "academy.accent" }) },
	{
		name: "accentForeground",
		swatch: css({ backgroundColor: "academy.accentForeground" }),
	},
	{ name: "statusSky", swatch: css({ backgroundColor: "academy.statusSky" }) },
	{
		name: "statusViolet",
		swatch: css({ backgroundColor: "academy.statusViolet" }),
	},
	{
		name: "statusAmber",
		swatch: css({ backgroundColor: "academy.statusAmber" }),
	},
	{
		name: "statusRust",
		swatch: css({ backgroundColor: "academy.statusRust" }),
	},
	{
		name: "statusSpruce",
		swatch: css({ backgroundColor: "academy.statusSpruce" }),
	},
	{ name: "input", swatch: css({ backgroundColor: "academy.input" }) },
	{
		name: "inputBorder",
		swatch: css({ backgroundColor: "academy.inputBorder" }),
	},
	{
		name: "segmentOff",
		swatch: css({ backgroundColor: "academy.segmentOff" }),
	},
	{ name: "ink", swatch: css({ backgroundColor: "academy.ink" }) },
	{ name: "inkRaised", swatch: css({ backgroundColor: "academy.inkRaised" }) },
	{ name: "inkBorder", swatch: css({ backgroundColor: "academy.inkBorder" }) },
	{ name: "inkText", swatch: css({ backgroundColor: "academy.inkText" }) },
	{
		name: "inkTextSoft",
		swatch: css({ backgroundColor: "academy.inkTextSoft" }),
	},
	{
		name: "inkTextMuted",
		swatch: css({ backgroundColor: "academy.inkTextMuted" }),
	},
	{ name: "inkAccent", swatch: css({ backgroundColor: "academy.inkAccent" }) },
	{
		name: "inkAccentForeground",
		swatch: css({ backgroundColor: "academy.inkAccentForeground" }),
	},
];

const nav = useForgeNav();
const clone = ref("repo");
const project = ref("lsp");

const bar = shell();
const panelStyles = panel();
const rows = line();
const row = hstack({ gap: "3", flexWrap: "wrap" });
const label = heading({ size: "lg" });
const main = css({ paddingInline: "edge", paddingBlock: "8" });
const section = css({ display: "grid", gap: "4", marginBlockEnd: "12" });
const grid = css({
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))",
	gap: "3",
});
const swatch = css({
	height: "12",
	marginBlockEnd: "1",
	border: "hairline",
	borderRadius: "academy-s",
});
const wrap = css({ overflowWrap: "anywhere" });
const spacer = css({ flex: "1" });
</script>

<template>
	<div data-forge @click="nav.followLink">
		<header :class="bar.bar">
			<a :class="bar.logo" href="/">Tartan</a>
			<span :class="spacer"></span>
		</header>
		<Masthead
			title="Design system"
			description="Rawkode Academy tokens, Panda CSS recipes, Vue components and Ark UI behaviour."
		/>
		<main id="main" :class="main">
			<section :class="section">
				<h2 :class="label">Colour</h2>
				<div :class="grid">
					<div v-for="color in colors" :key="color.name">
						<div :class="[swatch, color.swatch]"
							:data-swatch="color.name"></div>
						<code :class="wrap">academy.{{ color.name }}</code>
					</div>
				</div>
			</section>

			<section :class="section">
				<h2 :class="label">Type</h2>
				<div>
					<p :class="heading({ size: 'xl' })">Red Hat Display, xl</p>
					<p :class="heading({ size: 'lg' })">Red Hat Display, lg</p>
					<p>Red Hat Text for navigation, descriptions, forms and reading.</p>
					<p
						:class="text({ mono: true, tone: 'muted', size: 'sm' })">Red Hat Mono for addresses, identifiers and metadata.</p>
				</div>
			</section>

			<section :class="section">
				<h2 :class="label">List line</h2>
				<div>
					<h3
						:class="heading({ size: 'rule' })">A section heading sits on a rule</h3>
					<a :class="rows.root" href="/-/design-system">
						<span
							:class="rows.id"><span :class="rows.where">kiln:lsp</span>#128</span>
						<span
							:class="rows.title">Lines wrap instead of truncating an address</span>
						<Badge>bug</Badge>
						<Status state="fail">Failing</Status>
						<span :class="rows.age">2h</span>
					</a>
				</div>
			</section>

			<section :class="section">
				<h2 :class="label">Button</h2>
				<div :class="row">
					<Button variant="solid" type="button">Solid</Button>
					<Button type="button">Outline</Button>
					<Button type="button" pressed>Pressed</Button>
					<Button variant="solid" size="sm" type="button">Small solid</Button>
					<Button size="sm" type="button">Small outline</Button>
					<Button type="button" disabled>Disabled</Button>
					<Button href="/-/design-system">Link</Button>
				</div>
			</section>

			<section :class="section">
				<h2 :class="label">Status and badge</h2>
				<div :class="row">
					<Status state="open">Open</Status>
					<Status state="merged">Merged</Status>
					<Status state="closed">Closed</Status>
					<Status state="pass">Passing</Status>
					<Status state="fail">Failing</Status>
					<Badge>label</Badge>
				</div>
			</section>

			<section :class="section">
				<h2 :class="label">Segmented</h2>
				<Segmented
					v-model="clone"
					label="Clone"
					:items="[
						{ label: 'Whole repo', value: 'repo' },
						{ label: 'One project', value: 'project' },
					]"
				/>
			</section>

			<section :class="section">
				<h2 :class="label">Terminal</h2>
				<code :class="terminal()">git clone forge:oss/devtools/build/kiln</code>
			</section>

			<section :class="section">
				<h2 :class="label">Form controls</h2>
				<form :class="form()" @submit.prevent>
					<Field label="Name" name="name"
						helper="Helper text sits below the input." required />
					<Field label="Branch" name="branch" placeholder="workspace-index"
						mono />
					<Field label="Description" name="body" :rows="3" />
					<Select
						v-model="project"
						label="Project"
						name="project"
						:items="[
							{ label: 'core', value: 'core' },
							{ label: 'cli', value: 'cli' },
							{ label: 'lsp', value: 'lsp' },
						]"
					/>
				</form>
			</section>

			<section :class="section">
				<h2 :class="label">Panel</h2>
				<div
					:class="[panelStyles.root, panelStyles.body]">Panels are for things that stand apart from the rules around them.</div>
				<div :class="[panelStyles.root, panelStyles.empty]">Empty state</div>
			</section>
		</main>
	</div>
</template>
