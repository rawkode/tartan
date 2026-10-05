// A minimal in-memory Vue renderer for interaction tests in Node (no DOM
// library is a dependency). Components mount for real: lifecycle hooks run,
// promises resolve, `v-model` directives work, and events are fired by
// calling the listeners Vue registered. Elements keep attributes, DOM props
// (`value`, `checked`, `_value`) and listeners separately, so tests can assert
// exactly what would reach the DOM.

import { type Component, createRenderer, type Plugin } from "vue";

export type TestText = {
	readonly kind: "text";
	parent: TestElement | null;
	text: string;
};

export type TestComment = {
	readonly kind: "comment";
	parent: TestElement | null;
	text: string;
};

type Listener = (event: TestEvent) => unknown;

export type TestElement = {
	readonly kind: "element";
	readonly tag: string;
	parent: TestElement | null;
	readonly children: TestNode[];
	readonly attrs: Record<string, string>;
	readonly listeners: Record<string, Listener>;
	readonly domListeners: Record<string, Listener[]>;
	/** DOM properties set by the renderer or directives. */
	value: unknown;
	checked: boolean;
	selected: boolean;
	multiple: boolean;
	composing: boolean;
	type: string;
	_value: unknown;
	addEventListener: (name: string, fn: Listener) => void;
	removeEventListener: (name: string, fn: Listener) => void;
	setAttribute: (name: string, value: string) => void;
	removeAttribute: (name: string) => void;
	getAttribute: (name: string) => string | null;
	getRootNode: () => { activeElement: unknown };
	/** `<select>` options (for `v-model` on selects). */
	readonly options: TestElement[];
	selectedIndex: number;
};

export type TestNode = TestElement | TestText | TestComment;

const textNode = (text: string): TestText => ({
	kind: "text",
	parent: null,
	text,
});
const commentNode = (text: string): TestComment => ({
	kind: "comment",
	parent: null,
	text,
});

const element = (tag: string): TestElement => {
	const el: TestElement = {
		kind: "element",
		tag,
		parent: null,
		children: [],
		attrs: {},
		listeners: {},
		domListeners: {},
		value: "",
		checked: false,
		selected: false,
		multiple: false,
		composing: false,
		type: "",
		_value: undefined,
		addEventListener: (name, fn) => {
			(el.domListeners[name] ??= []).push(fn);
		},
		removeEventListener: (name, fn) => {
			el.domListeners[name] = (el.domListeners[name] ?? []).filter((f) =>
				f !== fn
			);
		},
		setAttribute: (name, value) => {
			el.attrs[name] = value;
		},
		removeAttribute: (name) => {
			delete el.attrs[name];
		},
		getAttribute: (name) => el.attrs[name] ?? null,
		getRootNode: () => ({ activeElement: null }),
		get options() {
			return findAll(el, (n) => n.tag === "option");
		},
		get selectedIndex() {
			return el.options.findIndex((o) => o.selected);
		},
		set selectedIndex(index: number) {
			el.options.forEach((o, i) => {
				o.selected = i === index;
			});
		},
	};
	return el;
};

export type TestEvent = {
	readonly type: string;
	readonly target: TestElement;
	defaultPrevented: boolean;
	preventDefault: () => void;
	stopPropagation: () => void;
	readonly key?: string;
};

const DOM_PROPS = new Set(["value", "checked", "selected", "multiple", "type"]);
const BOOLEAN_ATTRS = new Set([
	"disabled",
	"required",
	"readonly",
	"open",
	"hidden",
	"novalidate",
	"autofocus",
	"inert",
]);

