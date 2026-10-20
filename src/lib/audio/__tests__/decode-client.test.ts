import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDecodeWorker } from '../decode-client.ts'
import type { DecodeRequest, DecodeResponse } from '../decode-protocol.ts'

type Handler = (event: { data: DecodeResponse } | { error: Error }) => void

interface FakeWorkerOptions {
	decodable: boolean
	failOpen?: boolean
}

const workers: FakeWorker[] = []

class FakeWorker {
	readonly requests: DecodeRequest[] = []
	readonly terminate = vi.fn()
	readonly #listeners = new Map<string, Handler[]>()
	readonly #options: FakeWorkerOptions
	#frameCount = 0

	constructor(_url: URL, _options: unknown) {
		this.#options = currentOptions
		workers.push(this)
	}

	addEventListener(type: string, handler: Handler) {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), handler])
	}

	postMessage(request: DecodeRequest, _transfer?: Transferable[]) {
		this.requests.push(request)
		queueMicrotask(() => this.#respond(request))
	}

	#emit(data: DecodeResponse) {
		for (const handler of this.#listeners.get('message') ?? []) {
			handler({ data })
		}
	}

	#respond(request: DecodeRequest) {
		switch (request.type) {
			case 'open':
				if (this.#options.failOpen) {
					this.#emit({ id: request.id, type: 'error', message: 'open failed' })
					return
				}
				this.#emit({
					id: request.id,
					type: 'opened',
					decodable: this.#options.decodable,
					sampleRate: 48_000,
					numberOfChannels: 2,
				})
				return
			case 'stream':
			case 'closeStream':
				this.#emit({ id: request.id, type: 'ack' })
				return
			case 'next':
				if (this.#frameCount >= 1) {
					this.#emit({ id: request.id, type: 'chunk', done: true })
					return
				}
				this.#frameCount += 1
				this.#emit({
					id: request.id,
					type: 'chunk',
					done: false,
					timestamp: 0,
					sampleRate: 48_000,
					numberOfFrames: 4,
					channels: [new Float32Array(4), new Float32Array(4)],
				})
		}
	}
}

let currentOptions: FakeWorkerOptions = { decodable: true }

const firstWorker = (): FakeWorker => {
	const worker = workers[0]
	if (!worker) {
		throw new Error('no worker was created')
	}
	return worker
}

const fakeCtx = () =>
	({
		createBuffer: vi.fn(() => ({ copyToChannel: vi.fn() })),
	}) as unknown as AudioContext

beforeEach(() => {
	workers.length = 0
	vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('openDecodeWorker', () => {
	it('streams decoded chunks as AudioBuffers and closes the stream when done', async () => {
		currentOptions = { decodable: true }
		const handle = await openDecodeWorker(new Blob(['x']))
		if (!handle) {
			throw new Error('expected a worker handle')
		}
		expect(handle.sampleRate).toBe(48_000)
		expect(handle.numberOfChannels).toBe(2)

		const ctx = fakeCtx()
		const chunks = []
		for await (const chunk of handle.openStream(0, ctx)) {
			chunks.push(chunk)
		}

		expect(chunks).toHaveLength(1)
		expect(ctx.createBuffer).toHaveBeenCalledWith(2, 4, 48_000)
		const types = firstWorker().requests.map((request) => request.type)
		expect(types).toEqual(['open', 'stream', 'next', 'next', 'closeStream'])
	})

	it('returns null when the browser cannot decode the track', async () => {
		currentOptions = { decodable: false }
		expect(await openDecodeWorker(new Blob(['x']))).toBeNull()
		expect(firstWorker().terminate).toHaveBeenCalled()
	})

	it('returns null when the worker fails to open the file', async () => {
		currentOptions = { decodable: true, failOpen: true }
		expect(await openDecodeWorker(new Blob(['x']))).toBeNull()
		expect(firstWorker().terminate).toHaveBeenCalled()
	})

	it('returns null when Worker is unavailable', async () => {
		vi.stubGlobal('Worker', undefined)
		expect(await openDecodeWorker(new Blob(['x']))).toBeNull()
	})
})
