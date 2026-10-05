// @tartan/gitproto (WP22): git smart-HTTP protocol codecs, the fail-closed
// request parsers, advertisement rewriters, the report-status synthesizer,
// the side-band relay, a minimal pack writer, and the v2 `ls-refs` and
// receive-pack clients the kernel uses for reconciliation and ref-only
// writes. Pure Web-platform code (streams, `fetch`, `CompressionStream`,
// `DecompressionStream`, WebCrypto): no Cloudflare bindings, no tokens of
// its own, no policy decisions.
//
// Consumers: WP4 (gateway: `peekCommands`, `parseUploadRequest`, the
// rewriters, `synthReportStatus`, `createReceivePackRelay`, and after M1
// `parseCapRequest`, `synthCapAdvertisement`, `readUpstreamTip`,
// `stripV0Trailer`), WP5a (reconciliation: `lsRefs`), WP5b
// (`LaneBackend.readTip`: `lsRefs`), WP10 (`refWrite`: `pushRefs`; genesis:
// `writePack`) and WP20 (`writePack`).
//
// Rejections carry the wire reason codes of `@tartan/contract/kernel`:
// `UPLOAD_REASONS` for upload-pack requests (answered `ERR <reason>`) and
// `REF_POLICY_REASONS` for receive-pack command sections (answered `ng <ref>
// <reason>` for every command parsed so far, or a 400 when none was); each
// rejection also carries a finer `code` for logs and tests.

export type { Bytes } from "./bytes.ts";
export {
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
	PKT_DELIM,
	PKT_FLUSH,
	PKT_MAX_LENGTH,
	PKT_RESPONSE_END,
	type PktErrorCode,
	type PktLine,
	SIDE_BAND_MAX_DATA,
} from "./pktline.ts";
export {
	type CapabilityAllowlist,
	isAllowedCapability,
	RECEIVE_PACK_CAPABILITIES,
	UPLOAD_PACK_V0_CAPABILITIES,
	UPLOAD_PACK_V2_CAPABILITIES,
} from "./capabilities.ts";
export { checkRefnameFormat, isValidPushRefname } from "./refname.ts";
export {
	MAX_COMMANDS,
	peekCommands,
	type PeekCommandsResult,
	type PeekLimits,
	RECEIVE_ERROR_REASONS,
	RECEIVE_SECTION_MAX_BYTES,
	type ReceiveErrorCode,
	type ReceiveRejection,
} from "./receive.ts";
export {
	isAllowedFilterSpec,
	isProtocolV2,
	parseUploadRequest,
	PUBLIC_VIEW_PROFILE,
	UPLOAD_DECODE_MAX_BYTES,
	type UploadErrorCode,
	type UploadProfile,
	type UploadRejection,
	type UploadRequest,
	type UploadRequestOptions,
	V2_REQUEST_CAPABILITIES,
} from "./upload.ts";
export {
	type AdvertisementOptions,
	rewriteAdvertisement,
	rewriteLsRefsResponse,
	rewriteV2Capabilities,
} from "./advertisement.ts";
export {
	encodeReport,
	negotiateCaps,
	type NegotiatedCaps,
	parseReportStatus,
	type RefOptions,
	type RefStatus,
	type ReportStatus,
	synthReportStatus,
} from "./report.ts";
export {
	type Demuxed,
	demuxSideband,
	encodeBand2Lines,
	encodeSideband,
	sanitizeBand2Line,
	type SideBand,
} from "./sideband.ts";
export {
	createReceivePackRelay,
	type ReceivePackRelay,
	type ReceivePackRelayOptions,
	RELAY_HOLD_BACK_MAX_BYTES,
	RELAY_MAX_HOLD_MS,
} from "./relay.ts";
export {
	encodeCommit,
	encodeTree,
	hashObject,
	type PackObject,
	type Signature,
	type TreeEntryInput,
	type TreeMode,
	writePack,
} from "./pack.ts";
export {
	CLIENT_AGENT,
	type ClientOptions,
	type GitRemote,
	type LsRef,
	lsRefs,
	parseLsRefs,
	pushRefs,
} from "./client.ts";
export {
	CAP_ROUTE_AGENT,
	CAP_ROUTE_PROFILE,
	CAP_ROUTE_V0_CAPABILITIES,
	CAP_ROUTE_V2_CAPABILITIES,
	type CapRequest,
	type CapRequestOptions,
	parseCapRequest,
	readUpstreamTip,
	stripV0Trailer,
	synthCapAdvertisement,
	synthCapV2Capabilities,
} from "./cap.ts";
