import {
	cancelTrackScan,
	startTrackScannerWorker,
	type TracksScanOptions,
	type TracksScanProgress,
} from './scanner/start.ts'

/** @public */
export const scanProgressMessage = (progress: TracksScanProgress): string => {
	if (progress.stopping) {
		return m.settingsScanStopping()
	}

	const count = m.settingsScanProgress({
		current: progress.current,
		imported: progress.newlyImported,
	})
	if (progress.pauseReason === 'playback') {
		return `${count} ${m.settingsScanPausedPlayback()}`
	}
	if (progress.pauseReason === 'manual') {
		return `${count} ${m.settingsScanPaused()}`
	}
	return count
}

export const scanTracks = async (options: TracksScanOptions): Promise<void> => {
	const snackbarId = 'scan-tracks'
	snackbar({
		id: snackbarId,
		message: m.settingsPreparingForScan(),
		controls: false,
		duration: false,
	})

	try {
		const result = await startTrackScannerWorker(options, (progress) => {
			snackbar({
				id: snackbarId,
				message: scanProgressMessage(progress),
				controls: progress.stopping
					? false
					: { label: m.settingsScanCancel(), action: cancelTrackScan },
				duration: false,
			})
		})

		let message: string
		if (result.cancelled) {
			message = m.settingsScanCancelled({ imported: result.newlyImported })
			if (result.failed > 0) {
				message += ` ${m.settingsScanPartial({ failed: result.failed, imported: result.newlyImported })}`
			}
		} else if (result.failed > 0) {
			message = m.settingsScanPartial({
				failed: result.failed,
				imported: result.newlyImported,
			})
		} else if (result.newlyImported === 0) {
			message = m.settingsScanNoNewTracks()
		} else {
			message = m.settingsScanNewOrUpdatedTracks({ newTracks: result.newlyImported })
		}

		snackbar({ id: snackbarId, message, duration: result.failed > 0 ? 15_000 : 8000 })
	} catch (error) {
		console.error('[scanner] scan failed:', error)
		snackbar({
			id: snackbarId,
			message:
				error instanceof Error && error.name === 'QuotaExceededError'
					? m.settingsScanStorageFull()
					: m.settingsScanFailed(),
			duration: 15_000,
		})
	}
}
