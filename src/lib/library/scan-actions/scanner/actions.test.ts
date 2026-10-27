import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '$lib/db/database.ts'
import { onDatabaseChange } from '$lib/db/events.ts'
import { sha256Hex } from '$lib/helpers/hash.ts'
import { clearDatabaseStores } from '$lib/helpers/test-helpers.ts'
import {
	CURRENT_METADATA_VERSION,
	LEGACY_NO_NATIVE_DIRECTORY,
	type ParsedTrackData,
	type PlayHistoryEntry,
	type PlaylistEntry,
	type UnknownTrack,
} from '$lib/library/types.ts'
import { workerAction } from './actions.ts'
import { ScanGate } from './scan-gate.ts'
import * as importTrack from './steps/import-track.ts'
import { dbImportTracksBatch } from './steps/import-track.ts'
import { parseTrackMetadata } from './steps/parse-track-metadata.ts'

vi.mock('./steps/parse-track-metadata.ts', () => ({ parseTrackMetadata: vi.fn() }))
vi.mock('./steps/create-image-record.ts', () => ({
	createImageRecord: vi.fn(async (blob: Blob, hash: string) => ({
		hash,
		optimized: true,
		full: blob,
		small: new Blob(['small']),
		primaryColor: undefined,
	})),
}))

type TestFileHandle = FileSystemFileHandle & {
	setFile: (file: File) => void
	fail: (error: unknown) => void
}

const fileHandle = (name: string, contents = 'audio', lastModified = 100): TestFileHandle => {
	let file = new File([contents], name, { lastModified })
	let failure: unknown
	const handle = {
		kind: 'file' as const,
		name,
		getFile: vi.fn(() => (failure ? Promise.reject(failure) : Promise.resolve(file))),
		isSameEntry: vi.fn(
			(other: FileSystemHandle): Promise<boolean> =>
				Promise.resolve(other === (handle as unknown as FileSystemHandle)),
		),
		setFile: (value: File) => {
			file = value
		},
		fail: (error: unknown) => {
			failure = error
		},
	}
	return handle as unknown as TestFileHandle
}

const directory = (name: string, entries: FileSystemHandle[], failure?: unknown) =>
	({
		kind: 'directory' as const,
		name,
		async *values() {
			yield* entries
			if (failure) {
				throw failure
			}
		},
	}) as unknown as FileSystemDirectoryHandle

const trackData = (name: string): ParsedTrackData => ({
	name,
	album: 'Album',
	artists: ['Artist'],
	year: '2024',
	duration: 180,
	genre: [],
	trackNo: 1,
	trackOf: 1,
	discNo: 1,
	discOf: 1,
	metadataVersion: CURRENT_METADATA_VERSION,
})

const existingTrack = (file: TestFileHandle, uuid: string): UnknownTrack => ({
	...trackData(file.name),
	uuid,
	file,
	fileName: file.name,
	directory: 1,
	scannedAt: 1000,
})

const scan = (dirHandle: FileSystemDirectoryHandle, gate = new ScanGate(false)) =>
	workerAction({ action: 'directory-rescan', dirId: 1, dirHandle }, gate, () => {})

