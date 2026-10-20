<script lang="ts">
	import { onMount } from 'svelte'
	import Button from '$lib/components/Button.svelte'
	import PlainLayout from '$lib/components/PlainLayout.svelte'
	import Tabs from '$lib/components/Tabs.svelte'
	import { getListeningStats, type ListeningStats } from '$lib/library/listening-stats.ts'
	import SettingsListItem from '../settings/components/SettingsListItem.svelte'
	import SettingsSelectListItem from '../settings/components/SettingsSelectListItem.svelte'
	import SettingsSwitchListItem from '../settings/components/SettingsSwitchListItem.svelte'

	const player = usePlayer()

	const tabs = [
		{ id: 'listening', label: 'Listening' },
		{ id: 'lab', label: 'Audio lab' },
	] as const

	type TabId = (typeof tabs)[number]['id']

	let selectedTab = $state<TabId>('listening')
	const selectedIndex = $derived(tabs.findIndex((tab) => tab.id === selectedTab))

	let stats = $state<ListeningStats | null>(null)
	let statsError = $state(false)

	onMount(() => {
		getListeningStats()
			.then((result) => {
				stats = result
			})
			.catch((error: unknown) => {
				console.error('Failed to load listening stats', error)
				statsError = true
			})
	})

	const formatDuration = (totalSeconds: number): string => {
		const hours = Math.floor(totalSeconds / 3600)
		const minutes = Math.floor((totalSeconds % 3600) / 60)
		if (hours > 0) {
			return `${hours} h ${minutes} min`
		}
		return `${minutes} min`
	}

	const reverbOptions = [
		{ name: 'Off (Direct Sound)', value: 'off' },
		{ name: 'Subtle Studio', value: 'studio' },
		{ name: 'Living Room', value: 'room' },
		{ name: 'Concert Hall', value: 'hall' },
		{ name: 'Cathedral / Space', value: 'cathedral' },
	]

	const eqFlat = $derived(player.equalizer.bands.every((gain) => gain === 0))

	const abLoopDescription = $derived.by(() => {
		const loop = player.abLoop
		if (!player.abLoopButtonVisible) {
			return 'Turn on the A-B button above to loop a section'
		}
		if (loop === null) {
			return 'Use the A-B button in the player to loop a section'
		}
		if (loop.end === null) {
			return `Start set at ${Math.floor(loop.start)}s. Press A-B again to set the end`
		}
		return `Looping ${Math.floor(loop.start)}s to ${Math.floor(loop.end)}s`
	})
</script>

{#snippet tabText(tab: (typeof tabs)[number])}
	{tab.label}
{/snippet}

<PlainLayout title="Studio">
	<div class="settings-max-width mx-auto mt-2 mb-4 w-full">
		<Tabs
			items={tabs}
			{selectedIndex}
			onchange={(tab) => {
				selectedTab = tab.id
			}}
			text={tabText}
		/>
	</div>

	{#if selectedTab === 'listening'}
		<section class="card settings-max-width mx-auto w-full overflow-clip">
			{#if statsError}
				<div class="p-4 text-body-md text-onSurfaceVariant">
					Couldn't load listening stats. Try again later.
				</div>
			{:else if stats === null}
				<div class="p-4 text-body-md text-onSurfaceVariant">Loading…</div>
			{:else}
				<SettingsListItem title="Library tracks" columnInCompactLayout bottomDivider>
					<span class="text-title-md">{stats.libraryTracks.toLocaleString()}</span>
				</SettingsListItem>
				<SettingsListItem title="Total library length" columnInCompactLayout bottomDivider>
					<span class="text-title-md">{formatDuration(stats.libraryDurationSeconds)}</span>
				</SettingsListItem>
				<SettingsListItem
					title="Tracks played, last 7 days"
					description="Distinct tracks, counted by their most recent play"
					columnInCompactLayout
					bottomDivider
				>
					<span class="text-title-md">{stats.playedLast7Days.toLocaleString()}</span>
				</SettingsListItem>
				<SettingsListItem
					title="Tracks played, last 30 days"
					description="Distinct tracks, counted by their most recent play"
					columnInCompactLayout
				>
					<span class="text-title-md">{stats.playedLast30Days.toLocaleString()}</span>
				</SettingsListItem>
			{/if}
		</section>
	{:else}
		<section class="card settings-max-width mx-auto w-full overflow-clip">
			<SettingsSwitchListItem
				title="Bit-Perfect Playback"
				description="Initializes the audio engine at the track's native sample rate"
				bind:checked={player.bitPerfectEnabled}
				bottomDivider
			/>

			<SettingsSelectListItem
				title="Acoustic Space (Reverb)"
				description="Adds room reflections. When off, it uses no extra CPU"
				bind:selected={player.reverbPreset}
				items={reverbOptions}
				bottomDivider
			/>

			<SettingsSwitchListItem
				title="Night Mode (Dynamics Compressor)"
				description="Evens out loud and quiet passages"
				bind:checked={player.nightModeEnabled}
				bottomDivider
			/>

			<SettingsSwitchListItem
				title="Equalizer"
				description={player.equalizer.enabled && !eqFlat
					? 'Shaping the sound with your band settings'
					: 'Off or flat. The filters are bypassed to save CPU'}
				bind:checked={player.equalizer.enabled}
				bottomDivider
			/>

			<SettingsSwitchListItem
				title="Show A-B Loop Button"
				description="Adds the A-B button to the player controls"
				bind:checked={player.abLoopButtonVisible}
				bottomDivider
			/>

			<SettingsListItem title="A-B loop" description={abLoopDescription} columnInCompactLayout>
				{#if player.abLoop !== null}
					<Button
						kind="outlined"
						onclick={() => {
							player.abLoop = null
						}}
						>Clear loop</Button
					>
				{/if}
			</SettingsListItem>
		</section>
	{/if}
</PlainLayout>
