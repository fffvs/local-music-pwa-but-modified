import { getDatabase } from '$lib/db/database.ts'
import { dispatchDatabaseChangedEvent, type DatabaseChangeDetails } from '$lib/db/events.ts'
import {
        type FileEntity,
        getFileHandlesRecursively,
        companionArtMap,
        COMPANION_ART_NAMES
} from '$lib/helpers/file-system.ts'
import { sha256Hex } from '$lib/helpers/hash.ts'
import { SerialQueue } from '$lib/helpers/serial-queue.ts'
import { dbRemoveTracks } from '$lib/library/remove.ts'
import {
        CURRENT_METADATA_VERSION,
        type ImageRecord,
        LEGACY_NO_NATIVE_DIRECTORY,
        type Track,
} from '$lib/library/types.ts'
import { createImageRecord } from './steps/create-image-record.ts'
import { dbImportTrack } from './steps/import-track.ts'
import { parseTrackMetadata } from './steps/parse-track-metadata.ts'
import type { TracksScanMessage, TracksScanOptions } from './types.ts'

declare const self: DedicatedWorkerGlobalScope

interface TrackEnqueueOptions {
        scannedAt: number
        unwrappedFile: File
        file: FileEntity
        directoryId: number
        /** In cases when track already was imported */
        trackId?: number
        uuid?: string
}

interface ArtworkEntry {
        imageHash: string
        primaryColor: number | undefined
        /** The full record, retained so imports can put-if-absent without re-decoding. */
        record: ImageRecord
}

const MAX_CACHED_ARTWORKS = 64
const IMPORT_BATCH_SIZE = 100

const processLegacyCompanionArt = (files: File[]) => {
        const parentToArtMap = new Map<string, File>()

        for (const file of files) {
                if (file.webkitRelativePath) {
                        const pathParts = file.webkitRelativePath.split('/')
                        if (pathParts.length > 1) {
                                const fileName = pathParts[pathParts.length - 1].toLowerCase()
                                if (COMPANION_ART_NAMES.has(fileName)) {
                                        const parentPath = pathParts.slice(0, -1).join('/')
                                        parentToArtMap.set(parentPath, file)
                                }
                        }
                }
        }

        for (const file of files) {
                if (file.webkitRelativePath) {
                        const pathParts = file.webkitRelativePath.split('/')
                        if (pathParts.length > 1) {
                                const parentPath = pathParts.slice(0, -1).join('/')
                                const companionFile = parentToArtMap.get(parentPath)
                                if (companionFile) {
                                        companionArtMap.set(file, companionFile)
                                }
                        }
                }
        }
}

interface ImportTask {
        parsed: any
        options: TrackEnqueueOptions
        artwork?: ArtworkEntry
}

class TrackProcessor {
        #artworkQueue = new SerialQueue()
        #importQueue = new SerialQueue()
        #importBatch: ImportTask[] = []

        #imageCache = new Map<string, ArtworkEntry>()

        #tracker: StatusTracker
        #onImportSuccess?: (trackId: number) => void

        constructor(tracker: StatusTracker, onImportSuccess?: (trackId: number) => void) {
                this.#tracker = tracker
                this.#onImportSuccess = onImportSuccess
        }

        async #resolveArtwork(imageBlob: Blob): Promise<ArtworkEntry> {
                const hash = await sha256Hex(imageBlob)

                const cached = this.#imageCache.get(hash)
                if (cached) {
                        return cached
                }

                const db = await getDatabase()
                const existing = await db.get('images', hash)
                const record = existing ?? (await createImageRecord(imageBlob, hash))

                const entry: ArtworkEntry = {
                        imageHash: hash,
                        primaryColor: record.primaryColor,
                        record,
                }
                this.#imageCache.set(hash, entry)

                if (this.#imageCache.size > MAX_CACHED_ARTWORKS) {
                        const oldestKey = this.#imageCache.keys().next().value
                        if (oldestKey !== undefined) {
                                const evicted = this.#imageCache.get(oldestKey)
                                if (evicted) {
                                        (evicted.record as any).full = null;
                                        (evicted.record as any).small = null;
                                }
                                this.#imageCache.delete(oldestKey)
                        }
                }

