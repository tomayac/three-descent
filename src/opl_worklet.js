import { HmiOpl3Synth } from './opl3_hmi.js';

const PROCESSOR_NAME = 'descent-opl3';

class DescentOpl3Processor extends AudioWorkletProcessor {

	constructor() {

		super();
		this.synth = new HmiOpl3Synth( sampleRate );
		this.events = [];
		this.eventIndex = 0;

		this.port.onmessage = event => {

			const message = event.data;
			if ( message === null || message === undefined ) return;

			if ( message.type === 'banks' ) {

				this.synth.setBanks( message.melodic, message.drums );

			} else if ( message.type === 'volume' ) {

				this.synth.setMasterVolume( message.value );

			} else if ( message.type === 'event' ) {

				if ( this.eventIndex > 0 ) {

					const remaining = this.events.length - this.eventIndex;
					for ( let i = 0; i < remaining; i ++ ) {

						this.events[ i ] = this.events[ this.eventIndex + i ];

					}

					this.events.length = remaining;
					this.eventIndex = 0;

				}

				let insertAt = this.events.length;
				while ( insertAt > 0 && message.frame < this.events[ insertAt - 1 ].frame ) {

					this.events[ insertAt ] = this.events[ insertAt - 1 ];
					insertAt --;

				}

				this.events[ insertAt ] = message;

			} else if ( message.type === 'reset' ) {

				this.events.length = 0;
				this.eventIndex = 0;
				this.synth.reset();

			}

		};

	}

	process( inputs, outputs ) {

		const output = outputs[ 0 ];
		if ( output === undefined || output.length === 0 ) return true;
		const left = output[ 0 ];
		const right = output.length > 1 ? output[ 1 ] : output[ 0 ];
		const blockStart = currentFrame;
		let rendered = 0;

		while ( rendered < left.length ) {

			const next = this.events[ this.eventIndex ];
			const nextFrame = next === undefined ? Number.POSITIVE_INFINITY : next.frame;
			const eventOffset = Math.max( rendered, Math.min( left.length, Math.ceil( nextFrame - blockStart ) ) );

			if ( eventOffset > rendered ) {

				this.synth.render( left, right, rendered, eventOffset - rendered, blockStart + rendered );
				rendered = eventOffset;

			}

			if ( nextFrame <= blockStart + rendered ) {

				this.synth.processMidiEvent( next.midiType, next.channel, next.data1, next.data2,
					Math.max( blockStart + rendered, nextFrame ) );
				this.eventIndex ++;
				continue;

			}

			if ( eventOffset === rendered ) {

				this.synth.render( left, right, rendered, left.length - rendered, blockStart + rendered );
				rendered = left.length;

			}

		}

		if ( this.eventIndex === this.events.length ) {

			this.events.length = 0;
			this.eventIndex = 0;

		}

		return true;

	}

}

registerProcessor( PROCESSOR_NAME, DescentOpl3Processor );
