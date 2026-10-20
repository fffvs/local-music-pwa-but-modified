import { EQ_BANDS } from './eq-bands.ts'
import invariant from 'tiny-invariant'

/**
 * Options for the shared AudioContext. Music playback has no interactive
 * latency requirement, so 'playback' is used: a larger output buffer means the
 * audio thread wakes less often and is less likely to underrun on a loaded CPU.
 * Bit-perfect mode matches the context rate to the file's native rate.
 */
export const createAudioContextOptions = (
	bitPerfectEnabled: boolean,
	nativeSampleRate: number | null,
): AudioContextOptions => {
	const options: AudioContextOptions = { latencyHint: 'playback' }
	if (bitPerfectEnabled && nativeSampleRate) {
		options.sampleRate = nativeSampleRate
	}
	return options
}

/**
 * Owns the AudioContext, EQ filter chain, volume, compressor, stereo panner, and cached procedural reverb.
 */
export class AudioGraph {
	#context: AudioContext | null = $state(null)
	#inputNode: GainNode | null = null
	#volumeNode: GainNode | null = null
	#fadeNode: GainNode | null = null
	#compressorNode: DynamicsCompressorNode | null = null
	#pannerNode: StereoPannerNode | null = null
	#convolverNode: ConvolverNode | null = null
	#dryGainNode: GainNode | null = null
	#wetGainNode: GainNode | null = null
	#filters: BiquadFilterNode[] = []
	#suspendTimeout: number | null = null
	#reverbReleaseTimeout: number | null = null
	#eqBypassTimeout: number | null = null
	#eqBypassed = false
	#nativeSampleRate: number | null = null

	// Cache synthesized impulse responses to avoid 2M+ loop recalculations
	#reverbCache = new Map<string, AudioBuffer>()

	fadeEnabled = $state(true)
	nightModeEnabled = $state(false)
	stereoPan = $state(0.0)
	bitPerfectEnabled = $state(true)
	reverbPreset = $state<'off' | 'studio' | 'room' | 'hall' | 'cathedral'>('off')

	get context(): AudioContext {
		return this.#ensureGraph()
	}

	get initialized(): boolean {
		return this.#context !== null
	}

