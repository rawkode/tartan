// A tiny zip writer for the launcher's tests (stored and deflate entries,
// no CRC: the reader under test does not check it). Deno only.

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [
	n & 0xff,
	(n >> 8) & 0xff,
	(n >> 16) & 0xff,
	(n >>> 24) & 0xff,
];

const deflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream()
		.pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const writeZip = async (
	files: Readonly<Record<string, string | Uint8Array>>,
	options: { readonly deflate?: boolean } = {},
): Promise<Uint8Array> => {
	const encoder = new TextEncoder();
	const locals: number[] = [];
	const central: number[] = [];
	let count = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = [...encoder.encode(name)];
		const data = typeof content === "string"
			? encoder.encode(content)
			: content;
		const method = options.deflate ? 8 : 0;
		const stored = options.deflate ? await deflateRaw(data) : data;
		const offset = locals.length;
		locals.push(
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(method),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(stored.length),
			...u32(data.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...stored,
		);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(method),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(stored.length),
			...u32(data.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
		count++;
	}
	const eocd = [
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(count),
		...u16(count),
		...u32(central.length),
		...u32(locals.length),
		...u16(0),
	];
	return new Uint8Array([...locals, ...central, ...eocd]);
};
