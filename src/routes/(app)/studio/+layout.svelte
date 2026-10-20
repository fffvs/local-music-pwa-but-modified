<script lang="ts">
	import LibraryNavigation from '$lib/components/LibraryNavigation.svelte'

	const { children } = $props()
</script>

<LibraryNavigation variant="rail" activeSlug="studio" layoutMode="list" isWideLayout={false} />

<div class="sm:pl-20">
	{@render children()}
</div>
