// OPL2 FM synth and bank handling for HMP MIDI playback.

const NUM_CHANNELS = 16;
const OPL2_NUM_VOICES = 9;
const OPL_MULTIPLIERS = [ 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15 ];
// HMI treats CC1, channel pressure, and per-note pressure as vibrato sources
// (the strongest value wins), with a five-Hz LFO reaching half a semitone at 127.
const CONTROLLER_VIBRATO_HZ = 5.0;
const CONTROLLER_VIBRATO_CENTS = 50.0;

let _audioContext = null;
let _outputNode = null;
let _workletNode = null;
let _workletReady = false;
let _masterVolume = 127;

// Per-channel state (16 MIDI channels)
const _channels = [];

// FIFO ownership for held notes.  HMP files can layer multiple Note On events
// for the same channel/key before their corresponding Note Off events arrive.
const _activeNotes = new Map(); // key: "channel-note" -> oldest held note-state
const _activeNoteTails = new Map(); // key: "channel-note" -> newest held note-state

// Every Web Audio voice that has been created but has not ended yet.  A MIDI
// key can own multiple voices and released voices remain scheduled, so this
// must be tracked independently from the held-note FIFO maps.
const _scheduledVoices = new Set();

// OPL2 9-voice melodic limit
const _voiceSlots = []; // array of note-state objects, oldest first

// OPL bank data loaded from melodic.bnk / drum.bnk
let _bnkMelodicPatches = null; // Array(128): program -> patch
let _bnkDrumPatches = null; // Map(note -> patch)
let _bankHogFile = null;
let _loadedMelodicBank = '';
let _loadedDrumBank = '';
let _banksLoaded = false;

// OPL2 waveforms with feedback: cached as PeriodicWave objects
const _oplWaveCache = new Map();

function ensureChannelsInitialized() {

	if ( _channels.length === NUM_CHANNELS ) return;

	_channels.length = 0;

	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels.push( {
			program: 0,		// current instrument (0-127)
			volume: 100,	// channel volume (0-127)
			pan: 64,		// pan (0=left, 64=center, 127=right)
			expression: 127,	// expression controller
			sustain: false,	// sustain pedal (CC64)
			modulation: 0,	// modulation wheel (CC1)
			pressure: 0,	// channel pressure / aftertouch
			notePressure: new Uint8Array( 128 ),	// polyphonic key pressure
			pitchBend: 0	// pitch bend in cents (±200 = ±2 semitones)
		} );

	}

}

