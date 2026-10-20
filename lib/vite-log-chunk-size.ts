import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

interface SizeInfo {
	size: number
	count: number
}

const measureDirectory = (directory: string): { jsInfo: SizeInfo; totalInfo: SizeInfo } => {
	const jsInfo: SizeInfo = { size: 0, count: 0 }
	const totalInfo: SizeInfo = { size: 0, count: 0 }

	const processDirectory = (dir: string) => {
		for (const file of readdirSync(dir)) {
			const filePath = path.join(dir, file)
			const stat = statSync(filePath)

			if (stat.isDirectory()) {
				processDirectory(filePath)
				continue
			}

			if (file.endsWith('.js')) {
				jsInfo.size += stat.size
				jsInfo.count += 1
			}
			totalInfo.size += stat.size
			totalInfo.count += 1
		}
	}

	processDirectory(directory)

	return { jsInfo, totalInfo }
}

/**
 * Logs the size of the client bundle's immutable assets once it has been written.
 *
 * Runs synchronously in `writeBundle`, after the client output exists, and
 * reads the directory from the bundle's own output path. Earlier versions
 * waited on a timer and read a hardcoded `./build` path, which could race the
 * adapter and crash the build process.
 */
export const logChunkSizePlugin = (): Plugin => ({
	name: 'vite-plugin-log-chunk-size',
	apply: 'build',
	enforce: 'post',
	writeBundle(options) {
		if (this.environment.name !== 'client' || !options.dir) {
			return
		}

		const immutableDir = path.join(options.dir, '_app', 'immutable')
		if (!existsSync(immutableDir)) {
			return
		}

		const { jsInfo, totalInfo } = measureDirectory(immutableDir)
		console.info('Size of JS chunks:', jsInfo.size / 1024, 'KB. Files count:', jsInfo.count)
		console.info(
			'Size of all files:',
			totalInfo.size / 1024,
			'KB. Files count:',
			totalInfo.count,
		)
	},
})
