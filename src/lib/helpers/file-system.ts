export const isFileSystemAccessSupported: boolean = 'showDirectoryPicker' in globalThis

export type FileEntity = File | FileSystemFileHandle

const supportedExtensions = ['aac', 'mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']
const supportedExtensionsWithDot = supportedExtensions.map((ext) => `.${ext}`)

const isSupportedFile = (fileName: string): boolean => {
        const fileNameLower = fileName.toLowerCase()
        return supportedExtensionsWithDot.some((ext) => fileNameLower.endsWith(ext))
}

// Map associating scanned audio files to their directory's companion art blob
export const companionArtMap = new WeakMap<FileEntity, Blob>()

export const COMPANION_ART_NAMES = new Set([
        'cover.jpg', 'cover.jpeg', 'cover.png',
        'folder.jpg', 'folder.jpeg', 'folder.png',
        'front.jpg', 'front.jpeg', 'front.png',
        'album.jpg', 'album.jpeg', 'album.png'
])

export const getFileHandlesRecursively = async (
        directory: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle[]> => {
        const files: FileSystemFileHandle[] = []
        const subDirs: FileSystemDirectoryHandle[] = []
        let companionArtHandle: FileSystemFileHandle | undefined

        // First pass: group files and subdirectories, check for companion art
        for await (const handle of directory.values()) {
                if (handle.kind === 'file') {
                        const lowerName = handle.name.toLowerCase()
                        if (COMPANION_ART_NAMES.has(lowerName)) {
                                companionArtHandle = handle
                        } else if (isSupportedFile(handle.name)) {
                                files.push(handle)
                        }
                } else if (handle.kind === 'directory') {
                        subDirs.push(handle)
                }
        }

        // If a companion art file exists, read it as a blob
        let companionBlob: Blob | undefined
        if (companionArtHandle) {
                try {
                        companionBlob = await companionArtHandle.getFile()
                } catch (e) {
                        console.error('[companion-art] failed to load:', companionArtHandle.name, e)
                }
        }

        // Map companion artwork to all audio files in this directory
        if (companionBlob) {
                for (const file of files) {
                        companionArtMap.set(file, companionBlob)
                }
        }

        // Recursively read subdirectories
        for (const subDir of subDirs) {
                const subDirFiles = await getFileHandlesRecursively(subDir)
                files.push(...subDirFiles)
        }

        return files
}

const getFilesFromLegacyInputEvent = (e: Event): File[] => {
        const { files } = e.target as HTMLInputElement
        if (!files) {
                return []
        }
        return Array.from(files).filter((file) => isSupportedFile(file.name))
}

export const getFilesFromLegacyDirectory = (): Promise<File[]> => {
        const directoryElement = document.createElement('input')
        directoryElement.type = 'file'

        directoryElement.setAttribute('webkitdirectory', '')
        directoryElement.setAttribute('directory', '')

        const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<File[]>()

        const resolve = (files: File[]) => {
                directoryElement.remove()
                resolvePromise(files)
        }

        directoryElement.addEventListener('change', (e) => {
                resolve(getFilesFromLegacyInputEvent(e))
        })

        directoryElement.addEventListener('cancel', () => {
                resolve([])
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
