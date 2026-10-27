import { getDatabase } from '$lib/db/database.ts'
import { type DatabaseChangeDetails, dispatchDatabaseChangedEvent } from '$lib/db/events.ts'
import { type FileEntity, walkMusicDirectory } from '$lib/helpers/file-system.ts'
import { sha256Hex } from '$lib/helpers/hash.ts'
import {
	CURRENT_METADATA_VERSION,
	type ImageRecord,
	LEGACY_NO_NATIVE_DIRECTORY,
	type Track,
	type UnknownTrack,
} from '$lib/library/types.ts'
import type { ScanGate } from './scan-gate.ts'
import { createImageRecord } from './steps/create-image-record.ts'
import { dbImportTracksBatch, type TrackImport } from './steps/import-track.ts'
import { parseTrackMetadata } from './steps/parse-track-metadata.ts'
import type {
	LegacyScanFile,
	TracksScanProgress,
	TracksScanResult,
	TracksScanWorkerOptions,
} from './types.ts'

const IMPORT_BATCH_SIZE = 25
const MAX_BATCH_ARTWORK_BYTES = 8 * 1024 * 1024
const MAX_CACHED_ARTWORKS = 16
const MAX_CACHED_ARTWORK_BYTES = 16 * 1024 * 1024
const MAX_LEGACY_ARTWORK_CHECKS = 64
const PROGRESS_INTERVAL_MS = 250
const CHANGE_NOTIFICATION_INTERVAL_MS = 1000
const MAX_PENDING_CHANGES = 500

interface DiscoveredFile {
	file: FileEntity
	relativePath: string
	companionArtwork?: Blob
	companionArtworkUnavailable: boolean
}

interface PendingImport {
	item: TrackImport
	countsAsImport: boolean
}

interface ArtworkEntry {
	imageHash: string
	primaryColor: number | undefined
	record: ImageRecord
}

class StatusTracker {
	readonly result: TracksScanResult = {
		newlyImported: 0,
		current: 0,
		failed: 0,
		cancelled: false,
	}

	readonly #gate: ScanGate
	readonly #onProgress: (progress: TracksScanProgress) => void
	#lastSent = 0
	#timer: ReturnType<typeof setTimeout> | null = null

	constructor(gate: ScanGate, onProgress: (progress: TracksScanProgress) => void) {
		this.#gate = gate
		this.#onProgress = onProgress
	}

	send(force = false): void {
		const remaining = PROGRESS_INTERVAL_MS - (Date.now() - this.#lastSent)
		if (force || remaining <= 0) {
			this.#post()
		} else if (this.#timer === null) {
			this.#timer = setTimeout(() => this.#post(), remaining)
		}
	}

	close(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer)
			this.#timer = null
		}
	}

	#post(): void {
		this.close()
		this.#lastSent = Date.now()
		this.#onProgress({
			...this.result,
			pauseReason: this.#gate.pauseReason,
			stopping: this.#gate.signal.aborted && !this.result.cancelled,
		})
	}
}

const isQuotaError = (error: unknown): boolean =>
	error instanceof Error && error.name === 'QuotaExceededError'

/** Coalesce already-committed changes so live lists do not refetch on every batch. */
class ChangeNotifier {
	#changes: DatabaseChangeDetails[] = []
	#timer: ReturnType<typeof setTimeout> | null = null

	add = (changes: DatabaseChangeDetails[]): void => {
		this.#changes.push(...changes)
		if (this.#changes.length >= MAX_PENDING_CHANGES) {
			this.flush()
		} else if (this.#timer === null) {
			this.#timer = setTimeout(() => this.flush(), CHANGE_NOTIFICATION_INTERVAL_MS)
		}
	}

	flush(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer)
			this.#timer = null
		}
		if (this.#changes.length > 0) {
			const changes = this.#changes
			this.#changes = []
			dispatchDatabaseChangedEvent(changes)
		}
	}
}

