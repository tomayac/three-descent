// Ported from: descent-master/MAIN/SONGS.C
// Song/music selection and playback orchestration for HMP tracks.

import { hmp_parse, hmp_get_events, hmp_get_duration } from './hmp.js';
import {
	opl_init,
	opl_set_audio_graph,
	opl_set_master_volume,
	opl_reset_channels,
	opl_process_midi_event,
	opl_stop_all_notes
} from './opl_synth.js';

// Song constants (from SONGS.H)
export const SONG_TITLE = 0;
export const SONG_BRIEFING = 1;
export const SONG_ENDLEVEL = 2;
export const SONG_ENDGAME = 3;
export const SONG_CREDITS = 4;
export const SONG_LEVEL_MUSIC = 5;

const MAX_SONGS = 27;
const REGISTERED_GAME_SONGS = 22;
const DEFAULT_MELODIC_BANK = 'melodic.bnk';
const DEFAULT_DRUM_BANK = 'drum.bnk';

// SONGS.H defines 22 level songs for registered Descent.  Shareware has five;
// this live binding is selected from descent.sng when that table is available.
export let NUM_GAME_SONGS = 5;

// Shareware song file mapping
const SHAREWARE_SONG_FILENAMES = [
	'descent.hmp', 'briefing.hmp', null, 'endgame.hmp', 'credits.hmp',
	'game0.hmp', 'game1.hmp', 'game2.hmp', 'game3.hmp', 'game4.hmp',
	'game0.hmp', 'game1.hmp'
];

const SHAREWARE_SONGS = SHAREWARE_SONG_FILENAMES.map( filename => ( {
	filename: filename,
	melodicBank: DEFAULT_MELODIC_BANK,
	drumBank: DEFAULT_DRUM_BANK
} ) );

// External references
let _hogFile = null;
let _songs = SHAREWARE_SONGS;

// Playback state
let _audioContext = null;
let _masterGain = null;
let _compressor = null;
let _currentSong = - 1;
let _playing = false;
let _looping = false;
let _events = null;
let _eventIndex = 0;
let _startTime = 0;
let _scheduleTimer = null;
let _songDuration = 0;
let _playbackEndTime = 0;
let _playbackEndIndex = 0;
let _loopStartTime = 0;
let _loopStartEventIndex = 0;
let _loopDuration = 0;
let _nextSectionEndTime = 0;
let _hasLoopMarkers = false;
let _paused = false;
let _volume = 1.0;
let _usingWorklet = false;
let _lastRequestedSong = - 1;
let _restartSongWhenAudible = false;

function hmiMasterVolume() {

	return Math.min( 127, Math.trunc( _volume * 128 ) );

}

function effectiveOutputGain() {

	if ( _paused === true || _volume === 0 ) return 0;
	// The OPL3 worklet applies HMI's nonlinear master-volume curve inside the
	// synth.  The fallback has no chip-level volume model, so scale it here.
	return _usingWorklet === true ? 1 : _volume;

}

export function songs_init( hogFile ) {

	_hogFile = hogFile;
	_songs = SHAREWARE_SONGS;
	NUM_GAME_SONGS = 5;

	const songFile = hogFile.findFile( 'descent.sng' );
	if ( songFile !== null ) {

		const parsedSongs = parseSongTable( songFile );
		if ( parsedSongs.length > SONG_LEVEL_MUSIC ) {

			_songs = parsedSongs;
			NUM_GAME_SONGS = Math.min( REGISTERED_GAME_SONGS,
				parsedSongs.length - SONG_LEVEL_MUSIC );

		}

	}

	const initialSong = _songs[ SONG_TITLE ];
	opl_init( hogFile,
		initialSong?.melodicBank || DEFAULT_MELODIC_BANK,
		initialSong?.drumBank || DEFAULT_DRUM_BANK );
	console.log( 'SONGS: Music system initialized' );

}

