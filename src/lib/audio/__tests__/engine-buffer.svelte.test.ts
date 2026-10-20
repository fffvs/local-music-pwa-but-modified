import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wait } from '$lib/helpers/utils/wait.ts'
import type { AudioGraph } from '../audio-graph.svelte.ts'
import { isSafari } from '$lib/helpers/utils/ua.ts'
import { AudioBufferEngine, supportsBufferEngine, toGaplessCodec } from '../engine-buffer.svelte.ts'
import { playbackMetrics } from '../playback-metrics.svelte.ts'

vi.mock('$app/env', () => ({ browser: true }))

/**
 * The sink behavior is configurable per test. Default: hang (never yields) so
 * the scheduling loop doesn't interfere with unrelated assertions.
 */
const sinkBehavior = { mode: 'hang' as 'hang' | 'empty' }

const { MockInput, MockAudioBufferSink, mockCanDecodeAudio } = vi.hoisted(() => {
	class MockAudioBufferSink {
		buffers(): AsyncIterable<{ buffer: AudioBuffer; timestamp: number }> {
			const mode = sinkBehavior.mode
			return {
				[Symbol.asyncIterator]() {
					if (mode === 'hang') {
						return { next: () => new Promise<IteratorResult<never>>(() => {}) }
					}
					let done = false
					return {
						next: (): Promise<IteratorResult<never>> => {
							if (!done) {
								done = true
							}
							return Promise.resolve({ done: true, value: undefined as never })
						},
					}
				},
			}
		}
	}

	class MockInput {
		dispose = vi.fn()
	}

	const mockCanDecodeAudio = vi.fn<(codec: string) => Promise<boolean>>()

	return { MockAudioBufferSink, MockInput, mockCanDecodeAudio }
})

vi.mock('mediabunny', () => ({
	AudioBufferSink: MockAudioBufferSink,
	BlobSource: class {},
	Input: MockInput,
	canDecodeAudio: mockCanDecodeAudio,
	FLAC: 'flac',
	MP3: 'mp3',
	MP4: 'mp4',
	OGG: 'ogg',
	WAVE: 'wav',
	WEBM: 'webm',
	PCM_AUDIO_CODECS: ['pcm-s16'],
	InputDisposedError: class InputDisposedError extends Error {
		constructor() {
			super('disposed')
			this.name = 'InputDisposedError'
		}
	},
}))

vi.mock('$lib/helpers/utils/ua.ts', () => ({
	isSafari: vi.fn(() => false),
}))

const makeBufferGraph = () => {
	const gainNode = { connect: vi.fn(), disconnect: vi.fn() }
	const context = {
		createGain: vi.fn(() => gainNode),
		createBufferSource: vi.fn(() => ({
			connect: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			disconnect: vi.fn(),
			buffer: null,
			playbackRate: { value: 1 },
			addEventListener: vi.fn((event: string, cb: () => void) => {
				// Immediately fire 'ended' so scheduled sources are cleaned up
				if (event === 'ended') {
					cb()
				}
			}),
		})),
		currentTime: 0,
	}
	return {
		context,
		inputNode: { connect: vi.fn() },
		resume: vi.fn(() => Promise.resolve()),
		suspend: vi.fn(() => Promise.resolve()),
		gainNode,
	}
}

const makeEngine = (
	opts: {
		duration?: number
		playbackRate?: number
		scheduleAt?: number
		signal?: AbortSignal
	} = {},
) => {
	const controller = new AbortController()
	const graph = makeBufferGraph()
	const input = new MockInput()

	const engine = new AudioBufferEngine({
		audioGraph: graph as unknown as AudioGraph,
		duration: opts.duration ?? 180,
		input: input as never,
		audioTrack: {} as never,
		signal: opts.signal ?? controller.signal,
		playbackRate: opts.playbackRate ?? 1,
		preservePitch: true,
		scheduleAt: opts.scheduleAt,
	})

	return { engine, graph, controller, input }
}