class TrackProcessor {
	readonly #tracker: StatusTracker
	readonly #notifier = new ChangeNotifier()
	readonly #imageCache = new Map<string, ArtworkEntry>()
	readonly #blobCache = new WeakMap<Blob, ArtworkEntry>()
	readonly #legacyArtworkChecks = new Map<string, boolean>()
	#cachedArtworkBytes = 0
	#batch: PendingImport[] = []
	#batchArtworkBytes = 0
	#batchArtworkHashes = new Set<string>()

	constructor(tracker: StatusTracker) {
		this.#tracker = tracker
	}

	async #resolveArtwork(blob: Blob): Promise<ArtworkEntry> {
		const cachedBlob = this.#blobCache.get(blob)
		if (cachedBlob) {
			return cachedBlob
		}

		const hash = await sha256Hex(blob)
		const cached = this.#imageCache.get(hash)
		if (cached) {
			this.#imageCache.delete(hash)
			this.#imageCache.set(hash, cached)
			this.#blobCache.set(blob, cached)
			return cached
		}

		const db = await getDatabase()
		const existing = await db.get('images', hash)
		const record =
			existing?.full && existing.small ? existing : await createImageRecord(blob, hash)
		const entry: ArtworkEntry = { imageHash: hash, primaryColor: record.primaryColor, record }
		const bytes = record.full.size + record.small.size

