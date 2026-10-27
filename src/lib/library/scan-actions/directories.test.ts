import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '$lib/db/database.ts'
import { clearDatabaseStores } from '$lib/helpers/test-helpers.ts'
import { dbImportTracksBatch } from '$lib/library/scan-actions/scanner/steps/import-track.ts'
import { CURRENT_METADATA_VERSION, type UnknownTrack } from '$lib/library/types.ts'
import { replaceDirectories } from './directories.ts'
import { scanTracks } from './scan-tracks.ts'

vi.mock('$lib/db/lock-database', () => ({
	lockDatabase: (action: () => Promise<unknown>) => action(),
}))
vi.mock('./scan-tracks.ts', () => ({ scanTracks: vi.fn(async () => {}) }))

const handle = (name: string) => ({ name, kind: 'directory' }) as FileSystemDirectoryHandle

const track = (directory: number, uuid: string): UnknownTrack => ({
	uuid,
	name: uuid,
	album: 'Album',
	artists: ['Artist'],
	year: '2024',
	duration: 1,
	genre: [],
	trackNo: 1,
	trackOf: 1,
	discNo: 1,
	discOf: 1,
	file: new File(['audio'], '01.flac'),
	fileName: '01.flac',
	relativePath: 'Album/01.flac',
	directory,
	scannedAt: 1000,
	metadataVersion: CURRENT_METADATA_VERSION,
})

describe('reparenting directories', () => {
	beforeEach(async () => {
		vi.stubGlobal('structuredClone', <T>(value: T): T => value)
		await clearDatabaseStores()
		vi.mocked(scanTracks).mockClear()
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('invalidates every old path, including the retained directory id', async () => {
		const db = await getDatabase()
		await db.add('directories', { id: 10, handle: handle('child-a') })
		await db.add('directories', { id: 20, handle: handle('child-b') })
		const [first, second] = await dbImportTracksBatch([
			{ metadata: track(10, 'first') },
			{ metadata: track(20, 'second') },
		])
		await db.add('playlistEntries', {
			id: 1,
			playlistId: 1,
			trackId: first as number,
			addedAt: 1,
		})
		await db.add('playHistory', { id: 1, trackId: second as number, playedAt: 1 })
		const parent = handle('parent')

		await replaceDirectories(parent, [10, 20])

		expect(await db.get('tracks', first as number)).toMatchObject({
			directory: 20,
			relativePath: undefined,
		})
		expect(await db.get('tracks', second as number)).toMatchObject({
			directory: 20,
			relativePath: undefined,
		})
		expect(await db.count('directories')).toBe(1)
		expect(await db.count('playlistEntries')).toBe(1)
		expect(await db.count('playHistory')).toBe(1)
		expect(scanTracks).toHaveBeenCalledWith({
			action: 'directory-rescan',
			dirId: 20,
			dirHandle: parent,
		})
	})

	it('invalidates paths when a single child is replaced by its parent', async () => {
		const db = await getDatabase()
		await db.add('directories', { id: 20, handle: handle('child') })
		const [id] = await dbImportTracksBatch([{ metadata: track(20, 'single') }])

		await replaceDirectories(handle('parent'), [20])
		expect(await db.get('tracks', id as number)).toMatchObject({
			directory: 20,
			relativePath: undefined,
		})
	})
})
