import { browser } from '$app/env'
import { LegacyFileReader } from './legacy-files.ts'
import type {
	TracksScanMessage,
	TracksScanOptions,
	TracksScanProgress,
	TracksScanRequest,
	TracksScanResult,
} from './types.ts'

export type {
	/** @public */
	TracksScanOptions,
	/** @public */
	TracksScanProgress,
	/** @public */
	TracksScanResult,
} from './types.ts'

/** @public */
export type TrackParsedFn = (totalParsedCount: number) => void

let activeWorker: Worker | null = null
let activeLegacyReader: LegacyFileReader | null = null
let playbackActive = false
let scanProgress = $state.raw<TracksScanProgress | null>(null)
let progressListener: ((progress: TracksScanProgress) => void) | undefined

const updateProgress = (progress: TracksScanProgress): void => {
	scanProgress = progress
	activeLegacyReader?.setPaused(progress.pauseReason !== null)
	progressListener?.(progress)
}

const send = (request: TracksScanRequest): void => {
	activeWorker?.postMessage(request)
}

/** @public */
export const getScanProgress = (): TracksScanProgress | null => scanProgress

/** Automatically give playback priority, unless the user resumes this scan. @public */
export const setScanPlaybackActive = (active: boolean): void => {
	if (playbackActive === active) {
		return
	}
	playbackActive = active
	send({ type: 'playback', active })
}

/** @public */
export const pauseTrackScan = (): void => {
	if (scanProgress && !scanProgress.stopping) {
		updateProgress({ ...scanProgress, pauseReason: 'manual' })
		send({ type: 'pause' })
	}
}

/** @public */
export const resumeTrackScan = (): void => {
	if (scanProgress && !scanProgress.stopping) {
		updateProgress({ ...scanProgress, pauseReason: null })
		send({ type: 'resume' })
	}
}

/** @public */
export const cancelTrackScan = (): void => {
	if (scanProgress && !scanProgress.stopping) {
		activeLegacyReader?.cancel()
		updateProgress({ ...scanProgress, stopping: true })
		send({ type: 'cancel' })
	}
}

/** @public */
export const startTrackScannerWorker = (
	options: TracksScanOptions,
	progress: (data: TracksScanProgress) => void,
): Promise<TracksScanResult> => {
	if (!browser) {
		throw new Error('startTrackScannerWorker is only available in the browser')
	}
	if (activeWorker) {
		throw new Error('A library scan is already running')
	}

	const { promise, reject, resolve } = Promise.withResolvers<TracksScanResult>()
	const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
	activeWorker = worker
	activeLegacyReader =
		options.action === 'legacy-files-add' ? new LegacyFileReader(options.files) : null
	progressListener = progress
	let settled = false

	const cleanup = () => {
		if (settled) {
			return false
		}
		settled = true
		worker.terminate()
		activeWorker = null
		activeLegacyReader?.cancel()
		activeLegacyReader = null
		progressListener = undefined
		scanProgress = null
		return true
	}

	worker.addEventListener('error', (event) => {
		event.preventDefault()
		if (cleanup()) {
			reject(new Error(event.message || 'The scanner worker stopped unexpectedly'))
		}
	})
	worker.addEventListener('messageerror', () => {
		if (cleanup()) {
			reject(new Error('Could not receive a scanner message'))
		}
	})
	worker.addEventListener('message', ({ data }: MessageEvent<TracksScanMessage>) => {
		if (settled) {
			return
		}
		if (data.type === 'progress') {
			updateProgress(data.progress)
		} else if (data.type === 'request-legacy-chunk') {
			const reader = activeLegacyReader
			if (!reader) {
				if (cleanup()) {
					reject(new Error('The legacy file source is unavailable'))
				}
				return
			}
			void reader
				.nextChunk()
				.then((chunk) => {
					if (!settled) {
						worker.postMessage({
							type: 'legacy-chunk',
							chunk,
						} satisfies TracksScanRequest)
					}
				})
				.catch((error: unknown) => {
					if (!settled) {
						try {
							worker.postMessage({
								type: 'legacy-error',
								name: error instanceof Error ? error.name : 'Error',
								message:
									error instanceof Error
										? error.message
										: 'Could not read selected files',
							} satisfies TracksScanRequest)
						} catch (postError) {
							if (cleanup()) {
								reject(postError)
							}
						}
					}
				})
		} else if (data.type === 'done') {
			if (cleanup()) {
				resolve(data.result)
			}
		} else if (cleanup()) {
			const error = new Error(data.message)
			error.name = data.name
			reject(error)
		}
	})

	updateProgress({
		newlyImported: 0,
		current: 0,
		failed: 0,
		cancelled: false,
		pauseReason: playbackActive ? 'playback' : null,
		stopping: false,
	})
	try {
		const workerOptions =
			options.action === 'legacy-files-add'
				? { action: 'legacy-files-add' as const }
				: options
		worker.postMessage({
			type: 'start',
			options: workerOptions,
			playbackActive,
		} satisfies TracksScanRequest)
	} catch (error) {
		if (cleanup()) {
			reject(error)
		}
	}

	return promise
}
