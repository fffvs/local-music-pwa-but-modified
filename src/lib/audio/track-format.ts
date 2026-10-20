/**
 * Describes the audio format of a track for display (e.g. "FLAC 24/96").
 *
 * For FLAC, the sample rate, channel count and bit depth are read from the
 * STREAMINFO block at the start of the file. Only the first 42 bytes are read.
 */

export interface TrackFormat {
	label: string
	/** True for lossless audio above CD quality (more than 16 bits or 48 kHz). */
	hiRes: boolean
}

export interface FlacStreamInfo {
	sampleRate: number
	channels: number
	bitDepth: number
}

const FLAC_SIGNATURE = [0x66, 0x4c, 0x61, 0x43] // "fLaC"
const STREAMINFO_BLOCK_TYPE = 0
const STREAMINFO_LENGTH = 34
/** 4 bytes signature + 4 bytes block header + 34 bytes STREAMINFO. */
export const FLAC_HEADER_BYTES = 42
const STREAMINFO_OFFSET = 8
/** Byte offset of the packed sample rate / channels / bit depth field within STREAMINFO. */
const PACKED_FIELD_OFFSET = STREAMINFO_OFFSET + 18

export const isFlacHeader = (bytes: Uint8Array): boolean =>
	bytes.length >= 4 && FLAC_SIGNATURE.every((byte, i) => bytes[i] === byte)

/**
 * Parses the FLAC STREAMINFO block. Returns null if the bytes are not a FLAC
 * header or the block is malformed.
 */
export const parseFlacStreamInfo = (bytes: Uint8Array): FlacStreamInfo | null => {
	if (bytes.length < FLAC_HEADER_BYTES || !isFlacHeader(bytes)) {
		return null
	}

	const blockType = (bytes[4] ?? 0) & 0x7f
	const blockLength = ((bytes[5] ?? 0) << 16) | ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)
	if (blockType !== STREAMINFO_BLOCK_TYPE || blockLength !== STREAMINFO_LENGTH) {
		return null
	}

	const b = (offset: number) => bytes[PACKED_FIELD_OFFSET + offset] ?? 0

	// Packed big-endian fields: sample rate (20 bits), channels - 1 (3 bits),
	// bits per sample - 1 (5 bits), total samples (36 bits).
	const sampleRate = (b(0) << 12) | (b(1) << 4) | (b(2) >> 4)
	const channels = ((b(2) >> 1) & 0x07) + 1
	const bitDepth = (((b(2) & 0x01) << 4) | (b(3) >> 4)) + 1

	if (sampleRate === 0) {
		return null
	}

	return { sampleRate, channels, bitDepth }
}

/** Formats a sample rate as kHz, e.g. 44100 -> "44.1", 96000 -> "96". */
const formatKhz = (sampleRate: number): string => {
	const khz = sampleRate / 1000
	return Number.isInteger(khz) ? String(khz) : khz.toFixed(1)
}

export const formatTrackLabel = (codec: string, info: FlacStreamInfo | null): TrackFormat => {
	const name = codec.trim().toUpperCase() || 'AUDIO'

	if (!info) {
		return { label: name, hiRes: false }
	}

	const hiRes = info.bitDepth > 16 || info.sampleRate > 48_000
	return {
		label: `${name} ${info.bitDepth}/${formatKhz(info.sampleRate)}`,
		hiRes,
	}
}

/**
 * Reads the format of a loaded track file. Never throws: if the header can't
 * be read, the codec name is used as the label.
 */
export const readTrackFormat = async (file: Blob, codec: string): Promise<TrackFormat> => {
	let info: FlacStreamInfo | null = null

	try {
		const bytes = new Uint8Array(await file.slice(0, FLAC_HEADER_BYTES).arrayBuffer())
		info = parseFlacStreamInfo(bytes)
	} catch {
		info = null
	}

	const isFlac = codec.trim().toLowerCase() === 'flac' || info !== null
	return formatTrackLabel(isFlac ? 'flac' : codec, isFlac ? info : null)
}
