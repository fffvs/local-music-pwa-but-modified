import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFilesFromLegacyDirectory, walkMusicDirectory } from '$lib/helpers/file-system.ts'

const fileHandle = (name: string, contents = name) => {
	const file = new File([contents], name)
	return {
		kind: 'file' as const,
		name,
		getFile: vi.fn(async () => file),
	} as unknown as FileSystemFileHandle
}

const directoryHandle = (name: string, entries: FileSystemHandle[]) => {
	const values = vi.fn(async function* () {
		yield* entries
	})
	return { kind: 'directory' as const, name, values } as unknown as FileSystemDirectoryHandle & {
		values: typeof values
	}
}

const collect = async (root: FileSystemDirectoryHandle) => {
	const files = []
	for await (const file of walkMusicDirectory(root)) {
		files.push(file)
	}
	return files
}

describe('walkMusicDirectory', () => {
	afterEach(() => vi.restoreAllMocks())

	it('finds a companion cover even when it appears after the music', async () => {
		const audio = fileHandle('01.FLAC')
		const cover = fileHandle('cover.jpg')
		const album = directoryHandle('Album', [audio, cover])
		const root = directoryHandle('Music', [album])

		const files = await collect(root)
		expect(files).toHaveLength(1)
		expect(files[0]?.relativePath).toBe('Album/01.FLAC')
		expect(files[0]?.companionArtwork?.name).toBe('cover.jpg')
		expect(files[0]?.companionArtworkUnavailable).toBe(false)
		expect(audio.getFile).not.toHaveBeenCalled()
		expect(cover.getFile).toHaveBeenCalledTimes(1)
		expect(album.values).toHaveBeenCalledTimes(1)
	})

	it('re-enumerates large folders instead of retaining every handle', async () => {
		const tracks = Array.from({ length: 150 }, (_, index) => fileHandle(`${index}.flac`))
		const cover = fileHandle('folder.png')
		const root = directoryHandle('Music', [...tracks, cover])

		const files = await collect(root)
		expect(root.values).toHaveBeenCalledTimes(2)
		expect(files).toHaveLength(150)
		expect(files.every((item) => item.companionArtwork?.name === 'folder.png')).toBe(true)
		expect(cover.getFile).toHaveBeenCalledTimes(1)
	})

	it('reports an unreadable cover without dropping music', async () => {
		const audio = fileHandle('song.flac')
		const cover = fileHandle('front.jpg')
		vi.mocked(cover.getFile).mockRejectedValue(
			new DOMException('unavailable', 'NotReadableError'),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const onArtworkError = vi.fn()
		const root = directoryHandle('Music', [audio, cover])
		const files = []
		for await (const file of walkMusicDirectory(root, { onArtworkError })) {
			files.push(file)
		}

		expect(files).toHaveLength(1)
		expect(files[0]?.companionArtworkUnavailable).toBe(true)
		expect(onArtworkError).toHaveBeenCalledOnce()
	})

	it('propagates traversal and cooperative cancellation errors', async () => {
		const root = directoryHandle('Music', [fileHandle('a.flac'), fileHandle('b.flac')])
		const checkpoint = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError')))
		await expect(async () => {
			for await (const _file of walkMusicDirectory(root, { checkpoint })) {
				// Consume the iterator.
			}
		}).rejects.toMatchObject({ name: 'AbortError' })
	})
})

describe('legacy directory picker', () => {
	afterEach(() => vi.restoreAllMocks())

	it('returns the picker file list without copying it into a second array', async () => {
		const music = new File(['track'], 'song.flac')
		const cover = new File(['cover'], 'cover.jpg')
		const other = new File(['text'], 'readme.txt')
		const selected = [music, cover, other]
		vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
			this: HTMLInputElement,
		) {
			Object.defineProperty(this, 'files', { value: selected })
			this.dispatchEvent(new Event('change'))
		})
		expect(await getFilesFromLegacyDirectory()).toBe(selected)
	})
})
