<script lang="ts">
	import IconButton from '../../IconButton.svelte'
	import ActiveIndicator from './ActiveIndicator.svelte'

	const { class: className }: { class?: ClassValue } = $props()

	const player = usePlayer()

	const tooltip = $derived.by(() => {
		const loop = player.abLoop
		if (loop === null) {
			return 'Set loop start (A)'
		}
		if (loop.end === null) {
			return 'Set loop end (B)'
		}
		return 'Clear A-B loop'
	})
</script>

<IconButton {tooltip} class={className} onclick={player.cycleAbLoop}>
	<svg class="size-6 fill-current" viewBox="0 0 24 24" aria-hidden="true">
		<text
			x="12"
			y="15.5"
			text-anchor="middle"
			font-size="9"
			font-weight="700"
			font-family="system-ui, sans-serif"
			fill="currentColor"
		>
			A-B
		</text>
	</svg>

	<ActiveIndicator active={player.abLoop !== null} />
</IconButton>
