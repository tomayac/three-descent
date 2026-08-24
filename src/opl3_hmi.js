// HMI Sound Operating System MIDI-to-OPL3 driver.
//
// The chip emulator is pure JavaScript.  The frequency and volume conversion
// below follow the reverse-engineered HMI SOS model in libADLMIDI's
// model_hmi_sos.c:
//
// Copyright (c) 2025-2026 Vitaly Novichkov <admin@wohlnet.ru>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import OPL3 from './vendor/opl3/opl3.js';

const NUM_MIDI_CHANNELS = 16;
const NUM_MIDI_NOTES = 128;
const NUM_OPL3_VOICES = 18;
const OPL3_SAMPLE_RATE = 49700;
const CHIP_OUTPUT_GAIN = 8.0;
const CONTROLLER_VIBRATO_HZ = 5.0;
const CONTROLLER_VIBRATO_SEMITONES = 0.5;

const OPERATOR_OFFSETS = [
	[ 0x00, 0x03 ], [ 0x01, 0x04 ], [ 0x02, 0x05 ],
	[ 0x08, 0x0b ], [ 0x09, 0x0c ], [ 0x0a, 0x0d ],
	[ 0x10, 0x13 ], [ 0x11, 0x14 ], [ 0x12, 0x15 ]
];

const HMI_FREQUENCY_TABLE = new Uint16Array( [
	0x0157, 0x016b, 0x0181, 0x0198, 0x01b0, 0x01ca, 0x01e5, 0x0202, 0x0220, 0x0241, 0x0263, 0x0287,
	0x0557, 0x056b, 0x0581, 0x0598, 0x05b0, 0x05ca, 0x05e5, 0x0602, 0x0620, 0x0641, 0x0663, 0x0687,
	0x0957, 0x096b, 0x0981, 0x0998, 0x09b0, 0x09ca, 0x09e5, 0x0a02, 0x0a20, 0x0a41, 0x0a63, 0x0a87,
	0x0d57, 0x0d6b, 0x0d81, 0x0d98, 0x0db0, 0x0dca, 0x0de5, 0x0e02, 0x0e20, 0x0e41, 0x0e63, 0x0e87,
	0x1157, 0x116b, 0x1181, 0x1198, 0x11b0, 0x11ca, 0x11e5, 0x1202, 0x1220, 0x1241, 0x1263, 0x1287,
	0x1557, 0x156b, 0x1581, 0x1598, 0x15b0, 0x15ca, 0x15e5, 0x1602, 0x1620, 0x1641, 0x1663, 0x1687,
	0x1957, 0x196b, 0x1981, 0x1998, 0x19b0, 0x19ca, 0x19e5, 0x1a02, 0x1a20, 0x1a41, 0x1a63, 0x1a87,
	0x1d57, 0x1d6b, 0x1d81, 0x1d98, 0x1db0, 0x1dca, 0x1de5, 0x1e02, 0x1e20, 0x1e41, 0x1e63, 0x1e87,
	0x1eae, 0x1eb7, 0x1f02, 0x1f30, 0x1f60, 0x1f94, 0x1fca
] );

const HMI_BEND_TABLE = new Uint16Array( [
	0x144, 0x132, 0x121, 0x110, 0x101, 0x0f8,
	0x0e5, 0x0d8, 0x0cc, 0x0c1, 0x0b6, 0x0ac
] );

const HMI_VOLUME_TABLE = new Uint8Array( [
	0x3f, 0x3a, 0x35, 0x30, 0x2c, 0x29, 0x25, 0x24,
	0x23, 0x22, 0x21, 0x20, 0x1f, 0x1e, 0x1d, 0x1c,
	0x1b, 0x1a, 0x19, 0x18, 0x17, 0x16, 0x15, 0x14,
	0x13, 0x12, 0x11, 0x10, 0x0f, 0x0e, 0x0e, 0x0d,
	0x0d, 0x0c, 0x0c, 0x0b, 0x0b, 0x0a, 0x0a, 0x09,
	0x09, 0x08, 0x08, 0x07, 0x07, 0x06, 0x06, 0x06,
	0x05, 0x05, 0x05, 0x04, 0x04, 0x04, 0x04, 0x03,
	0x03, 0x03, 0x02, 0x02, 0x02, 0x01, 0x01, 0x00
] );

