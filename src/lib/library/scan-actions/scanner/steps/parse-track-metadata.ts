import { parseWebStream } from 'music-metadata'
import { CURRENT_METADATA_VERSION, type ParsedTrackData, UNKNOWN_ITEM } from '$lib/library/types.ts'

const artistSeparatorRegex = /,|&/

/** @public */
export const parseTrackMetadata = async (
	file: File,
): Promise<{ data: ParsedTrackData; imageBlob?: Blob } | null> => {
	// No file size cap: the parse below only reads the header region, so
	// memory and time are independent of the total file size. A size limit
	// here would silently drop large lossless files (e.g. 10 GB FLAC) from
	// the library.

	// STREAMING PARSE: Only reads the metadata headers (typically < 5MB)
	// instead of loading the entire file into RAM.
	// For a 1GB FLAC, this turns a 10+ second read into ~50ms.
	//
	// file.stream() returns a ReadableStream that music-metadata reads
	// incrementally. With skipPostHeaders: true, it stops reading as soon
	// as the last metadata block (VORBIS_COMMENT, PICTURE) ends — the
	// gigabytes of audio frame data are never touched.
	const stream = file.stream()

	try {
		const tags = await parseWebStream(
			stream,
			{
				mimeType: file.type,
				size: file.size,
			},
			{
				duration: true,
				skipPostHeaders: true,
			},
		)

		const { common } = tags

		let imageBlob: Blob | undefined
		const picture = common.picture?.[0]
		if (picture) {
			const imageData = new Uint8ClampedArray(picture.data)
			imageBlob = new Blob([imageData], { type: picture.format })
		}

		const artists =
			common.artists
				?.flatMap((artist) => artist.split(artistSeparatorRegex))
				.map((artist) => artist.trim()) ?? []

		const trackData: ParsedTrackData = {
			name: common.title || file.name,
			album: common.album ?? UNKNOWN_ITEM,
			artists: artists.length > 0 ? artists : [UNKNOWN_ITEM],
			genre: common.genre || [],
			trackNo: common.track.no ?? 0,
			trackOf: common.track.of ?? 0,
			discNo: common.disk.no ?? 0,
			discOf: common.disk.of ?? 0,
			year: common.year?.toString() ?? UNKNOWN_ITEM,
			duration: tags.format.duration ?? 0,
			language: common.language?.trim() ?? '',
			metadataVersion: CURRENT_METADATA_VERSION,
			format: {
				codec: tags.format.codec ?? '',
			},
		}

		return {
			data: trackData,
			imageBlob,
		}
	} finally {
		// Ensure the stream is closed even if parsing throws,
		// so the browser can release the underlying file handle.
		try {
			await stream.cancel()
		} catch {}
	}
}