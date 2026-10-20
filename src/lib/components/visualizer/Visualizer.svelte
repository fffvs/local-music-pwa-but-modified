<script lang="ts">
	import { browser } from '$app/env'
	import Button from '$lib/components/Button.svelte'

	type ButterchurnLib = typeof import('butterchurn').default
	type ButterchurnVisualizer = ReturnType<ButterchurnLib['createVisualizer']>

	const player = usePlayer()

	/** Limits rendering to ~30 fps. The visualizer is GPU work on the same device that plays audio. */
	const FRAME_INTERVAL_MS = 1000 / 30
	/** Caps the render resolution on high-DPI screens (common on Chromebooks). */
	const MAX_PIXEL_RATIO = 1.5
	const PRESET_BLEND_SECONDS = 2

	let container: HTMLDivElement | undefined = $state()
	let canvas: HTMLCanvasElement | undefined = $state()

	let butterchurn = $state.raw<ButterchurnLib | null>(null)
	let presets = $state.raw<Record<string, object>>({})
	let presetNames = $state<string[]>([])
	let presetIndex = $state(0)
	let visualizer = $state.raw<ButterchurnVisualizer | null>(null)

	let status = $state<'loading' | 'ready' | 'unsupported' | 'error'>('loading')

	const currentPresetName = $derived(presetNames[presetIndex] ?? '')

	const supportsWebGL2 = () => {
		try {
			return !!document.createElement('canvas').getContext('webgl2')
		} catch {
			return false
		}
	}

	const loadLibraries = async () => {
		if (!supportsWebGL2()) {
			status = 'unsupported'
			return
		}

		try {
			// Loaded on demand so the MilkDrop engine and its preset packs stay out of the main bundle.
			const [visualizerModule, presetsModule] = await Promise.all([
				import('butterchurn'),
				import('butterchurn-presets'),
			])
			butterchurn = visualizerModule.default
			presets = presetsModule.default.getPresets()
			presetNames = Object.keys(presets).sort((a, b) => a.localeCompare(b))
			presetIndex = Math.floor(Math.random() * presetNames.length)
			status = 'ready'
		} catch (error) {
			console.error('Failed to load visualizer', error)
			status = 'error'
		}
	}

	$effect(() => {
		if (!browser) {
			return
		}
		void loadLibraries()
	})

	// Create a visualizer for the current audio context and connect it to the passive analyser.
	// Recreated if the graph is rebuilt (context change).
	$effect(() => {
		const lib = butterchurn
		const context = player.audioContext
		const analyser = player.analyserNode
		const target = canvas
		if (!(lib && context && analyser && target)) {
			return
		}

		const instance = lib.createVisualizer(context, target, {
			width: target.width || 640,
			height: target.height || 360,
			pixelRatio: 1,
		})
		instance.connectAudio(analyser)
		visualizer = instance

		return () => {
			try {
				instance.disconnectAudio(analyser)
			} catch {
				// The context may already be closed during teardown.
			}
			visualizer = null
		}
	})

	// Load the selected preset whenever it changes.
	$effect(() => {
		const instance = visualizer
		const name = currentPresetName
		const preset = presets[name]
		if (!(instance && preset)) {
			return
		}
		instance.loadPreset(preset, PRESET_BLEND_SECONDS)
	})

	// Keep the render resolution in step with the container, capped for performance.
	$effect(() => {
		const element = container
		const target = canvas
		if (!(element && target)) {
			return
		}

		const resize = () => {
			const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
			const width = Math.max(1, Math.round(element.clientWidth * ratio))
			const height = Math.max(1, Math.round(element.clientHeight * ratio))
			target.width = width
			target.height = height
			visualizer?.setRendererSize(width, height)
		}

		const observer = new ResizeObserver(resize)
		observer.observe(element)
		resize()
		return () => observer.disconnect()
	})

	// Render only while audio is playing. Pausing leaves the last frame on screen.
	$effect(() => {
		const instance = visualizer
		if (!(instance && player.playing)) {
			return
		}

		let frameId = 0
		let lastFrame = 0
		const frame = (now: number) => {
			if (now - lastFrame >= FRAME_INTERVAL_MS) {
				lastFrame = now
				instance.render()
			}
			frameId = requestAnimationFrame(frame)
		}
		frameId = requestAnimationFrame(frame)

		return () => cancelAnimationFrame(frameId)
	})

	const showPreset = (step: number) => {
		const count = presetNames.length
		if (count === 0) {
			return
		}
		presetIndex = (presetIndex + step + count) % count
	}

	const showRandomPreset = () => {
		const count = presetNames.length
		if (count < 2) {
			return
		}
		let next = presetIndex
		while (next === presetIndex) {
			next = Math.floor(Math.random() * count)
		}
		presetIndex = next
	}
</script>

<section class="card settings-max-width mx-auto w-full overflow-clip">
	<div bind:this={container} class="relative aspect-video w-full bg-black">
		<canvas bind:this={canvas} class="block size-full"></canvas>

		{#if status === 'loading'}
			<div class="absolute inset-0 grid place-items-center text-body-md text-white/70">
				Loading visualizer…
			</div>
		{:else if status === 'unsupported'}
			<div
				class="absolute inset-0 grid place-items-center p-4 text-center text-body-md text-white/70"
			>
				The visualizer needs WebGL 2, which this browser doesn't support.
			</div>
		{:else if status === 'error'}
			<div
				class="absolute inset-0 grid place-items-center p-4 text-center text-body-md text-white/70"
			>
				The visualizer couldn't be loaded. Try reloading the page.
			</div>
		{:else if !player.audioContext}
			<div
				class="absolute inset-0 grid place-items-center p-4 text-center text-body-md text-white/70"
			>
				Play a track to start the visualizer.
			</div>
		{/if}
	</div>

	<div class="flex items-center gap-2 p-3">
		<div
			class="min-w-0 flex-1 truncate text-body-md text-onSurfaceVariant"
			title={currentPresetName}
		>
			{currentPresetName || 'No presets'}
		</div>
		<Button
			kind="outlined"
			disabled={presetNames.length < 2}
			onclick={() => showPreset(-1)}
			ariaLabel="Previous preset"
		>
			Prev
		</Button>
		<Button
			kind="outlined"
			disabled={presetNames.length < 2}
			onclick={showRandomPreset}
			ariaLabel="Random preset"
		>
			Random
		</Button>
		<Button
			kind="outlined"
			disabled={presetNames.length < 2}
			onclick={() => showPreset(1)}
			ariaLabel="Next preset"
		>
			Next
		</Button>
	</div>
</section>
