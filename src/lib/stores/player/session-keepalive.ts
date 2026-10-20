/**
 * Chrome (and ChromeOS) only attaches a page to the system media controls
 * (media keys, tray widget, lock screen) while an HTMLMediaElement is playing.
 * The Web Audio buffer engine never creates one, so FLAC playback would be
 * invisible to the OS. This keeps a silent, looping <audio> element playing in
 * step with playback so the media session stays registered.
 */

const SAMPLE_RATE = 8000
const SECONDS = 1

const createSilentWavUrl = (): string => {
	const sampleCount = SAMPLE_RATE * SECONDS
	const dataSize = sampleCount * 2 // 16-bit mono
	const buffer = new ArrayBuffer(44 + dataSize)
	const view = new DataView(buffer)
	const writeString = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i += 1) {
			view.setUint8(offset + i, value.charCodeAt(i))
		}
	}

	writeString(0, 'RIFF')
	view.setUint32(4, 36 + dataSize, true)
	writeString(8, 'WAVE')
	writeString(12, 'fmt ')
	view.setUint32(16, 16, true) // PCM chunk size
	view.setUint16(20, 1, true) // PCM
	view.setUint16(22, 1, true) // mono
	view.setUint32(24, SAMPLE_RATE, true)
	view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
	view.setUint16(32, 2, true) // block align
	view.setUint16(34, 16, true) // bits per sample
	writeString(36, 'data')
	view.setUint32(40, dataSize, true)
	// Sample data is left as zeros, which is silence.

	return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

export class SessionKeepAlive {
	#audio: HTMLAudioElement | undefined
	#url: string | undefined

	/** Starts or stops the silent element to match the desired playback state. */
	setPlaying(playing: boolean): void {
		if (playing) {
			this.#start()
		} else {
			this.#audio?.pause()
		}
	}

	#start(): void {
		if (typeof Audio === 'undefined') {
			return
		}
		if (!this.#audio) {
			this.#url = createSilentWavUrl()
			const audio = new Audio(this.#url)
			audio.loop = true
			audio.preload = 'auto'
			this.#audio = audio
		}
		// play() can reject (e.g. no user gesture yet). Retrying on the next
		// setPlaying(true) is enough, so the rejection is ignored.
		this.#audio.play().catch(() => {
			// Intentionally ignored, see comment above.
		})
	}

	dispose(): void {
		this.#audio?.pause()
		if (this.#url) {
			URL.revokeObjectURL(this.#url)
			this.#url = undefined
		}
		this.#audio = undefined
	}
}
