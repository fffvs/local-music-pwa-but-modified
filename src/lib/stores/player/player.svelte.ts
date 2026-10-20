
import { AudioGraph } from '$lib/audio/audio-graph.svelte.ts'
import { PlaybackController, type TrackLoader } from '$lib/audio/playback-controller.svelte.ts'
import { onDatabaseChange } from '$lib/db/events.ts'
import {
	createManagedArtwork,
	getTrackManagedArtworkSource,
} from '$lib/helpers/create-managed-artwork.svelte'
import { type FileLoadFailReason, resolveTrackFile } from '$lib/helpers/file-resolver.ts'
import { persist } from '$lib/helpers/persist.svelte.ts'
import { clamp } from '$lib/helpers/utils/clamp.ts'
import { debounce } from '$lib/helpers/utils/debounce.ts'
import { truncate } from '$lib/helpers/utils/text.ts'
import { isMobile, isSafari } from '$lib/helpers/utils/ua.ts'
import { getLibraryValue } from '$lib/library/get/value.ts'
import { createTrackQuery } from '$lib/library/get/value-queries.ts'
import { EqualizerStore } from '$lib/stores/player/equalizer.svelte.ts'
import { MediaSessionController } from './media-session.svelte.ts'
import { PlayHistoryTracker } from './play-history-tracker.ts'
import { type QueueEntry, type QueueOrigin, QueueStore, type QueueView } from './queue.svelte.ts'

export type PlayerRepeat = 'none' | 'one' | 'all'

export type QueueExhaustion = 'stops-after' | 'repeats-track' | 'repeats-queue'

/**
 * Everything decided about the moment the current track ends, so the ended
 * handler (which consumes), the preload effect (which peeks) and tail views
 * cannot disagree.
 */
interface TrackEndPlan {
	action: 'pause' | 'repeat-current' | 'advance'
	loop: boolean
	/** What plays next, or null when playback stops here. */
	nextTrackId: number | null
}

// How many seconds before track end to begin pre-buffering the next track.
// Opening a large lossless file (header, seek index, first decoded chunks) can
// take several seconds on slower hardware, so this leaves enough runway for the
// gapless handoff. Repeat calls are cheap: preloadNext() returns early when the
// same track is already queued.
const PRE_BUFFER_THRESHOLD_SECONDS = 60

export const PLAYER_PLAYBACK_RATE_MIN = 0.5
export const PLAYER_PLAYBACK_RATE_MAX = 2

export class PlayerStore {
        get analyserNode() {
                return this.#graph.initialized ? this.#graph.analyserNode : null
        }
        get audioContext() {
                return this.#graph.initialized ? this.#graph.context : null
        }

	readonly #graph = new AudioGraph()
	readonly #queue = new QueueStore()
	/** Narrowed to `QueueView`, which cannot start audio. */
	readonly queue: QueueView = this.#queue
	        readonly #history = new PlayHistoryTracker()
        
        // Sleep Timer States
                // Expose transient seek ramp helper to PlaybackController
        async runSeekRamp(action: () => void): Promise<void> {
                await this.#graph.runTransientSeekRamp(action);
        }

        sleepTimerTimeLeft = $state<number | null>(null)
        dynamicFaviconEnabled = $state(false)
        autoPauseOnUnplug = $state(true)
        resumeOnStartup = $state(true)
        ambientBackgroundEnabled = $state(true)
        
        // Standard, clean Svelte 5 reactive state fields
        bitPerfectEnabled = $state(true)
        nightModeEnabled = $state(false)
        stereoPan = $state(0.0)
        fadeEnabled = $state(true)
        reverbPreset = $state<'off' | 'studio' | 'room' | 'hall' | 'cathedral'>('off')
        #sleepTimerInterval: any = null

        get sleepTimer() {
                return this.sleepTimerTimeLeft !== null ? Math.ceil(this.sleepTimerTimeLeft / 60).toString() : 'off'
        }

        set sleepTimer(value: string) {
                if (value === 'off') {
                        this.setSleepTimer(null)
                } else {
                        this.setSleepTimer(Number.parseInt(value, 10))
                }
        }