describe('supportsBufferEngine', () => {
	beforeEach(() => {
		mockCanDecodeAudio.mockResolvedValue(true)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it('returns false immediately when AudioDecoder is not available', () => {
		// In the test environment (happy-dom), AudioDecoder is not defined
		expect(supportsBufferEngine('flac')).toBe(false)
	})

	it('returns false synchronously for unsupported codecs regardless of environment', () => {
		// Even if AudioDecoder were available, mp3 is not in the supported list
		expect(supportsBufferEngine('mp3')).toBe(false)
		expect(supportsBufferEngine('aac')).toBe(false)
		expect(supportsBufferEngine('opus')).toBe(false)
	})
})

describe('codec mapping', () => {
	it.each([
		['FLAC', 'flac'],
		['MPEG 1 Layer 3', 'mp3'],
		['MPEG 2 Layer 3', 'mp3'],
		['AAC', 'aac'],
		['Opus', 'opus'],
		['Vorbis', 'vorbis'],
	])('maps metadata codec %s to %s', (input, expected) => {
		expect(toGaplessCodec(input)).toBe(expected)
	})

	it.each(['ALAC', 'MPEG 1 Layer 2', 'PCM', ''])('does not map %s', (input) => {
		expect(toGaplessCodec(input)).toBeNull()
	})
})

describe('supportsBufferEngine with WebCodecs available', () => {
	beforeEach(() => {
		vi.stubGlobal('AudioDecoder', class {})
		mockCanDecodeAudio.mockResolvedValue(true)
		vi.mocked(isSafari).mockReturnValue(false)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('checks decodability of the mapped codec for gapless formats', async () => {
		expect(await supportsBufferEngine('MPEG 1 Layer 3')).toBe(true)
		expect(mockCanDecodeAudio).toHaveBeenLastCalledWith('mp3')
		expect(await supportsBufferEngine('AAC')).toBe(true)
		expect(mockCanDecodeAudio).toHaveBeenLastCalledWith('aac')
		expect(await supportsBufferEngine('FLAC')).toBe(true)
		expect(mockCanDecodeAudio).toHaveBeenLastCalledWith('flac')
	})

	it('reports false when the browser cannot decode the codec', async () => {
		mockCanDecodeAudio.mockResolvedValueOnce(false)
		expect(await supportsBufferEngine('Opus')).toBe(false)
	})

	it('returns false for codecs without a gapless mapping', () => {
		expect(supportsBufferEngine('ALAC')).toBe(false)
	})

	it('keeps Safari on the HTML engine', () => {
		vi.mocked(isSafari).mockReturnValue(true)
		expect(supportsBufferEngine('MPEG 1 Layer 3')).toBe(false)
		expect(mockCanDecodeAudio).not.toHaveBeenCalled()
	})
})

describe('playbackMetrics', () => {
	it('counts late buffers and tracks the worst lateness', () => {
		playbackMetrics.reset()
		playbackMetrics.recordLateBuffer(0.02)
		playbackMetrics.recordLateBuffer(0.05)
		playbackMetrics.recordLateBuffer(0.01)
		expect(playbackMetrics.lateBuffers).toBe(3)
		expect(playbackMetrics.worstLatenessMs).toBeCloseTo(50)
	})

	it('resets counters without clearing the engine type', () => {
		playbackMetrics.recordEngine('buffer')
		playbackMetrics.recordGaplessHandoff()
		playbackMetrics.reset()
		expect(playbackMetrics.gaplessHandoffs).toBe(0)
		expect(playbackMetrics.lastEngine).toBe('buffer')
	})
})

describe('AudioBufferEngine', () => {
	beforeEach(() => {
		sinkBehavior.mode = 'hang'
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('initial state', () => {
		it('currentTime starts at 0', () => {
			const { engine, controller } = makeEngine()
			expect(engine.currentTime).toBe(0)
			controller.abort()
		})

		it('ended starts as false', () => {
			const { engine, controller } = makeEngine()
			expect(engine.ended).toBe(false)
			controller.abort()
		})

		it('duration reflects the provided option', () => {
			const { engine, controller } = makeEngine({ duration: 240 })
			expect(engine.duration).toBe(240)
			controller.abort()
		})

		it('buffering is true on construction without scheduleAt (no pre-roll)', () => {
			const { engine, controller } = makeEngine()
			expect(engine.buffering).toBe(true)
			controller.abort()
		})

		it('buffering is false on construction with scheduleAt (gapless pre-roll)', () => {
			const { engine, controller } = makeEngine({ scheduleAt: 10 })
			expect(engine.buffering).toBe(false)
			controller.abort()
		})

		it('suspends graph on construction without scheduleAt', () => {
			const { graph, controller } = makeEngine()
			expect(graph.suspend).toHaveBeenCalled()
			controller.abort()
		})

		it('does not suspend graph on construction with scheduleAt', () => {
			const { graph, controller } = makeEngine({ scheduleAt: 10 })
			expect(graph.suspend).not.toHaveBeenCalled()
			controller.abort()
		})

		it('connects gainNode to graph inputNode', () => {
			const { graph, controller } = makeEngine()
			expect(graph.gainNode.connect).toHaveBeenCalledWith(graph.inputNode)
			controller.abort()
		})
	})

	describe('endTime', () => {
		it('is scheduleBase + duration / playbackRate at construction (ctx.currentTime=0)', () => {
			const { engine, controller } = makeEngine({ duration: 180, playbackRate: 1 })
			// scheduleBase = ctx.currentTime = 0, seekOffset = 0, rate = 1
			expect(engine.endTime).toBe(180)
			controller.abort()
		})

		it('accounts for playbackRate', () => {
			const { engine, controller } = makeEngine({ duration: 180, playbackRate: 2 })
			// 0 + (180 - 0) / 2 = 90
			expect(engine.endTime).toBe(90)
			controller.abort()
		})

		it('uses provided scheduleAt as the schedule base', () => {
			const { engine, controller } = makeEngine({ duration: 180, scheduleAt: 50 })
			// scheduleBase = 50, seekOffset = 0, rate = 1
			expect(engine.endTime).toBe(50 + 180)
			controller.abort()
		})

		it('updates after seek', () => {
			const { engine, controller } = makeEngine({ duration: 180 })
			engine.seek(60)
			// After seek(60): seekOffset = 60, scheduleBase = ctx.currentTime = 0
			expect(engine.endTime).toBe(120)
			controller.abort()
		})
	})

	describe('seek()', () => {
		it('updates currentTime immediately', () => {
			const { engine, controller } = makeEngine()

			engine.seek(42)

			expect(engine.currentTime).toBe(42)
			controller.abort()
		})

		it('clears ended state when seeking away from the end', () => {
			const { engine, controller } = makeEngine({ duration: 10 })

			// Seek to near-end while paused → marks ended
			engine.seek(9.7)
			expect(engine.ended).toBe(true)

			// Seek to the middle → clears ended (via #startFrom)
			engine.seek(5)
			expect(engine.ended).toBe(false)
			controller.abort()
		})

		it('marks ended when seeking to within threshold of end while paused', () => {
			const { engine, controller } = makeEngine({ duration: 10 })
			// SEEK_END_THRESHOLD_SECONDS = 0.5; 9.6 >= 10 - 0.5 = 9.5
			engine.seek(9.6)
			expect(engine.ended).toBe(true)
			controller.abort()
		})

		it('does NOT mark ended when seeking near end while playing', () => {
			const { engine, controller } = makeEngine({ duration: 10 })

			void engine.play()
			engine.seek(9.6)

			expect(engine.ended).toBe(false)
			controller.abort()
		})
	})

	describe('pause()', () => {
		it('suspends the graph', () => {
			const { engine, graph, controller } = makeEngine()
			// Initial construction already calls suspend once
			const callsBefore = graph.suspend.mock.calls.length

			engine.pause()

			expect(graph.suspend.mock.calls.length).toBeGreaterThan(callsBefore)
			controller.abort()
		})
	})

	describe('play()', () => {
		it('resumes the graph when not buffering', async () => {
			// scheduleAt means gapless pre-roll: buffering starts false so play() proceeds
			const { engine, graph, controller } = makeEngine({ scheduleAt: 10 })

			await engine.play()

			expect(graph.resume).toHaveBeenCalled()
			controller.abort()
		})

		it('returns immediately (without resuming graph) while still buffering', async () => {
			const { engine, graph, controller } = makeEngine()
			expect(engine.buffering).toBe(true)

			await engine.play()

			expect(graph.resume).not.toHaveBeenCalled()
			controller.abort()
		})
	})

	describe('setPlaybackRate()', () => {
		it('updates endTime to reflect the new rate', () => {
			const { engine, controller } = makeEngine({ duration: 180 })

			engine.setPlaybackRate(2, false)

			// After rate change to 2x from position 0: endTime = 0 + 180 / 2 = 90
			expect(engine.endTime).toBe(90)
			controller.abort()
		})
	})

	describe('onEnded callback', () => {
		it('fires when the scheduling loop completes with no buffers', async () => {
			sinkBehavior.mode = 'empty'
			const { engine, controller } = makeEngine()
			const onEnded = vi.fn()
			engine.onEnded = onEnded

			// Let the empty scheduling loop run to completion
			await wait(0)

			expect(onEnded).toHaveBeenCalled()
			controller.abort()
		})
	})

	describe('disposal (abort signal)', () => {
		it('disconnects gainNode from graph when aborted', () => {
			const { graph, controller } = makeEngine()

			controller.abort()

			expect(graph.gainNode.disconnect).toHaveBeenCalled()
		})

		it('disposes the mediabunny Input', () => {
			const { input, controller } = makeEngine()

			controller.abort()

			expect(input.dispose).toHaveBeenCalled()
		})
	})
})

describe('AudioBufferEngine with an external chunk stream', () => {
	it('schedules chunks from openStream and releases the source on dispose', async () => {
		const controller = new AbortController()
		const graph = makeBufferGraph()
		const closeSource = vi.fn()
		const openStream = vi.fn(async function* () {
			yield { buffer: { duration: 0.5 } as AudioBuffer, timestamp: 0 }
		})

		const engine = new AudioBufferEngine({
			audioGraph: graph as unknown as AudioGraph,
			duration: 10,
			input: null,
			audioTrack: null,
			openStream,
			closeSource,
			signal: controller.signal,
			playbackRate: 1,
			preservePitch: true,
		})

		await wait(10)
		expect(openStream).toHaveBeenCalledWith(0, graph.context)

		const source = graph.context.createBufferSource.mock.results[0]?.value
		expect(source.start).toHaveBeenCalled()

		controller.abort()
		expect(closeSource).toHaveBeenCalledTimes(1)
		expect(engine).toBeDefined()
	})
})

