import { dbGetImageRecord } from '$lib/library/images'
import type { Album, Track } from '$lib/library/types.ts'
import { getOrInsertAsync } from './get-or-insert-async.ts'

// Low-level JavaScript FinalizationRegistry safety net
const blobUrlSafetyNet = new FinalizationRegistry((url: string) => {
	try {
		URL.revokeObjectURL(url)
		if (localStorage.getItem('debug-blob-gc') === '1') {
			console.debug('[Blob GC] Reclaimed leaked artwork URL:', url)
		}
	} catch {}
})

class Artwork {
	cacheKey: string
	url: string
	#refCount = 0

	constructor(cacheKey: string, blob: Blob) {
		this.cacheKey = cacheKey
		this.url = URL.createObjectURL(blob)
		blobUrlSafetyNet.register(this, this.url)
	}

	acquire() {
		this.#refCount += 1
	}

	release() {
		this.#refCount -= 1
		if (this.#refCount === 0) {
			scheduleCleanup(this)
		}
	}

	disposeIfUnused() {
		if (this.#refCount > 0) {
			return
		}

		if (cache.get(this.cacheKey) === this) {
			cache.delete(this.cacheKey)
		}
		URL.revokeObjectURL(this.url)
	}
}

const cache = new Map<string, Artwork | Promise<Artwork | undefined>>()

const cleanupQueue = new Set<Artwork>()
let isCleanupScheduled = false
const scheduleCleanup = (artwork: Artwork) => {
	cleanupQueue.add(artwork)

	if (isCleanupScheduled) {
		return
	}

	isCleanupScheduled = true
	const oneMinute = 60 * 1000
	setTimeout(() => {
		for (const queued of cleanupQueue) {
			queued.disposeIfUnused()
		}
		cleanupQueue.clear()
		isCleanupScheduled = false
	}, oneMinute)
}

type ArtworkSourceImageSize = 'full' | 'small'

type ArtworkSource =
	| {
			type: 'blob'
			cacheKey: string
			blob: Blob
			size: ArtworkSourceImageSize
	  }
	| {
			type: 'imageHash'
			imageHash: string
			cacheKey: string
			size: ArtworkSourceImageSize
	  }

/**
 * Maximum pixel dimensions for each artwork size tier.
 * Keeps GPU texture uploads tiny and eliminates scan-line rendering.
 * - 'full' (player view): 800px — crisp on 2x retina at 400px display
 * - 'small' (list/grid thumbnails): 150px — more than enough for ~64px tiles
 */
const MAX_DIMENSIONS: Record<ArtworkSourceImageSize, number> = {
	full: 800,
	small: 150,
}

/**
 * Downscale an image blob off the main thread using createImageBitmap + OffscreenCanvas.
 * This prevents the browser from uploading a 3000×3000 texture to the GPU.
 * If the image is already smaller than maxDimension, it passes through untouched.
 */
const resizeBlobIfNeeded = async (blob: Blob, maxDimension: number): Promise<Blob> => {
	// createImageBitmap decodes on the browser's image thread, not the main thread
	const bitmap = await createImageBitmap(blob)

	const { width, height } = bitmap

	// Already small enough — no resize needed
	if (width <= maxDimension && height <= maxDimension) {
		bitmap.close()
		return blob
	}

	// Calculate aspect-ratio-preserving target dimensions
	const scale = maxDimension / Math.max(width, height)
	const targetWidth = Math.round(width * scale)
	const targetHeight = Math.round(height * scale)

	const canvas = new OffscreenCanvas(targetWidth, targetHeight)
	const ctx = canvas.getContext('2d')
	if (!ctx) {
		bitmap.close()
		throw new Error('Could not create artwork canvas context')
	}
	// imageSmoothingQuality 'medium' is the sweet spot: fast + good enough for album art
	ctx.imageSmoothingQuality = 'medium'
	ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)

	// Immediately free the full-resolution bitmap from memory
	bitmap.close()

	return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
}

const fetchArtwork = async (source: ArtworkSource): Promise<Artwork | undefined> => {
	let blob: Blob | undefined
	let alreadyThumbnail = false
	if (source.type === 'imageHash') {
		const record = await dbGetImageRecord(source.imageHash)
		blob = source.size === 'full' ? record?.full : record?.small
		alreadyThumbnail = source.size === 'small' && Boolean(record?.optimized)
	} else {
		blob = source.blob
	}

	if (!blob) {
		return undefined
	}

	// Stored thumbnails are already small; do not decode them a second time.
	const resizedBlob = alreadyThumbnail
		? blob
		: await resizeBlobIfNeeded(blob, MAX_DIMENSIONS[source.size])
	const artwork = new Artwork(source.cacheKey, resizedBlob)

	scheduleCleanup(artwork)

	return artwork
}

export const createManagedArtwork = (getSource: () => ArtworkSource | null | undefined) => {
	let artworkUrl = $state<string>()

	$effect.pre(() => {
		const source = getSource()
		if (!source) {
			artworkUrl = undefined
			return
		}

		let released = false
		let acquired: Artwork | undefined

		const acquire = (artwork: Artwork | undefined) => {
			if (released) {
				return
			}

			if (artwork) {
				artwork.acquire()
				acquired = artwork
			}

			artworkUrl = artwork?.url
		}

		const result = getOrInsertAsync(cache, source.cacheKey, () => fetchArtwork(source))

		if (result instanceof Promise) {
			void result.then(acquire).catch((error: unknown) => {
				console.error('Failed to load artwork', error)
				acquire(undefined)
			})
		} else {
			acquire(result)
		}

		return () => {
			released = true
			acquired?.release()
		}
	})

	return () => artworkUrl
}

/** @public */
export const getTrackManagedArtworkSource = (
	track: Track | undefined,
	size: ArtworkSourceImageSize,
): ArtworkSource | null => {
	if (!track) {
		return null
	}

	if (track.imageHash) {
		return {
			type: 'imageHash',
			imageHash: track.imageHash,
			cacheKey: `${track.imageHash}-${size}`,
			size,
		}
	}

	if (track.image) {
		return {
			type: 'blob',
			cacheKey: `track-${track.id}-${size}`,
			blob: size === 'full' ? track.image.full : track.image.small,
			size,
		}
	}

	return null
}

/** @public */
export const getAlbumManagedArtworkSource = (
	album: Album | undefined,
	size: ArtworkSourceImageSize = 'full',
): ArtworkSource | null => {
	if (!album) {
		return null
	}

	if (album.imageHash) {
		return {
			type: 'imageHash',
			imageHash: album.imageHash,
			cacheKey: `${album.imageHash}-${size}`,
			size,
		}
	}

	if (album.image) {
		return {
			type: 'blob',
			cacheKey: `album-${album.id}-${size}`,
			blob: album.image,
			size,
		}
	}

	return null
}
