import {
	AudioBufferSink,
	BlobSource,
	canDecodeAudio,
	FLAC,
	Input,
	type InputAudioTrack,
	InputDisposedError,
	PCM_AUDIO_CODECS,
} from 'mediabunny'
import { browser } from '$app/env'
import { isAbortError } from '$lib/helpers/utils/errors.ts'
import { isSafari } from '$lib/helpers/utils/ua.ts'
import { wait } from '$lib/helpers/utils/wait.ts'
import type { AudioGraph } from './audio-graph.svelte.ts'
import {
	type AudioEngineImpl,
	type AudioEngineOptions,
	CURRENT_TIME_UPDATE_TIMEOUT_MS,
} from './engine.ts'

const FORMATS = [FLAC]
const LOOK_AHEAD_TIME_SECONDS = 2.0
// Ultra-fast start: only require 0.2s of decoded buffer to begin playback
const BUFFER_RESUME_SECONDS = 0.2
const SEEK_END_THRESHOLD_SECONDS = 0.5

const isAudioCodecSupported = browser && 'AudioDecoder' in globalThis

export const supportsBufferEngine = (codec: string): boolean | Promise<boolean> => {
	const normalizedCodec = codec.toLowerCase()
	if (!isAudioCodecSupported) {
		return false
	}

	if (PCM_AUDIO_CODECS.includes(normalizedCodec as 'pcm-s16')) {
		return canDecodeAudio(normalizedCodec as 'pcm-s16')
	}

	if (normalizedCodec !== 'flac') {
		return false
	}

	if (isSafari()) {
		return false
	}

	return canDecodeAudio(normalizedCodec as 'flac')
}

interface AudioBufferEngineOptions {
	audioGraph: AudioGraph
	duration: number
	input: Input
	audioTrack: InputAudioTrack
	signal: AbortSignal
	scheduleAt?: number
	preservePitch: boolean
	playbackRate: number
}

/**
 * Plays audio by streaming and decoding via Mediabunny, scheduling decoded
 * AudioBuffers directly on the Web Audio API timeline with minimal memory overhead.
 */
export class AudioBufferEngine implements AudioEngineImpl {
	readonly #graph: AudioGraph
	readonly #gainNode: GainNode

	#input: Input | null
	#audioTrack: InputAudioTrack | null

	#scheduledSources = new Set<AudioBufferSourceNode>()
	#scheduleBase = 0
	#seekOffset = 0

	#schedulingController: AbortController
	readonly #externalSignal: AbortSignal
	#signal: AbortSignal

	#playbackRate = 1
	#timerId: number | null = null

	#lastScheduledEndTime = 0
	#wantsToPlay = false

	currentTime = $state(0)
	readonly duration: number
	buffering = $state(false)

	#ended = false
	get ended(): boolean {
		return this.#ended
	}

	get endTime(): number {
		return this.#scheduleBase + (this.duration - this.#seekOffset) / this.#playbackRate
	}

	onEnded: (() => void) | null = null
	onError: (() => void) | null = null

	constructor(options: AudioBufferEngineOptions) {
		const { audioGraph } = options

		this.#graph = audioGraph
		this.duration = options.duration
		this.#externalSignal = options.signal
		this.#input = options.input
		this.#audioTrack = options.audioTrack
		this.#playbackRate = options.playbackRate

		this.#gainNode = audioGraph.context.createGain()
		this.#gainNode.connect(audioGraph.inputNode)
		this.#schedulingController = new AbortController()

		this.#externalSignal.addEventListener('abort', () => this.#dispose(), { once: true })
		this.#signal = AbortSignal.any([this.#schedulingController.signal, this.#externalSignal])

		this.#startFrom(0, options.scheduleAt)
	}

	seek(time: number): void {
		this.currentTime = time
		this.#resetScheduling()

		if (!this.#wantsToPlay && time >= this.duration - SEEK_END_THRESHOLD_SECONDS) {
			this.#ended = true
			return
		}

		this.#startFrom(time)
	}

	setPlaybackRate(rate: number, _preservePitch: boolean): void {
		const elapsed = this.#graph.context.currentTime - this.#scheduleBase
		const currentPosition = this.#seekOffset + Math.max(0, elapsed * this.#playbackRate)
		this.#playbackRate = rate
		this.#resetScheduling()
		this.#startFrom(currentPosition)
	}

	play(): Promise<void> {
		this.#wantsToPlay = true
		if (this.buffering) {
			return Promise.resolve()
		}

		this.#startCurrentTimeLoop(this.#signal)
		return this.#graph.resume()
	}

	pause(): void {
		this.#wantsToPlay = false
		this.#stopCurrentTimeLoop()
		void this.#graph.suspend(false)
	}

