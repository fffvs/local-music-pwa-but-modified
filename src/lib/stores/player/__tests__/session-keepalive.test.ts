import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionKeepAlive } from '../session-keepalive.ts'

class FakeAudio {
	static instances: FakeAudio[] = []
	src: string
	loop = false
	preload = ''
	play = vi.fn(() => Promise.resolve())
	pause = vi.fn()

	constructor(src: string) {
		this.src = src
		FakeAudio.instances.push(this)
	}
}

const firstAudio = (): FakeAudio => {
	const audio = FakeAudio.instances[0]
	if (!audio) {
		throw new Error('no audio element was created')
	}
	return audio
}

describe('SessionKeepAlive', () => {
	beforeEach(() => {
		FakeAudio.instances = []
		vi.stubGlobal('Audio', FakeAudio)
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:silent')
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('creates one looping silent element and plays it when playback starts', () => {
		const keepAlive = new SessionKeepAlive()
		keepAlive.setPlaying(true)

		expect(FakeAudio.instances).toHaveLength(1)
		const audio = firstAudio()
		expect(audio.loop).toBe(true)
		expect(audio.src).toBe('blob:silent')
		expect(audio.play).toHaveBeenCalledTimes(1)
	})

	it('pauses the element when playback stops and reuses it on resume', () => {
		const keepAlive = new SessionKeepAlive()
		keepAlive.setPlaying(true)
		keepAlive.setPlaying(false)
		keepAlive.setPlaying(true)

		expect(FakeAudio.instances).toHaveLength(1)
		const audio = firstAudio()
		expect(audio.pause).toHaveBeenCalledTimes(1)
		expect(audio.play).toHaveBeenCalledTimes(2)
	})

	it('does nothing when pausing before anything has played', () => {
		const keepAlive = new SessionKeepAlive()
		keepAlive.setPlaying(false)
		expect(FakeAudio.instances).toHaveLength(0)
	})

	it('ignores a rejected play() promise', async () => {
		vi.stubGlobal(
			'Audio',
			class extends FakeAudio {
				override play = vi.fn(() => Promise.reject(new Error('NotAllowedError')))
			},
		)
		const keepAlive = new SessionKeepAlive()
		expect(() => keepAlive.setPlaying(true)).not.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 0))
	})

	it('dispose pauses the element and revokes its URL', () => {
		const keepAlive = new SessionKeepAlive()
		keepAlive.setPlaying(true)
		keepAlive.dispose()

		expect(firstAudio().pause).toHaveBeenCalled()
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:silent')
	})
})
