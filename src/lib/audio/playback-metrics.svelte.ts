export type PlaybackEngineKind = 'buffer' | 'html'
export type PlaybackDecoderKind = 'worker' | 'main'

/**
 * Lightweight counters for diagnosing playback smoothness. Shown on the Studio
 * page. Nothing here is persisted or sent anywhere.
 */
class PlaybackMetrics {
	lateBuffers = $state(0)
	worstLatenessMs = $state(0)
	gaplessHandoffs = $state(0)
	lastEngine = $state<PlaybackEngineKind | null>(null)
	decoder = $state<PlaybackDecoderKind | null>(null)

	recordLateBuffer(latenessSeconds: number): void {
		this.lateBuffers += 1
		this.worstLatenessMs = Math.max(this.worstLatenessMs, latenessSeconds * 1000)
	}

	recordGaplessHandoff(): void {
		this.gaplessHandoffs += 1
	}

	recordEngine(kind: PlaybackEngineKind): void {
		this.lastEngine = kind
	}

	recordDecoder(kind: PlaybackDecoderKind): void {
		this.decoder = kind
	}

	reset(): void {
		this.lateBuffers = 0
		this.worstLatenessMs = 0
		this.gaplessHandoffs = 0
	}
}

export const playbackMetrics = new PlaybackMetrics()
