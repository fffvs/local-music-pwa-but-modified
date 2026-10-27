import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbGetImageRecord } from '$lib/library/images.ts'
import type { Album } from '$lib/library/types.ts'
import {
	createManagedArtwork,
	getAlbumManagedArtworkSource,
} from '../create-managed-artwork.svelte.ts'

vi.mock('$lib/library/images', () => ({ dbGetImageRecord: vi.fn() }))

const album: Album = {
	id: 1,
	uuid: 'album',
	name: 'Album',
	artists: ['Artist'],
	year: '2024',
	imageHash: 'test-thumbnail',
}

describe('managed album artwork', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('uses the thumbnail tier when requested while keeping full art as the default', () => {
		expect(getAlbumManagedArtworkSource(album, 'small')).toMatchObject({
			type: 'imageHash',
			size: 'small',
		})
		expect(getAlbumManagedArtworkSource(album)).toMatchObject({
			type: 'imageHash',
			size: 'full',
		})
	})

	it('uses a stored optimized thumbnail without decoding the full-size cover', async () => {
		const full = new Blob(['full'], { type: 'image/jpeg' })
		const small = new Blob(['small'], { type: 'image/webp' })
		vi.mocked(dbGetImageRecord).mockResolvedValue({
			hash: 'test-thumbnail',
			optimized: true,
			full,
			small,
			primaryColor: undefined,
		})
		const decode = vi.fn()
		vi.stubGlobal('createImageBitmap', decode)
		const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail')
		let source: () => string | undefined = () => undefined
		const cleanup = $effect.root(() => {
			source = createManagedArtwork(() => getAlbumManagedArtworkSource(album, 'small'))
		})

		flushSync()
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve()
		}
		flushSync()
		expect(createUrl).toHaveBeenCalledWith(small)
		expect(decode).not.toHaveBeenCalled()
		expect(source()).toBe('blob:thumbnail')
		cleanup()
	})
})
