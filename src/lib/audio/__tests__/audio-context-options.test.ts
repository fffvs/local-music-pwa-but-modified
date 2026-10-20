import { describe, expect, it } from 'vitest'
import { createAudioContextOptions } from '../audio-graph.svelte.ts'

describe('createAudioContextOptions', () => {
	it('uses the playback latency hint by default', () => {
		expect(createAudioContextOptions(false, null)).toEqual({ latencyHint: 'playback' })
	})

	it('matches the native sample rate in bit-perfect mode', () => {
		expect(createAudioContextOptions(true, 96_000)).toEqual({
			latencyHint: 'playback',
			sampleRate: 96_000,
		})
	})

	it('ignores the native sample rate when bit-perfect is off', () => {
		expect(createAudioContextOptions(false, 96_000)).toEqual({ latencyHint: 'playback' })
	})

	it('does not set a sample rate when the native rate is unknown', () => {
		expect(createAudioContextOptions(true, null)).toEqual({ latencyHint: 'playback' })
	})
})