function getOplWaveform( waveType, fb ) {

	if ( _audioContext === null ) return null;

	const cacheKey = waveType + '-' + fb;

	if ( _oplWaveCache.has( cacheKey ) ) return _oplWaveCache.get( cacheKey );

	// Build PeriodicWave from Fourier coefficients
	const N = 64; // number of harmonics
	const real = new Float32Array( N );
	const imag = new Float32Array( N );

	if ( waveType === 0 ) {

		// Pure sine
		imag[ 1 ] = 1.0;

	} else if ( waveType === 1 ) {

		// Half-sine: positive half only (negative clamped to 0)
		real[ 0 ] = 1.0 / Math.PI;
		imag[ 1 ] = 0.5;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 2.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 2 ) {

		// Abs-sine: full-wave rectified (always positive)
		real[ 0 ] = 2.0 / Math.PI;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 4.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 3 ) {

		// Quarter-sine: sin(x) for 0≤x<π/2, 0 elsewhere
		const M = 1024;

		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				const x = ( 2 * Math.PI * j ) / M;
				const val = ( x < Math.PI / 2 ) ? Math.sin( x ) : 0;
				rSum += val * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= val * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	// Apply OPL2 feedback to the waveform
	if ( fb > 0 ) {

		const fbAmount = Math.PI / Math.pow( 2, 8 - fb );
		const M = 1024;
		const waveform = new Float32Array( M );
		let prev1 = 0, prev2 = 0;

		for ( let cycle = 0; cycle < 3; cycle ++ ) {

			for ( let j = 0; j < M; j ++ ) {

				const phase = ( 2 * Math.PI * j ) / M;
				const fbPhase = phase + fbAmount * ( prev1 + prev2 ) * 0.5;
				let val;

				if ( waveType === 0 ) {

					val = Math.sin( fbPhase );

				} else if ( waveType === 1 ) {

					val = Math.sin( fbPhase );
					if ( val < 0 ) val = 0;

				} else if ( waveType === 2 ) {

					val = Math.abs( Math.sin( fbPhase ) );

				} else {

					const normPhase = ( ( fbPhase % ( 2 * Math.PI ) ) + 2 * Math.PI ) % ( 2 * Math.PI );
					val = ( normPhase < Math.PI / 2 ) ? Math.sin( normPhase ) : 0;

				}

				waveform[ j ] = val;
				prev2 = prev1;
				prev1 = val;

			}

		}

		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				rSum += waveform[ j ] * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= waveform[ j ] * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	const wave = _audioContext.createPeriodicWave( real, imag, { disableNormalization: false } );
	_oplWaveCache.set( cacheKey, wave );
	return wave;

}

function oplAttackRate( rate ) {

	if ( rate === 0 ) return 10.0;
	return 2.826 / Math.pow( 2, rate - 1 );

}

function oplDecayRate( rate ) {

	if ( rate === 0 ) return 30.0;
	return 39.28 / Math.pow( 2, rate - 1 );

}

function oplSustainLevel( sl ) {

	if ( sl === 0 ) return 1.0;
	if ( sl >= 15 ) return 0.00002;
	return Math.pow( 10, - 3.0 * sl / 20.0 );

}

function oplTotalLevel( tl ) {

	if ( tl === 0 ) return 1.0;
	if ( tl >= 63 ) return 0.005;
	return Math.pow( 10, - 0.75 * tl / 20.0 );

}

function oplMultiplier( mult ) {

	return OPL_MULTIPLIERS[ mult & 0x0f ];

}

function oplKeyScaleLevel( kslField, midiNote ) {

	if ( kslField === 0 ) return 1.0;

	const KSL_DB_PER_OCT = [ 0, 3.0, 1.5, 6.0 ];
	const dbPerOct = KSL_DB_PER_OCT[ kslField ];
	const octavesAboveC4 = ( midiNote - 60 ) / 12.0;
	if ( octavesAboveC4 <= 0 ) return 1.0;

	const attenuationDb = dbPerOct * octavesAboveC4;
	return Math.pow( 10, - attenuationDb / 20.0 );

}

function oplKeyScaleRate( ksrBit, midiNote ) {

	if ( ksrBit === 0 ) return 1.0;
	const octaves = Math.max( 0, ( midiNote - 36 ) / 12.0 );
	return Math.pow( 2, octaves * 0.5 );

}

const OPL_PATCHES = {};

OPL_PATCHES[ 0 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 25 ] = {
	mod: { mult: 3, tl: 20, ar: 15, dr: 3, sl: 9, rr: 10, wave: 1, fb: 6, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 14, rr: 7, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 29 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 38 ] = {
	mod: { mult: 1, tl: 11, ar: 15, dr: 4, sl: 14, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 7, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 39 ] = {
	mod: { mult: 1, tl: 18, ar: 15, dr: 1, sl: 2, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 1, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 80 ] = {
	mod: { mult: 2, tl: 25, ar: 15, dr: 15, sl: 0, rr: 3, wave: 2, fb: 0, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 15, sl: 0, rr: 15, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 90 ] = {
	mod: { mult: 1, tl: 23, ar: 9, dr: 1, sl: 3, rr: 4, wave: 0, fb: 6, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 },
	car: { mult: 1, tl: 0, ar: 5, dr: 5, sl: 1, rr: 6, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 94 ] = {
	mod: { mult: 1, tl: 9, ar: 1, dr: 1, sl: 3, rr: 3, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 3, ar: 4, dr: 2, sl: 2, rr: 5, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 95 ] = {
	mod: { mult: 1, tl: 21, ar: 1, dr: 1, sl: 4, rr: 7, wave: 1, fb: 0, eg: 1, ksl: 0, ksr: 0, am: 1, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 15, sl: 0, rr: 7, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 100 ] = {
	mod: { mult: 1, tl: 13, ar: 15, dr: 1, sl: 5, rr: 1, wave: 1, fb: 0, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 1 },
	car: { mult: 2, tl: 0, ar: 15, dr: 2, sl: 15, rr: 5, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 113 ] = {
	mod: { mult: 7, tl: 21, ar: 14, dr: 12, sl: 2, rr: 6, wave: 0, fb: 5, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 2, tl: 0, ar: 15, dr: 8, sl: 1, rr: 6, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 117 ] = {
	mod: { mult: 1, tl: 1, ar: 15, dr: 8, sl: 4, rr: 7, wave: 2, fb: 2, eg: 0, ksl: 1, ksr: 1, am: 0, vib: 0 },
	car: { mult: 0, tl: 3, ar: 15, dr: 3, sl: 0, rr: 3, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 118 ] = {
	mod: { mult: 1, tl: 14, ar: 15, dr: 1, sl: 0, rr: 6, wave: 2, fb: 7, eg: 0, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 0, tl: 0, ar: 15, dr: 3, sl: 0, rr: 2, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

const OPL_DEFAULT_PATCH = {
	mod: { mult: 1, tl: 20, ar: 12, dr: 4, sl: 4, rr: 8, wave: 0, fb: 3, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 4, sl: 2, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

function getOplPatch( program ) {

	if ( _bnkMelodicPatches !== null && program >= 0 && program < _bnkMelodicPatches.length ) {

		const bnkPatch = _bnkMelodicPatches[ program ];
		if ( bnkPatch !== undefined && bnkPatch !== null ) return bnkPatch;

	}

	if ( OPL_PATCHES[ program ] !== undefined ) return OPL_PATCHES[ program ];

	return OPL_DEFAULT_PATCH;

}

function readAscii( data, offset, length ) {

	let str = '';

	for ( let i = 0; i < length; i ++ ) {

		const b = data[ offset + i ];
		if ( b === 0 ) break;
		str += String.fromCharCode( b );

	}

	return str;

}

function parseOplBankFile( data ) {

	if ( data instanceof Uint8Array !== true || data.length < 0x1c ) return null;

	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );
	let headerBase = 2;
	let signature = readAscii( data, headerBase, 6 );

	if ( signature !== 'ADLIB-' ) {

		headerBase = 0;
		signature = readAscii( data, headerBase, 6 );

	}

	if ( signature !== 'ADLIB-' ) {

		console.warn( 'OPL: Invalid bank signature: ' + signature );
		return null;

	}

	// HMI keeps both the number of used entries and the number of stored
	// name/instrument slots.  Program and drum-note mapping is positional, so
	// validate and retain the complete stored table rather than accepting a
	// truncated prefix of it.
	const numUsedEntries = view.getUint16( headerBase + 6, true );
	const numEntries = view.getUint16( headerBase + 8, true );
	const namesOffset = view.getUint32( headerBase + 10, true );
	const dataOffset = view.getUint32( headerBase + 14, true );
	const headerEnd = headerBase + 18;
	const namesLength = numEntries * 12;
	const instrumentsLength = numEntries * 30;

	function rangeFits( offset, length ) {

		return offset >= headerEnd && offset <= data.length &&
			length <= data.length - offset;

	}

	if ( numUsedEntries === 0 || numEntries === 0 || numUsedEntries > numEntries ||
		rangeFits( namesOffset, namesLength ) !== true ||
		rangeFits( dataOffset, instrumentsLength ) !== true ) return null;

	const namesEnd = namesOffset + namesLength;
	const instrumentsEnd = dataOffset + instrumentsLength;
	if ( namesOffset < instrumentsEnd && dataOffset < namesEnd ) return null;

	const entries = [];

	for ( let i = 0; i < numEntries; i ++ ) {

		const off = namesOffset + i * 12;
		const instrumentIndex = view.getUint16( off, true );
		if ( instrumentIndex >= numEntries ) return null;

		entries.push( {
			instrumentIndex: instrumentIndex,
			tag: data[ off + 2 ],
			name: readAscii( data, off + 3, 9 )
		} );

	}

	const instruments = [];

	for ( let i = 0; i < numEntries; i ++ ) {

		const off = dataOffset + i * 30;
		instruments.push( data.slice( off, off + 30 ) );

	}

	return {
		entries: entries,
		instruments: instruments
	};

}

function bankInstrumentToPatch( raw ) {

	if ( raw === undefined || raw === null || raw.length < 30 ) return null;

	// Instrument record format (30 bytes):
	// [0] percussive, [1] voice num
	// [2..14] operator 1 (mod), [15..27] operator 2 (car), [28..29] waveform selects.
	return {
		mod: {
			wave: raw[ 28 ] & 0x03,
			mult: raw[ 3 ] & 0x0F,
			fb: raw[ 4 ] & 0x07,
			ar: raw[ 5 ] & 0x0F,
			sl: raw[ 6 ] & 0x0F,
			eg: raw[ 7 ] & 0x01,
			dr: raw[ 8 ] & 0x0F,
			rr: raw[ 9 ] & 0x0F,
			tl: raw[ 10 ] & 0x3F,
			am: raw[ 11 ] & 0x01,
			vib: raw[ 12 ] & 0x01,
			ksr: raw[ 13 ] & 0x01,
			ksl: raw[ 2 ] & 0x03,
			con: raw[ 14 ] & 0x01
		},
		car: {
			wave: raw[ 29 ] & 0x03,
			mult: raw[ 16 ] & 0x0F,
			ar: raw[ 18 ] & 0x0F,
			sl: raw[ 19 ] & 0x0F,
			eg: raw[ 20 ] & 0x01,
			dr: raw[ 21 ] & 0x0F,
			rr: raw[ 22 ] & 0x0F,
			tl: raw[ 23 ] & 0x3F,
			am: raw[ 24 ] & 0x01,
			vib: raw[ 25 ] & 0x01,
			ksr: raw[ 26 ] & 0x01,
			ksl: raw[ 15 ] & 0x03,
			con: raw[ 27 ] & 0x01
		}
	};

}

function postBanksToWorklet() {

	if ( _workletReady !== true || _workletNode === null || _banksLoaded !== true ) return;

	const drums = new Array( 128 ).fill( null );
	if ( _bnkDrumPatches !== null ) {

		for ( const [ note, patch ] of _bnkDrumPatches ) drums[ note ] = patch;

	}

	_workletNode.port.postMessage( {
		type: 'banks',
		melodic: _bnkMelodicPatches,
		drums: drums
	} );

}

function postMasterVolumeToWorklet() {

	if ( _workletReady !== true || _workletNode === null ) return;
	_workletNode.port.postMessage( { type: 'volume', value: _masterVolume } );

}

function midiToFreq( note ) {

	return 440.0 * Math.pow( 2, ( note - 69 ) / 12.0 );

}

function selectPatch( channel, note ) {

	const program = _channels[ channel ].program;

	if ( channel === 9 && _bnkDrumPatches !== null ) {

		return _bnkDrumPatches.get( note ) || null;

	}

	return getOplPatch( program );

}

function channelLevel( channel ) {

	return ( _channels[ channel ].volume / 127 ) *
		( _channels[ channel ].expression / 127 );

}

function channelPan( channel ) {

	const value = _channels[ channel ].pan;
	return value <= 64 ? ( value - 64 ) / 64 : ( value - 64 ) / 63;

}

function controllerVibratoDepth( channel, notePressure = 0 ) {

	const amount = Math.max(
		_channels[ channel ].modulation,
		_channels[ channel ].pressure,
		notePressure
	);
	return amount * CONTROLLER_VIBRATO_CENTS / 127;

}

function eventTime( time ) {

	const requestedTime = Number.isFinite( time ) ? Math.max( 0, time ) : 0;
	return _audioContext !== null
		? Math.max( _audioContext.currentTime, requestedTime )
		: requestedTime;

}

function midi7Bit( value ) {

	return Math.max( 0, Math.min( 127, value | 0 ) );

}

function ensureControllerVibrato( active, time ) {

	if ( active.controllerActive !== true || active.controllerVibLfo !== null || _audioContext === null ) return;

	const startTime = eventTime( time );
	if ( active.stopTime !== null && startTime >= active.stopTime ) return;

	const lfo = _audioContext.createOscillator();
	const carGain = _audioContext.createGain();
	const modGain = _audioContext.createGain();

	lfo.frequency.value = CONTROLLER_VIBRATO_HZ;
	lfo.type = 'sine';
	carGain.gain.setValueAtTime( 0, startTime );
	modGain.gain.setValueAtTime( 0, startTime );
	lfo.connect( carGain );
	lfo.connect( modGain );
	carGain.connect( active.carrier.detune );
	modGain.connect( active.modulator.detune );

	active.controllerVibLfo = lfo;
	active.controllerVibCarGain = carGain;
	active.controllerVibModGain = modGain;

	lfo.start( startTime );

	if ( active.stopTime !== null ) {

		lfo.stop( active.stopTime );

	}

}

function voiceAcceptsControllerAt( active, time ) {

	return active.controllerActive === true &&
		( active.stopTime === null || time < active.stopTime );

}

function updateChannelLevel( channel, time ) {

	const value = channelLevel( channel );
	const playTime = eventTime( time );

	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || voiceAcceptsControllerAt( active, playTime ) !== true ) continue;

		try {

			active.channelGain.gain.setValueAtTime( value, playTime );

		} catch ( e ) { /* voice may already have stopped */ }

	}

}

function updateChannelPan( channel, time ) {

	const value = channelPan( channel );
	const playTime = eventTime( time );

	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || voiceAcceptsControllerAt( active, playTime ) !== true || active.pan === null ) continue;

		try {

			active.pan.pan.setValueAtTime( value, playTime );

		} catch ( e ) { /* voice may already have stopped */ }

	}

}

function updateControllerVibrato( channel, time ) {

	const playTime = eventTime( time );

	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || voiceAcceptsControllerAt( active, playTime ) !== true ) continue;

		try {

			const depth = controllerVibratoDepth( channel, active.notePressure );
			if ( depth > 0 ) ensureControllerVibrato( active, playTime );
			if ( active.controllerVibLfo === null ) continue;

			active.controllerVibCarGain.gain.setValueAtTime( depth, playTime );
			active.controllerVibModGain.gain.setValueAtTime( depth, playTime );

		} catch ( e ) { /* voice may already have stopped */ }

	}

}

function updatePitchBend( channel, bendCents, time ) {

	const playTime = eventTime( time );

	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || voiceAcceptsControllerAt( active, playTime ) !== true ) continue;

		try {

			active.carrier.detune.setValueAtTime( bendCents, playTime );
			active.modulator.detune.setValueAtTime( bendCents, playTime );

		} catch ( e ) { /* oscillator may have stopped */ }

	}

}

function removeVoiceSlot( active ) {

	for ( let i = 0; i < _voiceSlots.length; i ++ ) {

		if ( _voiceSlots[ i ] === active ) {

			_voiceSlots.splice( i, 1 );
			return;

		}

	}

}

function linkActiveNote( key, active ) {

	const previous = _activeNoteTails.get( key );
	active.keyPrevious = previous === undefined ? null : previous;
	active.keyNext = null;
	active.keyLinked = true;

	if ( previous === undefined ) _activeNotes.set( key, active );
	else previous.keyNext = active;
	_activeNoteTails.set( key, active );

}

function unlinkActiveNote( key, active ) {

	if ( active.keyLinked !== true ) return;
	const previous = active.keyPrevious;
	const next = active.keyNext;

	if ( previous === null ) {

		if ( next === null ) _activeNotes.delete( key );
		else _activeNotes.set( key, next );

	} else {

		previous.keyNext = next;

	}

	if ( next === null ) {

		if ( previous === null ) _activeNoteTails.delete( key );
		else _activeNoteTails.set( key, previous );

	} else {

		next.keyPrevious = previous;

	}

	active.keyPrevious = null;
	active.keyNext = null;
	active.keyLinked = false;

}

function hardStopActiveNote( key, active, time ) {

	const playTime = eventTime( time );
	const stopTime = playTime + 0.005;
	active.keyHeld = false;
	active.sustained = false;
	active.controllerActive = false;
	active.stopTime = stopTime;

	try {

		active.noteGain.gain.cancelAndHoldAtTime( playTime );
		active.noteGain.gain.linearRampToValueAtTime( 0, playTime + 0.003 );
		active.modGain.gain.cancelAndHoldAtTime( playTime );
		active.modGain.gain.linearRampToValueAtTime( 0.0001, playTime + 0.003 );

		if ( active.modOutputGain ) {

			active.modOutputGain.gain.cancelAndHoldAtTime( playTime );
			active.modOutputGain.gain.linearRampToValueAtTime( 0, playTime + 0.003 );

		}

		active.carrier.stop( stopTime );
		active.modulator.stop( stopTime );

		if ( active.vibLfo ) active.vibLfo.stop( stopTime );
		if ( active.controllerVibLfo ) active.controllerVibLfo.stop( stopTime );
		if ( active.amLfo ) active.amLfo.stop( stopTime );

	} catch ( e ) { /* already stopped */ }

	unlinkActiveNote( key, active );
	removeVoiceSlot( active );

}

function cleanupActiveNote( key, active ) {

	// A non-sustaining OPL envelope can become inaudible before its matching
	// MIDI Note Off.  Keep that silent note in the FIFO so the Note Off still
	// consumes the correct layered Note On instead of releasing a later voice.
	if ( active.keyHeld !== true ) unlinkActiveNote( key, active );
	active.controllerActive = false;
	removeVoiceSlot( active );
	_scheduledVoices.delete( active );

}

function scheduleNoteOn( channel, note, velocity, time ) {

	if ( _audioContext === null || _outputNode === null ) return;
	const opl = selectPatch( channel, note );
	if ( opl === null ) return;

	const key = channel + '-' + note;
	if ( _voiceSlots.length >= OPL2_NUM_VOICES ) {

		const oldest = _voiceSlots.shift();

		if ( oldest !== undefined ) {

			hardStopActiveNote( oldest.key, oldest, time );

		}

	}

	const playbackNote = ( channel === 9 && Number.isInteger( opl.percussionNote ) )
		? opl.percussionNote
		: note;
	const freq = midiToFreq( playbackNote );
	const vel = velocity / 127;

	const modFreq = freq * oplMultiplier( opl.mod.mult );
	const carFreq = freq * oplMultiplier( opl.car.mult );
	const algorithmAdditive = ( opl.mod.con === 1 );

	const modKSL = oplKeyScaleLevel( opl.mod.ksl, playbackNote );
	const modDepthScale = oplTotalLevel( opl.mod.tl ) * modKSL;
	const peakMod = modDepthScale * carFreq * 8.0;

	const carKSL = oplKeyScaleLevel( opl.car.ksl, playbackNote );
	const carLevel = oplTotalLevel( opl.car.tl ) * carKSL;

	const velSq = vel * vel;
	const levelScale = velSq;

	const modKSR = oplKeyScaleRate( opl.mod.ksr, playbackNote );
	const carKSR = oplKeyScaleRate( opl.car.ksr, playbackNote );

	const modAR = oplAttackRate( opl.mod.ar ) / modKSR;
	const modDR = oplDecayRate( opl.mod.dr ) / modKSR;
	const modSL = oplSustainLevel( opl.mod.sl );
	const modRR = oplDecayRate( opl.mod.rr ) / modKSR;
	const carAR = oplAttackRate( opl.car.ar ) / carKSR;
	const carDR = oplDecayRate( opl.car.dr ) / carKSR;
	const carSL = oplSustainLevel( opl.car.sl );
	const carRR = oplDecayRate( opl.car.rr ) / carKSR;

	const modSustaining = opl.mod.eg === 1;
	const carSustaining = opl.car.eg === 1;

	const modulator = _audioContext.createOscillator();
	const modWave = getOplWaveform( opl.mod.wave, opl.mod.fb );

	if ( modWave !== null ) {

		modulator.setPeriodicWave( modWave );

	} else {

		modulator.type = 'sine';

	}

	modulator.frequency.value = modFreq;

	const modGain = _audioContext.createGain();
	modGain.gain.setValueAtTime( 0, time );

	if ( algorithmAdditive === true ) {

		const modVol = levelScale * modDepthScale * 0.18;
		const modSustainVal = modSustaining === true ? Math.max( modVol * modSL, 0.0001 ) : 0.0001;
		modGain.gain.setTargetAtTime( modVol, time, modAR / 3 );
		modGain.gain.setTargetAtTime( modSustainVal, time + modAR, modDR / 3 );

		if ( modSustaining !== true ) {

			modGain.gain.setTargetAtTime( 0.0001, time + modAR + modDR, modRR / 3 );

		}

	} else if ( peakMod > 0.1 ) {

		const modSustainVal = modSustaining === true ? Math.max( peakMod * modSL, 0.0001 ) : 0.0001;
		modGain.gain.setTargetAtTime( peakMod, time, modAR / 3 );
		modGain.gain.setTargetAtTime( modSustainVal, time + modAR, modDR / 3 );

		if ( modSustaining !== true ) {

			modGain.gain.setTargetAtTime( 0.0001, time + modAR + modDR, modRR / 3 );

		}

	}

	modulator.connect( modGain );
	let modOutputGain = null;

	const carrier = _audioContext.createOscillator();
	const carWave = getOplWaveform( opl.car.wave, 0 );

	if ( carWave !== null ) {

		carrier.setPeriodicWave( carWave );

	} else {

		carrier.type = 'sine';

	}

	carrier.frequency.value = carFreq;

	if ( algorithmAdditive === true ) {

		modOutputGain = _audioContext.createGain();
		modOutputGain.gain.setValueAtTime( 1.0, time );
		modGain.connect( modOutputGain );

	} else {

		modGain.connect( carrier.frequency );

	}

	if ( _channels[ channel ].pitchBend !== 0 ) {

		carrier.detune.setValueAtTime( _channels[ channel ].pitchBend, time );
		modulator.detune.setValueAtTime( _channels[ channel ].pitchBend, time );

	}

	const noteGain = _audioContext.createGain();
	// Keep MIDI channel level outside the operator envelope.  Controller ramps
	// can then affect held/releasing notes without replacing their ADSR events.
	const controllerGain = _audioContext.createGain();

	const vol = levelScale * carLevel * 0.18;

	const carSustainVal = carSustaining === true ? Math.max( vol * carSL, 0.0001 ) : 0.0001;

	noteGain.gain.setValueAtTime( 0, time );
	noteGain.gain.setTargetAtTime( vol, time, carAR / 3 );
	noteGain.gain.setTargetAtTime( carSustainVal, time + carAR, carDR / 3 );

	if ( carSustaining !== true ) {

		noteGain.gain.setTargetAtTime( 0.0001, time + carAR + carDR, carRR / 3 );

	}

	let vibLfo = null;

	if ( opl.car.vib === 1 || opl.mod.vib === 1 ) {

		vibLfo = _audioContext.createOscillator();
		vibLfo.frequency.value = 6.1;
		vibLfo.type = 'sine';

		if ( opl.car.vib === 1 ) {

			const vibCarGain = _audioContext.createGain();
			vibCarGain.gain.value = 7.0;
			vibLfo.connect( vibCarGain );
			vibCarGain.connect( carrier.detune );

		}

		if ( opl.mod.vib === 1 ) {

			const vibModGain = _audioContext.createGain();
			vibModGain.gain.value = 7.0;
			vibLfo.connect( vibModGain );
			vibModGain.connect( modulator.detune );

		}

		vibLfo.start( time );

	}

	let amLfo = null;
	let amGain = null;

	if ( opl.car.am === 1 ) {

		amLfo = _audioContext.createOscillator();
		amLfo.frequency.value = 3.7;
		amLfo.type = 'sine';

		amGain = _audioContext.createGain();
		amGain.gain.value = 1.0;

		const amDepthNode = _audioContext.createGain();
		amDepthNode.gain.value = 0.06;
		amLfo.connect( amDepthNode );
		amDepthNode.connect( amGain.gain );

		amLfo.start( time );

		carrier.connect( amGain );
		amGain.connect( noteGain );

	} else {

		carrier.connect( noteGain );

	}

	if ( algorithmAdditive === true && modOutputGain ) {

		modOutputGain.connect( noteGain );

	}

	controllerGain.gain.setValueAtTime( channelLevel( channel ), time );
	noteGain.connect( controllerGain );

	const panValue = channelPan( channel );
	let panNode = null;

	if ( typeof _audioContext.createStereoPanner === 'function' ) {

		panNode = _audioContext.createStereoPanner();
		panNode.pan.setValueAtTime( panValue, time );
		controllerGain.connect( panNode );
		panNode.connect( _outputNode );

	} else {

		controllerGain.connect( _outputNode );

	}

	carrier.start( time );
	modulator.start( time );

	const shouldAutoStop = ( carSustaining !== true ) && ( algorithmAdditive !== true || modSustaining !== true );
	let stopTime = null;

	if ( shouldAutoStop === true ) {

		const carTail = carAR + carDR + carRR + 1.0;
		const modTail = modAR + modDR + modRR + 1.0;
		stopTime = time + Math.max( carTail, modTail );
		carrier.stop( stopTime );
		modulator.stop( stopTime );

		if ( vibLfo ) vibLfo.stop( stopTime );
		if ( amLfo ) amLfo.stop( stopTime );

	}

	const noteState = {
		key: key,
		channel: channel,
		note: note,
		keyHeld: true,
		sustained: false,
		notePressure: _channels[ channel ].notePressure[ note ],
		startTime: time,
		carrier: carrier,
		modulator: modulator,
		noteGain: noteGain,
		channelGain: controllerGain,
		modGain: modGain,
		modOutputGain: modOutputGain,
		pan: panNode,
		carRR: carRR,
		modRR: modRR,
		vibLfo: vibLfo,
		controllerVibLfo: null,
		controllerVibCarGain: null,
		controllerVibModGain: null,
		controllerActive: true,
		stopTime: stopTime,
		amLfo: amLfo,
		keyPrevious: null,
		keyNext: null,
		keyLinked: false
	};

	const initialControllerVibrato = controllerVibratoDepth(
		channel, noteState.notePressure
	);
	if ( initialControllerVibrato > 0 ) {

		const playTime = eventTime( time );
		ensureControllerVibrato( noteState, playTime );
		if ( noteState.controllerVibLfo !== null ) {

			noteState.controllerVibCarGain.gain.setValueAtTime( initialControllerVibrato, playTime );
			noteState.controllerVibModGain.gain.setValueAtTime( initialControllerVibrato, playTime );

		}

	}

	carrier.onended = () => {

		cleanupActiveNote( key, noteState );

	};

	linkActiveNote( key, noteState );
	_scheduledVoices.add( noteState );
	_voiceSlots.push( noteState );

}

function releaseActiveNote( active, time ) {

	active.keyHeld = false;
	active.sustained = false;
	const carRelease = active.carRR;
	const modRelease = active.modRR;
	const maxRelease = Math.max( carRelease, modRelease );
	const playTime = eventTime( time );
	const stopTime = playTime + maxRelease + 0.1;
	active.stopTime = stopTime;

	try {

		active.noteGain.gain.cancelAndHoldAtTime( playTime );
		active.noteGain.gain.setTargetAtTime( 0.0001, playTime, carRelease / 3 );

		active.modGain.gain.cancelAndHoldAtTime( playTime );
		active.modGain.gain.setTargetAtTime( 0.0001, playTime, modRelease / 3 );

		if ( active.modOutputGain ) {

			active.modOutputGain.gain.cancelAndHoldAtTime( playTime );
			active.modOutputGain.gain.setTargetAtTime( 0.0001, playTime, modRelease / 3 );

		}

		active.carrier.stop( stopTime );
		active.modulator.stop( stopTime );
		if ( active.vibLfo ) active.vibLfo.stop( stopTime );
		if ( active.controllerVibLfo ) active.controllerVibLfo.stop( stopTime );
		if ( active.amLfo ) active.amLfo.stop( stopTime );

	} catch ( e ) { /* already stopped */ }

}

function scheduleNoteOff( channel, note, time ) {

	const key = channel + '-' + note;
	const active = _activeNotes.get( key );

	if ( active === undefined ) return;
	active.keyHeld = false;
	unlinkActiveNote( key, active );

	if ( _channels[ channel ].sustain === true ) {

		active.sustained = true;
		return;

	}

	releaseActiveNote( active, time );

}

function releaseSustainedNotes( channel, time ) {

	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || active.sustained !== true ||
			active.controllerActive !== true ) continue;
		active.sustained = false;
		releaseActiveNote( active, time );

	}

}

function stopChannelSounds( channel, time ) {

	// MIDI All Sound Off must also retire release tails, which no longer have
	// a unique current-key owner but are still present in the scheduled set.
	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || active.controllerActive !== true ) continue;
		hardStopActiveNote( active.key, active, time );

	}

	// Natural envelope completion removes a voice from _scheduledVoices but
	// deliberately retains its logical Note On until the matching Note Off.
	// All Sound Off must retire those silent FIFO owners too.
	for ( let note = 0; note < 128; note ++ ) {

		const key = channel + '-' + note;
		let active = _activeNotes.get( key );
		while ( active !== undefined ) {

			hardStopActiveNote( key, active, time );
			active = _activeNotes.get( key );

		}

	}

}

function releaseChannelNotes( channel, time ) {

	// MIDI All Notes Off is equivalent to a note-off for every held key.  Keep
	// the instrument release envelopes intact rather than hard-stopping them.
	for ( let note = 0; note < 128; note ++ ) {

		const key = channel + '-' + note;
		while ( _activeNotes.has( key ) ) scheduleNoteOff( channel, note, time );

	}

}

function handleControlChange( channel, controller, value, playTime ) {

	value = midi7Bit( value );

	switch ( controller ) {

		case 1:
			_channels[ channel ].modulation = value;
			updateControllerVibrato( channel, playTime );
			break;

		case 7:
			_channels[ channel ].volume = value;
			updateChannelLevel( channel, playTime );
			break;

		case 10:
			_channels[ channel ].pan = value;
			updateChannelPan( channel, playTime );
			break;

		case 11:
			_channels[ channel ].expression = value;
			updateChannelLevel( channel, playTime );
			break;

		case 64: {
			const sustain = value >= 64;
			_channels[ channel ].sustain = sustain;
			if ( sustain !== true ) releaseSustainedNotes( channel, playTime );
			break;
		}

		case 120:
			stopChannelSounds( channel, playTime );
			break;

		case 123:
			releaseChannelNotes( channel, playTime );
			break;

		case 121:
			_channels[ channel ].sustain = false;
			releaseSustainedNotes( channel, playTime );
			_channels[ channel ].expression = 127;
			_channels[ channel ].modulation = 0;
			_channels[ channel ].pressure = 0;
			_channels[ channel ].notePressure.fill( 0 );
			_channels[ channel ].pitchBend = 0;
			for ( const active of _scheduledVoices ) {

				if ( active.channel === channel ) active.notePressure = 0;

			}
			updateChannelLevel( channel, playTime );
			updateControllerVibrato( channel, playTime );
			updatePitchBend( channel, 0, playTime );
			break;

	}

}

function handlePolyphonicPressure( channel, note, value, playTime ) {

	note = midi7Bit( note );
	value = midi7Bit( value );
	_channels[ channel ].notePressure[ note ] = value;

	const effectiveTime = eventTime( playTime );
	for ( const active of _scheduledVoices ) {

		if ( active.channel !== channel || active.note !== note ||
			voiceAcceptsControllerAt( active, effectiveTime ) !== true ) continue;

		active.notePressure = value;
		try {

			const depth = controllerVibratoDepth( channel, value );
			if ( depth > 0 ) ensureControllerVibrato( active, effectiveTime );
			if ( active.controllerVibLfo === null ) continue;
			active.controllerVibCarGain.gain.setValueAtTime( depth, effectiveTime );
			active.controllerVibModGain.gain.setValueAtTime( depth, effectiveTime );

		} catch ( e ) { /* voice may already have stopped */ }

	}

}

function handleChannelPressure( channel, value, playTime ) {

	_channels[ channel ].pressure = midi7Bit( value );
	updateControllerVibrato( channel, playTime );

}

function handlePitchBend( channel, data1, data2, playTime ) {

	const bendValue = ( ( data2 << 7 ) | data1 ) - 8192;
	const bendCents = ( bendValue / 8192 ) * 200;
	_channels[ channel ].pitchBend = bendCents;
	updatePitchBend( channel, bendCents, playTime );

}

export async function opl_set_audio_graph( audioContext, outputNode, enableWorklet = true ) {

	if ( _workletNode !== null ) {

		try {

			_workletNode.disconnect();

		} catch ( e ) { /* already disconnected */ }

		_workletNode = null;
		_workletReady = false;

	}

	if ( _audioContext !== audioContext ) {

		_oplWaveCache.clear();

	}

	_audioContext = audioContext;
	_outputNode = outputNode;

	if ( enableWorklet !== true || audioContext === null || outputNode === null ||
		audioContext.audioWorklet === undefined ||
		typeof audioContext.audioWorklet.addModule !== 'function' ||
		typeof AudioWorkletNode !== 'function' ) return false;

	let node = null;

	try {

		await audioContext.audioWorklet.addModule( new URL( './opl_worklet.js', import.meta.url ) );
		node = new AudioWorkletNode( audioContext, 'descent-opl3', {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [ 2 ]
		} );
		node.connect( outputNode );
		_workletNode = node;
		_workletReady = true;
		postBanksToWorklet();
		postMasterVolumeToWorklet();
		console.log( 'OPL: Pure JavaScript OPL3 AudioWorklet ready' );
		return true;

	} catch ( error ) {

		if ( node !== null ) {

			try {

				node.disconnect();

			} catch ( e ) { /* never connected or already disconnected */ }

		}

		console.warn( 'OPL: AudioWorklet unavailable; using Web Audio fallback:', error );
		_workletNode = null;
		_workletReady = false;
		return false;

	}

}

export function opl_set_master_volume( volume ) {

	if ( Number.isFinite( volume ) !== true ) return false;
	_masterVolume = Math.max( 0, Math.min( 127, Math.trunc( volume ) ) );
	postMasterVolumeToWorklet();
	return true;

}

export function opl_init( hogFile, melodicBankName = 'melodic.bnk', drumBankName = 'drum.bnk' ) {

	ensureChannelsInitialized();
	opl_reset_channels();

	const melodicName = String( melodicBankName || 'melodic.bnk' ).toLowerCase();
	const drumName = String( drumBankName || 'drum.bnk' ).toLowerCase();

	if ( _bankHogFile === hogFile && _loadedMelodicBank === melodicName &&
		_loadedDrumBank === drumName ) {

		postBanksToWorklet();
		return _banksLoaded;

	}

	_bnkMelodicPatches = null;
	_bnkDrumPatches = null;
	_bankHogFile = hogFile;
	_loadedMelodicBank = melodicName;
	_loadedDrumBank = drumName;
	_banksLoaded = false;

	if ( hogFile === null || hogFile === undefined ) return false;

	const melodicFile = hogFile.findFile( melodicName );
	let melodicLoaded = false;

	if ( melodicFile !== null ) {

		const melodicData = melodicFile.readBytes( melodicFile.length() );
		const melodicBank = parseOplBankFile( melodicData );

		if ( melodicBank !== null ) {

			const melodicTable = new Array( 128 );
			let melodicCount = 0;

			for ( let program = 0; program < melodicBank.entries.length && program < 128; program ++ ) {

				const entry = melodicBank.entries[ program ];
				if ( entry.instrumentIndex >= melodicBank.instruments.length ) continue;

				const patch = bankInstrumentToPatch( melodicBank.instruments[ entry.instrumentIndex ] );
				if ( patch === null ) continue;

				melodicTable[ program ] = patch;
				melodicCount ++;

			}

			_bnkMelodicPatches = melodicTable;
			melodicLoaded = melodicCount > 0;
			console.log( 'OPL: Loaded ' + melodicName + ' (' + melodicCount + ' program patches)' );

		}

	}

	const drumFile = hogFile.findFile( drumName );
	let drumLoaded = false;

	if ( drumFile !== null ) {

		const drumData = drumFile.readBytes( drumFile.length() );
		const drumBank = parseOplBankFile( drumData );

		if ( drumBank !== null ) {

			const drumMap = new Map();

			// In the AdLib drum bank a name record's POSITION is the MIDI note it
			// services — i.e. the General MIDI percussion key map (Kick@36, Snare@38,
			// closed hat@42, open hat@46, crash@49, ride@51, cowbell@56, ...), exactly
			// as the melodic bank's position is its program number.  HMI stores the
			// percussion instrument's fixed playback note in entry.tag; select the
			// patch by incoming key, but tune it to that fixed note.  Skip silent
			// 'Blank.in' slots so unused percussion keys remain silent.
			for ( let note = 0; note < drumBank.entries.length && note < 128; note ++ ) {

				const entry = drumBank.entries[ note ];
				if ( entry.name === 'Blank.in' ) continue;
				if ( entry.instrumentIndex >= drumBank.instruments.length ) continue;

				const patch = bankInstrumentToPatch( drumBank.instruments[ entry.instrumentIndex ] );
				if ( patch === null ) continue;
				patch.percussionNote = entry.tag;
				drumMap.set( note, patch );

			}

			_bnkDrumPatches = drumMap;
			drumLoaded = drumMap.size > 0;
			console.log( 'OPL: Loaded ' + drumName + ' (' + drumMap.size + ' drum-note patches)' );

		}

	}

	_banksLoaded = melodicLoaded && drumLoaded;
	postBanksToWorklet();
	return _banksLoaded;

}

export function opl_reset_channels() {

	ensureChannelsInitialized();

	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels[ i ].program = 0;
		_channels[ i ].volume = 100;
		_channels[ i ].pan = 64;
		_channels[ i ].expression = 127;
		_channels[ i ].sustain = false;
		_channels[ i ].modulation = 0;
		_channels[ i ].pressure = 0;
		_channels[ i ].notePressure.fill( 0 );
		_channels[ i ].pitchBend = 0;

	}

	if ( _workletReady === true && _workletNode !== null ) {

		_workletNode.port.postMessage( { type: 'reset' } );

	}

}

export function opl_process_midi_event( ev, playTime ) {

	ensureChannelsInitialized();

	const ch = ev.channel;

	if ( _workletReady === true && _workletNode !== null && _audioContext !== null ) {

		const eventTime = Number.isFinite( playTime ) ? playTime : _audioContext.currentTime;
		_workletNode.port.postMessage( {
			type: 'event',
			frame: Math.max( 0, Math.round( eventTime * _audioContext.sampleRate ) ),
			midiType: ev.type,
			channel: ch,
			data1: ev.data1,
			data2: ev.data2
		} );
		return;

	}

	switch ( ev.type ) {

		case 0x8:
			scheduleNoteOff( ch, ev.data1, playTime );
			break;

		case 0x9:
			if ( ev.data2 === 0 ) {

				scheduleNoteOff( ch, ev.data1, playTime );

			} else {

				scheduleNoteOn( ch, ev.data1, ev.data2, playTime );

			}
			break;

		case 0xA:
			handlePolyphonicPressure( ch, ev.data1, ev.data2, playTime );
			break;

		case 0xB:
			handleControlChange( ch, ev.data1, ev.data2, playTime );
			break;

		case 0xC:
			_channels[ ch ].program = ev.data1;
			break;

		case 0xD:
			handleChannelPressure( ch, ev.data1, playTime );
			break;

		case 0xE:
			handlePitchBend( ch, ev.data1, ev.data2, playTime );
			break;

	}

}

export function opl_stop_all_notes() {

	if ( _workletReady === true && _workletNode !== null ) {

		_workletNode.port.postMessage( { type: 'reset' } );

	}

	if ( _audioContext === null ) return;

	const now = _audioContext.currentTime;

	for ( const active of _scheduledVoices ) {

		try {

			active.noteGain.gain.cancelScheduledValues( now );
			active.noteGain.gain.setValueAtTime( 0, now );
			active.modGain.gain.cancelScheduledValues( now );
			active.modGain.gain.setValueAtTime( 0, now );
			if ( active.modOutputGain ) {

				active.modOutputGain.gain.cancelScheduledValues( now );
				active.modOutputGain.gain.setValueAtTime( 0, now );

			}
			active.carrier.stop( now + 0.01 );
			active.modulator.stop( now + 0.01 );
			if ( active.vibLfo ) active.vibLfo.stop( now + 0.01 );
			if ( active.controllerVibLfo ) active.controllerVibLfo.stop( now + 0.01 );
			if ( active.amLfo ) active.amLfo.stop( now + 0.01 );

		} catch ( e ) { /* already stopped */ }

		unlinkActiveNote( active.key, active );

	}

	for ( let channel = 0; channel < NUM_CHANNELS; channel ++ ) {

		for ( let note = 0; note < 128; note ++ ) {

			const key = channel + '-' + note;
			let active = _activeNotes.get( key );
			while ( active !== undefined ) {

				unlinkActiveNote( key, active );
				active.keyHeld = false;
				active.sustained = false;
				active.controllerActive = false;
				active = _activeNotes.get( key );

			}

		}

	}

	_activeNotes.clear();
	_activeNoteTails.clear();
	_scheduledVoices.clear();
	_voiceSlots.length = 0;

}