function clampInteger( value, minimum, maximum ) {

	value = Number.isFinite( value ) ? Math.trunc( value ) : minimum;
	return Math.max( minimum, Math.min( maximum, value ) );

}

function hmiTableIndex( value, length ) {

	return Math.max( 0, Math.min( length - 1, value ) );

}

function hmiBendFrequency( bend, note ) {

	note -= 12;
	const noteMod12 = note % 12;
	let outputFrequency = HMI_FREQUENCY_TABLE[ note ];
	let fmOctave = outputFrequency & 0x1c00;
	let fmFrequency = outputFrequency & 0x03ff;
	let bendFactor;
	let newFrequency;

	if ( bend < 64 ) {

		bendFactor = ( ( 63 - bend ) * 1000 ) >> 6;
		newFrequency = outputFrequency - HMI_FREQUENCY_TABLE[ hmiTableIndex( note - 1, HMI_FREQUENCY_TABLE.length ) ];

		if ( newFrequency > 719 ) {

			newFrequency = ( fmFrequency - HMI_BEND_TABLE[ 0 ] ) & 0x03ff;

		}

		newFrequency = Math.trunc( newFrequency * bendFactor / 1000 );
		outputFrequency -= newFrequency;

	} else {

		bendFactor = ( ( bend - 64 ) * 1000 ) >> 6;
		newFrequency = HMI_FREQUENCY_TABLE[ hmiTableIndex( note + 1, HMI_FREQUENCY_TABLE.length ) ] - outputFrequency;

		if ( newFrequency > 719 ) {

			fmFrequency = HMI_BEND_TABLE[ hmiTableIndex( 11 - noteMod12, HMI_BEND_TABLE.length ) ];
			outputFrequency = ( fmOctave + 1024 ) | fmFrequency;
			newFrequency = HMI_FREQUENCY_TABLE[ hmiTableIndex( note + 1, HMI_FREQUENCY_TABLE.length ) ] - outputFrequency;

		}

		newFrequency = Math.trunc( newFrequency * bendFactor / 1000 );
		outputFrequency += newFrequency;

	}

	return outputFrequency;

}

function scaledHmiTotalLevel( baseLevel, channelVolume, expression, velocity, masterVolume ) {

	let volume = Math.trunc( channelVolume * expression * masterVolume / 16129 );
	volume = ( Math.trunc( volume * 128 / 127 ) * velocity ) >> 7;
	volume = Math.min( volume, 127 );
	volume = HMI_VOLUME_TABLE[ volume >> 1 ];

	let outputVolume = ( 64 - volume ) << 1;
	outputVolume *= 64 - baseLevel;
	return ( 8192 - outputVolume ) >> 7;

}

function createChannelState() {

	return {
		program: 0,
		volume: 100,
		pan: 64,
		expression: 127,
		sustain: false,
		modulation: 0,
		pressure: 0,
		notePressure: new Uint8Array( NUM_MIDI_NOTES ),
		pitchBend: 0
	};

}

function createVoiceState( index ) {

	const bank = index >= 9 ? 1 : 0;
	const chipChannel = index % 9;
	return {
		index: index,
		bank: bank,
		chipChannel: chipChannel,
		modOffset: OPERATOR_OFFSETS[ chipChannel ][ 0 ],
		carOffset: OPERATOR_OFFSETS[ chipChannel ][ 1 ],
		assigned: false,
		keyOn: false,
		keyHeld: false,
		sustained: false,
		midiChannel: 0,
		note: 0,
		playbackNote: 0,
		velocity: 0,
		notePressure: 0,
		patch: null,
		startSerial: 0,
		releaseSerial: 0,
		frequencyHigh: 0,
		keyPrevious: - 1,
		keyNext: - 1,
		keyLinked: false
	};

}

export class HmiOpl3Synth {