                return entry
        }

        async parseAndEnqueue(options: TrackEnqueueOptions) {
                const parsed = await parseTrackMetadata(options.unwrappedFile)
                if (!parsed) {
                        return
                }

                this.#artworkQueue.enqueue(async () => {
                        let imageBlob = parsed.imageBlob
                        if (!imageBlob) {
                                imageBlob = companionArtMap.get(options.file)
                        }

                        const artwork = imageBlob ? await this.#resolveArtwork(imageBlob) : undefined

                        this.#importBatch.push({ parsed, options, artwork })

                        if (this.#importBatch.length >= IMPORT_BATCH_SIZE) {
                                const currentBatch = [...this.#importBatch]
                                this.#importBatch = []
                                this.#enqueueBatchImport(currentBatch)
                        }
                })
        }

        #enqueueBatchImport(batch: ImportTask[]) {
                this.#importQueue.enqueue(async () => {
                        const batchChanges: DatabaseChangeDetails[] = []
                        const collector = (changes: DatabaseChangeDetails[]) => {
                                batchChanges.push(...changes)
                        }
                        try {
                                for (const task of batch) {
                                        const trackId = await dbImportTrack(
                                                {
                                                        ...task.parsed.data,
                                                        imageHash: task.artwork?.imageHash,
                                                        primaryColor: task.artwork?.primaryColor,
                                                        file: task.options.file,
                                                        directory: task.options.directoryId,
                                                        fileName: task.options.file.name,
                                                        scannedAt: task.options.scannedAt,
                                                        uuid: task.options.uuid ?? crypto.randomUUID(),
                                                },
                                                task.options.trackId,
                                                task.artwork?.record,
                                                collector,
                                        )

                                        this.#onImportSuccess?.(trackId)
                                        this.#tracker.newlyImported += 1
                                        this.#tracker.sendMsg(false)
                                }

                                if (batchChanges.length > 0) {
                                        dispatchDatabaseChangedEvent(batchChanges)
                                }
                        } catch (err) {
                                console.error("[Batch Import Error]", err)
                        }
                })
        }

        async drain(): Promise<void> {
                await this.#artworkQueue.drain()
                if (this.#importBatch.length > 0) {
                        const remainingBatch = [...this.#importBatch]
                        this.#importBatch = []
                        this.#enqueueBatchImport(remainingBatch)
                }
                await this.#importQueue.drain()
        }
}

class StatusTracker {
        newlyImported = 0
        current = 0
        total = 0

        #pendingTimeout: number | null = null
        #hasPendingMessage = false
        #timeId: string

        constructor(total: number, timeId: string) {
                this.total = total
                this.#timeId = timeId

                console.time(this.#timeId)
        }

        sendMsg = (finished: boolean) => {
                if (finished) {
                        console.timeEnd(this.#timeId)
                        if (this.#pendingTimeout) {
                                self.clearTimeout(this.#pendingTimeout)
                        }
                } else {
                        if (this.#pendingTimeout) {
                                this.#hasPendingMessage = true
                                return
                        }

                        this.#pendingTimeout = self.setTimeout(() => {
                                this.#pendingTimeout = null
                                if (this.#hasPendingMessage) {
                                        this.#hasPendingMessage = false
                                        this.#postMessage(false)
                                }
                        }, 200)
                }

                this.#postMessage(finished)
        }

        #postMessage = (finished: boolean): void => {
                const message: TracksScanMessage = {
                        finished,
                        count: {
                                newlyImported: this.newlyImported,
                                current: this.current,
                                total: this.total,
                        },
                }

                self.postMessage(message)
        }
}

const findTrackByFileHandle = async (handle: FileSystemFileHandle, tracks: Track[]) => {
        for (const track of tracks) {
                const isSame = await handle.isSameEntry(track.file as FileSystemFileHandle)
                if (isSame) {
                        return track
                }
        }

        return null
}

