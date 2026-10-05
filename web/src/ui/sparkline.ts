// Sparkline geometry: numbers → an SVG polyline `points` string. Non-finite
// values are dropped; a flat series sits in the middle.

export type Sparkline = {
	readonly points: string;
	readonly min: number;
	readonly max: number;
	readonly last: number | null;
	readonly count: number;
};

export const sparkline = (
	values: readonly number[],
	width = 120,
	height = 28,
	pad = 2,
): Sparkline => {
	const finite = values.filter((v) => Number.isFinite(v)).slice(-240);
	if (finite.length === 0) {
		return { points: "", min: 0, max: 0, last: null, count: 0 };
	}
	const min = Math.min(...finite);
	const max = Math.max(...finite);
	const span = max - min;
	const innerH = height - pad * 2;
	const step = finite.length > 1 ? (width - pad * 2) / (finite.length - 1) : 0;
	const points = finite.map((v, i) => {
		const x = pad + (finite.length > 1 ? i * step : (width - pad * 2) / 2);
		const y = span === 0
			? height / 2
			: pad + innerH - ((v - min) / span) * innerH;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	return {
		points: points.join(" "),
		min,
		max,
		last: finite[finite.length - 1] ?? null,
		count: finite.length,
	};
};