	constructor( outputSampleRate = 48000 ) {

		this.outputSampleRate = outputSampleRate;
		this.channels = new Array( NUM_MIDI_CHANNELS );
		this.voices = new Array( NUM_OPL3_VOICES );
		this.activeVoiceHeadByKey = new Int16Array( NUM_MIDI_CHANNELS * NUM_MIDI_NOTES );
		this.activeVoiceTailByKey = new Int16Array( NUM_MIDI_CHANNELS * NUM_MIDI_NOTES );
		this.melodicPatches = null;
		this.drumPatches = null;
		this.drumPatchForNote = new Array( NUM_MIDI_NOTES );
		this.masterVolume = 127;
		this.serial = 1;
		this.hmiMultiplierOffset = 0;
		this.nativePair = new Float32Array( 2 );
		this.sampleA0 = 0;
		this.sampleA1 = 0;
		this.sampleB0 = 0;
		this.sampleB1 = 0;
		this.sourceFraction = 0;
		this.resamplerReady = false;
		this.nextVibratoFrame = 0;
		this.sampleLeft = 0;
		this.sampleRight = 0;

		for ( let i = 0; i < NUM_MIDI_CHANNELS; i ++ ) this.channels[ i ] = createChannelState();
		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) this.voices[ i ] = createVoiceState( i );
		this.reset();

	}

	setMasterVolume( volume ) {

		volume = clampInteger( volume, 0, 127 );
		if ( volume === this.masterVolume ) return;
		this.masterVolume = volume;

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			if ( this.voices[ i ].assigned === true ) this._writeVoiceVolume( this.voices[ i ] );

		}

	}

	setBanks( melodicPatches, drumPatches ) {

		this.melodicPatches = Array.isArray( melodicPatches ) ? melodicPatches : null;
		this.drumPatches = Array.isArray( drumPatches ) ? drumPatches : null;

		for ( let note = 0; note < NUM_MIDI_NOTES; note ++ ) {

			this.drumPatchForNote[ note ] = this.drumPatches?.[ note ] || null;

		}

	}

	reset() {

		this.opl = new OPL3();
		this.opl.write( 1, 0x05, 0x01 );
		this.opl.write( 0, 0x01, 0x20 );
		// Descent's HMI driver uses the deep tremolo and vibrato depths.
		this.opl.write( 0, 0xbd, 0xc0 );
		this.activeVoiceHeadByKey.fill( - 1 );
		this.activeVoiceTailByKey.fill( - 1 );
		this.serial = 1;

		for ( let channel = 0; channel < NUM_MIDI_CHANNELS; channel ++ ) {

			const state = this.channels[ channel ];
			state.program = 0;
			state.volume = 100;
			state.pan = 64;
			state.expression = 127;
			state.sustain = false;
			state.modulation = 0;
			state.pressure = 0;
			state.notePressure.fill( 0 );
			state.pitchBend = 0;

		}

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			const voice = this.voices[ i ];
			voice.assigned = false;
			voice.keyOn = false;
			voice.keyHeld = false;
			voice.sustained = false;
			voice.patch = null;
			voice.startSerial = 0;
			voice.releaseSerial = 0;
			voice.frequencyHigh = 0;
			voice.keyPrevious = - 1;
			voice.keyNext = - 1;
			voice.keyLinked = false;

		}

		this.sourceFraction = 0;
		this.resamplerReady = false;
		this.nextVibratoFrame = 0;
		this.sampleLeft = 0;
		this.sampleRight = 0;

	}

	_hmiFrequency( tone ) {

		tone = Math.max( 0, Number.isFinite( tone ) ? tone : 0 );
		let note = Math.trunc( tone );
		let bendDecimal = tone - note;
		let octaveOffset = 0;

		if ( bendDecimal > 0.5 ) {

			note ++;
			bendDecimal -= 1.0;

		}

		const bend = Math.trunc( bendDecimal * 64.0 ) + 64;

		while ( note < 12 ) {

			octaveOffset --;
			note += 12;

		}

		while ( note > 114 ) {

			octaveOffset ++;
			note -= 12;

		}

		const inputFrequency = bend === 64
			? HMI_FREQUENCY_TABLE[ note - 12 ]
			: hmiBendFrequency( bend, note );
		const frequency = inputFrequency & 0x03ff;
		let octave = ( ( inputFrequency >> 10 ) & 0x07 ) + octaveOffset;
		this.hmiMultiplierOffset = 0;

		if ( octave < 0 ) octave = 0;
		while ( octave > 7 ) {

			this.hmiMultiplierOffset ++;
			octave --;

		}

		return frequency | ( octave << 10 );

	}

	_selectPatch( channel, note ) {

		if ( channel === 9 && this.drumPatches !== null ) {

			return this.drumPatchForNote[ note ] || null;

		}

		return this.melodicPatches?.[ this.channels[ channel ].program ] || null;

	}

	_findVoice() {

		let selected = - 1;
		let oldestSerial = Number.MAX_SAFE_INTEGER;

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			const voice = this.voices[ i ];
			if ( voice.assigned !== true ) return i;
			if ( voice.keyOn !== true && voice.releaseSerial < oldestSerial ) {

				selected = i;
				oldestSerial = voice.releaseSerial;

			}

		}

		if ( selected !== - 1 ) return selected;

		oldestSerial = Number.MAX_SAFE_INTEGER;
		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			if ( this.voices[ i ].startSerial < oldestSerial ) {

				selected = i;
				oldestSerial = this.voices[ i ].startSerial;

			}

		}

		return selected;

	}

	_linkVoiceKey( voice ) {

		const key = voice.midiChannel * NUM_MIDI_NOTES + voice.note;
		const previous = this.activeVoiceTailByKey[ key ];
		voice.keyPrevious = previous;
		voice.keyNext = - 1;
		voice.keyLinked = true;

		if ( previous >= 0 ) this.voices[ previous ].keyNext = voice.index;
		else this.activeVoiceHeadByKey[ key ] = voice.index;
		this.activeVoiceTailByKey[ key ] = voice.index;

	}

	_unlinkVoiceKey( voice ) {

		if ( voice.keyLinked !== true ) return;
		const key = voice.midiChannel * NUM_MIDI_NOTES + voice.note;
		const previous = voice.keyPrevious;
		const next = voice.keyNext;

		if ( previous >= 0 ) this.voices[ previous ].keyNext = next;
		else this.activeVoiceHeadByKey[ key ] = next;

		if ( next >= 0 ) this.voices[ next ].keyPrevious = previous;
		else this.activeVoiceTailByKey[ key ] = previous;

		voice.keyPrevious = - 1;
		voice.keyNext = - 1;
		voice.keyLinked = false;

	}

	_keyOffVoice( voice ) {

		if ( voice.keyOn !== true ) return;
		voice.keyHeld = false;
		voice.sustained = false;
		voice.keyOn = false;
		voice.releaseSerial = this.serial ++;
		this._unlinkVoiceKey( voice );
		voice.frequencyHigh &= 0x1f;
		this.opl.write( voice.bank, 0xb0 + voice.chipChannel, voice.frequencyHigh );

	}

	_writePatch( voice ) {

		const patch = voice.patch;
		const mod = patch.mod;
		const car = patch.car;
		const bank = voice.bank;

		this.opl.write( bank, 0x20 + voice.modOffset,
			( ( mod.am & 1 ) << 7 ) | ( ( mod.vib & 1 ) << 6 ) | ( ( mod.eg & 1 ) << 5 ) |
			( ( mod.ksr & 1 ) << 4 ) | ( mod.mult & 0x0f ) );
		this.opl.write( bank, 0x20 + voice.carOffset,
			( ( car.am & 1 ) << 7 ) | ( ( car.vib & 1 ) << 6 ) | ( ( car.eg & 1 ) << 5 ) |
			( ( car.ksr & 1 ) << 4 ) | ( car.mult & 0x0f ) );
		this.opl.write( bank, 0x60 + voice.modOffset, ( ( mod.ar & 0x0f ) << 4 ) | ( mod.dr & 0x0f ) );
		this.opl.write( bank, 0x60 + voice.carOffset, ( ( car.ar & 0x0f ) << 4 ) | ( car.dr & 0x0f ) );
		this.opl.write( bank, 0x80 + voice.modOffset, ( ( mod.sl & 0x0f ) << 4 ) | ( mod.rr & 0x0f ) );
		this.opl.write( bank, 0x80 + voice.carOffset, ( ( car.sl & 0x0f ) << 4 ) | ( car.rr & 0x0f ) );
		this.opl.write( bank, 0xe0 + voice.modOffset, mod.wave & 0x07 );
		this.opl.write( bank, 0xe0 + voice.carOffset, car.wave & 0x07 );
		this._writeVoiceVolume( voice );
		this._writeVoicePan( voice );

	}

	_writeVoiceVolume( voice ) {

		if ( voice.assigned !== true || voice.patch === null ) return;
		const channel = this.channels[ voice.midiChannel ];
		const mod = voice.patch.mod;
		const car = voice.patch.car;
		const connection = mod.con & 1;
		const modLevel = connection === 1
			? scaledHmiTotalLevel( mod.tl & 0x3f, channel.volume, channel.expression,
				voice.velocity, this.masterVolume )
			: mod.tl & 0x3f;
		const carLevel = scaledHmiTotalLevel( car.tl & 0x3f, channel.volume, channel.expression,
			voice.velocity, this.masterVolume );

		this.opl.write( voice.bank, 0x40 + voice.modOffset, ( ( mod.ksl & 3 ) << 6 ) | ( modLevel & 0x3f ) );
		this.opl.write( voice.bank, 0x40 + voice.carOffset, ( ( car.ksl & 3 ) << 6 ) | ( carLevel & 0x3f ) );

	}

	_writeVoicePan( voice ) {

		if ( voice.assigned !== true || voice.patch === null ) return;
		const pan = this.channels[ voice.midiChannel ].pan;
		let routing = 0;
		if ( pan < 80 ) routing |= 0x10;
		if ( pan >= 48 ) routing |= 0x20;
		const feedback = voice.patch.mod.fb & 7;
		const connection = voice.patch.mod.con & 1;
		this.opl.write( voice.bank, 0xc0 + voice.chipChannel,
			routing | ( feedback << 1 ) | connection );

	}

	_controllerVibrato( voice, outputFrame ) {

		const channel = this.channels[ voice.midiChannel ];
		const amount = Math.max( channel.modulation, channel.pressure, voice.notePressure );
		if ( amount === 0 ) return 0;
		const phase = outputFrame / this.outputSampleRate * CONTROLLER_VIBRATO_HZ * Math.PI * 2;
		return Math.sin( phase ) * amount / 127 * CONTROLLER_VIBRATO_SEMITONES;

	}

	_voiceUsesControllerVibrato( voice ) {

		const channel = this.channels[ voice.midiChannel ];
		return channel.modulation !== 0 || channel.pressure !== 0 || voice.notePressure !== 0;

	}

	_writeOperatorMultiplier( voice, offset, op, multiplierOffset ) {

		let multiplier = op.mult & 0x0f;
		let remainingOffset = multiplierOffset;

		if ( remainingOffset > 0 ) {

			if ( multiplier + remainingOffset > 0x0f ) {

				remainingOffset = 0;
				multiplier = 0x0f;

			} else {

				multiplier += remainingOffset;

			}

		}

		this.opl.write( voice.bank, 0x20 + offset,
			( ( op.am & 1 ) << 7 ) | ( ( op.vib & 1 ) << 6 ) | ( ( op.eg & 1 ) << 5 ) |
			( ( op.ksr & 1 ) << 4 ) | multiplier );
		return remainingOffset;

	}

	_writeVoiceFrequency( voice, outputFrame ) {

		if ( voice.assigned !== true || voice.patch === null ) return;
		const channel = this.channels[ voice.midiChannel ];
		const tone = voice.playbackNote + channel.pitchBend + this._controllerVibrato( voice, outputFrame );
		const packed = this._hmiFrequency( tone );
		let multiplierOffset = this.hmiMultiplierOffset;
		multiplierOffset = this._writeOperatorMultiplier( voice, voice.modOffset,
			voice.patch.mod, multiplierOffset );
		this._writeOperatorMultiplier( voice, voice.carOffset,
			voice.patch.car, multiplierOffset );

		voice.frequencyHigh = ( packed >> 8 ) & 0x1f;
		this.opl.write( voice.bank, 0xa0 + voice.chipChannel, packed & 0xff );
		this.opl.write( voice.bank, 0xb0 + voice.chipChannel,
			voice.frequencyHigh | ( voice.keyOn === true ? 0x20 : 0 ) );

	}

	_noteOn( channelNumber, note, velocity, outputFrame ) {

		const patch = this._selectPatch( channelNumber, note );
		if ( patch === null || patch === undefined ) return;

		const voice = this.voices[ this._findVoice() ];
		if ( voice.keyOn === true ) this._keyOffVoice( voice );
		this._unlinkVoiceKey( voice );
		voice.assigned = true;
		voice.keyOn = false;
		voice.keyHeld = true;
		voice.sustained = false;
		voice.midiChannel = channelNumber;
		voice.note = note;
		voice.playbackNote = channelNumber === 9 && Number.isInteger( patch.percussionNote )
			? clampInteger( patch.percussionNote, 0, 127 )
			: note;
		voice.velocity = velocity;
		voice.notePressure = this.channels[ channelNumber ].notePressure[ note ];
		voice.patch = patch;
		voice.startSerial = this.serial ++;
		voice.releaseSerial = 0;
		this._writePatch( voice );
		this._writeVoiceFrequency( voice, outputFrame );
		voice.keyOn = true;
		this.opl.write( voice.bank, 0xb0 + voice.chipChannel, voice.frequencyHigh | 0x20 );
		this._linkVoiceKey( voice );

	}

	_noteOff( channelNumber, note ) {

		const voiceIndex = this.activeVoiceHeadByKey[ channelNumber * NUM_MIDI_NOTES + note ];
		if ( voiceIndex < 0 ) return;
		const voice = this.voices[ voiceIndex ];
		voice.keyHeld = false;
		this._unlinkVoiceKey( voice );

		if ( this.channels[ channelNumber ].sustain === true ) {

			voice.sustained = true;
			return;

		}

		this._keyOffVoice( voice );

	}

	_releaseSustainedNotes( channelNumber ) {

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			const voice = this.voices[ i ];
			if ( voice.assigned === true && voice.midiChannel === channelNumber &&
				voice.sustained === true ) this._keyOffVoice( voice );

		}

	}

	_allSoundOff( channelNumber ) {

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			const voice = this.voices[ i ];
			if ( voice.assigned !== true || voice.midiChannel !== channelNumber ) continue;

			this._unlinkVoiceKey( voice );
			voice.keyOn = false;
			voice.keyHeld = false;
			voice.sustained = false;
			voice.frequencyHigh &= 0x1f;
			this.opl.write( voice.bank, 0xb0 + voice.chipChannel, voice.frequencyHigh );
			// All Sound Off is immediate, so fully attenuate both operators.  A
			// later assignment rewrites the complete patch before key-on.
			this.opl.write( voice.bank, 0x80 + voice.modOffset, 0x0f );
			this.opl.write( voice.bank, 0x80 + voice.carOffset, 0x0f );
			this.opl.write( voice.bank, 0x40 + voice.modOffset, 0x3f );
			this.opl.write( voice.bank, 0x40 + voice.carOffset, 0x3f );
			voice.assigned = false;
			voice.patch = null;

		}

	}

	_allNotesOff( channelNumber ) {

		for ( let note = 0; note < NUM_MIDI_NOTES; note ++ ) {

			const key = channelNumber * NUM_MIDI_NOTES + note;
			while ( this.activeVoiceHeadByKey[ key ] >= 0 ) this._noteOff( channelNumber, note );

		}

	}

	_updateChannelVoices( channelNumber, updateVolume, updatePan, updateFrequency, outputFrame ) {

		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

			const voice = this.voices[ i ];
			if ( voice.assigned !== true || voice.midiChannel !== channelNumber ) continue;
			if ( updateVolume === true ) this._writeVoiceVolume( voice );
			if ( updatePan === true ) this._writeVoicePan( voice );
			if ( updateFrequency === true ) this._writeVoiceFrequency( voice, outputFrame );

		}

	}

	processMidiEvent( type, channelNumber, data1, data2, outputFrame = 0 ) {

		channelNumber = clampInteger( channelNumber, 0, 15 );
		data1 = clampInteger( data1, 0, 127 );
		data2 = clampInteger( data2, 0, 127 );
		const channel = this.channels[ channelNumber ];

		switch ( type ) {

			case 0x08:
				this._noteOff( channelNumber, data1 );
				break;

			case 0x09:
				if ( data2 === 0 ) this._noteOff( channelNumber, data1 );
				else this._noteOn( channelNumber, data1, data2, outputFrame );
				break;

			case 0x0a: {
				channel.notePressure[ data1 ] = data2;
				let voiceIndex = this.activeVoiceHeadByKey[ channelNumber * NUM_MIDI_NOTES + data1 ];
				while ( voiceIndex >= 0 ) {

					const voice = this.voices[ voiceIndex ];
					voiceIndex = voice.keyNext;
					voice.notePressure = data2;
					this._writeVoiceFrequency( voice, outputFrame );

				}
				break;
			}

			case 0x0b:
				switch ( data1 ) {

					case 1:
						channel.modulation = data2;
						this._updateChannelVoices( channelNumber, false, false, true, outputFrame );
						break;
					case 7:
						channel.volume = data2;
						this._updateChannelVoices( channelNumber, true, false, false, outputFrame );
						break;
					case 10:
						channel.pan = data2;
						this._updateChannelVoices( channelNumber, false, true, false, outputFrame );
						break;
					case 11:
						channel.expression = data2;
						this._updateChannelVoices( channelNumber, true, false, false, outputFrame );
						break;
					case 64:
						channel.sustain = data2 >= 64;
						if ( channel.sustain !== true ) this._releaseSustainedNotes( channelNumber );
						break;
					case 120:
						this._allSoundOff( channelNumber );
						break;
					case 123:
						this._allNotesOff( channelNumber );
						break;
					case 121:
						channel.sustain = false;
						this._releaseSustainedNotes( channelNumber );
						channel.expression = 127;
						channel.modulation = 0;
						channel.pressure = 0;
						channel.notePressure.fill( 0 );
						channel.pitchBend = 0;
						for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) {

							const voice = this.voices[ i ];
							if ( voice.assigned === true && voice.midiChannel === channelNumber ) voice.notePressure = 0;

						}
						this._updateChannelVoices( channelNumber, true, false, true, outputFrame );
						break;

				}
				break;

			case 0x0c:
				channel.program = data1;
				break;

			case 0x0d:
				channel.pressure = data1;
				this._updateChannelVoices( channelNumber, false, false, true, outputFrame );
				break;

			case 0x0e: {
				const bendValue = ( data2 << 7 ) | data1;
				channel.pitchBend = ( bendValue - 8192 ) / 8192 * 2.0;
				this._updateChannelVoices( channelNumber, false, false, true, outputFrame );
				break;
			}

		}

	}

	_renderNativeSample() {

		this.opl.read( this.nativePair );

	}

	_renderOutputSample() {

		if ( this.resamplerReady !== true ) {

			this._renderNativeSample();
			this.sampleA0 = this.nativePair[ 0 ];
			this.sampleA1 = this.nativePair[ 1 ];
			this._renderNativeSample();
			this.sampleB0 = this.nativePair[ 0 ];
			this.sampleB1 = this.nativePair[ 1 ];
			this.resamplerReady = true;

		}

		const fraction = this.sourceFraction;
		this.sampleLeft = ( this.sampleA0 + ( this.sampleB0 - this.sampleA0 ) * fraction ) * CHIP_OUTPUT_GAIN;
		this.sampleRight = ( this.sampleA1 + ( this.sampleB1 - this.sampleA1 ) * fraction ) * CHIP_OUTPUT_GAIN;
		this.sourceFraction += OPL3_SAMPLE_RATE / this.outputSampleRate;

		while ( this.sourceFraction >= 1 ) {

			this.sampleA0 = this.sampleB0;
			this.sampleA1 = this.sampleB1;
			this._renderNativeSample();
			this.sampleB0 = this.nativePair[ 0 ];
			this.sampleB1 = this.nativePair[ 1 ];
			this.sourceFraction --;

		}

	}

	render( left, right, offset, count, startOutputFrame ) {

		for ( let i = 0; i < count; i ++ ) {

			const outputFrame = startOutputFrame + i;

			if ( outputFrame >= this.nextVibratoFrame ) {

				for ( let voiceIndex = 0; voiceIndex < NUM_OPL3_VOICES; voiceIndex ++ ) {

					const voice = this.voices[ voiceIndex ];
					if ( voice.assigned === true && voice.keyOn === true &&
						this._voiceUsesControllerVibrato( voice ) === true ) {

						this._writeVoiceFrequency( voice, outputFrame );

					}

				}

				this.nextVibratoFrame = outputFrame + 64;

			}

			this._renderOutputSample();
			left[ offset + i ] = this.sampleLeft;
			right[ offset + i ] = this.sampleRight;

		}

	}

	getActiveVoiceCount() {

		let count = 0;
		for ( let i = 0; i < NUM_OPL3_VOICES; i ++ ) if ( this.voices[ i ].keyOn === true ) count ++;
		return count;

	}

}
