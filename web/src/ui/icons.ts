// Host icon set for `icon` nodes and the shell. Extensions pick a name; the
// path data is ours (16×16 grid, stroked). Unknown names get the dot.

export const ICONS: Readonly<Record<string, string>> = {
	dot: "M8 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3",
	check: "M3 8.5l3 3l7-7",
	x: "M4 4l8 8M12 4l-8 8",
	alert: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2",
	info: "M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13M8 7v4.5M8 4.8v.2",
	clock: "M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13M8 4.5V8l2.5 1.5",
	branch:
		"M5 2.5v11M5 10.5c0-3 6-2 6-6M11 2.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3",
	commit: "M1.5 8h4M10.5 8h4M8 5.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5",
	lane: "M2 4h12M2 8h12M2 12h12",
	file: "M4 1.5h5l3 3v10H4zM9 1.5v3h3",
	folder: "M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z",
	user:
		"M8 2a3 3 0 1 1 0 6a3 3 0 0 1 0-6M2.5 14.5c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5",
	users:
		"M6 2.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5M1.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3a2 2 0 0 1 0 4M12 9.6c1.4.4 2.3 1.6 2.5 3.4",
	play: "M5 3l8 5l-8 5z",
	lock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
	link:
		"M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8",
	star:
		"M8 1.8l1.9 4l4.3.5l-3.2 3l.9 4.3L8 11.4l-3.9 2.2l.9-4.3l-3.2-3l4.3-.5z",
	radar:
		"M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13M8 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7M8 8l5-3",
	gate: "M2.5 14V5l5.5-3l5.5 3v9M6 14V9h4v5",
	merge: "M5 2.5v11M5 5.5c0 3 6 2 6 6v2M5 2.5",
	agent: "M3.5 5h9v8h-9zM8 2.5V5M6 8.5v1M10 8.5v1M1.5 8v2M14.5 8v2",
	settings:
		"M8 5.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
	menu: "M2 4h12M2 8h12M2 12h12",
	sun:
		"M8 5a3 3 0 1 1 0 6a3 3 0 0 1 0-6M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
	moon: "M13 10.5A6 6 0 0 1 5.5 3a6 6 0 1 0 7.5 7.5",
	external: "M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v4h-9v-9h4",
};

export const iconPath = (name: string | undefined): string =>
	(name !== undefined && Object.hasOwn(ICONS, name)
		? ICONS[name]
		: undefined) ??
		ICONS["dot"] ?? "";
