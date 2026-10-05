// Display formatting shared by the renderer and the views. Pure, locale-stable
// enough for tests (no assertions depend on the runtime locale).

const NUMBER = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export const formatNumber = (value: number): string =>
	Number.isFinite(value)
		? Math.abs(value) >= 100_000 ? COMPACT.format(value) : NUMBER.format(value)
		: "—";

/** Epoch milliseconds (events, timelines) → ISO string for `<time datetime>`. */
export const isoTime = (ms: number): string => {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const DATE_TIME = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export const formatTime = (ms: number): string => {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
};

/** "3 min ago" style relative time against `now` (both epoch ms). */
export const relativeTime = (ms: number, now: number): string => {
	const seconds = Math.round((now - ms) / 1000);
	const abs = Math.abs(seconds);
	const suffix = seconds >= 0 ? "ago" : "from now";
	if (abs < 45) return seconds >= 0 ? "just now" : "in a moment";
	if (abs < 90 * 60) return `${Math.round(abs / 60)} min ${suffix}`;
	if (abs < 36 * 3600) return `${Math.round(abs / 3600)} h ${suffix}`;
	return `${Math.round(abs / 86400)} d ${suffix}`;
};

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
};

export const shortSha = (sha: string): string => sha.slice(0, 7);
