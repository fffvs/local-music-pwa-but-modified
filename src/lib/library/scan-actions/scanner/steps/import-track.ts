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
        ('tracks' | 'albums' | 'artists' | 'playlistEntries' | 'images')[],
        'readwrite'
>

const dbImportAlbum = async (tx: ImportTrackTx, track: Track) => {
        const albumName = track.album

        const store = tx.objectStore('albums')

        const existingAlbum = await store.index('name').get(albumName)
        const updatedAlbum: Omit<Album, 'id'> = existingAlbum
                ? {
                                ...existingAlbum,
                                artists: [...new Set([...existingAlbum.artists, ...track.artists])].filter(
                                        (artist) => artist !== UNKNOWN_ITEM,
                                ),
                                year: existingAlbum.year ?? track.year,
                                imageHash: existingAlbum.imageHash ?? track.imageHash,
                                image:
                                        (existingAlbum.imageHash ?? track.imageHash) ? undefined : existingAlbum.image,
                        }
                : {
                                uuid: crypto.randomUUID(),
                                name: albumName,
                                artists: track.artists,
                                year: track.year,
                                imageHash: track.imageHash,
                        }

        const albumId = await store.put(updatedAlbum as Album)

        const change: DatabaseChangeDetails = {
                storeName: 'albums',
                key: albumId,
                operation: existingAlbum ? 'update' : 'add',
        }

        return change
}

const dbImportArtist = async (tx: ImportTrackTx, artistName: string) => {
        const store = tx.objectStore('artists')

        const existingArtistId = await store.index('name').getKey(artistName)
        if (existingArtistId) {
                return
        }

        const newArtist: Omit<Artist, 'id'> = {
                name: artistName,
                uuid: crypto.randomUUID(),
        }

        const artistId = await store.put(newArtist as Artist)

        const change: DatabaseChangeDetails = {
                storeName: 'artists',
                key: artistId,
                operation: 'add',
        }

        return change
}

const dbImportArtists = (tx: ImportTrackTx, artistNames: string[]) =>
        Promise.all(artistNames.map(async (artist) => dbImportArtist(tx, artist)))

const dbPutImageIfAbsentWithTx = async (
        tx: ImportTrackTx,
        imageRecord: ImageRecord,
): Promise<DatabaseChangeDetails | undefined> => {
        const store = tx.objectStore('images')

        if (await store.getKey(imageRecord.hash)) {
                return undefined
        }

        await store.put(imageRecord)

        return {
                storeName: 'images',
                key: imageRecord.hash,
                operation: 'add',
        }
}

/**
 * Optional collector function. When provided, database change events are
 * pushed into it instead of being dispatched immediately. The caller is then
 * responsible for dispatching a coalesced event batch.
 * @public
 */
export type ChangeCollector = (changes: DatabaseChangeDetails[]) => void

/** @public */
export const dbImportTrack = async (
        metadata: UnknownTrack,
        existingTrackId: number | undefined,
        imageRecord?: ImageRecord,
        changeCollector?: ChangeCollector,
): Promise<number> => {
        const db = await getDatabase()
        const tx = db.transaction(
                ['tracks', 'albums', 'artists', 'playlistEntries', 'images'],
                'readwrite',
        )

        const tracksStore = tx.objectStore('tracks')

        const oldImageHash =
                existingTrackId === undefined
                        ? undefined
                        : (await tracksStore.get(existingTrackId))?.imageHash

        const record =
                existingTrackId === undefined
                        ? metadata
                        : ({ ...metadata, id: existingTrackId } satisfies Track)

        const imageChange = imageRecord ? await dbPutImageIfAbsentWithTx(tx, imageRecord) : undefined

        const trackId = await tracksStore.put(record as Track)
        const track: Track = {
                ...metadata,
                id: trackId,
        }

        const [albumChange, artistsChanges] = await Promise.all([
                dbImportAlbum(tx, track),
                dbImportArtists(tx, track.artists),
        ])

        const imageGcChanges =
                oldImageHash && oldImageHash !== metadata.imageHash
                        ? await dbDeleteOrphanedImagesWithTx(
                                        {
                                                tracksByImage: tx.objectStore('tracks').index('imageHash'),
                                                albumsByImage: tx.objectStore('albums').index('imageHash'),
                                                imagesStore: tx.objectStore('images'),
                                        },
                                        [oldImageHash],
                                )
                        : []

        await tx.done

        const allChanges: (DatabaseChangeDetails | undefined)[] = [
                {
                        storeName: 'tracks',
                        key: trackId,
                        operation: existingTrackId === undefined ? 'add' : 'update',
                },
                albumChange,
                ...artistsChanges,
                imageChange,
                ...imageGcChanges,
        ]

        const validChanges = allChanges.filter(
                (c): c is DatabaseChangeDetails => c !== undefined,
        )

        if (changeCollector) {
                // Batch mode: caller will dispatch a single coalesced event later
                changeCollector(validChanges)
        } else {
                // Legacy mode: preserve original per-track dispatch behavior
                dispatchDatabaseChangedEvent(validChanges)
        }

        return trackId
}