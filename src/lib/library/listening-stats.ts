import { getDatabase } from '$lib/db/database.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ListeningStats {
	libraryTracks: number
	libraryDurationSeconds: number
	/** Distinct tracks whose last play falls within the window. */
	playedLast7Days: number
	playedLast30Days: number
}

/**
 * Summary numbers for the Studio page. Play history keeps one row per track
 * (the most recent play), so these are "distinct tracks played in window"
 * counts rather than total play counts.
 */
export const getListeningStats = async (now: number = Date.now()): Promise<ListeningStats> => {
	const db = await getDatabase()

	const tx = db.transaction('tracks')
	const tracksStore = tx.objectStore('tracks')
	const libraryTracks = await tracksStore.count()

	let libraryDurationSeconds = 0
	let cursor = await tracksStore.openCursor()
	while (cursor !== null) {
		const duration = cursor.value.duration
		if (Number.isFinite(duration) && duration > 0) {
			libraryDurationSeconds += duration
		}
		cursor = await cursor.continue()
	}
	await tx.done

	const playedLast7Days = await db.countFromIndex(
		'playHistory',
		'playedAt',
		globalThis.IDBKeyRange.lowerBound(now - 7 * DAY_MS),
	)
	const playedLast30Days = await db.countFromIndex(
		'playHistory',
		'playedAt',
		globalThis.IDBKeyRange.lowerBound(now - 30 * DAY_MS),
	)

	return { libraryTracks, libraryDurationSeconds, playedLast7Days, playedLast30Days }
}