function parseSongTable( file ) {

	const bytes = file.readBytes( file.length() );
	let byteLength = bytes.length;
	for ( let i = 0; i < bytes.length; i ++ ) {

		if ( bytes[ i ] === 0x1a ) {

			byteLength = i;
			break;

		}

	}

	let text = '';
	for ( let i = 0; i < byteLength; i ++ ) text += String.fromCharCode( bytes[ i ] );

	const songs = [];
	const lines = text.split( /\r\n?|\n/ );

	for ( let i = 0; i < lines.length && songs.length < MAX_SONGS; i ++ ) {

		const line = lines[ i ].trim();
		if ( line.length === 0 ) continue;

		const fields = line.split( /\s+/ );
		if ( fields.length < 3 || fields[ 0 ].length === 0 ) {

			console.warn( 'SONGS: Invalid descent.sng row ' + ( i + 1 ) );
			return [];

		}

		songs.push( {
			filename: fields[ 0 ],
			melodicBank: fields[ 1 ],
			drumBank: fields[ 2 ]
		} );

	}

	// Descent 1.5's 422-byte table is truncated after twelve rows.  DXX repairs
	// the missing registered level entries as game08.hmp through game22.hmp.
	if ( songs.length === 12 && file.length() === 422 ) {

		const repairMelodicBank = songs[ 11 ].melodicBank;
		const repairDrumBank = songs[ 11 ].drumBank;

		for ( let i = 12; i < MAX_SONGS; i ++ ) {

			const number = i - 4;
			songs.push( {
				filename: 'game' + ( number < 10 ? '0' : '' ) + number + '.hmp',
				melodicBank: repairMelodicBank,
				drumBank: repairDrumBank
			} );

		}

	}

	return songs;

}

// Set shared AudioContext from digi.js (avoids multiple contexts)
export async function songs_set_audio_context( ctx, masterGainNode ) {

	_audioContext = ctx;
	_usingWorklet = false;

	// Compressor prevents clipping with many simultaneous FM voices
	_compressor = ctx.createDynamicsCompressor();
	_compressor.threshold.value = - 12;
	_compressor.knee.value = 6;
	_compressor.ratio.value = 4;
	_compressor.attack.value = 0.003;
	_compressor.release.value = 0.1;

	// Chain: synth output -> _masterGain -> _compressor -> masterGainNode
	_masterGain = ctx.createGain();
	_masterGain.gain.value = effectiveOutputGain();
	_masterGain.connect( _compressor );
	_compressor.connect( masterGainNode );

	_usingWorklet = await opl_set_audio_graph( ctx, _masterGain );
	_masterGain.gain.value = effectiveOutputGain();

}

function ensureAudioContext() {

	if ( _audioContext !== null ) return true;

	try {

		_audioContext = new ( window.AudioContext || window.webkitAudioContext )();
		_usingWorklet = false;

		_compressor = _audioContext.createDynamicsCompressor();
		_compressor.threshold.value = - 12;
		_compressor.knee.value = 6;
		_compressor.ratio.value = 4;
		_compressor.attack.value = 0.003;
		_compressor.release.value = 0.1;

		_masterGain = _audioContext.createGain();
		_masterGain.gain.value = effectiveOutputGain();
		_masterGain.connect( _compressor );
		_compressor.connect( _audioContext.destination );

		// This path exists only when the digital-audio subsystem did not provide
		// its shared context.  Keep it wholly on the synchronous fallback backend;
		// switching an already-scheduled song to a late worklet would split voices
		// between two synthesizers.
		void opl_set_audio_graph( _audioContext, _masterGain, false );

		return true;

	} catch ( e ) {

		console.warn( 'SONGS: Could not create AudioContext:', e );
		return false;

	}

}

function findFirstEventAfter( time ) {

	if ( _events === null ) return 0;

	for ( let i = 0; i < _events.length; i ++ ) {

		if ( _events[ i ].time > time ) return i;

	}

	return _events.length;

}

function configureSongTiming( parsedDuration ) {

	_songDuration = Math.max(
		_events[ _events.length - 1 ].time,
		Number.isFinite( parsedDuration ) ? parsedDuration : 0
	);

	if ( _songDuration <= 0 ) {

		_songDuration = 0.01;

	}

	_hasLoopMarkers = false;
	_loopStartTime = 0;
	_loopStartEventIndex = 0;
	_loopDuration = _songDuration;
	_playbackEndTime = _songDuration;
	_playbackEndIndex = _events.length;

	let markerStart = - 1;
	let markerStartEventIndex = - 1;
	let markerEnd = - 1;

	for ( let i = 0; i < _events.length; i ++ ) {

		const ev = _events[ i ];
		if ( ev.type !== 0xB ) continue;

		if ( markerStart < 0 && ev.data1 === 110 ) {

			markerStart = ev.time;
			markerStartEventIndex = i;

		} else if ( markerStart >= 0 && ev.data1 === 111 && ev.time >= markerStart ) {

			markerEnd = ev.time;
			break;

		}

	}

	if ( markerStart >= 0 && markerEnd > markerStart ) {

		_hasLoopMarkers = true;
		_loopStartTime = markerStart;
		_loopStartEventIndex = markerStartEventIndex;
		_playbackEndTime = markerEnd;
		_playbackEndIndex = findFirstEventAfter( _playbackEndTime );
		_loopDuration = _playbackEndTime - _loopStartTime;

	}

}