		if (bytes <= MAX_CACHED_ARTWORK_BYTES) {
			this.#imageCache.set(hash, entry)
			this.#cachedArtworkBytes += bytes
			while (
				this.#imageCache.size > MAX_CACHED_ARTWORKS ||
				this.#cachedArtworkBytes > MAX_CACHED_ARTWORK_BYTES
			) {
				const oldest = this.#imageCache.entries().next().value
				if (!oldest) {
					break
				}
				const [key, value] = oldest
				this.#cachedArtworkBytes -= value.record.full.size + value.record.small.size
				this.#imageCache.delete(key)
			}
		}
		this.#blobCache.set(blob, entry)
		return entry
	}

	async #enqueue(item: TrackImport, countsAsImport: boolean): Promise<void> {
		const image = item.imageRecord
		const imageBytes = image ? image.full.size + image.small.size : 0
		let additionalBytes = image && !this.#batchArtworkHashes.has(image.hash) ? imageBytes : 0

		if (
			this.#batch.length > 0 &&
			(this.#batch.length >= IMPORT_BATCH_SIZE ||
				this.#batchArtworkBytes + additionalBytes > MAX_BATCH_ARTWORK_BYTES)
		) {
			await this.flush()
			additionalBytes = imageBytes
		}

		this.#batch.push({ item, countsAsImport })
		if (image) {
			this.#batchArtworkHashes.add(image.hash)
		}
		this.#batchArtworkBytes += additionalBytes
		if (
			this.#batch.length >= IMPORT_BATCH_SIZE ||
			this.#batchArtworkBytes >= MAX_BATCH_ARTWORK_BYTES
		) {
			await this.flush()
		}
	}

	async #hasUsableArtwork(track: Track): Promise<boolean> {
		// Only inspect pre-migration records; new batches write images atomically.
		if (
			!track.imageHash ||
			(track.fileSize !== undefined && track.fileLastModified !== undefined)
		) {
			return true
		}
		const cached = this.#legacyArtworkChecks.get(track.imageHash)
		if (cached !== undefined) {
			return cached
		}
		const record = await (await getDatabase()).get('images', track.imageHash)
		const usable = Boolean(record?.full && record.small)
		this.#legacyArtworkChecks.set(track.imageHash, usable)
		if (this.#legacyArtworkChecks.size > MAX_LEGACY_ARTWORK_CHECKS) {
			const oldest = this.#legacyArtworkChecks.keys().next().value
			if (oldest !== undefined) {
				this.#legacyArtworkChecks.delete(oldest)
			}
		}
		return usable
	}

	async process(
		discovered: DiscoveredFile,
		directoryId: number,
		scannedAt: number,
	): Promise<void> {
		const existing = await findExistingTrack(discovered, directoryId)
		const file =
			discovered.file instanceof File ? discovered.file : await discovered.file.getFile()

		if (
			existing &&
			canReuseMetadata(existing, file) &&
			(await this.#hasUsableArtwork(existing))
		) {
			const needsUpdate =
				existing.relativePath !== discovered.relativePath ||
				existing.fileSize !== file.size ||
				existing.fileLastModified !== file.lastModified ||
				(discovered.companionArtworkUnavailable && !existing.artworkPending)

			if (needsUpdate) {
				await this.#enqueue(
					{
						metadata: {
							...existing,
							file: discovered.file,
							relativePath: discovered.relativePath,
							fileSize: file.size,
							fileLastModified: file.lastModified,
							artworkPending:
								discovered.companionArtworkUnavailable || existing.artworkPending,
						},
						existingTrackId: existing.id,
					},
					false,
				)
			}
			return
		}

		const parsed = await parseTrackMetadata(file)
		if (!parsed) {
			throw new Error(`No metadata for ${file.name}`)
		}

		const imageBlob = parsed.imageBlob ?? discovered.companionArtwork
		const artwork = imageBlob ? await this.#resolveArtwork(imageBlob) : undefined
		const keepExistingArtwork = !parsed.imageBlob && discovered.companionArtworkUnavailable
		const metadata: UnknownTrack = {
			...parsed.data,
			imageHash:
				artwork?.imageHash ?? (keepExistingArtwork ? existing?.imageHash : undefined),
			image: keepExistingArtwork && !artwork ? existing?.image : undefined,
			primaryColor:
				artwork?.primaryColor ?? (keepExistingArtwork ? existing?.primaryColor : undefined),
			file: discovered.file,
			directory: directoryId,
			fileName: discovered.file.name,
			relativePath: discovered.relativePath,
			fileSize: file.size,
			fileLastModified: file.lastModified,
			artworkPending: keepExistingArtwork,
			scannedAt,
			uuid: existing?.uuid ?? crypto.randomUUID(),
		}
		await this.#enqueue(
			{ metadata, existingTrackId: existing?.id, imageRecord: artwork?.record },
			true,
		)
	}

	async flush(): Promise<void> {
		if (this.#batch.length === 0) {
			return
		}

		const batch = this.#batch
		this.#batch = []
		this.#batchArtworkBytes = 0
		this.#batchArtworkHashes.clear()

		try {
			await dbImportTracksBatch(
				batch.map(({ item }) => item),
				this.#notifier.add,
			)
			this.#tracker.result.newlyImported += batch.filter(
				({ countsAsImport }) => countsAsImport,
			).length
		} catch (error) {
			console.error('[Batch Import Error]', error)
			if (isQuotaError(error)) {
				throw error
			}

			// One invalid record should not discard the other tracks in the batch.
			for (const task of batch) {
				try {
					await dbImportTracksBatch([task.item], this.#notifier.add)
					if (task.countsAsImport) {
						this.#tracker.result.newlyImported += 1
					}
				} catch (itemError) {
					if (isQuotaError(itemError)) {
						throw itemError
					}
					this.#tracker.result.failed += 1
					console.warn(
						'[scanner] could not save track:',
						task.item.metadata.fileName,
						itemError,
					)
				}
			}
		}
		this.#tracker.send()
	}

	finish(): void {
		this.#notifier.flush()
	}
}

const canReuseMetadata = (track: Track, file: File): boolean => {
	if (track.metadataVersion !== CURRENT_METADATA_VERSION || track.artworkPending) {
		return false
	}
	if (track.fileSize !== undefined && track.fileLastModified !== undefined) {
		return track.fileSize === file.size && track.fileLastModified === file.lastModified
	}
	// Older records did not store file attributes. Migrate their attributes
	// without re-reading tags when the old scan already covered the file.
	return file.lastModified <= track.scannedAt
}

