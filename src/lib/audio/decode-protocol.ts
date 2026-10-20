/**
 * Messages between the playback engine and the decode worker.
 *
 * Every request carries an `id`; the matching response echoes it back.
 * Decoded audio is sent as transferred Float32Arrays (one per channel), so the
 * sample data is not copied on the way to the main thread.
 */

export type DecodeRequest =
	| { id: number; type: 'open'; file: Blob }
	| { id: number; type: 'stream'; streamId: number; startTime: number }
	| { id: number; type: 'next'; streamId: number }
	| { id: number; type: 'closeStream'; streamId: number }

export type DecodeResponse =
	| {
			id: number
			type: 'opened'
			decodable: boolean
			sampleRate: number
			numberOfChannels: number
	  }
	| { id: number; type: 'ack' }
	| {
			id: number
			type: 'chunk'
			done: false
			timestamp: number
			sampleRate: number
			numberOfFrames: number
			channels: Float32Array[]
	  }
	| { id: number; type: 'chunk'; done: true }
	| { id: number; type: 'error'; message: string }
