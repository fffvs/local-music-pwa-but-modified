export const isFileSystemAccessSupported: boolean = 'showDirectoryPicker' in globalThis

export type FileEntity = File | FileSystemFileHandle

const supportedExtensions = ['aac', 'mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']
const supportedExtensionsWithDot = supportedExtensions.map((ext) => `.${ext}`)

export const isSupportedMusicFile = (fileName: string): boolean => {
	const lowerName = fileName.toLowerCase()
	return supportedExtensionsWithDot.some((extension) => lowerName.endsWith(extension))
}

export const COMPANION_ART_NAMES = new Set([
	'cover.jpg',
	'cover.jpeg',
	'cover.png',
	'folder.jpg',
	'folder.jpeg',
	'folder.png',
	'front.jpg',
	'front.jpeg',
	'front.png',
	'album.jpg',
	'album.jpeg',
	'album.png',
])

export interface DiscoveredMusicFile {
	file: FileSystemFileHandle
	/** Path relative to the directory the user selected. */
	relativePath: string
	companionArtwork?: File
	companionArtworkUnavailable: boolean
}

interface WalkDirectoryOptions {
	checkpoint?: () => Promise<void>
	onArtworkError?: (error: unknown, path: string) => void
}

// Small album folders are traversed once. Large folders are re-enumerated rather
// than retaining every handle so their cover can still appear after their tracks.
const MAX_BUFFERED_DIRECTORY_ENTRIES = 128

export async function* walkMusicDirectory(
	directory: FileSystemDirectoryHandle,
	options: WalkDirectoryOptions = {},
	prefix = '',
): AsyncGenerator<DiscoveredMusicFile> {
	const checkpoint = options.checkpoint ?? (() => Promise.resolve())
	const buffered: FileSystemHandle[] = []
	let overflowed = false
	let artworkHandle: FileSystemFileHandle | undefined

	for await (const handle of directory.values()) {
		await checkpoint()
		if (handle.kind === 'file' && COMPANION_ART_NAMES.has(handle.name.toLowerCase())) {
			artworkHandle = handle as FileSystemFileHandle
		}

		if (!overflowed) {
			if (buffered.length < MAX_BUFFERED_DIRECTORY_ENTRIES) {
				buffered.push(handle)
			} else {
				overflowed = true
				buffered.length = 0
			}
		}
	}

	let companionArtwork: File | undefined
	let companionArtworkUnavailable = false
	if (artworkHandle) {
		await checkpoint()
		try {
			companionArtwork = await artworkHandle.getFile()
		} catch (error) {
			companionArtworkUnavailable = true
			console.error('[companion-art] failed to load:', artworkHandle.name, error)
			options.onArtworkError?.(error, `${prefix}${artworkHandle.name}`)
		}
	}

	const entries = overflowed ? directory.values() : buffered
	for await (const handle of entries) {
		await checkpoint()
		const relativePath = `${prefix}${handle.name}`
		if (handle.kind === 'directory') {
			yield* walkMusicDirectory(
				handle as FileSystemDirectoryHandle,
				options,
				`${relativePath}/`,
			)
		} else if (isSupportedMusicFile(handle.name)) {
			yield {
				file: handle as FileSystemFileHandle,
				relativePath,
				companionArtwork,
				companionArtworkUnavailable,
			}
		}
	}
}

export const getFilesFromLegacyDirectory = (): Promise<FileList | null> => {
	const directoryElement = document.createElement('input')
	directoryElement.type = 'file'

	directoryElement.setAttribute('webkitdirectory', '')
	directoryElement.setAttribute('directory', '')

	const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<FileList | null>()

	const resolve = (files: FileList | null) => {
		directoryElement.remove()
		resolvePromise(files)
	}

	directoryElement.addEventListener('change', () => {
		resolve(directoryElement.files)
	})

	directoryElement.addEventListener('cancel', () => {
		resolve(null)
	})

	directoryElement.addEventListener('error', (errorEvent) => {
		reject(new Error('Input error', { cause: errorEvent }))
	})

	directoryElement.style.position = 'fixed'
	directoryElement.style.top = '-100000px'
	directoryElement.style.left = '-100000px'
	document.body.appendChild(directoryElement)

	directoryElement.click()

	return promise
}
