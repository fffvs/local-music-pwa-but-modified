import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '$lib/db/database.ts'
import { onDatabaseChange } from '$lib/db/events.ts'
import { clearDatabaseStores, dbGetAllAndExpectLength } from '$lib/helpers/test-helpers.ts'
import {
	dbImportTrack,
	dbImportTracksBatch,
} from '$lib/library/scan-actions/scanner/steps/import-track.ts'
import type { ImageRecord, UnknownTrack } from '$lib/library/types.ts'

const makeImageRecord = (hash: string): ImageRecord => ({
	hash,
	optimized: true,
	full: new Blob([hash], { type: 'image/jpeg' }),
	small: new Blob([`${hash}-small`], { type: 'image/webp' }),
	primaryColor: 0xff_11_22_33,
})

const buildTrack = (overrides: Partial<UnknownTrack> = {}): UnknownTrack => ({
	uuid: crypto.randomUUID(),
	name: 'Test Track',
	album: 'Test Album',
	artists: ['Test Artist'],
	year: '2023',
	duration: 180,
	trackNo: 1,
	trackOf: 10,
	discNo: 1,
	discOf: 1,
	genre: ['Rock'],
	file: new File(['test'], 'test.mp3', { type: 'audio/mp3' }),
	scannedAt: Date.now(),
	fileName: 'test.mp3',
	directory: 1,
	...overrides,
})

const importTrack = (
	overrides: Partial<UnknownTrack>,
	imageRecord?: ImageRecord,
	existingTrackId?: number,
): Promise<number> =>
	dbImportTrack(
		buildTrack({
			imageHash: imageRecord?.hash,
			primaryColor: imageRecord?.primaryColor,
			...overrides,
		}),
		existingTrackId,
		imageRecord,
	)

describe('dbImportTrack artwork dedup', () => {
	beforeEach(async () => {
		await clearDatabaseStores()
	})

	it('writes the image record once for tracks sharing the same artwork', async () => {
		const image = makeImageRecord('cover')
		await importTrack({ name: 'Track 1', fileName: 'a.mp3' }, image)
		await importTrack({ name: 'Track 2', fileName: 'b.mp3' }, image)

		await dbGetAllAndExpectLength('tracks', 2)
		const images = await dbGetAllAndExpectLength('images', 1)
		expect(images[0]?.hash).toBe('cover')
	})

	it('points the album at the first art-bearing track imageHash', async () => {
		// First track has no artwork, second one does.
		await importTrack({ name: 'Track 1', fileName: 'a.mp3' })
		await importTrack({ name: 'Track 2', fileName: 'b.mp3' }, makeImageRecord('late-cover'))

		const albums = await dbGetAllAndExpectLength('albums', 1)
		expect(albums[0]?.imageHash).toBe('late-cover')
	})

	it('orphans and deletes the old image when a rescan changes artwork', async () => {
		// Track A pins the album image; Track B carries a distinct image only it uses.
		await importTrack({ name: 'Track A', fileName: 'a.mp3' }, makeImageRecord('album-cover'))
		const trackBId = await importTrack(
			{ name: 'Track B', fileName: 'b.mp3' },
			makeImageRecord('b-cover'),
		)

		await dbGetAllAndExpectLength('images', 2)

		// Rescan Track B with new artwork.
		await importTrack(
			{ name: 'Track B', fileName: 'b.mp3' },
			makeImageRecord('b-cover-v2'),
			trackBId,
		)

		const images = await dbGetAllAndExpectLength('images', 2)
		expect(images.map((image) => image.hash).sort()).toEqual(['album-cover', 'b-cover-v2'])
	})

	it('keeps the image when a rescan reuses the same artwork', async () => {
		const image = makeImageRecord('stable-cover')
		const trackId = await importTrack({ name: 'Track', fileName: 'a.mp3' }, image)

		await importTrack({ name: 'Track', fileName: 'a.mp3' }, image, trackId)

		const images = await dbGetAllAndExpectLength('images', 1)
		expect(images[0]?.hash).toBe('stable-cover')
	})

	it('stores imageHash on the track and primaryColor denormalized', async () => {
		const image = makeImageRecord('cover')
		const trackId = await importTrack({ name: 'Track', fileName: 'a.mp3' }, image)

		const db = await getDatabase()
		const track = await db.get('tracks', trackId)
		expect(track?.imageHash).toBe('cover')
		expect(track?.primaryColor).toBe(0xff_11_22_33)
		expect(track?.image).toBeUndefined()
	})
})

describe('dbImportTracksBatch', () => {
	beforeEach(async () => {
		await clearDatabaseStores()
	})

	afterEach(() => vi.restoreAllMocks())

	it('commits multiple tracks atomically and notifies only after the batch', async () => {
		const db = await getDatabase()
		const transactions = vi.spyOn(db, 'transaction')
		const events = vi.fn()
		const stopListening = onDatabaseChange(events)
		const image = makeImageRecord('shared-cover')
		const ids = await dbImportTracksBatch([
			{ metadata: buildTrack({ name: 'One', imageHash: image.hash }), imageRecord: image },
			{ metadata: buildTrack({ name: 'Two', imageHash: image.hash }), imageRecord: image },
		])
		stopListening()

		expect(ids).toHaveLength(2)
		expect(transactions).toHaveBeenCalledTimes(1)
		expect(events).toHaveBeenCalledTimes(1)
		expect(
			events.mock.calls[0]?.[0].filter(
				(change: { storeName: string }) => change.storeName === 'tracks',
			),
		).toHaveLength(2)
		expect(await db.count('tracks')).toBe(2)
		expect(await db.count('albums')).toBe(1)
		expect(await db.count('artists')).toBe(1)
		expect(await db.count('images')).toBe(1)
	})

	it('rolls back all records and sends no changes when the transaction fails', async () => {
		const db = await getDatabase()
		const events = vi.fn()
		const stopListening = onDatabaseChange(events)
		const image = makeImageRecord('aborted-cover')
		await expect(
			dbImportTracksBatch([
				{
					metadata: buildTrack({ uuid: 'duplicate', imageHash: image.hash }),
					imageRecord: image,
				},
				{ metadata: buildTrack({ uuid: 'duplicate' }) },
			]),
		).rejects.toBeDefined()
		stopListening()

		expect(events).not.toHaveBeenCalled()
		expect(await db.count('tracks')).toBe(0)
		expect(await db.count('albums')).toBe(0)
		expect(await db.count('artists')).toBe(0)
		expect(await db.count('images')).toBe(0)
	})

	it('repairs an incomplete stored image when a good copy is imported', async () => {
		const db = await getDatabase()
		await db.put('images', {
			hash: 'broken',
			optimized: false,
			full: null as unknown as Blob,
			small: null as unknown as Blob,
			primaryColor: undefined,
		})
		const image = makeImageRecord('broken')
		await dbImportTracksBatch([
			{ metadata: buildTrack({ imageHash: image.hash }), imageRecord: image },
		])
		const repaired = await db.get('images', image.hash)
		expect(repaired?.full).toMatchObject({ type: 'image/jpeg' })
		expect(repaired?.small).toMatchObject({ type: 'image/webp' })
	})
})