const findExistingTrack = async (
	{ file, relativePath }: DiscoveredFile,
	directoryId: number,
): Promise<Track | undefined> => {
	const db = await getDatabase()
	const byPath = await db.getFromIndex('tracks', 'byRelativePath', [directoryId, relativePath])
	if (byPath) {
		return byPath
	}

	const candidates = await db.getAllFromIndex('tracks', 'path', [directoryId, file.name])
	let legacyMatch: Track | undefined
	for (const track of candidates) {
		if (file instanceof File) {
			if (!(track.file instanceof File)) {
				continue
			}
			const previousPath = track.relativePath || track.file.webkitRelativePath
			if (previousPath && previousPath !== relativePath) {
				continue
			}
			if (track.file.size !== file.size || track.file.lastModified !== file.lastModified) {
				continue
			}
			if (previousPath) {
				return track
			}
			// Old copied files had no durable identity. Do not guess if ambiguous.
			if (legacyMatch) {
				return undefined
			}
			legacyMatch = track
			continue
		}
		if (track.file instanceof File) {
			continue
		}
		if (await file.isSameEntry(track.file)) {
			return track
		}
	}
	return legacyMatch
}

async function* walkLegacyFiles(
	files: AsyncIterable<LegacyScanFile>,
): AsyncGenerator<DiscoveredFile> {
	for await (const file of files) {
		yield { ...file, companionArtworkUnavailable: false }
	}
}

/** Scans never delete missing tracks: a removable drive may only be temporarily unavailable. */
export const workerAction = async (
	options: TracksScanWorkerOptions,
	gate: ScanGate,
	onProgress: (progress: TracksScanProgress) => void,
	legacyFiles?: AsyncIterable<LegacyScanFile>,
): Promise<TracksScanResult> => {
	const tracker = new StatusTracker(gate, onProgress)
	const stopListening = gate.onChange(() => tracker.send(true))
	const processor = new TrackProcessor(tracker)
	const scannedAt = Date.now()
	const directoryId =
		options.action === 'legacy-files-add' ? LEGACY_NO_NATIVE_DIRECTORY : options.dirId
	let fatalError: unknown
	let consecutiveAccessErrors = 0

	tracker.send(true)
	try {
		if (options.action === 'legacy-files-add' && !legacyFiles) {
			throw new Error('The legacy file source is unavailable')
		}
		const files =
			options.action === 'legacy-files-add'
				? walkLegacyFiles(legacyFiles as AsyncIterable<LegacyScanFile>)
				: walkMusicDirectory(options.dirHandle, {
						checkpoint: () => gate.checkpoint(),
						onArtworkError: () => {
							if (!gate.signal.aborted) {
								tracker.result.failed += 1
								tracker.send()
							}
						},
					})

		for await (const file of files) {
			await gate.checkpoint()
			try {
				await processor.process(file, directoryId, scannedAt)
				consecutiveAccessErrors = 0
			} catch (error) {
				if (gate.signal.aborted || isQuotaError(error)) {
					throw error
				}
				tracker.result.failed += 1
				console.warn('[scanner] could not read track:', file.relativePath, error)
				const errorName = error instanceof Error ? error.name : ''
				consecutiveAccessErrors =
					errorName === 'NotFoundError' || errorName === 'NotReadableError'
						? consecutiveAccessErrors + 1
						: 0
				if (errorName === 'NotAllowedError' || consecutiveAccessErrors >= 3) {
					throw error
				}
			} finally {
				tracker.result.current += 1
				tracker.send()
			}
		}
	} catch (error) {
		if (gate.signal.aborted) {
			tracker.result.cancelled = true
		} else {
			fatalError = error
		}
	}

	try {
		// Completed work remains useful if the user cancels or a drive disconnects.
		await processor.flush()
	} catch (error) {
		fatalError ??= error
	}

	processor.finish()
	if (gate.signal.aborted) {
		tracker.result.cancelled = true
	}
	stopListening()
	tracker.close()
	if (fatalError !== undefined) {
		throw fatalError
	}
	return tracker.result
}
