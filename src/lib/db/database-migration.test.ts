import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { expect, it } from 'vitest'

it('adds the relative-path index without deleting v4 tracks, playlists or history', async () => {
	const old = await openDB('snae-app-data', 4, {
		upgrade(db) {
			const tracks = db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true })
			tracks.createIndex('uuid', 'uuid', { unique: true })
			tracks.createIndex('path', ['directory', 'fileName'])
			tracks.createIndex('byAlbumSorted', ['album', 'discNo', 'trackNo', 'name'])
			tracks.createIndex('imageHash', 'imageHash')
			tracks.createIndex('artists', 'artists', { multiEntry: true })
			for (const key of ['name', 'album', 'year', 'duration', 'scannedAt', 'directory']) {
				tracks.createIndex(key, key)
			}
			const entries = db.createObjectStore('playlistEntries', {
				keyPath: 'id',
				autoIncrement: true,
			})
			for (const key of ['playlistId', 'trackId', 'addedAt']) {
				entries.createIndex(key, key)
			}
			entries.createIndex('playlistTrack', ['playlistId', 'trackId'])
			const history = db.createObjectStore('playHistory', {
				keyPath: 'id',
				autoIncrement: true,
			})
			history.createIndex('trackId', 'trackId', { unique: true })
			history.createIndex('playedAt', 'playedAt')
		},
	})
	await old.put('tracks', {
		id: 7,
		uuid: 'old-track',
		name: 'Song',
		album: 'Album',
		artists: ['Artist'],
		year: '2024',
		duration: 1,
		trackNo: 1,
		discNo: 1,
		directory: 2,
		fileName: 'song.flac',
	})
	await old.put('playlistEntries', { id: 3, playlistId: 5, trackId: 7, addedAt: 10 })
	await old.put('playHistory', { id: 4, trackId: 7, playedAt: 11 })
	old.close()

	const { getDatabase } = await import('./database.ts')
	const upgraded = await getDatabase()
	expect(upgraded.version).toBe(5)
	expect(upgraded.transaction('tracks').store.indexNames.contains('byRelativePath')).toBe(true)
	expect(await upgraded.get('tracks', 7)).toMatchObject({ uuid: 'old-track' })
	expect(await upgraded.get('playlistEntries', 3)).toMatchObject({ trackId: 7 })
	expect(await upgraded.get('playHistory', 4)).toMatchObject({ trackId: 7 })
})
