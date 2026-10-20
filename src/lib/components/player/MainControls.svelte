<script lang="ts">
	import AbLoopButton from './buttons/AbLoopButton.svelte'
	import PlayNextButton from './buttons/PlayNextButton.svelte'
	import PlayPrevButton from './buttons/PlayPrevButton.svelte'
	import PlayTogglePillButton from './buttons/PlayTogglePillButton.svelte'
	import RepeatButton from './buttons/RepeatButton.svelte'
	import ShuffleButton from './buttons/ShuffleButton.svelte'

	const { class: className }: { class?: ClassValue } = $props()

	const player = usePlayer()
</script>

<div class={['flex items-center gap-2', className]}>
	<ShuffleButton />

	<PlayPrevButton />

	<PlayTogglePillButton />

	<PlayNextButton />

	<RepeatButton />

	{#if player.abLoopButtonVisible}
		<AbLoopButton />
	{/if}
</div>
