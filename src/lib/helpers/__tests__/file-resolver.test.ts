import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '$lib/db/database.ts'
import { resolveTrackFile } from '$lib/helpers/file-resolver.ts'

vi.mock('$lib/db/database', () => ({ getDatabase: vi.fn() }))
vi.mock('$lib/helpers/utils/ua', () => ({
	isAndroid: () => true,
	isChromiumBased: () => true,
}))

describe('Android track file resolution', () => {
	afterEach(() => vi.restoreAllMocks())

	it('resolves nested relative paths from the selected directory', async () => {
		const file = new File(['audio'], '01.flac')
		const leaf = { getFileHandle: vi.fn(async () => ({ getFile: async () => file })) }
		const artist = { getDirectoryHandle: vi.fn(async () => leaf) }
		const root = {
			queryPermission: vi.fn(async () => 'granted'),
			getDirectoryHandle: vi.fn(async () => artist),
		}
		const db = { get: vi.fn(async () => ({ handle: root })) }
		vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>)

		const result = await resolveTrackFile({
			directoryId: 1,
			entity: { name: '01.flac' } as FileSystemFileHandle,
			relativePath: 'Artist/Album/01.flac',
			askPermission: false,
		})
		expect(result).toEqual({ status: 'loaded', file })
		expect(root.getDirectoryHandle).toHaveBeenCalledWith('Artist')
		expect(artist.getDirectoryHandle).toHaveBeenCalledWith('Album')
		expect(leaf.getFileHandle).toHaveBeenCalledWith('01.flac')
	})

	it('still resolves older root-level records without a relative path', async () => {
		const file = new File(['audio'], 'song.flac')
		const root = {
			queryPermission: vi.fn(async () => 'granted'),
			getFileHandle: vi.fn(async () => ({ getFile: async () => file })),
		}
		const db = { get: vi.fn(async () => ({ handle: root })) }
		vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>)

		const result = await resolveTrackFile({
			directoryId: 1,
			entity: { name: 'song.flac' } as FileSystemFileHandle,
			askPermission: false,
		})
		expect(result).toEqual({ status: 'loaded', file })
		expect(root.getFileHandle).toHaveBeenCalledWith('song.flac')
	})
})
