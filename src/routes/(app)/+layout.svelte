<script lang="ts">
	import { browser } from '$app/env'
	import { navigating, page } from '$app/state'
	import Button from '$lib/components/Button.svelte'
	import {
		APP_DIALOGS_COMPONENTS_MAP,
		APP_DIALOGS_KEYS,
	} from '$lib/components/global-dialogs/dialogs.ts'
	import Icon from '$lib/components/icon/Icon.svelte'
	import LibraryNavigation from '$lib/components/LibraryNavigation.svelte'
	import MenuRenderer, { setupGlobalMenu } from '$lib/components/menu/MenuRenderer.svelte'
	import PlayerOverlay from '$lib/components/PlayerOverlay.svelte'
	import Seo from '$lib/components/Seo.svelte'
	import SnackbarRenderer from '$lib/components/snackbar/SnackbarRenderer.svelte'
	import { isElementTextInput } from '$lib/helpers/input.ts'
	import { DialogsStore } from '$lib/stores/dialogs/store.svelte.ts'
	import { setDialogsStoreContext } from '$lib/stores/dialogs/use-store.ts'
	import { PlayerStore } from '$lib/stores/player/player.svelte.ts'
	import { setPlayerStoreContext } from '$lib/stores/player/use-store.ts'
	import { onViewTransitionPrepare } from '$lib/view-transitions.svelte.ts'
	import { setupAppInstallPromptListeners } from './layout/app-install-prompt.ts'
	import {
		type DirectoriesPermissionPromptSnackbarArg,
		setupDirectoriesPermissionPrompt,
	} from './layout/setup-directories-permission-prompt.svelte.ts'
	import { setupTheme } from './layout/setup-theme.svelte.ts'

	// These context are in different files from their implementation
	// to allow better trees shaking and inlining
	const player = setPlayerStoreContext(new PlayerStore())
	const dialogs = setDialogsStoreContext(new DialogsStore())

	$effect(() => () => {
		// Cleanup
		player.dispose()
	})

	if (import.meta.hot) {
		import.meta.hot.dispose(() => {
			player.dispose()
		})
	}

	
        setupTheme()

        // 1. Continue Where You Left Off QoL Prompt on Mount
        $effect(() => {
                if (!browser) return;

                setTimeout(() => {
                        const savedTrackId = localStorage.getItem('snaeplayer-resume-trackId');
                        const savedTime = localStorage.getItem('snaeplayer-resume-time');

                        if (player.resumeOnStartup && savedTrackId && savedTime) {
                                const trackId = parseInt(savedTrackId, 10);
                                const time = parseFloat(savedTime);

                                if (time > 10) {
                                        import('$lib/library/get/value.ts').then(({ getLibraryValue }) => {
                                                getLibraryValue('tracks', trackId).then(track => {
                                                        if (track) {
                                                                import('$lib/components/snackbar/snackbar.ts').then(({ snackbar }) => {
                                                                        snackbar({
                                                                                id: 'resume-playback',
                                                                                message: `Continue listening to "${track.name}"?`,
                                                                                duration: 8000,
                                                                                controls: {
                                                                                        label: 'Resume',
                                                                                        action: () => {
                                                                                                player.playTrackId(trackId);
                                                                                                setTimeout(() => {
                                                                                                        player.seek(time);
                                                                                                }, 450);
                                                                                        }
                                                                                }
                                                                        });
                                                                });
                                                        }
                                                }).catch(() => {});
                                        });
                                }
                        }
                }, 1000);
        });

        // 2. Dynamic Favicon & Title QoL Effect
        let originalFaviconHref = '';
        let originalTitle = '';

        $effect(() => {
                if (!browser) return;

                const enabled = player.dynamicFaviconEnabled;
                const activeTrack = player.activeTrack;
                const isPlaying = player.playing;
                const artworkSrc = player.artworkSrc;

                const faviconLink = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
                if (faviconLink && !originalFaviconHref) {
                        originalFaviconHref = faviconLink.href;
                }
                if (!originalTitle) {
                        originalTitle = document.title || 'Snae Player';
                }

                if (!enabled || !activeTrack) {
                        if (faviconLink && originalFaviconHref) {
                                if (faviconLink.href && faviconLink.href.startsWith('blob:')) {
                                        URL.revokeObjectURL(faviconLink.href);
                                }
                                faviconLink.href = originalFaviconHref;
                        }
                        document.title = originalTitle;
                        return;
                }

                const stateSymbol = isPlaying ? '▶ ' : '❚❚ ';
                const trackName = activeTrack.name || 'Unknown Track';
                const albumName = activeTrack.album || 'Unknown Album';
                document.title = `${stateSymbol}${trackName} — ${albumName}`;

                if (artworkSrc && faviconLink) {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        img.src = artworkSrc;
                        img.onload = () => {
                                const canvas = document.createElement('canvas');
                                canvas.width = 32;
                                canvas.height = 32;
                                const ctx = canvas.getContext('2d');
                                if (ctx) {
                                        ctx.drawImage(img, 0, 0, 32, 32);
                                        canvas.toBlob((blob) => {
                                                if (blob) {
                                                        if (faviconLink.href && faviconLink.href.startsWith('blob:')) {
                                                                URL.revokeObjectURL(faviconLink.href);
                                                        }
                                                        faviconLink.href = URL.createObjectURL(blob);
                                                }
                                        }, 'image/png');
                                }
                        };
                } else if (faviconLink && originalFaviconHref) {
                        if (faviconLink.href && faviconLink.href.startsWith('blob:')) {
                                URL.revokeObjectURL(faviconLink.href);
                        }
                        faviconLink.href = originalFaviconHref;
                }
        });

        // 3. Snae Player Strict Code Guard (Luau --!strict equivalent)
        $effect(() => {
                if (!browser) return;

                console.log('%c🛡️ Snae Strict Mode Active: Monitoring runtime execution...', 'color: #4af2a1; font-weight: bold; font-family: monospace;');

                let perfObserver: PerformanceObserver | null = null;
                try {
                        perfObserver = new PerformanceObserver((list) => {
                                for (const entry of list.getEntries()) {
                                        if (entry.duration > 50) {
                                                console.warn(
                                                        `%c[Strict: Performance] Long task detected! A script blocked the main thread for ${entry.duration.toFixed(1)}ms. This can cause audio stutter.`,
                                                        'color: #ffaa00; font-weight: bold;'
                                                );
                                        }
                                }
                        });
                        perfObserver.observe({ entryTypes: ['longtask'] });
                } catch (e) {}

                const handleRejection = (event: PromiseRejectionEvent) => {
                        console.error(
                                '%c[Strict: Promise] Uncaught async rejection detected! You have a promise that failed without a .catch() handler.',
                                'color: #ff5555; font-weight: bold;'
                        );
                        console.error(event.reason);
                };

                const handleGlobalError = (event: ErrorEvent) => {
                        if (event.message && event.message.includes('ResizeObserver')) {
                                return;
                        }
                        console.error(
                                `[Strict: Exception] ${event.message} inside ${event.filename} at line ${event.lineno}`
                        );
                };

                const originalWarn = console.warn;
                console.warn = (...args: any[]) => {
                        const warnStr = args.join(' ');
                        if (warnStr.includes('svelte') || warnStr.includes('rune') || warnStr.includes('state')) {
                                console.group('%c[Strict: Svelte Reactivity Warning]', 'color: #ff5555; font-weight: bold;');
                                originalWarn(...args);
                                console.trace('Reactivity Warning Stack Trace');
                                console.groupEnd();
                                return;
                        }
                        originalWarn(...args);
                };

                let clipInterval = 0;
                if (player.audioContext) {
                        try {
                                const analyser = player.analyserNode;
                                if (analyser) {
                                        const buffer = new Float32Array(analyser.fftSize);
                                        clipInterval = window.setInterval(() => {
                                                if (!player.playing) return;
                                                analyser.getFloatTimeDomainData(buffer);
                                                for (let i = 0; i < buffer.length; i++) {
                                                        if (Math.abs(buffer[i]) >= 0.99) {
                                                                console.warn('%c[Strict: Audio] Output is clipping! Pre-amp or EQ gain is too high, causing hardware distortion.', 'color: #ffaa00; font-style: italic;');
                                                                break;
                                                        }
                                                }
                                        }, 1000);
                                }
                        } catch (e) {}
                }

                window.addEventListener('unhandledrejection', handleRejection);
                window.addEventListener('error', handleGlobalError);

                return () => {
                        if (perfObserver) perfObserver.disconnect();
                        if (clipInterval) clearInterval(clipInterval);
                        console.warn = originalWarn;
                        window.removeEventListener('unhandledrejection', handleRejection);
                        window.removeEventListener('error', handleGlobalError);
                };
        });

        // 5. AudioContext Tab-Sleep Auto-Recovery Heartbeat
        $effect(() => {
                if (!browser) return;

                const handleVisibilityChange = () => {
                        if (document.visibilityState === 'visible' && player.audioContext) {
                                const ctx = player.audioContext;
                                if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
                                        console.log('[Context Recovery] Waking up suspended AudioContext due to tab activation.');
                                        ctx.resume().catch(e => console.warn('[Context Recovery] Failed to auto-resume:', e));
                                }
                        }
                };

                document.addEventListener('visibilitychange', handleVisibilityChange);
                return () => {
                        document.removeEventListener('visibilitychange', handleVisibilityChange);
                };
        });



	setupGlobalMenu()
	setupAppInstallPromptListeners()

	const { children } = $props()

	let overlayContentHeight = $state(0)
	let bottomBarHeightActual = $state(0)

	const isBottomNavShown = $derived(
		page.route.id?.startsWith('/(app)/library/[[slug=libraryEntities]]'),
	)
	const bottomBarHeight = $derived(isBottomNavShown ? bottomBarHeightActual : 0)

	const activeLibrarySlug = $derived.by(() => {
		const slug = page.params.slug
		return slug === 'albums' || slug === 'artists' || slug === 'playlists' ? slug : 'tracks'
	})

	$effect(() => {
		document.documentElement.style.setProperty(
			'--bottom-overlay-height',
			`${overlayContentHeight + bottomBarHeight}px`,
		)
	})

	onViewTransitionPrepare((_state, match) => {
		if (match.view === 'player') {
			const target = document.querySelector('#mini-player')
			const rect = target?.getBoundingClientRect()

			if (!rect) {
				return
			}

			const setProperty = (name: keyof DOMRect) => {
				document.documentElement.style.setProperty(`--mp-${name}`, `${rect[name]}px`)
			}

			setProperty('left')
			setProperty('bottom')
			setProperty('width')
			setProperty('height')
		}
	})

	if (browser) {
		void setupDirectoriesPermissionPrompt(directoriesPermissionSnackbar)
	}
