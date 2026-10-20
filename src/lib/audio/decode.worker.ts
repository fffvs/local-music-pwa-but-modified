import {
	type AudioSample,
	AudioSampleSink,
	BlobSource,
	FLAC,
	Input,
	type InputAudioTrack,
	MP3,
	MP4,
	OGG,
	WAVE,
	WEBM,
} from 'mediabunny'
import type { DecodeRequest, DecodeResponse } from './decode-protocol.ts'

declare const self: DedicatedWorkerGlobalScope

const FORMATS = [FLAC, MP3, MP4, OGG, WAVE, WEBM]

/**
 * Decoded packets are grouped into chunks of about this many seconds. A FLAC
 * packet is only a few thousand samples, so grouping them cuts the number of
 * worker messages and AudioBufferSourceNodes by roughly an order of magnitude.
 */
const CHUNK_SECONDS = 0.5

interface StreamState {
	samples: AsyncGenerator<AudioSample, void, unknown>
	/** A sample read ahead that did not fit the current chunk (e.g. format change). */
	carry: AudioSample | null
	/** Serializes `next` requests so chunks are produced in order. */
	queue: Promise<void>
}

// One worker serves one track, so there is at most one open input at a time.
let input: Input | null = null
let track: InputAudioTrack | null = null
const streams = new Map<number, StreamState>()

const reply = (message: DecodeResponse, transfer: Transferable[] = []): void => {
	self.postMessage(message, transfer)
}

const handleOpen = async (id: number, file: Blob): Promise<void> => {
	input?.dispose()
	input = new Input({ formats: FORMATS, source: new BlobSource(file) })

	const audioTrack = await input.getPrimaryAudioTrack()
	if (!audioTrack) {
		throw new Error('No audio track found')
	}

	track = audioTrack
	const decodable = await audioTrack.canDecode()
	reply({
		id,
		type: 'opened',
		decodable,
		sampleRate: audioTrack.sampleRate,
		numberOfChannels: audioTrack.numberOfChannels,
	})
}

const readSample = async (state: StreamState): Promise<AudioSample | null> => {
	if (state.carry) {
		const carried = state.carry
		state.carry = null
		return carried
	}
	const result = await state.samples.next()
	return result.done ? null : result.value
}

/** Reads consecutive samples until about CHUNK_SECONDS of audio has been collected. */
const collectGroup = async (state: StreamState): Promise<AudioSample[]> => {
	const group: AudioSample[] = []
	let frames = 0
	let targetFrames = 0

	while (true) {
		const sample = await readSample(state)
		if (!sample) {
			break
		}

		const first = group[0]
		if (
			first &&
			(sample.sampleRate !== first.sampleRate ||
				sample.numberOfChannels !== first.numberOfChannels)
		) {
			// Format changed: keep this sample for the next chunk.
			state.carry = sample
			break
		}

		group.push(sample)
		frames += sample.numberOfFrames
		if (targetFrames === 0) {
			targetFrames = Math.round(sample.sampleRate * CHUNK_SECONDS)
		}
		if (frames >= targetFrames) {
			break
		}
	}

	return group
}

/** Copies a group of samples into one planar buffer per channel and closes them. */
const mergeGroup = (group: AudioSample[]): { channels: Float32Array[]; numberOfFrames: number } => {
	const numberOfFrames = group.reduce((total, sample) => total + sample.numberOfFrames, 0)
	const numberOfChannels = group[0]?.numberOfChannels ?? 0
	const channels = Array.from(
		{ length: numberOfChannels },
		() => new Float32Array(numberOfFrames),
	)

	let offset = 0
	try {
		for (const sample of group) {
			for (let planeIndex = 0; planeIndex < numberOfChannels; planeIndex += 1) {
				const target = channels[planeIndex]
				if (!target) {
					continue
				}
				// Each sample writes into its own slice of the shared plane.
				sample.copyTo(target.subarray(offset, offset + sample.numberOfFrames), {
					planeIndex,
					format: 'f32-planar',
				})
			}
			offset += sample.numberOfFrames
		}
	} finally {
		for (const sample of group) {
			sample.close()
		}
	}

	return { channels, numberOfFrames }
}

const produceChunk = async (id: number, streamId: number, state: StreamState): Promise<void> => {
	const group = await collectGroup(state)
	const first = group[0]

	if (!first) {
		streams.delete(streamId)
		void state.samples.return(undefined)
		reply({ id, type: 'chunk', done: true })
		return
	}

	const { timestamp, sampleRate } = first
	const { channels, numberOfFrames } = mergeGroup(group)

	reply(
		{
			id,
			type: 'chunk',
			done: false,
			timestamp,
			sampleRate,
			numberOfFrames,
			channels,
		},
		channels.map((channel) => channel.buffer),
	)
}

const handleNext = (id: number, streamId: number): Promise<void> => {
	const state = streams.get(streamId)
	if (!state) {
		reply({ id, type: 'chunk', done: true })
		return Promise.resolve()
	}

	// Chain onto the previous request so chunks always come back in order.
	const run = state.queue.then(() => produceChunk(id, streamId, state))
	state.queue = run.catch(() => {})
	return run
}

const handleMessage = (request: DecodeRequest): Promise<void> => {
	switch (request.type) {
		case 'open':
			return handleOpen(request.id, request.file)

		case 'stream': {
			if (!track) {
				return Promise.reject(new Error('Decode worker has no open track'))
			}
			const sink = new AudioSampleSink(track)
			streams.set(request.streamId, {
				samples: sink.samples(request.startTime),
				carry: null,
				queue: Promise.resolve(),
			})
			reply({ id: request.id, type: 'ack' })
			return Promise.resolve()
		}

		case 'next':
			return handleNext(request.id, request.streamId)

		case 'closeStream': {
			const state = streams.get(request.streamId)
			streams.delete(request.streamId)
			void state?.samples.return(undefined)
			reply({ id: request.id, type: 'ack' })
			return Promise.resolve()
		}
	}
}

self.addEventListener('message', ({ data }: MessageEvent<DecodeRequest>) => {
	handleMessage(data).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		reply({ id: data.id, type: 'error', message })
	})
})
