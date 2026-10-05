// A minimal zip reader for Playwright traces (`trace.zip`): the central
// directory, stored (0) and deflate (8) entries, nothing else. The e2e
// launcher uses it to find forge session cookies in retained traces (to
// revoke them) and to leak-scan trace text. Anything it cannot read (zip64,
// encryption, another method, an entry over the size cap) is an error, and
// the caller then deletes the trace rather than keep what it cannot check.

export type ZipEntry = { readonly name: string; readonly data: Uint8Array };

export class ZipError extends Error {
	override name = "ZipError";
}

/** Per entry, after inflation. Trace entries are a few MB at most. */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const inflateRaw = async (bytes: Uint8Array, expected: number) => {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.byteLength;
		if (total > MAX_ENTRY_BYTES) throw new ZipError("entry too large");
		chunks.push(chunk);
	}
	if (expected !== total) throw new ZipError("size mismatch after inflation");
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

export const readZip = async (bytes: Uint8Array): Promise<ZipEntry[]> => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let eocd = -1;
	for (
		let i = bytes.length - 22;
		i >= Math.max(0, bytes.length - 65_557);
		i--
	) {
		if (view.getUint32(i, true) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError("no end of central directory");
	const count = view.getUint16(eocd + 10, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (count === 0xffff || cdOffset === 0xffffffff) {
		throw new ZipError("zip64 is not supported");
	}
	const entries: ZipEntry[] = [];
	let p = cdOffset;
	for (let n = 0; n < count; n++) {
		if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) {
			throw new ZipError("bad central directory");
		}
		const flags = view.getUint16(p + 8, true);
		const method = view.getUint16(p + 10, true);
		const compressed = view.getUint32(p + 20, true);
		const size = view.getUint32(p + 24, true);
		const nameLength = view.getUint16(p + 28, true);
		const extraLength = view.getUint16(p + 30, true);
		const commentLength = view.getUint16(p + 32, true);
		const local = view.getUint32(p + 42, true);
		const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
		p += 46 + nameLength + extraLength + commentLength;
		if (flags & 0x1) throw new ZipError(`${name}: encrypted`);
		if (size > MAX_ENTRY_BYTES || compressed === 0xffffffff) {
			throw new ZipError(`${name}: too large`);
		}
		if (view.getUint32(local, true) !== LOCAL) {
			throw new ZipError(`${name}: bad local header`);
		}
		const start = local + 30 + view.getUint16(local + 26, true) +
			view.getUint16(local + 28, true);
		const raw = bytes.subarray(start, start + compressed);
		if (raw.length !== compressed) throw new ZipError(`${name}: truncated`);
		if (name.endsWith("/")) continue;
		if (method === 0) entries.push({ name, data: raw.slice() });
		else if (method === 8) {
			entries.push({ name, data: await inflateRaw(raw, size) });
		} else throw new ZipError(`${name}: compression method ${method}`);
	}
	return entries;
};