        setSleepTimer(minutes: number | null) {
                if (this.#sleepTimerInterval !== null) {
                        clearInterval(this.#sleepTimerInterval)
                        this.#sleepTimerInterval = null
                }

                if (minutes === null) {
                        this.sleepTimerTimeLeft = null
                        return
                }

                this.sleepTimerTimeLeft = minutes * 60
                this.#sleepTimerInterval = setInterval(() => {
                        if (this.sleepTimerTimeLeft !== null) {
                                this.sleepTimerTimeLeft--
                                if (this.sleepTimerTimeLeft <= 0) {
                                        this.pause()
                                        this.setSleepTimer(null)
                                }
                        }
                }, 1000)
        }

	readonly #ms = new MediaSessionController(this)
	readonly equalizer = new EqualizerStore(this.#graph)

	/** Mobile iOS does not allow changing volume */
	readonly canChangeVolume = !(isMobile() && isSafari())

	readonly #controller: PlaybackController
	#removeDatabaseListener: (() => void) | undefined

	repeat: PlayerRepeat = $state('none')
	muted = $state(false)
	#volume = $state(100)
	playbackRate = $state(1)
	preservePitch = $state(true)
	gaplessPlaybackEnabled = $state(false)
	pauseAfterTrackWhenRepeatIsOff = $state(false)

	get playing() {
		return this.#controller.playing
	}
	get currentTime() {
		return this.#controller.currentTime
	}
	get duration() {
		return this.#controller.duration
	}
	get trackFormat() {
		return this.#controller.format
	}
	get loading() {
		return this.#controller.loading
	}
	get canTogglePlay(): boolean {
		return this.playing || this.#queue.current !== null || this.#queue.peekNext(false) !== null
	}
	get canPlayNext(): boolean {
		return this.#queue.peekNext(true) !== null
	}
	get canPlayPrev(): boolean {
		if (this.#queue.canStepBack(true)) {
			return true
		}

		return this.#queue.current !== null && this.currentTime > 3
	}

	/**
	 * Everything decided about the moment the current track ends, computed once so
	 * the ended handler (which consumes), the preload effect (which peeks) and
	 * tail views cannot disagree — a drift between them would gapless-preload a
	 * different track than the one that then plays. Note `nextTrackId` is not the
	 * question "does the queue have upcoming rows": with repeat on, an exhausted
	 * queue still has something up next.
	 */
	readonly #trackEndPlan: TrackEndPlan = $derived.by(() => {
		if (this.repeat === 'none' && this.pauseAfterTrackWhenRepeatIsOff) {
			return { action: 'pause', loop: false, nextTrackId: null }
		}

		if (this.repeat === 'one') {
			return {
				action: 'repeat-current',
				loop: false,
				nextTrackId: this.#queue.current?.trackId ?? null,
			}
		}

		const loop = this.repeat === 'all'

		return { action: 'advance', loop, nextTrackId: this.#queue.peekNext(loop) }
	})

	readonly queueExhaustion: QueueExhaustion | null = $derived.by(() => {
		if (
			this.#queue.current === null ||
			this.#queue.count('manual') > 0 ||
			this.#queue.count('source') > 0
		) {
			return null
		}

		if (this.#trackEndPlan.nextTrackId === null) {
			return 'stops-after'
		}

		return this.#trackEndPlan.action === 'repeat-current' ? 'repeats-track' : 'repeats-queue'
	})

	readonly #activeTrackQuery = createTrackQuery(() => this.#queue.current?.trackId ?? -1, {
		allowEmpty: true,
	})
	readonly activeTrack = $derived.by(() => {
		const currentTrackId = this.#queue.current?.trackId
		const track = this.#activeTrackQuery.value

		return track?.id === currentTrackId ? track : undefined
	})

	readonly #artwork = createManagedArtwork(() =>
		getTrackManagedArtworkSource(this.activeTrack, 'full'),
	)
	readonly artworkSrc = $derived.by(this.#artwork)

	get volume() {
		return this.canChangeVolume ? this.#volume : 100
	}

	set volume(value) {
		this.#volume = clamp(value, 0, 100)
	}

	constructor() {

                // Throttled 5s state-saver for "Continue Where You Left Off" QoL
                let lastSaveTime = 0;
                $effect(() => {
                        const time = this.currentTime;
                        const id = this.activeTrack?.id;
                        const now = Date.now();
                        if (id && this.playing && now - lastSaveTime > 5000) {
                                localStorage.setItem('snaeplayer-resume-trackId', id.toString());
                                localStorage.setItem('snaeplayer-resume-time', time.toString());
                                lastSaveTime = now;
                        }
                });
        

                // Auto-Pause on Headphone Unplug (monitors system audio output changes)
                if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
                        let lastOutputsCount = 0;
                        navigator.mediaDevices.enumerateDevices().then(devices => {
                                lastOutputsCount = devices.filter(d => d.kind === 'audiooutput').length;
                        }).catch(() => {});

                        navigator.mediaDevices.addEventListener('devicechange', async () => {
                                if (!this.autoPauseOnUnplug || !this.playing) return;
                                try {
                                        const devices = await navigator.mediaDevices.enumerateDevices();
                                        const currentOutputs = devices.filter(d => d.kind === 'audiooutput').length;
                                        if (currentOutputs < lastOutputsCount) {
                                                this.pause(); // Headphone unplugged -> Pause!
                                        }
                                        lastOutputsCount = currentOutputs;
                                } catch (e) {}
                        });
                }
        
		persist('player', this, [
			'volume',
			'repeat',
			'muted',
			'playbackRate',
			'preservePitch',
			'gaplessPlaybackEnabled',
			'pauseAfterTrackWhenRepeatIsOff',
			'abLoopButtonVisible',
		])
		persist('player', this.#queue, ['shuffle'])

		this.#controller = this.#createPlaybackController()
		this.#setupQueueDatabaseListener()

		this.#setupPreloadEffect()
		this.#setupDspEffect()
                this.#setupVolumeEffect()
		this.#setupPlaybackRateEffect()
		this.#setupPlayHistoryUpdateEffect()
		this.#setupAbLoopEffect()
	}

	#setupQueueDatabaseListener(): void {
		this.#removeDatabaseListener = onDatabaseChange((changes) => {
			const deletedTrackIds = new Set<number>()
			for (const change of changes) {
				if (change.storeName === 'tracks' && change.operation === 'delete') {
					deletedTrackIds.add(change.key)
				}
			}

			if (deletedTrackIds.size === 0) {
				return
			}

			if (!this.#queue.removeTracks(deletedTrackIds)) {
				return
			}

			const next = this.#queue.current
			if (next === null) {
				this.#controller.abort()
			} else {
				this.#beginEntryPlayback(next)
			}
		})
	}

	#createPlaybackController() {
		const trackLoader: TrackLoader = async (trackId, reason) => {
			const track = await getLibraryValue('tracks', trackId)

			const result = await resolveTrackFile({
				directoryId: track.directory,
				entity: track.file,
				// Preload should stay silent
				askPermission: reason === 'load',
			})

			return {
				...result,
				duration: track.duration,
				codec: track.format?.codec ?? '',
			}
		}

		return new PlaybackController(this.#graph, {
			trackLoader,
			onTrackEnded: this.#handleTrackEnded,
			onError: this.#handleError,
			isGaplessEnabled: () => this.gaplessPlaybackEnabled,
		})
	}

	#setupVolumeEffect(): void {
		$effect(() => {
			if (!this.#graph.initialized) {
				return
			}

			const muted = this.muted

			// Humans perceive volume logarithmically, so match that perception.
			const k = 0.5
			const volume = (this.volume / 100) ** k

			untrack(() => {
				this.#graph.setVolume(muted ? 0 : volume)
			})
		})
	}

	#setupPlaybackRateEffect(): void {
		const updatePlaybackRate = debounce((rate: number, preservePitch: boolean) => {
			this.#controller.setPlaybackRate(rate, preservePitch)
		}, 200)

		$effect(() => {
			const rate = this.playbackRate
			// With gapless playback enabled we don't support pitch option.
			const preservePitch = this.preservePitch && !this.gaplessPlaybackEnabled

			untrack(() => {
				updatePlaybackRate(rate, preservePitch)
			})
		})
	}

	#setupPreloadEffect(): void {
		$effect(() => {
			const duration = this.duration
			const current = this.currentTime
			const remaining = duration - current

			if (duration <= 0 || remaining > PRE_BUFFER_THRESHOLD_SECONDS) {
				return
			}

			const upNext = this.#trackEndPlan.nextTrackId

			untrack(() => {
				if (upNext === null) {
					this.#controller.abortNext()
				} else {
					void this.#controller.preloadNext(upNext)
				}
			})
		})
	}

	#handleTrackEnded = () => {
		this.#history.complete()

		const plan = this.#trackEndPlan
		if (plan.action === 'pause') {
			this.pause()
			return
		}

		const next =
			plan.action === 'repeat-current' ? this.#queue.current : this.#queue.advance(plan.loop)

		if (!next) {
			this.pause()
			return
		}

		this.#beginEntryPlayback(next, { gapless: true })
	}

	/** Starts the current row, or explicitly activates the first queued row when idle. */
	play = (): void => {
		const current = this.#queue.current
		if (current !== null) {
			this.#controller.play(current.trackId)

			return
		}

		this.#beginEntryPlayback(this.#queue.advance(false))
	}

	pause = (): void => {
		this.#controller.pause()
	}

	seek = (time: number): void => {
		this.#controller.seek(time)
		this.#ms.updatePosition(time)
	}

	/**
	 * Starts a fresh playback/history session for a selected row. Null is a queue
	 * navigation no-op, so the existing session remains untouched.
	 */
	#beginEntryPlayback = (entry: QueueEntry | null, options: { gapless?: boolean } = {}): void => {
		if (entry !== null) {
			this.#history.begin(entry.trackId)
			this.#controller.play(entry.trackId, { ...options, fromBeginning: true })
		}
	}

	playNext = (): void => {
		this.#beginEntryPlayback(this.#queue.advance(true))
	}

	playPrev = (): void => {
		// Past the restart threshold "previous" means restarting the current track.
		if (this.currentTime > 3) {
			this.#beginEntryPlayback(this.#queue.current)

			return
		}

		this.#beginEntryPlayback(this.#queue.stepBack(true))
	}

	/**
	 * Replaces the source queue and starts its selected row. An empty list is a
	 * no-op, preserving the current queue and audio.
	 */
	playFrom = (start: number | 'shuffle', list: readonly number[], origin?: QueueOrigin): void => {
		if (list.length === 0) {
			return
		}

		this.#beginEntryPlayback(this.#queue.setSource(list, start, origin))
	}

	playQueueEntry = (entryId: number): void => {
		this.#beginEntryPlayback(this.#queue.playEntry(entryId))
	}

	/** Plays a track id wherever it lives: jumps in the source queue, else starts fresh. */
	playTrackId = (id: number): void => {
		this.#beginEntryPlayback(this.#queue.playTrackId(id))
	}

	togglePlay = (): void => {
		if (this.playing) {
			this.pause()
		} else {
			this.play()
		}
	}

	/**
	 * A-B loop for the active track. Cycling the button sets A (current position),
	 * then B (loop end), then clears the loop. The loop is scoped to one track and
	 * is dropped automatically when the track changes.
	 */
	abLoop: { trackId: number; start: number; end: number | null } | null = $state(null)

	/** Whether the A-B button is shown in the player controls. Off by default. */
	abLoopButtonVisible = $state(false)

	cycleAbLoop = (): void => {
		const trackId = this.activeTrack?.id
		if (trackId === undefined) return

		const loop = this.abLoop
		if (loop === null || loop.trackId !== trackId) {
			this.abLoop = { trackId, start: this.currentTime, end: null }
		} else if (loop.end === null) {
			// Ignore a B point that isn't meaningfully after A (e.g. pressed twice fast).
			if (this.currentTime - loop.start < 1) return
			this.abLoop = { ...loop, end: this.currentTime }
		} else {
			this.abLoop = null
		}
	}

	toggleRepeat = (): void => {
		let { repeat } = this

		if (repeat === 'none') {
			repeat = 'all'
		} else if (repeat === 'all') {
			repeat = 'one'
		} else {
			repeat = 'none'
		}

		this.repeat = repeat
	}

	#handleError = (reason: FileLoadFailReason): void => {
		const name = truncate(this.activeTrack?.name ?? 'Unknown', 30)
		const errorMap = {
			'not-found': m.playerAudioErrorNotFound,
			'permission-denied': m.playerAudioErrorPermissionDenied,
			error: m.playerAudioErrorLoadError,
		} as const

		snackbar({
			id: 'failed-to-load-audio',
			message: errorMap[reason]({ name }),
			duration: 10_000,
		})
	}

	#setupAbLoopEffect(): void {
		$effect(() => {
			const loop = this.abLoop
			if (loop === null) return

			// Hiding the button also drops the loop, so it can't keep running uncancellable.
			if (!this.abLoopButtonVisible) {
				untrack(() => {
					this.abLoop = null
				})
				return
			}

			if (loop.end === null) return

			const { start } = loop
			const end = loop.end
			const time = this.currentTime
			const trackId = this.activeTrack?.id

			untrack(() => {
				if (trackId !== loop.trackId) {
					this.abLoop = null
				} else if (time >= end) {
					this.seek(start)
				}
			})
		})
	}

	#setupPlayHistoryUpdateEffect(): void {
		$effect(() => {
			const currentTime = this.currentTime
			const duration = this.duration
			untrack(() => this.#history.update(currentTime, duration))
		})
	}

	dispose(): void {
		this.#removeDatabaseListener?.()
		this.#controller.abort()
		this.#graph.dispose()
	}

        #setupDspEffect(): void {
                $effect(() => {
                        if (!this.#graph.initialized) {
                                return
                        }

                        // Svelte 5 automatically tracks reads of these state fields as dependencies!
                        const pan = this.stereoPan
                        const nightMode = this.nightModeEnabled
                        const bitPerfect = this.bitPerfectEnabled

                        // Push updates synchronously into AudioGraph's physical Web Audio nodes
                        this.#graph.bitPerfectEnabled = bitPerfect
                        this.#graph.nightModeEnabled = nightMode
                        this.#graph.stereoPan = pan
                        this.#graph.reverbPreset = this.reverbPreset
                        this.#graph.updateReverb()

                        this.#graph.updateCompressor()
                        this.#graph.updatePanner()
                })
        }
}
