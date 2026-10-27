export interface TracksScanResult {
	/** Tracks whose metadata was newly added or updated. */
	newlyImported: number
	/** Audio files checked so far. */
	current: number
	/** Files or companion artwork that could not be read. */
	failed: number
	cancelled: boolean
}

export type ScanPauseReason = 'manual' | 'playback' | null

/** @public */
export interface TracksScanProgress extends TracksScanResult {
	pauseReason: ScanPauseReason
	stopping: boolean
}

/** @public */
export type TracksScanOptions =
	| {
			action: 'directory-add' | 'directory-rescan'
			dirId: number
			dirHandle: FileSystemDirectoryHandle
	  }
	// Used in browsers which do not support showDirectoryPicker.
	| {
			action: 'legacy-files-add'
			files: FileList | readonly File[]
	  }

export type TracksScanWorkerOptions =
	| Exclude<TracksScanOptions, { action: 'legacy-files-add' }>
	| { action: 'legacy-files-add' }

export interface LegacyScanFile {
	file: File
	relativePath: string
	companionArtwork?: File
}

export interface LegacyFilesChunk {
	files: LegacyScanFile[]
	done: boolean
}

export type TracksScanRequest =
	| { type: 'start'; options: TracksScanWorkerOptions; playbackActive: boolean }
	| { type: 'legacy-chunk'; chunk: LegacyFilesChunk }
	| { type: 'legacy-error'; name: string; message: string }
	| { type: 'playback'; active: boolean }
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'cancel' }

export type TracksScanMessage =
	| { type: 'progress'; progress: TracksScanProgress }
	| { type: 'request-legacy-chunk' }
	| { type: 'done'; result: TracksScanResult }
	| { type: 'error'; name: string; message: string }
