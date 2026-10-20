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

// One worker serves one track, so there is at most one open input at a time.
let input: Input | null = null
let track: InputAudioTrack | null = null
const streams = new Map<number, AsyncGenerator<AudioSample, void, unknown>>()

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

const handleNext = async (id: number, streamId: number): Promise<void> => {
	const stream = streams.get(streamId)
	const result = stream ? await stream.next() : { done: true as const, value: undefined }

	if (result.done) {
		streams.delete(streamId)
		reply({ id, type: 'chunk', done: true })
		return
	}

	const sample = result.value
	try {
		const numberOfFrames = sample.numberOfFrames
		const channels: Float32Array[] = []
		for (let planeIndex = 0; planeIndex < sample.numberOfChannels; planeIndex += 1) {
			const plane = new Float32Array(numberOfFrames)
			sample.copyTo(plane, { planeIndex, format: 'f32-planar' })
			channels.push(plane)
		}

		reply(
			{
				id,
				type: 'chunk',
				done: false,
				timestamp: sample.timestamp,
				sampleRate: sample.sampleRate,
				numberOfFrames,
				channels,
			},
			channels.map((channel) => channel.buffer),
		)
	} finally {
		sample.close()
	}
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
			streams.set(request.streamId, sink.samples(request.startTime))
			reply({ id: request.id, type: 'ack' })
			return Promise.resolve()
		}

		case 'next':
			return handleNext(request.id, request.streamId)

		case 'closeStream': {
			const stream = streams.get(request.streamId)
			streams.delete(request.streamId)
			void stream?.return(undefined)
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
