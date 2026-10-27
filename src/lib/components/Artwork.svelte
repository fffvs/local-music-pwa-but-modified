<script lang="ts">
        import type { IconType } from './icon/Icon.svelte'
        import Icon from './icon/Icon.svelte'

        interface Props {
                src: string | undefined
                class?: ClassValue
                alt?: string
                fallbackIcon?: IconType | false
                noFallbackBg?: boolean
                children?: Snippet
        }

        const {
                src,
                fallbackIcon = 'musicNote',
                noFallbackBg,
                class: className,
                alt,
                children,
        }: Props = $props()

        let displayedSrc = $state<string | undefined>(undefined)
        let isDecoding = $state(false)
        let error = $state(false)

        $effect(() => {
                if (!src) {
                        displayedSrc = undefined
                        error = false
                        return
                }

                // If we already have this image displayed, don't re-decode
                if (src === displayedSrc) {
                        return
                }

                // Decode the new image off-screen on a helper thread
                // to prevent main-thread layout thrashing and progressive top-to-bottom wipes
                isDecoding = true
                const img = new Image()
                img.src = src
                img.decode()
                        .then(() => {
                                // Once fully decoded, assign the source.
                                // It will render instantly and smoothly.
                                displayedSrc = src
                                error = false
                        })
                        .catch(() => {
                                // Fallback on browser error/abort
                                displayedSrc = src
                                error = false
                        })
                        .finally(() => {
                                isDecoding = false
                        })
        })
</script>

<div
        class={[
                'flex aspect-square overflow-hidden ring-1 ring-surfaceContainerHigh contain-strict relative',
                !noFallbackBg && 'bg-surfaceContainerHighest',
                className,
        ]}
>
        {#if displayedSrc && !error}
                <img
                        src={displayedSrc}
                        {alt}
                        loading="eager"
                        class={[
                                "size-full object-cover transition-opacity duration-250 ease-out",
                                isDecoding ? "opacity-45" : "opacity-100"
                        ]}
                        draggable="false"
                        onerror={() => {
                                error = true
                        }}
                >
        {:else if fallbackIcon !== false}
                <Icon type={fallbackIcon} class="m-auto size-2/3 text-onSurfaceVariant/38" />
        {/if}

        {#if children}
                {@render children()}
        {/if}
</div>
