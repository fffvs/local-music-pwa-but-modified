import { COMPANION_ART_NAMES, isSupportedMusicFile } from '$lib/helpers/file-system.ts'
import type { LegacyFilesChunk, LegacyScanFile } from './types.ts'

const FILES_PER_CHUNK = 16
const ENTRIES_PER_YIELD = 256

const parentPath = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)
const filePath = (file: File): string => file.webkitRelativePath || file.name

/**
 * A webkitdirectory picker necessarily returns a complete browser-owned FileList.
 * Keep only directory-to-index metadata and send a small chunk to the worker on
 * demand, rather than cloning a second library-sized array of File objects.
 */
export class LegacyFileReader {
	readonly #files: FileList | readonly File[]
	readonly #artworkIndexes = new Map<string, number>()
	#initialized = false
	#offset = 0
	#paused = false
	#cancelled = false
	#wake: (() => void) | undefined

	constructor(files: FileList | readonly File[]) {
		this.#files = files
	}

	setPaused(paused: boolean): void {
		this.#paused = paused
		this.#notify()
	}

	cancel(): void {
		this.#cancelled = true
		this.#notify()
	}

	async nextChunk(): Promise<LegacyFilesChunk> {
		if (!(await this.#checkpoint())) {
			return { files: [], done: true }
		}

		if (!this.#initialized) {
			for (let index = 0; index < this.#files.length; index += 1) {
				const file = this.#files[index]
				if (file && COMPANION_ART_NAMES.has(file.name.toLowerCase())) {
					this.#artworkIndexes.set(parentPath(filePath(file)), index)
				}
				if ((index + 1) % ENTRIES_PER_YIELD === 0 && !(await this.#yield())) {
					return { files: [], done: true }
				}
			}
			this.#initialized = true
		}

		const files: LegacyScanFile[] = []
		let examined = 0
		while (this.#offset < this.#files.length && files.length < FILES_PER_CHUNK) {
			const file = this.#files[this.#offset]
			this.#offset += 1
			if (file && isSupportedMusicFile(file.name)) {
				const relativePath = filePath(file)
				const artworkIndex = this.#artworkIndexes.get(parentPath(relativePath))
				files.push({
					file,
					relativePath,
					companionArtwork:
						artworkIndex === undefined ? undefined : this.#files[artworkIndex],
				})
			}
			examined += 1
			if (examined % ENTRIES_PER_YIELD === 0 && !(await this.#yield())) {
				return { files: [], done: true }
			}
		}
		return { files, done: this.#offset >= this.#files.length }
	}

	async #checkpoint(): Promise<boolean> {
		while (this.#paused && !this.#cancelled) {
			await new Promise<void>((resolve) => {
				this.#wake = resolve
			})
		}
		return !this.#cancelled
	}

	async #yield(): Promise<boolean> {
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		return this.#checkpoint()
	}

	#notify(): void {
		this.#wake?.()
		this.#wake = undefined
	}
}
