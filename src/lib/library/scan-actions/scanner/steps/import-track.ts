import type { IDBPTransaction } from 'idb'
import { type AppDB, getDatabase } from '$lib/db/database.ts'
import { type DatabaseChangeDetails, dispatchDatabaseChangedEvent } from '$lib/db/events.ts'
import { dbDeleteOrphanedImagesWithTx } from '$lib/library/images.ts'
import {
	type Album,
	type Artist,
	type ImageRecord,
	type Track,
	UNKNOWN_ITEM,
	type UnknownTrack,
} from '$lib/library/types.ts'

type ImportTrackTx = IDBPTransaction<
	AppDB,
	('tracks' | 'albums' | 'artists' | 'images')[],
	'readwrite'
>

/** @public */
export interface TrackImport {
	metadata: UnknownTrack
	existingTrackId?: number
	imageRecord?: ImageRecord
}

/** The caller must dispatch the collected changes after the transaction commits. */
export type ChangeCollector = (changes: DatabaseChangeDetails[]) => void

interface ImportCache {
	albums: Map<string, Album>
	artists: Set<string>
	images: Set<string>
}

const dbImportAlbum = async (
	tx: ImportTrackTx,
	track: Track,
	cache: ImportCache,
): Promise<DatabaseChangeDetails | undefined> => {
	const store = tx.objectStore('albums')
	const existing = cache.albums.get(track.album) ?? (await store.index('name').get(track.album))
	const album: Omit<Album, 'id'> = existing
		? {
				...existing,
				artists: [...new Set([...existing.artists, ...track.artists])].filter(
					(artist) => artist !== UNKNOWN_ITEM,
				),
				year: existing.year ?? track.year,
				imageHash: existing.imageHash ?? track.imageHash,
				image: (existing.imageHash ?? track.imageHash) ? undefined : existing.image,
			}
		: {
				uuid: crypto.randomUUID(),
				name: track.album,
				artists: track.artists,
				year: track.year,
				imageHash: track.imageHash,
			}

	if (
		existing &&
		existing.year === album.year &&
		existing.imageHash === album.imageHash &&
		existing.image === album.image &&
		existing.artists.length === album.artists.length &&
		existing.artists.every((artist, index) => artist === album.artists[index])
	) {
		cache.albums.set(track.album, existing)
		return undefined
	}

	const albumId = await store.put(album as Album)
	cache.albums.set(track.album, { ...album, id: albumId })

	return { storeName: 'albums', key: albumId, operation: existing ? 'update' : 'add' }
}

const dbImportArtists = async (
	tx: ImportTrackTx,
	artistNames: readonly string[],
	cache: ImportCache,
): Promise<DatabaseChangeDetails[]> => {
	const store = tx.objectStore('artists')
	const changes: DatabaseChangeDetails[] = []

	for (const name of new Set(artistNames)) {
		if (cache.artists.has(name)) {
			continue
		}

		const existingId = await store.index('name').getKey(name)
		if (existingId === undefined) {
			const artist: Omit<Artist, 'id'> = { name, uuid: crypto.randomUUID() }
			const artistId = await store.put(artist as Artist)
			changes.push({ storeName: 'artists', key: artistId, operation: 'add' })
		}
		cache.artists.add(name)
	}

	return changes
}

const dbPutImageWithTx = async (
	tx: ImportTrackTx,
	image: ImageRecord,
	cache: ImportCache,
): Promise<DatabaseChangeDetails | undefined> => {
	if (cache.images.has(image.hash)) {
		return undefined
	}

	const store = tx.objectStore('images')
	const existing = await store.get(image.hash)
	cache.images.add(image.hash)
	if (existing?.full && existing.small) {
		return undefined
	}

	// Repair incomplete records left by an interrupted or older import as well.
	await store.put(image)
	return { storeName: 'images', key: image.hash, operation: existing ? 'update' : 'add' }
}

/**
 * Imports a bounded batch in one transaction. Parsing and image decoding must
 * happen before this call so the transaction never waits on file I/O.
 * @public
 */
export const dbImportTracksBatch = async (
	items: readonly TrackImport[],
	changeCollector?: ChangeCollector,
): Promise<number[]> => {
	if (items.length === 0) {
		return []
	}

	const db = await getDatabase()
	const tx = db.transaction(['tracks', 'albums', 'artists', 'images'], 'readwrite')
	const tracks = tx.objectStore('tracks')
	const cache: ImportCache = { albums: new Map(), artists: new Set(), images: new Set() }
	const changes: DatabaseChangeDetails[] = []
	const oldImageHashes: string[] = []
	const ids: number[] = []

	try {
		for (const { metadata, existingTrackId, imageRecord } of items) {
			const oldImageHash =
				existingTrackId === undefined
					? undefined
					: (await tracks.get(existingTrackId))?.imageHash
			const imageChange = imageRecord
				? await dbPutImageWithTx(tx, imageRecord, cache)
				: undefined
			if (imageChange) {
				changes.push(imageChange)
			}

			const record =
				existingTrackId === undefined ? metadata : { ...metadata, id: existingTrackId }
			const trackId = await tracks.put(record as Track)
			const track: Track = { ...metadata, id: trackId }
			ids.push(trackId)
			changes.push({
				storeName: 'tracks',
				key: trackId,
				operation: existingTrackId === undefined ? 'add' : 'update',
			})

			const albumChange = await dbImportAlbum(tx, track, cache)
			if (albumChange) {
				changes.push(albumChange)
			}
			changes.push(...(await dbImportArtists(tx, track.artists, cache)))

			if (oldImageHash && oldImageHash !== metadata.imageHash) {
				oldImageHashes.push(oldImageHash)
			}
		}

		changes.push(
			...(await dbDeleteOrphanedImagesWithTx(
				{
					tracksByImage: tracks.index('imageHash'),
					albumsByImage: tx.objectStore('albums').index('imageHash'),
					imagesStore: tx.objectStore('images'),
				},
				oldImageHashes,
			)),
		)
		await tx.done
	} catch (error) {
		try {
			tx.abort()
		} catch {
			// IndexedDB may already have aborted the transaction.
		}
		await tx.done.catch(() => {})
		throw error
	}

	if (changeCollector) {
		changeCollector(changes)
	} else {
		dispatchDatabaseChangedEvent(changes)
	}

	return ids
}

/** @public */
export const dbImportTrack = async (
	metadata: UnknownTrack,
	existingTrackId: number | undefined,
	imageRecord?: ImageRecord,
	changeCollector?: ChangeCollector,
): Promise<number> => {
	const [id] = await dbImportTracksBatch(
		[{ metadata, existingTrackId, imageRecord }],
		changeCollector,
	)
	invariant(id !== undefined, 'Track import must return an id')
	return id
}