export function songs_play_song( songnum, loop ) {

	if ( _hogFile === null ) return;
	if ( Number.isInteger( songnum ) !== true || songnum < 0 || songnum >= _songs.length ) {

		console.warn( 'SONGS: Invalid song number ' + songnum );
		return;

	}

	const song = _songs[ songnum ];
	const filename = song?.filename || null;
	const file = filename !== null ? _hogFile.findFile( filename ) : null;

	// DXX preserves the current level track when the optional end-level song is
	// absent.  Shareware intentionally has no end-level HMP.
	if ( songnum === SONG_ENDLEVEL && _currentSong >= SONG_LEVEL_MUSIC && file === null ) {

		console.log( 'SONGS: End-level music unavailable; keeping current level song' );
		return;

	}

	songs_stop();

	if ( filename === null ) {

		console.log( 'SONGS: No music file for song ' + songnum );
		return;

	}

	// DIGI.C remembers every non-null MIDI request before opening or loading it.
	// If music is disabled, restoring the volume later retries this song and
	// forces looping, matching digi_set_midi_volume().
	_lastRequestedSong = songnum;
	_restartSongWhenAudible = true;

	if ( file === null ) {

		console.warn( 'SONGS: ' + filename + ' not found in HOG' );
		return;

	}

	if ( hmiMasterVolume() < 1 ) {

		console.log( 'SONGS: Music disabled; deferring ' + filename );
		return;

	}

	const hmpData = new Uint8Array( file.readBytes( file.length() ) );
	const hmpFile = hmp_parse( hmpData );

	if ( hmpFile === null ) {

		console.warn( 'SONGS: Failed to parse ' + filename );
		return;

	}

	_events = hmp_get_events( hmpFile );

	if ( _events.length === 0 ) {

		console.warn( 'SONGS: No events in ' + filename );
		return;

	}

	configureSongTiming( hmp_get_duration( hmpFile ) );

	if ( ensureAudioContext() !== true ) return;
	if ( opl_init( _hogFile, song.melodicBank, song.drumBank ) !== true ) {

		console.warn( 'SONGS: Failed to load instrument banks for ' + filename );
		return;

	}

	if ( _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

	opl_reset_channels();

	_currentSong = songnum;
	_playing = true;
	_restartSongWhenAudible = false;
	_looping = ( loop === true || loop === 1 );
	_eventIndex = 0;
	_startTime = _audioContext.currentTime + 0.1;
	_nextSectionEndTime = _startTime + _playbackEndTime;

	scheduleNextChunk();

	console.log( 'SONGS: Playing ' + filename + ' (' + _events.length + ' events, ' +
		_songDuration.toFixed( 1 ) + 's' + ( _looping ? ', looping' : '' ) +
		( _hasLoopMarkers ? ', loop markers ' + _loopStartTime.toFixed( 3 ) + 's-' + _playbackEndTime.toFixed( 3 ) + 's' : '' ) +
		')' );

}

export function songs_play_level_song( levelnum ) {

	if ( Number.isInteger( levelnum ) !== true || levelnum === 0 || NUM_GAME_SONGS <= 0 ) {

		console.warn( 'SONGS: Invalid level number ' + levelnum );
		return;

	}

	// Ported from SONGS.C: negative level numbers are secret levels and index
	// directly by -levelnum; normal levels index by (levelnum-1).
	const songnum = ( levelnum < 0 )
		? ( ( - levelnum ) % NUM_GAME_SONGS )
		: ( ( levelnum - 1 ) % NUM_GAME_SONGS );

	songs_play_song( SONG_LEVEL_MUSIC + songnum, true );

}

export function songs_stop() {

	// D1 keeps the last non-null song request after stopping.  A later
	// zero-to-audible volume transition restarts it if no song handle exists.
	if ( _lastRequestedSong >= 0 ) _restartSongWhenAudible = true;

	_playing = false;
	_currentSong = - 1;
	_events = null;
	_songDuration = 0;
	_playbackEndTime = 0;
	_playbackEndIndex = 0;
	_loopStartTime = 0;
	_loopStartEventIndex = 0;
	_loopDuration = 0;
	_nextSectionEndTime = 0;
	_hasLoopMarkers = false;

	if ( _scheduleTimer !== null ) {

		clearTimeout( _scheduleTimer );
		_scheduleTimer = null;

	}

	opl_stop_all_notes();

}

// MENU.C stops a muted MIDI handle only when the Options screen closes.  This
// lets the slider mute/unmute the current position while it is still open,
// while a later visit restarts the remembered song from its beginning.
export function songs_stop_if_silent() {

	if ( hmiMasterVolume() < 1 ) songs_stop();

}

export function songs_pause() {

	_paused = true;
	if ( _masterGain !== null ) _masterGain.gain.value = 0;

}

export function songs_resume_playback() {

	_paused = false;
	if ( _masterGain !== null ) _masterGain.gain.value = effectiveOutputGain();

}

export function songs_set_volume( vol ) {

	if ( Number.isFinite( vol ) !== true ) return false;
	const oldMasterVolume = hmiMasterVolume();
	_volume = Math.max( 0, Math.min( 1, vol ) );
	const newMasterVolume = hmiMasterVolume();
	opl_set_master_volume( newMasterVolume );

	if ( _masterGain !== null ) {

		_masterGain.gain.value = effectiveOutputGain();

	}

	// DIGI.C uses > 1 here (rather than merely non-zero).  Normal Descent
	// settings move in sixteen-step increments, so this distinction only
	// affects direct API callers but is retained exactly.
	if ( oldMasterVolume < 1 && newMasterVolume > 1 &&
		_restartSongWhenAudible === true && _lastRequestedSong >= 0 ) {

		songs_play_song( _lastRequestedSong, true );

	}
	return true;

}

function scheduleNextChunk() {

	if ( _playing !== true || _events === null ) return;

	const SCHEDULE_AHEAD = 2.0;
	const MAX_WRAP_PASSES = 4;
	const now = _audioContext.currentTime;

	let wrapPasses = 0;

	while ( wrapPasses < MAX_WRAP_PASSES ) {

		const songTime = now - _startTime;
		const scheduleUntilTime = songTime + SCHEDULE_AHEAD;

		while ( _eventIndex < _playbackEndIndex ) {

			const ev = _events[ _eventIndex ];

			if ( ev.time > scheduleUntilTime ) break;

			// A throttled/background tab can wake after the two-second lookahead has
			// expired.  The HMP stream still consumes every event in order; schedule
			// overdue events at the current audio time instead of dropping note-offs,
			// program changes, or controller state.
			const playTime = Math.max( now, _startTime + ev.time );
			opl_process_midi_event( ev, playTime );

			_eventIndex ++;

		}

		if ( _eventIndex < _playbackEndIndex ) break;

		if ( _looping !== true || _loopDuration <= 0 ) {

			if ( now >= _nextSectionEndTime - 0.01 ) {

				_playing = false;
				return;

			}

			break;

		}

		_eventIndex = ( _hasLoopMarkers === true ) ? _loopStartEventIndex : 0;
		_startTime += _loopDuration;
		_nextSectionEndTime += _loopDuration;
		wrapPasses ++;

	}

	let delayMs = 50;

	if ( _eventIndex >= _playbackEndIndex ) {

		const remainingMs = Math.max( 10, ( _nextSectionEndTime - _audioContext.currentTime ) * 1000 );
		delayMs = Math.min( 100, remainingMs );

	}

	if ( wrapPasses >= MAX_WRAP_PASSES ) {

		delayMs = 20;

	}

	_scheduleTimer = setTimeout( scheduleNextChunk, delayMs );

}

// Resume audio context (call from user gesture)
export function songs_resume() {

	if ( _audioContext !== null && _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

}