</script>

<Seo />

{#snippet directoriesPermissionSnackbar({ dirs, dismiss }: DirectoriesPermissionPromptSnackbarArg)}
	<div class="flex w-full flex-col gap-1 pt-2 pb-1">
		<div>
			<div>{m.libraryDirPromptBrowserPermission()}</div>
			<div class="text-body-sm opacity-54">
				{m.libraryDirPromptExplanation()}
			</div>
		</div>

		<!-- Showing only subset at the time so snackbar does not take up the whole screen -->
		{#each dirs().slice(0, 3) as dir}
			<div class="flex items-center justify-between gap-2">
				<Icon type="folder" class="size-4 text-tertiaryContainer" />

				<div class="truncate">
					{dir.name}
				</div>

				<Button kind="flat" class="ml-auto w-24 shrink-0 text-inversePrimary!" onclick={dir.action}>
					{m.libraryDirPromptGrant()}
				</Button>
			</div>
		{/each}

		<Button kind="flat" class="text-inversePrimary!" onclick={dismiss}>
			{m.dismiss()}
		</Button>
	</div>
{/snippet}

<svelte:window
	onkeydown={(e) => {
		if (e.key === ' ' && !isElementTextInput(e.target)) {
			e.preventDefault()

			player.togglePlay()
		}
	}}
/>

{#if navigating?.to}
	<div class="page-loading-indicator fixed inset-x-0 top-0 z-20 h-1 bg-tertiary/40">
		<div
			class="page-loading-indicator-bar h-1 w-full origin-top-left overflow-hidden bg-onTertiaryContainer"
		></div>
	</div>
{/if}

{@render children()}

<div
	class="page-overlay-container pointer-events-none fixed inset-x-0 bottom-0 grid gap-y-2 overflow-hidden"
>
	<SnackbarRenderer />

	<div
		bind:clientHeight={overlayContentHeight}
		class={["col-[2/5] grid grid-cols-subgrid gap-y-2", bottomBarHeight <= 0 && 'mb-2']}
	>
		{#if !page.data.noPlayerOverlay}
			<PlayerOverlay class={'col-[1/4]'} />
		{/if}
	</div>

	{#if isBottomNavShown}
		<div bind:clientHeight={bottomBarHeightActual} class="col-[1/6]">
			<LibraryNavigation variant="bottom" activeSlug={activeLibrarySlug} />
		</div>
	{/if}
</div>

<div class="pointer-events-none fixed inset-0 z-10">
	<MenuRenderer />
</div>

{#each APP_DIALOGS_KEYS as dialogKey}
	{const DialogComponent = $derived(APP_DIALOGS_COMPONENTS_MAP[dialogKey])}

	<DialogComponent open={dialogs.getAccessor(dialogKey)} />
{/each}

<style lang="postcss">
	@reference '../../app.css';

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}

	.page-loading-indicator {
		animation: fade-in 0.2s 0.2s linear backwards;
	}

	.page-loading-indicator-bar {
		animation: page-loading-indicator 6s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
	}

	.page-overlay-container {
		--p-overlay-side: --spacing(4);
		grid-template-columns: var(--p-overlay-side) 1fr minmax(0, --spacing(125)) 1fr var(
				--p-overlay-side
			);
	}

	@keyframes page-loading-indicator {
		0% {
			transform: scaleX(0);
		}
		100% {
			transform: scaleX(0.8);
		}
	}

	@keyframes -global-view-regular-fade-out {
		to {
			opacity: 0;
		}
	}

	@keyframes -global-view-regular-fade-in {
		from {
			opacity: 0;
		}
	}

	@keyframes -global-view-regular-out {
		to {
			scale: var(--view-regular-out);
		}
	}

	@keyframes -global-view-regular-in {
		from {
			scale: var(--view-regular-in);
		}
	}

	@keyframes -global-view-bottom-bar-out {
		to {
			translate: 0 100%;
		}
	}

	@keyframes -global-view-bottom-bar-in {
		from {
			translate: 0 100%;
		}
	}

	:global(html:active-view-transition-type(regular)) {
		--view-regular-out: 1.1;
		--view-regular-in: 0.9;

		&:active-view-transition-type(backwards) {
			--view-regular-out: 0.9;
			--view-regular-in: 1.1;
		}

		&::view-transition-old(root) {
			animation:
				view-regular-fade-out 90ms var(--ease-outgoing40) forwards,
				view-regular-out 300ms var(--ease-incoming80outgoing40);
		}

		&::view-transition-new(root) {
			animation:
				view-regular-fade-in 210ms 90ms var(--ease-incoming80) backwards,
				view-regular-in 300ms var(--ease-incoming80outgoing40);
		}

		&::view-transition-old(pl-card) {
			display: none;
		}

		&::view-transition-new(pl-card) {
			animation: none;
		}

		&::view-transition-new(bottom-bar):only-child {
			animation: view-bottom-bar-in 300ms var(--ease-standard) forwards;
		}

		&::view-transition-old(bottom-bar):only-child {
			animation: view-bottom-bar-out 300ms var(--ease-standard) forwards;
		}
	}
</style>
