import { describe, expect, it } from 'vitest'
import {
	FLAC_HEADER_BYTES,
	formatTrackLabel,
	parseFlacStreamInfo,
	readTrackFormat,
} from '../track-format.ts'

/** Builds the first 42 bytes of a FLAC file with a STREAMINFO block. */
const buildFlacHeader = (sampleRate: number, channels: number, bitDepth: number): Uint8Array => {
	const bytes = new Uint8Array(FLAC_HEADER_BYTES)
	bytes.set([0x66, 0x4c, 0x61, 0x43], 0) // "fLaC"
	bytes[4] = 0x80 // last-block flag, STREAMINFO type 0
	bytes[7] = 34 // block length

	// Packed 64-bit field: sample rate (20) | channels-1 (3) | bps-1 (5) | total samples (36)
	const packed =
		(BigInt(sampleRate) << 44n) |
		(BigInt(channels - 1) << 41n) |
		(BigInt(bitDepth - 1) << 36n) |
		0n
	const view = new DataView(bytes.buffer)
	view.setBigUint64(8 + 18, packed)
	return bytes
}

describe('parseFlacStreamInfo', () => {
	it('reads sample rate, channels and bit depth', () => {
		expect(parseFlacStreamInfo(buildFlacHeader(96_000, 2, 24))).toEqual({
			sampleRate: 96_000,
			channels: 2,
			bitDepth: 24,
		})
	})

	it('reads CD quality audio', () => {
		expect(parseFlacStreamInfo(buildFlacHeader(44_100, 2, 16))).toEqual({
			sampleRate: 44_100,
			channels: 2,
			bitDepth: 16,
		})
	})

	it('returns null for non-FLAC bytes', () => {
		expect(parseFlacStreamInfo(new Uint8Array(FLAC_HEADER_BYTES))).toBeNull()
	})

	it('returns null when the header is too short', () => {
		expect(parseFlacStreamInfo(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))).toBeNull()
	})

	it('returns null when the first block is not STREAMINFO', () => {
		const bytes = buildFlacHeader(44_100, 2, 16)
		bytes[4] = 0x84 // block type 4 (VORBIS_COMMENT)
		expect(parseFlacStreamInfo(bytes)).toBeNull()
	})
})

describe('formatTrackLabel', () => {
	it('labels FLAC with bit depth and kHz', () => {
		const info = { sampleRate: 96_000, channels: 2, bitDepth: 24 }
		expect(formatTrackLabel('flac', info)).toEqual({ label: 'FLAC 24/96', hiRes: true })
	})

	it('keeps one decimal for 44.1 kHz multiples', () => {
		const info = { sampleRate: 44_100, channels: 2, bitDepth: 16 }
		expect(formatTrackLabel('flac', info)).toEqual({ label: 'FLAC 16/44.1', hiRes: false })
	})

	it('marks 192 kHz as hi-res', () => {
		const info = { sampleRate: 192_000, channels: 2, bitDepth: 24 }
		expect(formatTrackLabel('flac', info).label).toBe('FLAC 24/192')
		expect(formatTrackLabel('flac', info).hiRes).toBe(true)
	})

	it('falls back to the codec name without header info', () => {
		expect(formatTrackLabel('mp3', null)).toEqual({ label: 'MP3', hiRes: false })
	})
})

describe('readTrackFormat', () => {
	it('reads FLAC format from the file header', async () => {
		const file = new Blob([Uint8Array.from(buildFlacHeader(192_000, 2, 24))])
		expect(await readTrackFormat(file, 'flac')).toEqual({ label: 'FLAC 24/192', hiRes: true })
	})

	it('uses the codec name for non-FLAC files', async () => {
		const file = new Blob([Uint8Array.from([0x49, 0x44, 0x33, 0x04])])
		expect(await readTrackFormat(file, 'mp3')).toEqual({ label: 'MP3', hiRes: false })
	})

	it('still labels FLAC when the header cannot be read', async () => {
		const file = new Blob([Uint8Array.from([0x66, 0x4c])])
		expect(await readTrackFormat(file, 'flac')).toEqual({ label: 'FLAC', hiRes: false })
	})
})
