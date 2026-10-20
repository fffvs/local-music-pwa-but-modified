// butterchurn (WebGL MilkDrop port) ships without type declarations.
declare module 'butterchurn' {
	interface ButterchurnVisualizer {
		connectAudio: (node: AudioNode) => void
		disconnectAudio: (node: AudioNode) => void
		loadPreset: (preset: object, blendTimeSeconds?: number) => void
		setRendererSize: (width: number, height: number) => void
		render: () => void
	}

	const butterchurn: {
		createVisualizer: (
			context: AudioContext,
			canvas: HTMLCanvasElement,
			options?: {
				width?: number
				height?: number
				pixelRatio?: number
				textureRatio?: number
			},
		) => ButterchurnVisualizer
	}

	export default butterchurn
}

declare module 'butterchurn-presets' {
	const butterchurnPresets: {
		getPresets: () => Record<string, object>
	}

	export default butterchurnPresets
}

declare module '*?as=metadata' {
	const metadata: {
		src: string
		width: number
		height: number
	}

	export default metadata
}
