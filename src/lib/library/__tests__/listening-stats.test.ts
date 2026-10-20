import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { getDatabase } from '$lib/db/database.ts'
import { clearDatabaseStores } from '$lib/helpers/test-helpers.ts'
import { getListeningStats } from '$lib/library/listening-stats.ts'
import { LEGACY_NO_NATIVE_DIRECTORY, type Track } from '$lib/library/types.ts'

const DAY = 24 * 60 * 60 * 1000

const seedTrack = async (id: number, duration: number) => {
	const db = await getDatabase()
	const track: Track = {
		id,
		uuid: `track-${id}`,
		name: `Track ${id}`,
		artists: ['Artist'],
		album: 'Album',
		year: '2026',
		duration,
		genre: [],
		trackNo: 1,
		trackOf: 1,
		discNo: 1,
		discOf: 1,
		fileName: `track-${id}.mp3`,
		directory: LEGACY_NO_NATIVE_DIRECTORY,
		scannedAt: Date.now(),
		file: new File(['x'], `track-${id}.mp3`, { type: 'audio/mpeg' }),
	}
	await db.add('tracks', track)
}

const seedPlay = async (trackId: number, playedAt: number) => {
	const db = await getDatabase()
	await db.add('playHistory', { trackId, playedAt } as never)
}

afterEach(async () => {
	await clearDatabaseStores()
})

describe('getListeningStats', () => {
	it('returns zeros for an empty library', async () => {
		const stats = await getListeningStats()
		expect(stats).toEqual({
			libraryTracks: 0,
			libraryDurationSeconds: 0,
			playedLast7Days: 0,
			playedLast30Days: 0,
		})
	})

	it('sums library duration and counts tracks', async () => {
		await seedTrack(1, 180)
		await seedTrack(2, 240.5)
		const stats = await getListeningStats()
		expect(stats.libraryTracks).toBe(2)
		expect(stats.libraryDurationSeconds).toBeCloseTo(420.5)
	})

	it('counts distinct tracks played within 7 and 30 day windows', async () => {
		const now = Date.now()
		await seedTrack(1, 100)
		await seedTrack(2, 100)
		await seedTrack(3, 100)
		await seedPlay(1, now - 1 * DAY)
		await seedPlay(2, now - 10 * DAY)
		await seedPlay(3, now - 60 * DAY)

		const stats = await getListeningStats(now)
		expect(stats.playedLast7Days).toBe(1)
		expect(stats.playedLast30Days).toBe(2)
	})
})
