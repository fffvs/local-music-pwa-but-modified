import { describe, expect, it, vi } from 'vitest'
import { ScanGate } from './scan-gate.ts'

describe('ScanGate', () => {
	it('pauses for playback, permits an explicit override, and pauses on later playback', async () => {
		const gate = new ScanGate(true)
		const listener = vi.fn()
		const unsubscribe = gate.onChange(listener)
		let passed = false
		const waiting = gate.checkpoint().then(() => {
			passed = true
		})
		await Promise.resolve()
		expect(gate.pauseReason).toBe('playback')
		expect(passed).toBe(false)

		gate.resume()
		await waiting
		expect(passed).toBe(true)
		expect(gate.pauseReason).toBeNull()

		gate.setPlaybackActive(false)
		gate.setPlaybackActive(true)
		expect(gate.pauseReason).toBe('playback')
		expect(listener).toHaveBeenCalledTimes(3)
		unsubscribe()
	})

	it('does not override a manual pause when playback stops', async () => {
		const gate = new ScanGate(false)
		gate.pause()
		gate.setPlaybackActive(true)
		gate.setPlaybackActive(false)
		expect(gate.pauseReason).toBe('manual')

		const pending = gate.checkpoint()
		gate.resume()
		await expect(pending).resolves.toBeUndefined()
	})

	it('wakes a paused scan when cancelled', async () => {
		const gate = new ScanGate(true)
		const pending = gate.checkpoint()
		gate.cancel()
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
		await expect(gate.checkpoint()).rejects.toMatchObject({ name: 'AbortError' })
	})
})
