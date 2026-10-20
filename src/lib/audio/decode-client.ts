import type { DecodeRequest, DecodeResponse } from './decode-protocol.ts'

export interface DecodedChunk {
	buffer: AudioBuffer
	timestamp: number
}

export interface DecodeWorkerHandle {
	readonly sampleRate: number
	readonly numberOfChannels: number
	/** Opens a decoded-buffer stream starting at `startTime` (seconds). */
	openStream: (
		startTime: number,
		ctx: AudioContext,
	) => AsyncGenerator<DecodedChunk, void, unknown>
	/** Stops the worker. Pending requests reject with an AbortError. */
	terminate: () => void
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** How many chunk requests may be outstanding while a stream is being read. */
const PREFETCH_DEPTH = 2

const abortError = () => new DOMException('Decode worker terminated', 'AbortError')

/**
 * Starts a dedicated decode worker for one file. Resolves to `null` when the
 * worker can't be used (no Worker support, open failure, or the browser can't
 * decode the track), so callers can fall back to decoding on the main thread.
 */
export const openDecodeWorker = async (file: Blob): Promise<DecodeWorkerHandle | null> => {
	if (typeof Worker === 'undefined') {
		return null
	}

	const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
	const pending = new Map<number, (response: DecodeResponse) => void>()
	const rejecters = new Map<number, (error: unknown) => void>()
	let nextId = 1
	let nextStreamId = 1
	let terminated = false

	const rejectAll = (error: unknown) => {
		for (const reject of rejecters.values()) {
			reject(error)
		}
		pending.clear()
		rejecters.clear()
	}

	worker.addEventListener('message', ({ data }: MessageEvent<DecodeResponse>) => {
		const resolve = pending.get(data.id)
		const reject = rejecters.get(data.id)
		pending.delete(data.id)
		rejecters.delete(data.id)

		if (data.type === 'error') {
			reject?.(new Error(data.message))
		} else {
			resolve?.(data)
		}
	})

	worker.addEventListener('error', (event) => {
		rejectAll(event.error ?? new Error('Decode worker failed'))
	})

	const request = (
		message: DistributiveOmit<DecodeRequest, 'id'>,
		transfer: Transferable[] = [],
	): Promise<DecodeResponse> => {
		if (terminated) {
			return Promise.reject(abortError())
		}

		const id = nextId
		nextId += 1
		const { promise, resolve, reject } = Promise.withResolvers<DecodeResponse>()
		pending.set(id, resolve)
		rejecters.set(id, reject)
		worker.postMessage({ ...message, id }, transfer)
		return promise
	}

	const terminate = () => {
		if (terminated) {
			return
		}
		terminated = true
		rejectAll(abortError())
		worker.terminate()
	}

	try {
		const opened = await request({ type: 'open', file })
		if (opened.type !== 'opened' || !opened.decodable) {
			terminate()
			return null
		}

		const { sampleRate, numberOfChannels } = opened

		async function* streamChunks(
			ctx: AudioContext,
			startTime: number,
		): AsyncGenerator<DecodedChunk, void, unknown> {
			const streamId = nextStreamId
			nextStreamId += 1
			await request({ type: 'stream', streamId, startTime })

			// Keep a few chunk requests in flight so the worker decodes ahead of
			// playback instead of waiting for each round trip.
			const inFlight: Promise<DecodeResponse>[] = []
			const fill = () => {
				while (inFlight.length < PREFETCH_DEPTH) {
					const pendingChunk = request({ type: 'next', streamId })
					// Responses we never read (after an abort) must not surface as unhandled.
					pendingChunk.catch(() => {})
					inFlight.push(pendingChunk)
				}
			}

			try {
				fill()
				while (true) {
					const next = inFlight.shift()
					if (!next) {
						return
					}
					const response = await next
					if (response.type !== 'chunk' || response.done) {
						return
					}
					fill()

					const buffer = ctx.createBuffer(
						response.channels.length,
						response.numberOfFrames,
						response.sampleRate,
					)
					for (const [channel, data] of response.channels.entries()) {
						// Data arrived from the worker as a transferred, owned ArrayBuffer.
						buffer.copyToChannel(data as Float32Array<ArrayBuffer>, channel)
					}

					yield { buffer, timestamp: response.timestamp }
				}
			} finally {
				// Best effort: the worker may already be gone during teardown.
				request({ type: 'closeStream', streamId }).catch(() => {})
			}
		}

		return {
			sampleRate,
			numberOfChannels,
			openStream: (startTime, ctx) => streamChunks(ctx, startTime),
			terminate,
		}
	} catch {
		terminate()
		return null
	}
}