	#dispose(): void {
		this.#resetScheduling()
		if (this.#input) {
			try {
				this.#input.dispose()
			} catch {}
			this.#input = null
		}
		this.#audioTrack = null
		try {
			this.#gainNode.disconnect()
		} catch {}
	}

	#startFrom(seekTo: number, scheduleAt?: number) {
		const signal = this.#signal
		this.#ended = false

		if (!this.#audioTrack) return
		const sink = new AudioBufferSink(this.#audioTrack)

		const ctx = this.#graph.context
		const base = scheduleAt ?? Math.max(ctx.currentTime, this.#lastScheduledEndTime)
		this.#scheduleBase = base
		this.#seekOffset = seekTo
		this.#lastScheduledEndTime = base

		if (scheduleAt === undefined) {
			this.buffering = true
		} else if (this.#wantsToPlay) {
			this.#startCurrentTimeLoop(signal)
		}

		void this.#scheduleSink(sink, seekTo, base, signal)
	}

	async #scheduleSink(
		sink: AudioBufferSink,
		seekTo: number,
		base: number,
		signal: AbortSignal,
	): Promise<void> {
		let allBuffersPulled = false
		const trackDuration = this.duration

		const handleEnded = () => {
			if (allBuffersPulled && this.#scheduledSources.size === 0 && !signal.aborted) {
				this.#ended = true
				this.#stopCurrentTimeLoop()
				this.onEnded?.()
			}
		}

		const resumeAfterBuffering = () => {
			this.buffering = false
			if (this.#wantsToPlay) {
				this.#startCurrentTimeLoop(signal)
				void this.#graph.resume()
			}
		}

		try {
			for await (const { buffer, timestamp } of sink.buffers(seekTo)) {
				if (signal.aborted) {
					break
				}

				const ctx = this.#graph.context
				const startAt = base + (timestamp - seekTo) / this.#playbackRate

				// Strict look-ahead throttle to prevent decoding gigabytes into RAM
				while (startAt > ctx.currentTime + LOOK_AHEAD_TIME_SECONDS) {
					if (signal.aborted) {
						break
					}

					if (trackDuration - timestamp <= LOOK_AHEAD_TIME_SECONDS) {
						break
					}

					await wait(50, signal)
				}

				if (signal.aborted) {
					break
				}

				const source = ctx.createBufferSource()
				source.buffer = buffer
				source.playbackRate.value = this.#playbackRate
				source.connect(this.#gainNode)
				source.start(startAt)

				this.#lastScheduledEndTime = startAt + buffer.duration / this.#playbackRate

				if (
					this.buffering &&
					this.#lastScheduledEndTime >= ctx.currentTime + BUFFER_RESUME_SECONDS
				) {
					resumeAfterBuffering()
				}

				this.#scheduledSources.add(source)

				source.addEventListener('ended', () => {
					this.#scheduledSources.delete(source)
					try {
						source.disconnect()
					} catch {}
					handleEnded()
				}, { once: true })
			}

			allBuffersPulled = true

			if (this.buffering && !signal.aborted) {
				resumeAfterBuffering()
			}
		} catch (error) {
			if (signal.aborted || error instanceof InputDisposedError || isAbortError(error)) {
				// Aborted cleanly
			} else {
				console.error('Error during audio playback:', error)
				this.onError?.()
			}
			return
		}

		handleEnded()
	}

	#startCurrentTimeLoop(signal: AbortSignal): void {
		this.#stopCurrentTimeLoop()

		const tick = () => {
			if (signal.aborted) {
				return
			}

			const elapsed = this.#graph.context.currentTime - this.#scheduleBase
			this.currentTime = this.#seekOffset + Math.max(0, elapsed * this.#playbackRate)
			this.#timerId = window.setTimeout(tick, CURRENT_TIME_UPDATE_TIMEOUT_MS)
		}

		this.#timerId = window.setTimeout(tick, CURRENT_TIME_UPDATE_TIMEOUT_MS)
	}

	#stopCurrentTimeLoop(): void {
		if (this.#timerId !== null) {
			clearTimeout(this.#timerId)
			this.#timerId = null
		}
	}

	#resetScheduling() {
		this.#stopCurrentTimeLoop()
		this.buffering = false

		this.#schedulingController.abort()

		for (const node of this.#scheduledSources) {
			try {
				node.stop()
			} catch {}
			try {
				node.disconnect()
			} catch {}
		}
		this.#scheduledSources.clear()

		const controller = new AbortController()
		this.#schedulingController = controller
		this.#signal = AbortSignal.any([this.#externalSignal, controller.signal])
	}
}

export const createAudioBufferEngine = async (options: AudioEngineOptions) => {
	const { signal } = options
	const input = new Input({ formats: FORMATS, source: new BlobSource(options.blob) })

	const audioTrack = await input.getPrimaryAudioTrack()
	if (!audioTrack) {
		input.dispose()
		throw new Error('No audio track found')
	}

	signal.throwIfAborted()

	return new AudioBufferEngine({
		audioGraph: options.audioGraph,
		duration: options.duration,
		input,
		audioTrack,
		signal,
		scheduleAt: options.scheduleAt,
		preservePitch: options.preservePitch,
		playbackRate: options.playbackRate,
	})
}