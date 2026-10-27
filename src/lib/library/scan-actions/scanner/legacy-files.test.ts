import { describe, expect, it } from 'vitest'
import { LegacyFileReader } from './legacy-files.ts'

const file = (path: string): File => {
	const value = new File(['data'], path.split('/').at(-1) ?? path)
	Object.defineProperty(value, 'webkitRelativePath', { value: path })
	return value
}

describe('LegacyFileReader', () => {
	it('sends bounded chunks and matches companion artwork even when it appears last', async () => {
		const songs = Array.from({ length: 35 }, (_, index) => file(`Music/Album/${index}.flac`))
		const otherSong = file('Music/Other/0.flac')
		const cover = file('Music/Album/cover.jpg')
		const reader = new LegacyFileReader([...songs, otherSong, cover, file('Music/readme.txt')])
		const chunks = []
		let done = false
		while (!done) {
			const chunk = await reader.nextChunk()
			expect(chunk.files.length).toBeLessThanOrEqual(16)
			chunks.push(...chunk.files)
			done = chunk.done
		}

		expect(chunks).toHaveLength(36)
		expect(chunks[0]).toMatchObject({
			relativePath: 'Music/Album/0.flac',
			companionArtwork: cover,
		})
		expect(chunks.at(-1)).toMatchObject({ relativePath: 'Music/Other/0.flac' })
		expect(chunks.at(-1)?.companionArtwork).toBeUndefined()
	})

	it('waits while paused and wakes safely on cancellation', async () => {
		const reader = new LegacyFileReader([file('Music/song.flac')])
		reader.setPaused(true)
		const pending = reader.nextChunk()
		reader.cancel()
		expect(await pending).toEqual({ files: [], done: true })
	})

	it('continues after resuming', async () => {
		const reader = new LegacyFileReader([file('Music/song.flac')])
		reader.setPaused(true)
		const pending = reader.nextChunk()
		reader.setPaused(false)
		expect((await pending).files).toHaveLength(1)
	})
})
