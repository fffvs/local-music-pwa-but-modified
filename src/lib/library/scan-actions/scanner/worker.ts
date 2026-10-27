/// <reference lib='WebWorker' />

import { workerAction } from './actions.ts'
import { ScanGate } from './scan-gate.ts'
import type {
	LegacyFilesChunk,
	LegacyScanFile,
	TracksScanMessage,
	TracksScanRequest,
} from './types.ts'

declare const self: DedicatedWorkerGlobalScope

let gate: ScanGate | undefined
let pendingLegacyChunk:
	| { resolve: (chunk: LegacyFilesChunk) => void; reject: (error: Error) => void }
	| undefined
const post = (message: TracksScanMessage) => self.postMessage(message)

async function* readLegacyFiles(scanGate: ScanGate): AsyncGenerator<LegacyScanFile> {
	while (true) {
		await scanGate.checkpoint()
		const chunkPromise = new Promise<LegacyFilesChunk>((resolve, reject) => {
			pendingLegacyChunk = { resolve, reject }
		})
		post({ type: 'request-legacy-chunk' })
		const chunk = await chunkPromise
		for (const file of chunk.files) {
			yield file
		}
		if (chunk.done) {
			return
		}
	}
}

self.addEventListener('message', (event: MessageEvent<TracksScanRequest>) => {
	const request = event.data
	if (request.type === 'start') {
		if (gate) {
			return
		}
		const scanGate = new ScanGate(request.playbackActive)
		gate = scanGate
		void workerAction(
			request.options,
			scanGate,
			(progress) => post({ type: 'progress', progress }),
			request.options.action === 'legacy-files-add' ? readLegacyFiles(scanGate) : undefined,
		)
			.then((result) => post({ type: 'done', result }))
			.catch((error: unknown) => {
				console.error('[scanner worker]', error)
				post({
					type: 'error',
					name: error instanceof Error ? error.name : 'Error',
					message: error instanceof Error ? error.message : 'Unknown scanner error',
				})
			})
		return
	}

	if (request.type === 'legacy-chunk') {
		pendingLegacyChunk?.resolve(request.chunk)
		pendingLegacyChunk = undefined
		return
	}
	if (request.type === 'legacy-error') {
		const error = new Error(request.message)
		error.name = request.name
		pendingLegacyChunk?.reject(error)
		pendingLegacyChunk = undefined
		return
	}

	if (!gate) {
		return
	}
	if (request.type === 'playback') {
		gate.setPlaybackActive(request.active)
	} else if (request.type === 'pause') {
		gate.pause()
	} else if (request.type === 'resume') {
		gate.resume()
	} else {
		gate.cancel()
	}
})