	get inputNode(): GainNode {
		this.#ensureGraph()
		invariant(this.#inputNode, 'AudioGraph input node should be initialized')
		return this.#inputNode
	}

	get filters(): readonly BiquadFilterNode[] {
		this.#ensureGraph()
		return this.#filters
	}

	/**
	 * Routes the input around the 10-band EQ when it is flat or disabled, so the
	 * biquad filters don't consume CPU for no audible change. Bypassing is deferred
	 * until the gains have faded to zero to avoid a click; un-bypassing is immediate.
	 */
	setEqBypassed(bypassed: boolean): void {
		if (!this.#context || !this.#inputNode || this.#filters.length === 0) return
		if (bypassed === this.#eqBypassed && this.#eqBypassTimeout === null) return

		if (this.#eqBypassTimeout !== null) {
			clearTimeout(this.#eqBypassTimeout)
			this.#eqBypassTimeout = null
		}

		if (!bypassed) {
			this.#applyEqRouting(false)
			return
		}

		this.#eqBypassTimeout = window.setTimeout(() => {
			this.#eqBypassTimeout = null
			this.#applyEqRouting(true)
		}, 150)
	}

	#applyEqRouting(bypassed: boolean): void {
		const input = this.#inputNode
		const first = this.#filters[0]
		const last = this.#filters[this.#filters.length - 1]
		const compressor = this.#compressorNode
		if (!input || !first || !last || !compressor || bypassed === this.#eqBypassed) return

		try {
			if (bypassed) {
				input.disconnect(first)
				last.disconnect(compressor)
				input.connect(compressor)
			} else {
				input.disconnect(compressor)
				input.connect(first)
				last.connect(compressor)
			}
			this.#eqBypassed = bypassed
		} catch {
			// Graph was torn down concurrently; nothing to route.
		}
	}

	setNextNativeSampleRate(rate: number) {
		this.#nativeSampleRate = rate
	}

	#ensureGraph(): AudioContext {
		if (this.#context) {
			return this.#context
		}

		const options = createAudioContextOptions(this.bitPerfectEnabled, this.#nativeSampleRate)
		if (options.sampleRate) {
			console.log(`[Bit-Perfect] Initializing AudioContext at: ${options.sampleRate}Hz`)
		}

		const ctx = new AudioContext(options)

		const filters = EQ_BANDS.map(({ frequency }) => {
			const filter = ctx.createBiquadFilter()
			filter.type = 'peaking'
			filter.frequency.value = frequency
			filter.Q.value = 1.41
			filter.gain.value = 0
			return filter
		})

		const inputNode = ctx.createGain()

		let node: AudioNode = inputNode
		for (const filter of filters) {
			node.connect(filter)
			node = filter
		}

		const compressorNode = ctx.createDynamicsCompressor()
		compressorNode.threshold.value = 0
		compressorNode.ratio.value = 1
		node.connect(compressorNode)

		const pannerNode = ctx.createStereoPanner()
		pannerNode.pan.value = 0
		compressorNode.connect(pannerNode)

		// Parallel Reverb Circuit
		const dryGainNode = ctx.createGain()
		const wetGainNode = ctx.createGain()
		const convolverNode = ctx.createConvolver()

		dryGainNode.gain.value = 1.0
		wetGainNode.gain.value = 0.0

		pannerNode.connect(dryGainNode)
		pannerNode.connect(convolverNode)
		convolverNode.connect(wetGainNode)

		const fadeNode = ctx.createGain()
		fadeNode.gain.value = 1.0
		dryGainNode.connect(fadeNode)
		wetGainNode.connect(fadeNode)

		const volumeNode = ctx.createGain()
		fadeNode.connect(volumeNode)
		volumeNode.connect(ctx.destination)

		this.#context = ctx
		this.#inputNode = inputNode
		this.#volumeNode = volumeNode
		this.#fadeNode = fadeNode
		this.#compressorNode = compressorNode
		this.#pannerNode = pannerNode
		this.#convolverNode = convolverNode
		this.#dryGainNode = dryGainNode
		this.#wetGainNode = wetGainNode
		this.#filters = filters

		this.updateCompressor()
		this.updatePanner()
		this.updateReverb()

		return ctx
	}

	async runTransientSeekRamp(seekAction: () => void): Promise<void> {
		if (!this.#context || !this.#fadeNode) {
			seekAction()
			return
		}

		const ctx = this.#context
		const t = ctx.currentTime

		this.#fadeNode.gain.cancelScheduledValues(t)
		this.#fadeNode.gain.setValueAtTime(this.#fadeNode.gain.value, t)
		this.#fadeNode.gain.setTargetAtTime(0.001, t, 0.004)

		seekAction()

		const t2 = ctx.currentTime
		this.#fadeNode.gain.cancelScheduledValues(t2)
		this.#fadeNode.gain.setValueAtTime(0.001, t2)
		this.#fadeNode.gain.setTargetAtTime(1.0, t2, 0.008)
	}

	updateCompressor(): void {
		if (!this.#compressorNode || !this.#context) return
		const t = this.#context.currentTime
		if (this.nightModeEnabled) {
			this.#compressorNode.threshold.setTargetAtTime(-24, t, 0.03)
			this.#compressorNode.knee.setTargetAtTime(30, t, 0.03)
			this.#compressorNode.ratio.setTargetAtTime(12, t, 0.03)
			this.#compressorNode.attack.setTargetAtTime(0.003, t, 0.03)
			this.#compressorNode.release.setTargetAtTime(0.25, t, 0.03)
		} else {
			this.#compressorNode.threshold.setTargetAtTime(0, t, 0.03)
			this.#compressorNode.ratio.setTargetAtTime(1, t, 0.03)
		}
	}

	#generateImpulseResponse(duration: number, decay: number): AudioBuffer {
		const ctx = this.context
		const cacheKey = `${ctx.sampleRate}_${duration}_${decay}`
		const cached = this.#reverbCache.get(cacheKey)
		if (cached) return cached

		const sampleRate = ctx.sampleRate
		const length = Math.floor(sampleRate * duration)
		const impulse = ctx.createBuffer(2, length, sampleRate)
		const left = impulse.getChannelData(0)
		const right = impulse.getChannelData(1)

		for (let i = 0; i < length; i++) {
			const envelope = Math.pow(1 - i / length, decay)
			left[i] = (Math.random() * 2 - 1) * envelope
			right[i] = (Math.random() * 2 - 1) * envelope
		}

		this.#reverbCache.set(cacheKey, impulse)
		return impulse
	}

	updateReverb(): void {
		if (!this.#context || !this.#dryGainNode || !this.#wetGainNode || !this.#convolverNode) return
		const t = this.#context.currentTime

		const preset = this.reverbPreset
		if (preset === 'off') {
			this.#dryGainNode.gain.setTargetAtTime(1.0, t, 0.03)
			this.#wetGainNode.gain.setTargetAtTime(0.0, t, 0.03)
			// A ConvolverNode with a null buffer outputs silence without doing any
			// convolution. Clear the IR once the wet path has faded out so the
			// (CPU-expensive) convolution stops running on low-power devices.
			const convolver = this.#convolverNode
			if (this.#reverbReleaseTimeout !== null) {
				clearTimeout(this.#reverbReleaseTimeout)
			}
			this.#reverbReleaseTimeout = window.setTimeout(() => {
				this.#reverbReleaseTimeout = null
				if (this.reverbPreset === 'off') {
					convolver.buffer = null
				}
			}, 300)
			return
		}

		if (this.#reverbReleaseTimeout !== null) {
			clearTimeout(this.#reverbReleaseTimeout)
			this.#reverbReleaseTimeout = null
		}

		const configs = {
			studio: { duration: 0.8, decay: 3.5, wet: 0.18, dry: 0.95 },
			room: { duration: 1.6, decay: 2.5, wet: 0.30, dry: 0.88 },
			hall: { duration: 3.2, decay: 1.8, wet: 0.42, dry: 0.80 },
			cathedral: { duration: 5.5, decay: 1.2, wet: 0.55, dry: 0.70 },
		}

		const cfg = configs[preset] || configs.room
		this.#convolverNode.buffer = this.#generateImpulseResponse(cfg.duration, cfg.decay)
		this.#dryGainNode.gain.setTargetAtTime(cfg.dry, t, 0.03)
		this.#wetGainNode.gain.setTargetAtTime(cfg.wet, t, 0.03)
	}

	updatePanner(): void {
		if (!this.#pannerNode || !this.#context) return
		this.#pannerNode.pan.setTargetAtTime(this.stereoPan, this.#context.currentTime, 0.015)
	}

	setVolume(normalized: number): void {
		if (this.#volumeNode && this.#context) {
			this.#volumeNode.gain.setTargetAtTime(normalized, this.#context.currentTime, 0.015)
		}
	}

	resume(): Promise<void> {
		if (this.#suspendTimeout !== null) {
			clearTimeout(this.#suspendTimeout)
			this.#suspendTimeout = null
		}

		if (this.#context && this.#fadeNode) {
			this.#fadeNode.gain.cancelScheduledValues(this.#context.currentTime)
			const targetGain = 1.0
			const timeConstant = this.fadeEnabled ? 0.04 : 0.001
			this.#fadeNode.gain.setTargetAtTime(targetGain, this.#context.currentTime, timeConstant)
		}

		if (this.#context?.state !== 'suspended') {
			return Promise.resolve()
		}

		return this.#context.resume()
	}

	suspend(forceImmediate: boolean = false): Promise<void> {
		if (this.#suspendTimeout !== null) {
			clearTimeout(this.#suspendTimeout)
			this.#suspendTimeout = null
		}

		if (!this.#context || this.#context.state !== 'running') {
			return Promise.resolve()
		}

		if (this.#fadeNode) {
			this.#fadeNode.gain.cancelScheduledValues(this.#context.currentTime)
			const targetGain = 0.0
			const timeConstant = this.fadeEnabled ? 0.035 : 0.001
			this.#fadeNode.gain.setTargetAtTime(targetGain, this.#context.currentTime, timeConstant)
		}

		if (forceImmediate) {
			return this.#context.suspend()
		}

		return new Promise((resolve) => {
			this.#suspendTimeout = window.setTimeout(() => {
				this.#suspendTimeout = null
				if (this.#context && this.#context.state === 'running') {
					this.#context.suspend().then(resolve)
				} else {
					resolve()
				}
			}, 30000)
		})
	}

	dispose(): void {
		if (this.#suspendTimeout !== null) {
			clearTimeout(this.#suspendTimeout)
			this.#suspendTimeout = null
		}

		if (this.#reverbReleaseTimeout !== null) {
			clearTimeout(this.#reverbReleaseTimeout)
			this.#reverbReleaseTimeout = null
		}

		if (this.#eqBypassTimeout !== null) {
			clearTimeout(this.#eqBypassTimeout)
			this.#eqBypassTimeout = null
		}
		this.#eqBypassed = false

		this.#reverbCache.clear()

		if (this.#inputNode) {
			try { this.#inputNode.disconnect() } catch {}
		}
		if (this.#filters) {
			for (const filter of this.#filters) {
				try { filter.disconnect() } catch {}
			}
		}
		if (this.#compressorNode) {
			try { this.#compressorNode.disconnect() } catch {}
		}
		if (this.#pannerNode) {
			try { this.#pannerNode.disconnect() } catch {}
		}
		if (this.#convolverNode) {
			try { this.#convolverNode.disconnect() } catch {}
		}
		if (this.#dryGainNode) {
			try { this.#dryGainNode.disconnect() } catch {}
		}
		if (this.#wetGainNode) {
			try { this.#wetGainNode.disconnect() } catch {}
		}
		if (this.#fadeNode) {
			try { this.#fadeNode.disconnect() } catch {}
		}
		if (this.#volumeNode) {
			try { this.#volumeNode.disconnect() } catch {}
		}

		if (this.#context) {
			this.#context.close()
		}
		this.#context = null
		this.#inputNode = null
		this.#volumeNode = null
		this.#fadeNode = null
		this.#compressorNode = null
		this.#pannerNode = null
		this.#filters = []
	}
}