const { createApp: createTestApp } = createRenderer<TestNode, TestElement>({
	createElement: (tag) => element(tag),
	createText: (text) => textNode(text),
	createComment: (text) => commentNode(text),
	setText: (node, text) => {
		(node as TestText).text = text;
	},
	setElementText: (el, text) => {
		el.children.splice(0, el.children.length);
		if (text !== "") {
			const t = textNode(text);
			t.parent = el;
			el.children.push(t);
		}
	},
	insert: (child, parent, anchor) => {
		if (child.parent) {
			const old = child.parent.children.indexOf(child);
			if (old !== -1) child.parent.children.splice(old, 1);
		}
		const index = anchor ? parent.children.indexOf(anchor) : -1;
		if (index === -1) parent.children.push(child);
		else parent.children.splice(index, 0, child);
		child.parent = parent;
	},
	remove: (child) => {
		const parent = child.parent;
		if (!parent) return;
		const index = parent.children.indexOf(child);
		if (index !== -1) parent.children.splice(index, 1);
		child.parent = null;
	},
	parentNode: (node) => node.parent,
	nextSibling: (node) => {
		const parent = node.parent;
		if (!parent) return null;
		return parent.children[parent.children.indexOf(node) + 1] ?? null;
	},
	patchProp: (el, key, _prev, next) => {
		if (/^on[A-Z]/.test(key)) {
			const name = key.slice(2).replace(/(Once|Passive|Capture)+$/, "")
				.toLowerCase();
			if (typeof next === "function") el.listeners[name] = next as Listener;
			else if (Array.isArray(next)) {
				el.listeners[name] = (e) => next.forEach((f) => (f as Listener)(e));
			} else delete el.listeners[name];
			return;
		}
		if (DOM_PROPS.has(key)) {
			(el as unknown as Record<string, unknown>)[key] = next;
			if (key === "value") el._value = next;
			if (next === null || next === undefined || next === false) {
				el.removeAttribute(key);
			} else el.setAttribute(key, next === true ? "" : String(next));
			return;
		}
		if (key === "class" || key === "style") {
			if (next === null || next === undefined || next === "") {
				el.removeAttribute(key);
			} else el.setAttribute(key, String(next));
			return;
		}
		// As runtime-dom: boolean attributes are present or absent; any other
		// attribute stringifies its value (`aria-selected="false"`).
		if (BOOLEAN_ATTRS.has(key)) {
			if (next === null || next === undefined || next === false) {
				el.removeAttribute(key);
			} else el.setAttribute(key, "");
		} else if (next === null || next === undefined) el.removeAttribute(key);
		else el.setAttribute(key, String(next));
	},
	insertStaticContent: (content, parent, anchor) => {
		const holder = element("static");
		holder.attrs["data-static"] = content;
		const index = anchor ? parent.children.indexOf(anchor) : -1;
		if (index === -1) parent.children.push(holder);
		else parent.children.splice(index, 0, holder);
		holder.parent = parent;
		return [holder, holder];
	},
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const findAll = (
	root: TestElement,
	predicate: (el: TestElement) => boolean,
): TestElement[] => {
	const out: TestElement[] = [];
	const walk = (node: TestNode): void => {
		if (node.kind !== "element") return;
		if (node !== root && predicate(node)) out.push(node);
		node.children.forEach(walk);
	};
	walk(root);
	return out;
};

export const textOf = (node: TestNode): string =>
	node.kind === "text"
		? node.text
		: node.kind === "comment"
		? ""
		: node.children.map(textOf).join("");

/** Normalized visible text (whitespace collapsed). */
export const text = (node: TestNode): string =>
	textOf(node).replace(/\s+/g, " ").trim();

export const byTag = (root: TestElement, tag: string): TestElement[] =>
	findAll(root, (el) => el.tag === tag);

export const byText = (
	root: TestElement,
	tag: string,
	match: string | RegExp,
): TestElement | null =>
	findAll(root, (el) =>
		el.tag === tag &&
		(typeof match === "string"
			? text(el).includes(match)
			: match.test(text(el))))[0] ?? null;

export const byAttr = (
	root: TestElement,
	name: string,
	value?: string,
): TestElement[] =>
	findAll(
		root,
		(el) =>
			name in el.attrs && (value === undefined || el.attrs[name] === value),
	);

/** Serializes the tree to HTML-ish text (for "nothing injected" assertions). */
export const html = (node: TestNode): string => {
	if (node.kind === "text") {
		return node.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	}
	if (node.kind === "comment") return "";
	const attrs = Object.entries(node.attrs).map(([k, v]) =>
		` ${k}="${v.replace(/"/g, "&quot;")}"`
	).join("");
	const listeners = Object.keys(node.listeners).map((k) => ` @${k}`).join("");
	return `<${node.tag}${attrs}${listeners}>${
		node.children.map(html).join("")
	}</${node.tag}>`;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const fire = (
	el: TestElement,
	type: string,
	init: { key?: string } = {},
): TestEvent => {
	const event: TestEvent = {
		type,
		target: el,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {},
		...init,
	};
	el.listeners[type]?.(event);
	for (const fn of el.domListeners[type] ?? []) fn(event);
	return event;
};

export const click = (el: TestElement): TestEvent => fire(el, "click");

/** Types into an input/textarea (sets `value`, fires `input`). */
export const type = (el: TestElement, value: string): void => {
	el.value = value;
	fire(el, "input");
};

/** Picks the option of a select whose text or value matches. */
export const choose = (select: TestElement, match: string): void => {
	const options = select.options;
	const index = options.findIndex((o) =>
		text(o) === match || String(o.value) === match
	);
	if (index === -1) throw new Error(`no option ${match}`);
	select.selectedIndex = index;
	select.value = options[index]?.value ?? "";
	fire(select, "change");
};

export const check = (el: TestElement, checked = true): void => {
	el.checked = checked;
	fire(el, "change");
};

export const submit = (form: TestElement): TestEvent => fire(form, "submit");

/** Lets pending promises and Vue's scheduler settle. */
export const flush = async (rounds = 8): Promise<void> => {
	for (let i = 0; i < rounds; i += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
};

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export type Mounted = {
	readonly root: TestElement;
	readonly unmount: () => void;
};

export const mount = (
	component: Component,
	options: {
		readonly props?: Record<string, unknown>;
		readonly provide?: readonly (readonly [symbol | string, unknown])[];
		readonly plugins?: readonly Plugin[];
	} = {},
): Mounted => {
	// `v-model` reads `document.activeElement`; set a stub only now, after
	// vue-router evaluated its `isBrowser` check at import time.
	const g = globalThis as {
		document?: unknown;
		Document?: unknown;
		ShadowRoot?: unknown;
	};
	g.document ??= { activeElement: null, title: "" };
	// `instanceof` targets for vModelText's focus check (never matched here).
	g.Document ??= function Document() {};
	g.ShadowRoot ??= function ShadowRoot() {};
	const root = element("root");
	const app = createTestApp(component, options.props);
	for (const [key, value] of options.provide ?? []) app.provide(key, value);
	for (const plugin of options.plugins ?? []) app.use(plugin);
	app.mount(root);
	return { root, unmount: () => app.unmount() };
};