describe('streaming directory scans', () => {
	beforeEach(async () => {
		// Test handles are ordinary objects; real browser handles and blobs are structured-cloneable.
		vi.stubGlobal('structuredClone', <T>(value: T): T => value)
		await clearDatabaseStores()
		vi.mocked(parseTrackMetadata).mockReset()
		vi.mocked(parseTrackMetadata).mockImplementation(async (file) => ({
			data: trackData(file.name),
		}))
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('keeps tracks, playlists and history when a rescan sees an empty drive', async () => {
		const file = fileHandle('song.flac')
		const [id] = await dbImportTracksBatch([{ metadata: existingTrack(file, 'old-track') }])
		const db = await getDatabase()
		await db.add('playlistEntries', { playlistId: 1, trackId: id, addedAt: 1 } as PlaylistEntry)
		await db.add('playHistory', { trackId: id, playedAt: 1 } as PlayHistoryEntry)

		const result = await scan(directory('disconnected', []))
		expect(result).toMatchObject({ current: 0, newlyImported: 0, failed: 0 })
		expect(await db.get('tracks', id as number)).toMatchObject({ uuid: 'old-track' })
		expect(await db.count('playlistEntries')).toBe(1)
		expect(await db.count('playHistory')).toBe(1)
	})

	it('migrates repeated basenames by handle identity and reuses the relative-path index', async () => {
		const first = fileHandle('01.flac', 'one')
		const second = fileHandle('01.flac', 'two')
		const [firstId, secondId] = await dbImportTracksBatch([
			{ metadata: existingTrack(first, 'first') },
			{ metadata: existingTrack(second, 'second') },
		])
		const root = directory('Music', [directory('A', [first]), directory('B', [second])])
		const db = await getDatabase()
		await db.add('playlistEntries', {
			playlistId: 1,
			trackId: firstId,
			addedAt: 1,
		} as PlaylistEntry)

		const result = await scan(root)
		expect(result).toMatchObject({ current: 2, newlyImported: 0, failed: 0 })
		expect(parseTrackMetadata).not.toHaveBeenCalled()
		expect(await db.get('tracks', firstId as number)).toMatchObject({
			uuid: 'first',
			relativePath: 'A/01.flac',
		})
		expect(await db.get('tracks', secondId as number)).toMatchObject({
			uuid: 'second',
			relativePath: 'B/01.flac',
		})
		expect(await db.count('playlistEntries')).toBe(1)

		vi.mocked(first.isSameEntry).mockClear()
		vi.mocked(second.isSameEntry).mockClear()
		await scan(root)
		expect(first.isSameEntry).not.toHaveBeenCalled()
		expect(second.isSameEntry).not.toHaveBeenCalled()
		expect(parseTrackMetadata).not.toHaveBeenCalled()
	})

	it('does not guess between ambiguous old copied files with the same name and attributes', async () => {
		const first = new File(['same'], '01.flac', { lastModified: 100 })
		const second = new File(['same'], '01.flac', { lastModified: 100 })
		const incoming = new File(['same'], '01.flac', { lastModified: 100 })
		Object.defineProperty(incoming, 'webkitRelativePath', { value: 'Album/01.flac' })
		const template = existingTrack(fileHandle('01.flac'), 'old-first')
		const [firstId, secondId] = await dbImportTracksBatch([
			{ metadata: { ...template, file: first, directory: LEGACY_NO_NATIVE_DIRECTORY } },
			{
				metadata: {
					...template,
					uuid: 'old-second',
					file: second,
					directory: LEGACY_NO_NATIVE_DIRECTORY,
				},
			},
		])

		async function* files() {
			await Promise.resolve()
			yield { file: incoming, relativePath: 'Album/01.flac' }
		}
		const result = await workerAction(
			{ action: 'legacy-files-add' },
			new ScanGate(false),
			() => {},
			files(),
		)
		const db = await getDatabase()
		expect(result.newlyImported).toBe(1)
		expect(await db.count('tracks')).toBe(3)
		expect(await db.get('tracks', firstId as number)).toMatchObject({ uuid: 'old-first' })
		expect(await db.get('tracks', secondId as number)).toMatchObject({ uuid: 'old-second' })
	})

	it('re-parses a changed size even if the modified time is unchanged, preserving its id', async () => {
		const file = fileHandle('song.flac', 'old', 100)
		const root = directory('Music', [file])
		await scan(root)
		const db = await getDatabase()
		const [original] = await db.getAll('tracks')
		file.setFile(new File(['a longer file'], 'song.flac', { lastModified: 100 }))

		const result = await scan(root)
		const [updated] = await db.getAll('tracks')
		expect(result.newlyImported).toBe(1)
		expect(parseTrackMetadata).toHaveBeenCalledTimes(2)
		expect(updated?.id).toBe(original?.id)
		expect(updated?.uuid).toBe(original?.uuid)
		expect(updated?.fileSize).toBe('a longer file'.length)
	})

	it('reports an unreadable track and keeps its existing library record', async () => {
		const missing = fileHandle('missing.flac')
		const [id] = await dbImportTracksBatch([{ metadata: existingTrack(missing, 'missing') }])
		missing.fail(new DOMException('unplugged', 'NotReadableError'))
		const good = fileHandle('good.flac')
		const result = await scan(directory('Music', [missing, good]))
		const db = await getDatabase()

		expect(result).toMatchObject({ current: 2, failed: 1, newlyImported: 1 })
		expect(await db.get('tracks', id as number)).toMatchObject({ uuid: 'missing' })
		expect(await db.count('tracks')).toBe(2)
	})

	it('reports an I/O AbortError as a read failure when the user did not cancel', async () => {
		const interrupted = fileHandle('interrupted.flac')
		interrupted.fail(new DOMException('read aborted', 'AbortError'))
		const result = await scan(directory('Music', [interrupted, fileHandle('good.flac')]))
		expect(result).toMatchObject({ current: 2, failed: 1, newlyImported: 1, cancelled: false })
	})

	it('flushes completed work when cancelled', async () => {
		const gate = new ScanGate(false)
		const files = [fileHandle('a.flac'), fileHandle('b.flac'), fileHandle('c.flac')]
		vi.mocked(parseTrackMetadata).mockImplementation((file) => {
			if (file.name === 'b.flac') {
				gate.cancel()
			}
			return Promise.resolve({ data: trackData(file.name) })
		})

		const result = await scan(directory('Music', files), gate)
		expect(result).toMatchObject({ current: 2, newlyImported: 2, cancelled: true })
		expect(await (await getDatabase()).count('tracks')).toBe(2)
	})

	it('flushes completed work and propagates a traversal failure', async () => {
		const error = new DOMException('drive disconnected', 'NotReadableError')
		const root = directory('Music', [
			directory('readable', [fileHandle('song.flac')]),
			directory('broken', [], error),
		])
		await expect(scan(root)).rejects.toMatchObject({ name: 'NotReadableError' })
		expect(await (await getDatabase()).count('tracks')).toBe(1)
	})

	it('isolates an individual import failure after a batch rollback', async () => {
		const original = importTrack.dbImportTracksBatch
		vi.spyOn(importTrack, 'dbImportTracksBatch').mockImplementation((items, collector) => {
			if (items.length > 1 || items[0]?.metadata.fileName === 'bad.flac') {
				return Promise.reject(new Error('Could not import this track'))
			}
			return original(items, collector)
		})
		const root = directory('Music', [fileHandle('good.flac'), fileHandle('bad.flac')])

		const result = await scan(root)
		expect(result).toMatchObject({ newlyImported: 1, failed: 1, cancelled: false })
		expect(await (await getDatabase()).count('tracks')).toBe(1)
	})

	it('coalesces committed batch notifications for live library lists', async () => {
		const files = Array.from({ length: 45 }, (_, index) => fileHandle(`song-${index}.flac`))
		const listener = vi.fn()
		const stop = onDatabaseChange(listener)
		try {
			await scan(directory('Music', files))
		} finally {
			stop()
		}

		expect(listener).toHaveBeenCalledTimes(1)
		const changes = listener.mock.calls[0]?.[0] as Array<{ storeName: string }>
		expect(changes.filter((change) => change.storeName === 'tracks')).toHaveLength(45)
	})

	it('does not corrupt pending covers when the bounded artwork cache evicts entries', async () => {
		const files = Array.from({ length: 45 }, (_, index) => fileHandle(`song-${index}.flac`))
		vi.mocked(parseTrackMetadata).mockImplementation(async (file) => ({
			data: trackData(file.name),
			imageBlob: new Blob([file.name], { type: 'image/jpeg' }),
		}))

		const result = await scan(directory('Music', files))
		const db = await getDatabase()
		const tracks = await db.getAll('tracks')
		expect(result.newlyImported).toBe(45)
		expect(await db.count('images')).toBe(45)
		for (const track of tracks) {
			const image = await db.get('images', track.imageHash as string)
			expect(await image?.full.text()).toBe(track.fileName)
			expect(await image?.small.text()).toBe('small')
		}
	})

	it('repairs incomplete artwork from an older scan during migration', async () => {
		const file = fileHandle('song.flac')
		const artwork = new Blob(['original cover'], { type: 'image/jpeg' })
		const hash = await sha256Hex(artwork)
		const db = await getDatabase()
		await db.put('images', {
			hash,
			optimized: false,
			full: null as unknown as Blob,
			small: null as unknown as Blob,
			primaryColor: undefined,
		})
		const [id] = await dbImportTracksBatch([
			{ metadata: { ...existingTrack(file, 'older'), imageHash: hash } },
		])
		vi.mocked(parseTrackMetadata).mockResolvedValue({
			data: trackData(file.name),
			imageBlob: artwork,
		})

		const result = await scan(directory('Music', [file]))
		expect(result.newlyImported).toBe(1)
		expect(await db.get('tracks', id as number)).toMatchObject({
			uuid: 'older',
			imageHash: hash,
		})
		const repaired = await db.get('images', hash)
		expect(await repaired?.full.text()).toBe('original cover')
		expect(await repaired?.small.text()).toBe('small')
	})

	it('keeps existing artwork when a companion cover is unreadable and retries it later', async () => {
		const file = fileHandle('song.flac')
		const cover = fileHandle('cover.jpg', 'cover')
		const root = directory('Music', [file, cover])
		await scan(root)
		const db = await getDatabase()
		const [before] = await db.getAll('tracks')
		expect(before?.imageHash).toBeDefined()

		cover.fail(new DOMException('unavailable', 'NotReadableError'))
		const partial = await scan(root)
		const [during] = await db.getAll('tracks')
		expect(partial.failed).toBe(1)
		expect(during?.imageHash).toBe(before?.imageHash)
		expect(during?.artworkPending).toBe(true)

		cover.fail(undefined)
		await scan(root)
		const [after] = await db.getAll('tracks')
		expect(after?.imageHash).toBe(before?.imageHash)
		expect(after?.artworkPending).toBe(false)
		expect(after?.id).toBe(before?.id)
	})
})
