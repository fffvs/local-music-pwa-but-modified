import type { ScanPauseReason } from './types.ts'

/** Coordinates user controls with playback without interrupting an active IDB transaction. */
export class ScanGate {
	readonly #controller = new AbortController()
	readonly #waiters = new Set<() => void>()
	readonly #listeners = new Set<() => void>()
	#manualPause = false
	#playbackActive: boolean
	#allowDuringPlayback = false

	constructor(playbackActive: boolean) {
		this.#playbackActive = playbackActive
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	get signal(): AbortSignal {
		return this.#controller.signal
	}

	get pauseReason(): ScanPauseReason {
		if (this.#manualPause) {
			return 'manual'
		}
		return this.#playbackActive && !this.#allowDuringPlayback ? 'playback' : null
	}

	setPlaybackActive(active: boolean): void {
		this.#playbackActive = active
		if (!active) {
			this.#allowDuringPlayback = false
		}
		this.#changed()
	}

	pause(): void {
		this.#manualPause = true
		this.#changed()
	}

	resume(): void {
		this.#manualPause = false
		// A user can explicitly continue a scan while music is playing.
		this.#allowDuringPlayback = this.#playbackActive
		this.#changed()
	}

	cancel(): void {
		this.#controller.abort()
		this.#changed()
	}

	async checkpoint(): Promise<void> {
		this.signal.throwIfAborted()
		while (this.pauseReason !== null) {
			await new Promise<void>((resolve) => this.#waiters.add(resolve))
			this.signal.throwIfAborted()
		}
	}

	#changed(): void {
		for (const wake of this.#waiters) {
			wake()
		}
		this.#waiters.clear()
		for (const listener of this.#listeners) {
			listener()
		}
	}
}