const findTrackByMixedFileEntity = async (handle: FileEntity, tracks: Track[]) => {
        for (const track of tracks) {
                const existingFile = track.file
                if (existingFile.name !== handle.name) {
                        continue
                }

                if (
                        existingFile instanceof FileSystemFileHandle &&
                        handle instanceof FileSystemFileHandle
                ) {
                        const isSame = await handle.isSameEntry(existingFile)
                        if (isSame) {
                                return track
                        }
                }

                if (
                        existingFile instanceof File &&
                        handle instanceof File &&
                        existingFile.size === handle.size
                ) {
                        return track
                }
        }

        return null
}

const scanExistingDirectory = async (handles: FileEntity[], directoryId: number) => {
        const db = await getDatabase()

        const tracker = new StatusTracker(handles.length, 'SCAN_EXISTING_DIR')
        const scannedTracksIds = new Set<number>()
        const processor = new TrackProcessor(tracker, (trackId) => {
                scannedTracksIds.add(trackId)
        })

        const scannedAt = Date.now()

        const findTrackFn =
                directoryId === LEGACY_NO_NATIVE_DIRECTORY
                        ? findTrackByMixedFileEntity
                        : findTrackByFileHandle

        for (const handle of handles) {
                tracker.current += 1

                try {
                        const possibleExistingTracks = await db.getAllFromIndex('tracks', 'path', [
                                directoryId,
                                handle.name,
                        ])
                        const existingTrack = await findTrackFn(
                                handle as FileSystemFileHandle,
                                possibleExistingTracks,
                        )

                        const unwrappedFile = handle instanceof File ? handle : await handle.getFile()

                        if (
                                existingTrack &&
                                unwrappedFile.lastModified <= existingTrack.scannedAt &&
                                existingTrack.metadataVersion === CURRENT_METADATA_VERSION
                        ) {
                                scannedTracksIds.add(existingTrack.id)
                                tracker.sendMsg(false)

                                continue
                        }

                        await processor.parseAndEnqueue({
                                unwrappedFile,
                                file: handle,
                                directoryId,
                                trackId: existingTrack?.id,
                                uuid: existingTrack?.uuid,
                                scannedAt,
                        })
                } catch {
                        // ignore errors
                }
        }

        await processor.drain()

        if (directoryId === LEGACY_NO_NATIVE_DIRECTORY) {
                tracker.sendMsg(true)
                return
        }

        const tracksIdsInDirectory = await db.getAllKeysFromIndex('tracks', 'directory', directoryId)
        const tracksToRemove: number[] = []
        for (const trackId of tracksIdsInDirectory) {
                if (!scannedTracksIds.has(trackId)) {
                        tracksToRemove.push(trackId)
                }
        }
        await dbRemoveTracks(tracksToRemove).catch(console.warn)

        tracker.sendMsg(true)
}

const scanNewDirectory = async (handles: FileEntity[], directoryId: number) => {
        const tracker = new StatusTracker(handles.length, 'SCAN_NEW_DIR')
        const processor = new TrackProcessor(tracker)
        const scannedAt = Date.now()

        for (const handle of handles) {
                tracker.current += 1

                try {
                        const unwrappedFile = handle instanceof File ? handle : await handle.getFile()

                        await processor.parseAndEnqueue({
                                unwrappedFile,
                                file: handle,
                                directoryId,
                                scannedAt,
                        })
                } catch {
                        // ignore errors
                }
        }

        await processor.drain()

        tracker.sendMsg(true)
}

export const workerAction = async (options: TracksScanOptions) => {
        if (options.action === 'directory-add') {
                const handles = await getFileHandlesRecursively(options.dirHandle)
                await scanNewDirectory(handles, options.dirId)
                return
        }

        if (options.action === 'directory-rescan') {
                const handles = await getFileHandlesRecursively(options.dirHandle)
                await scanExistingDirectory(handles, options.dirId)
                return
        }

        if (options.action === 'legacy-files-add') {
                processLegacyCompanionArt(options.files)
                await scanExistingDirectory(options.files, LEGACY_NO_NATIVE_DIRECTORY)
        }
}