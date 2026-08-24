// Ported from: descent-master/MAIN/DIGI.C
// Digital sound playback via Web Audio API

// Sound ID constants (from SOUNDS.H)
export const SOUND_LASER_FIRED = 10;
export const SOUND_WEAPON_HIT_BLASTABLE = 11;
export const SOUND_BADASS_EXPLOSION = 11;		// alias
export const SOUND_ROBOT_HIT_PLAYER = 17;
export const SOUND_ROBOT_HIT = 20;
export const SOUND_ROBOT_DESTROYED = 21;
export const SOUND_VOLATILE_WALL_HIT = 21;		// alias
export const SOUND_DROP_BOMB = 26;
export const SOUND_WEAPON_HIT_DOOR = 27;
export const SOUND_LASER_HIT_CLUTTER = 30;
export const SOUND_CONTROL_CENTER_HIT = 30;		// alias
export const SOUND_EXPLODING_WALL = 31;
export const SOUND_CONTROL_CENTER_DESTROYED = 31;	// alias
export const SOUND_CONTROL_CENTER_WARNING_SIREN = 32;
export const SOUND_MINE_BLEW_UP = 33;
export const SOUND_FUSION_WARMUP = 34;
export const SOUND_REFUEL_STATION_GIVING_FUEL = 62;
export const SOUND_PLAYER_HIT_WALL = 70;
export const SOUND_PLAYER_GOT_HIT = 71;
export const SOUND_HOSTAGE_RESCUED = 91;

// Countdown voice sounds (SOUND_COUNTDOWN_0_SECS through SOUND_COUNTDOWN_29_SECS)
export const SOUND_COUNTDOWN_0_SECS = 100;
export const SOUND_COUNTDOWN_13_SECS = 113;
export const SOUND_COUNTDOWN_29_SECS = 114;

export const SOUND_HUD_MESSAGE = 117;
export const SOUND_HUD_KILL = 118;
export const SOUND_HOMING_WARNING = 122;
export const SOUND_VOLATILE_WALL_HISS = 151;
export const SOUND_GOOD_SELECTION_PRIMARY = 153;
export const SOUND_GOOD_SELECTION_SECONDARY = 154;
export const SOUND_ALREADY_SELECTED = 155;
export const SOUND_BAD_SELECTION = 156;
export const SOUND_CLOAK_OFF = 161;
export const SOUND_INVULNERABILITY_OFF = 163;
export const SOUND_BOSS_SHARE_SEE = 183;
export const SOUND_BOSS_SHARE_DIE = 185;

// Sounds[] array maps game sound IDs to PIG sound file indices
// Built from $SOUNDS in bitmaps.bin (shareware) or HAM data (registered)
let Sounds = null;

// Audio system state
let _audioContext = null;
let _masterGain = null;		// overall master gain → destination
let _digiGain = null;		// SFX gain → master (separate from music)
let _digiVolume = 1.0;
let _soundBuffers = [];		// AudioBuffer[] indexed by PIG sound index
let _pigFile = null;
let _initialized = false;

// Retained for caller compatibility.  D1 admission itself is channel-based;
// these values do not alter replacement order.
export const SND_PRIORITY_LOW = 0;		// ambient, distant effects
export const SND_PRIORITY_NORMAL = 1;	// robot sounds, explosions
export const SND_PRIORITY_HIGH = 2;		// player weapons, damage, UI

// D1's five detail presets select 2, 4, 8, 12, or 16 ordinary digital
// channels.  Linked sound objects use their own 16-slot pool.
const MAX_CONCURRENT_SOUNDS_LIMIT = 16;
let _maxConcurrentSounds = MAX_CONCURRENT_SOUNDS_LIMIT;
let _activeSources = 0;

// Ordinary sources retain their exact D1 logical channel.  Linked sound
// objects are tracked separately and are never candidates for replacement.
const _activeSourceEntries = [];
const _ordinaryChannels = new Array( MAX_CONCURRENT_SOUNDS_LIMIT ).fill( null );
let _nextOrdinaryChannel = 0;

// Latest ordinary source for each resolved PIG sample.  DOS D1 asks the mixer
// for an existing sample handle in digi_play_sample_once(), regardless of
// whether that handle was started through the ordinary or once entry point.
const _latestSourceBySample = new Map();

// Per-sample concurrent instance tracking for digi_is_sound_playing().
// Ordinary D1 playback stacks freely; digi_play_sample_once() is the API that
// explicitly replaces an existing instance.
const _soundInstanceCounts = new Map();

// Finish one generic source exactly once.  A failed start, an explicit steal,
// and a natural/late onended callback can all race for the same bookkeeping.
function finalizeActiveSourceEntry( entry ) {

	if ( entry.active !== true ) return false;
	entry.active = false;
	entry.source.onended = null;

	if ( _latestSourceBySample.get( entry.soundKey ) === entry.source ) {

		_latestSourceBySample.delete( entry.soundKey );
		for ( let i = _activeSourceEntries.length - 1; i >= 0; i -- ) {

			const candidate = _activeSourceEntries[ i ];
			if ( candidate !== entry && candidate.active === true &&
				candidate.soundKey === entry.soundKey ) {

				_latestSourceBySample.set( entry.soundKey, candidate.source );
				break;

			}

		}

	}

	_activeSources --;
	const count = _soundInstanceCounts.get( entry.soundKey ) || 0;
	if ( count <= 1 ) {

		_soundInstanceCounts.delete( entry.soundKey );

	} else {

		_soundInstanceCounts.set( entry.soundKey, count - 1 );

	}

	const index = _activeSourceEntries.indexOf( entry );
	if ( index !== - 1 ) _activeSourceEntries.splice( index, 1 );
	if ( _ordinaryChannels[ entry.channel ] === entry ) {

		_ordinaryChannels[ entry.channel ] = null;

	}
	disconnectAudioNode( entry.source );
	disconnectAudioNode( entry.gainNode );
	disconnectAudioNode( entry.leftGainNode );
	disconnectAudioNode( entry.rightGainNode );
	disconnectAudioNode( entry.mergerNode );
	return true;

}

function disconnectAudioNode( node ) {

	if ( node === null || node === undefined || typeof node.disconnect !== 'function' ) return;

	try {

		node.disconnect();

	} catch ( e ) { /* already disconnected */ }

}

// Sound sample rate (from original Descent)
const SOUND_SAMPLE_RATE = 11025;
const DEFAULT_SOUND_MAX_DISTANCE = 256.0;
const MIN_3D_SOUND_VOLUME = 10 / 65536;
const MIN_SOUND_OBJECT_VOLUME = 1 / 65536;
const WID_RENDPAST_FLAG = 4;

// D1 computes world sound location itself, rather than delegating distance and
// orientation to the platform mixer.  The route callback is injected to keep
// digi.js independent of the gameseg.js -> wall.js -> digi.js module cycle.
let _worldDistanceResolver = null;
let _listenerPosX = 0;
let _listenerPosY = 0;
let _listenerPosZ = 0;
let _listenerSegnum = - 1;
let _listenerRightX = 1;
let _listenerRightY = 0;
let _listenerRightZ = 0;
let _locatedVolume = 0;
let _locatedPan = 0.5;
let _soundPauseDepth = 0;
let _reverseStereo = false;

export function digi_set_world_distance_resolver( resolver ) {

	_worldDistanceResolver = resolver;

}

export function digi_set_reverse_stereo( reversed ) {

	if ( reversed !== true && reversed !== false ) return false;
	_reverseStereo = reversed;
	return true;

}

// Initialize the digital sound system
export function digi_init( pigFile ) {

	_pigFile = pigFile;

	// Don't create AudioContext until user gesture (browser policy)
	// We'll lazily create it on first play

	console.log( 'DIGI: Sound system ready (' + pigFile.sounds.length + ' sounds available)' );

}

// Set the Sounds[] mapping table (game sound ID -> PIG sound index)
export function digi_set_sounds_table( soundsTable ) {

	Sounds = soundsTable;

}

// Ensure AudioContext exists (must be called after user gesture)
function ensureAudioContext() {

	if ( _audioContext !== null ) return true;

	try {

		_audioContext = new ( window.AudioContext || window.webkitAudioContext )();

		// Master gain → destination
		_masterGain = _audioContext.createGain();
		_masterGain.gain.value = 1.0;
		_masterGain.connect( _audioContext.destination );

		// SFX bus → master.  D1 captures the current digital volume in
		// ordinary channels when they start; linked sounds are updated in sync.
		_digiGain = _audioContext.createGain();
		_digiGain.gain.value = 1.0;
		_digiGain.connect( _masterGain );

		// Pre-allocate buffer array
		_soundBuffers = new Array( _pigFile.sounds.length );

		return true;

	} catch ( e ) {

		console.warn( 'DIGI: Could not create AudioContext:', e );
		return false;

	}

}

// Convert 8-bit unsigned PCM to AudioBuffer
function createAudioBuffer( soundIndex ) {

	if ( _soundBuffers[ soundIndex ] !== undefined ) return _soundBuffers[ soundIndex ];

	const rawData = _pigFile.getSoundData( soundIndex );
	if ( rawData === null ) {

		_soundBuffers[ soundIndex ] = null;
		return null;

	}

	const sampleCount = rawData.length;
	const audioBuffer = _audioContext.createBuffer( 1, sampleCount, SOUND_SAMPLE_RATE );
	const channelData = audioBuffer.getChannelData( 0 );

	// Convert unsigned 8-bit (0-255) to signed float (-1.0 to +1.0)
	for ( let i = 0; i < sampleCount; i ++ ) {

		channelData[ i ] = ( rawData[ i ] - 128 ) / 128.0;

	}

	_soundBuffers[ soundIndex ] = audioBuffer;
	return audioBuffer;

}

// Select D1's next logical channel.  The cursor advances after a sound starts,
// even when another channel elsewhere in the ring is free.  A channel's
// mixer volume is captured when it starts and compared with the current SFX
// volume, exactly as D1 does.  Louder channels are skipped for up to one full
// pass; if every channel is louder, the starting channel is still replaced.
function claimOrdinaryChannel() {

	let tries = 0;
	while ( tries < _maxConcurrentSounds ) {

		const entry = _ordinaryChannels[ _nextOrdinaryChannel ];
		if ( entry === null || entry.active !== true ||
			entry.mixerVolumeAtStart <= _digiVolume ) break;

		_nextOrdinaryChannel ++;
		if ( _nextOrdinaryChannel >= _maxConcurrentSounds ) _nextOrdinaryChannel = 0;
		tries ++;

	}

	const channel = _nextOrdinaryChannel;
	const victim = _ordinaryChannels[ channel ];
	if ( victim !== null && victim.active === true ) {

		victim.source.onended = null;
		finalizeActiveSourceEntry( victim );

		try {

			victim.source.stop();

		} catch ( e ) { /* already stopped */ }

	}

	return channel;

}

function advanceOrdinaryChannel( channel ) {

	_nextOrdinaryChannel = channel + 1;
	if ( _nextOrdinaryChannel >= _maxConcurrentSounds ) _nextOrdinaryChannel = 0;

}

// Resolve a game sound ID to its PIG file sound index
function resolveSoundIndex( soundId ) {

	if ( Number.isInteger( soundId ) !== true || soundId < 0 ) return - 1;
	if ( _pigFile === null || _pigFile === undefined ||
		_pigFile.sounds === null || _pigFile.sounds === undefined ) return - 1;

	const soundCount = _pigFile.sounds.length;
	if ( Number.isInteger( soundCount ) !== true || soundCount < 0 ) return - 1;

	let pigIndex = soundId;

	if ( Sounds !== null ) {

		if ( Sounds === undefined || Number.isInteger( Sounds.length ) !== true ||
			soundId >= Sounds.length ) return - 1;

		pigIndex = Sounds[ soundId ];

	}

	if ( Number.isInteger( pigIndex ) !== true || pigIndex < 0 || pigIndex >= soundCount ) return - 1;

	return pigIndex;

}

// Play a non-positional (2D) sound — for player/UI sounds
// volume: 0.0 to 1.0, priority: SND_PRIORITY_* (default HIGH for non-positional)
export function digi_play_sample( soundId, volume, priority ) {

	if ( _pigFile === null ) return;
	if ( volume === undefined ) volume = 1.0;
	if ( priority === undefined ) priority = SND_PRIORITY_HIGH;

	const pigIndex = resolveSoundIndex( soundId );
	if ( pigIndex === - 1 ) return;
	if ( ensureAudioContext() !== true ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	// Claim only after every validation and paging step has succeeded.  A bad
	// request must never silence a valid channel.
	const channel = claimOrdinaryChannel();

	const curCount = _soundInstanceCounts.get( pigIndex ) || 0;

	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	// Volume control
	const gainNode = _audioContext.createGain();
	gainNode.gain.value = volume * _digiVolume;
	source.connect( gainNode );
	gainNode.connect( _digiGain );

	_activeSources ++;
	_soundInstanceCounts.set( pigIndex, curCount + 1 );

	const entry = {
		source: source,
		soundKey: pigIndex,
		active: true,
		gainNode: gainNode,
		leftGainNode: null,
		rightGainNode: null,
		mergerNode: null,
		channel: channel,
		mixerVolumeAtStart: volume * _digiVolume
	};
	_activeSourceEntries.push( entry );
	_ordinaryChannels[ channel ] = entry;
	_latestSourceBySample.set( pigIndex, source );

	source.onended = function () {

		finalizeActiveSourceEntry( entry );

	};

	try {

		source.start( 0 );
		advanceOrdinaryChannel( channel );

	} catch ( e ) {

		// start() may throw after an implementation/test double has already
		// dispatched onended.  The entry guard keeps both paths exact once.
		source.onended = null;
		finalizeActiveSourceEntry( entry );
		return;

	}

	return source;

}

function setStereoGains( leftGainNode, rightGainNode, volume, pan ) {

	const clampedPan = Math.max( 0, Math.min( pan, 1 ) );
	leftGainNode.gain.value = volume * Math.min( 1, 2 - clampedPan * 2 );
	rightGainNode.gain.value = volume * Math.min( 1, clampedPan * 2 );

}

// Fixed-point Descent's vm_vec_mag_quick approximation in world units.
function quickMagnitude( x, y, z ) {

	let largest = Math.abs( x );
	let middle = Math.abs( y );
	let smallest = Math.abs( z );
	let swap;

	if ( largest < middle ) {

		swap = largest;
		largest = middle;
		middle = swap;

	}

	if ( middle < smallest ) {

		swap = middle;
		middle = smallest;
		smallest = swap;

	}

	if ( largest < middle ) {

		swap = largest;
		largest = middle;
		middle = swap;

	}

	return largest + middle * 3 / 8 + smallest * 3 / 16;

}

// Compute D1's portal-aware volume and listener-relative pan into the shared
// scalar result above.  This is called every frame for linked sound objects.
function getWorldSoundLocation( maxVolume, maxDistance, sourceSegnum, pos_x, pos_y, pos_z ) {

	_locatedVolume = 0;
	_locatedPan = 0.5;

	if ( typeof _worldDistanceResolver !== 'function' || _listenerSegnum < 0 ||
		Number.isInteger( sourceSegnum ) !== true || sourceSegnum < 0 ||
		Number.isFinite( maxVolume ) !== true || Number.isFinite( maxDistance ) !== true ||
		maxDistance <= 0 ) return false;

	const dx = pos_x - _listenerPosX;
	const dy = pos_y - _listenerPosY;
	const dz = pos_z - _listenerPosZ;
	const directDistance = quickMagnitude( dx, dy, dz );
	const audibleDistance = maxDistance * 5 / 4;
	if ( directDistance >= audibleDistance ) return false;

	let searchDepth = Math.floor( audibleDistance / 20 );
	if ( searchDepth < 1 ) searchDepth = 1;

	const pathDistance = _worldDistanceResolver(
		_listenerPosX, _listenerPosY, _listenerPosZ, _listenerSegnum,
		pos_x, pos_y, pos_z, sourceSegnum,
		searchDepth, WID_RENDPAST_FLAG
	);
	if ( pathDistance < 0 ) return false;

	const volume = maxVolume - pathDistance / audibleDistance;
	if ( volume <= 0 ) return false;

	let pan = 0.5;
	if ( directDistance > 0.000001 ) {

		const inverseDistance = 1 / directDistance;
		const rightDot = (
			dx * _listenerRightX + dy * _listenerRightY + dz * _listenerRightZ
		) * inverseDistance;
		// vm_vec_delta_ang_norm passes this dot through fix_acos(), which
		// saturates magnitudes above F1_0 before fix_cos() reconstructs it.
		const clampedRightDot = Math.max( - 1, Math.min( rightDot, 1 ) );
		pan = ( ( _reverseStereo === true ? - clampedRightDot : clampedRightDot ) + 1 ) / 2;

	}

	_locatedVolume = volume;
	_locatedPan = pan;
	return true;

}

// Low-level located playback.  D1 supplies an already-computed pan and volume
// to its mixer; Web Audio reproduces its linear stereo law explicitly.
export function digi_play_sample_3d( soundId, pan, volume, priority ) {

	if ( _pigFile === null ) return;
	if ( pan === undefined ) pan = 0.5;
	if ( volume === undefined ) volume = 1.0;
	if ( priority === undefined ) priority = SND_PRIORITY_NORMAL;
	if ( Number.isFinite( volume ) !== true || volume < MIN_3D_SOUND_VOLUME ) return;

	const pigIndex = resolveSoundIndex( soundId );
	if ( pigIndex === - 1 ) return;
	if ( ensureAudioContext() !== true ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	// Claim only after every validation and paging step has succeeded.  A bad
	// request must never silence a valid channel.
	const channel = claimOrdinaryChannel();

	const curCount = _soundInstanceCounts.get( pigIndex ) || 0;

	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	const leftGainNode = _audioContext.createGain();
	const rightGainNode = _audioContext.createGain();
	const mergerNode = _audioContext.createChannelMerger( 2 );
	setStereoGains( leftGainNode, rightGainNode, volume * _digiVolume, pan );

	source.connect( leftGainNode );
	source.connect( rightGainNode );
	leftGainNode.connect( mergerNode, 0, 0 );
	rightGainNode.connect( mergerNode, 0, 1 );
	mergerNode.connect( _digiGain );

	_activeSources ++;
	_soundInstanceCounts.set( pigIndex, curCount + 1 );

	const entry = {
		source: source,
		soundKey: pigIndex,
		active: true,
		gainNode: null,
		leftGainNode: leftGainNode,
		rightGainNode: rightGainNode,
		mergerNode: mergerNode,
		channel: channel,
		mixerVolumeAtStart: volume * _digiVolume
	};
	_activeSourceEntries.push( entry );
	_ordinaryChannels[ channel ] = entry;
	_latestSourceBySample.set( pigIndex, source );

	source.onended = function () {

		finalizeActiveSourceEntry( entry );

	};

	try {

		source.start( 0 );
		advanceOrdinaryChannel( channel );

	} catch ( e ) {

		source.onended = null;
		finalizeActiveSourceEntry( entry );
		return;

	}

	return source;

}

// Resolve and play a source at a world position through D1's segment-aware
// location model.  maxDistance is the logical range before the 1.25 factor.
export function digi_play_sample_world(
	soundId, maxVolume, sourceSegnum, pos_x, pos_y, pos_z,
	priority, maxDistance = DEFAULT_SOUND_MAX_DISTANCE
) {

	if ( getWorldSoundLocation(
		maxVolume, maxDistance, sourceSegnum, pos_x, pos_y, pos_z
	) !== true ) return;

	return digi_play_sample_3d( soundId, _locatedPan, _locatedVolume, priority );

}

// Update the D1 listener state in Descent coordinates.
export function digi_update_listener(
	pos_x, pos_y, pos_z, segnum,
	right_x, right_y, right_z
) {

	_listenerPosX = pos_x;
	_listenerPosY = pos_y;
	_listenerPosZ = pos_z;
	_listenerSegnum = segnum;
	_listenerRightX = right_x;
	_listenerRightY = right_y;
	_listenerRightZ = right_z;

}

// --- Sound Object Linking System (from DIGI.C) ---
// Persistent/looping 3D sounds attached to objects or positions

const SOF_USED = 1;
const SOF_PLAYING = 2;
const SOF_LINK_TO_OBJ = 4;
const SOF_LINK_TO_POS = 8;
const SOF_PLAY_FOREVER = 16;

const MAX_SOUND_OBJECTS = 16;
let _nextSignature = 1;

// Pre-allocated sound object pool (Golden Rule #5: no allocations in render loop)
const _soundObjects = [];

for ( let _si = 0; _si < MAX_SOUND_OBJECTS; _si ++ ) {

	_soundObjects.push( {
		signature: 0,
		flags: 0,
		soundnum: - 1,
		max_volume: 1.0,
		max_distance: DEFAULT_SOUND_MAX_DISTANCE,
		volume: 0,
		pan: 0.5,
		// Link to object
		objnum: - 1,
		objsignature: 0,
		// Link to position
		segnum: - 1,
		sidenum: - 1,
		pos_x: 0,
		pos_y: 0,
		pos_z: 0,
		// Web Audio nodes (reused per slot)
		source: null,
		leftGainNode: null,
		rightGainNode: null,
		mergerNode: null,
		// A stopped source can dispatch onended after this slot has been reused.
		// Keep ownership separate from the sound-object signature so each play
		// can be finalized exactly once.
		playGeneration: 0,
		activePlayGeneration: 0
	} );

}

// Callback to get object position/alive state — set via digi_set_object_getter()
let _getObject = null;

// Set the object getter callback (avoids circular imports)
// getter(objnum) should return { pos_x, pos_y, pos_z, segnum, signature, type } or null
export function digi_set_object_getter( getter ) {

	_getObject = getter;

}

// Start playing a sound object slot
function startSoundObject( idx ) {

	const so = _soundObjects[ idx ];

	if ( _audioContext === null ) return;
	if ( _soundPauseDepth > 0 ) return;
	if ( so.flags === 0 ) return;
	if ( so.volume < MIN_SOUND_OBJECT_VOLUME ) return;

	const pigIndex = so.soundnum;
	if ( pigIndex === - 1 ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	// Create audio nodes
	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	if ( ( so.flags & SOF_PLAY_FOREVER ) !== 0 ) {

		source.loop = true;

	}

	const leftGainNode = _audioContext.createGain();
	const rightGainNode = _audioContext.createGain();
	const mergerNode = _audioContext.createChannelMerger( 2 );
	setStereoGains( leftGainNode, rightGainNode, so.volume * _digiVolume, so.pan );

	source.connect( leftGainNode );
	source.connect( rightGainNode );
	leftGainNode.connect( mergerNode, 0, 0 );
	rightGainNode.connect( mergerNode, 0, 1 );
	mergerNode.connect( _digiGain );

	// Store nodes for later update/stop
	so.source = source;
	so.leftGainNode = leftGainNode;
	so.rightGainNode = rightGainNode;
	so.mergerNode = mergerNode;
	so.flags |= SOF_PLAYING;
	const playGeneration = so.playGeneration + 1;
	so.playGeneration = playGeneration;
	so.activePlayGeneration = playGeneration;

	_activeSources ++;

	const capturedIdx = idx;
	source.onended = function () {

		const slot = _soundObjects[ capturedIdx ];
		if ( slot.activePlayGeneration !== playGeneration ) return;

		source.onended = null;
		slot.activePlayGeneration = 0;
		_activeSources --;
		if ( ( slot.flags & SOF_PLAY_FOREVER ) === 0 ) {

			slot.flags = 0;

		} else {

			slot.flags &= ~SOF_PLAYING;

		}

		slot.source = null;
		slot.leftGainNode = null;
		slot.rightGainNode = null;
		slot.mergerNode = null;
		disconnectAudioNode( source );
		disconnectAudioNode( leftGainNode );
		disconnectAudioNode( rightGainNode );
		disconnectAudioNode( mergerNode );

	};

	try {

		source.start( 0 );

	} catch ( e ) {

		// Preserve SOF_USED/link metadata so digi_sync_sounds() can retry this
		// persistent source.  Invalidate this generation before any late callback.
		source.onended = null;
		stopSoundObjectPlayback( so );

	}

}

// Stop one playback without releasing its persistent sound-object slot.
function stopSoundObjectPlayback( so ) {

	const source = so.source;
	const leftGainNode = so.leftGainNode;
	const rightGainNode = so.rightGainNode;
	const mergerNode = so.mergerNode;
	if ( source !== null ) source.onended = null;

	// Invalidate ownership before stop(), since onended may be queued already
	// (or fire synchronously in a Web Audio implementation/test double).
	if ( so.activePlayGeneration !== 0 ) {

		so.activePlayGeneration = 0;
		_activeSources --;

	}

	so.source = null;
	so.leftGainNode = null;
	so.rightGainNode = null;
	so.mergerNode = null;
	so.flags &= ~SOF_PLAYING;

	if ( source !== null ) {

		try {

			source.stop();

		} catch ( e ) { /* already stopped */ }

	}

	disconnectAudioNode( source );
	disconnectAudioNode( leftGainNode );
	disconnectAudioNode( rightGainNode );
	disconnectAudioNode( mergerNode );

}

// Stop and release a sound object slot.
function stopSoundObject( idx ) {

	const so = _soundObjects[ idx ];
	stopSoundObjectPlayback( so );
	so.flags = 0;

}

function updateSoundObjectLocation( so, segnum, pos_x, pos_y, pos_z ) {

	if ( getWorldSoundLocation(
		so.max_volume, so.max_distance, segnum, pos_x, pos_y, pos_z
	) === true ) {

		so.volume = _locatedVolume;
		so.pan = _locatedPan;
		return true;

	}

	so.volume = 0;
	so.pan = 0.5;
	return false;

}

function prepareLinkedSound( soundnum ) {

	const pigIndex = resolveSoundIndex( soundnum );
	if ( pigIndex === - 1 ) return - 1;
	if ( ensureAudioContext() !== true ) return - 1;
	return createAudioBuffer( pigIndex ) !== null ? pigIndex : - 1;

}

// Link a sound to a moving object (follows the object each frame)
// Returns a signature ID, or -1 on failure
export function digi_link_sound_to_object( soundnum, objnum, forever, max_volume ) {

	return digi_link_sound_to_object2(
		soundnum, objnum, forever, max_volume, DEFAULT_SOUND_MAX_DISTANCE
	);

}

export function digi_link_sound_to_object2( soundnum, objnum, forever, max_volume, max_distance ) {

	if ( max_volume === undefined ) max_volume = 1.0;
	if ( max_distance === undefined ) max_distance = DEFAULT_SOUND_MAX_DISTANCE;
	if ( Number.isFinite( max_volume ) !== true || max_volume < 0 ||
		Number.isFinite( max_distance ) !== true || max_distance <= 0 ) return - 1;
	const soundKey = prepareLinkedSound( soundnum );
	if ( soundKey === - 1 || typeof _getObject !== 'function' ) return - 1;

	const obj = _getObject( objnum );
	if ( obj === null || obj === undefined || Number.isInteger( obj.segnum ) !== true ||
		obj.segnum < 0 || Number.isInteger( obj.signature ) !== true ||
		Number.isFinite( obj.pos_x ) !== true || Number.isFinite( obj.pos_y ) !== true ||
		Number.isFinite( obj.pos_z ) !== true ) return - 1;

	// If not forever, just play a one-shot 3D sound at the object's position
	if ( forever !== true && forever !== 1 ) {

		digi_play_sample_world(
			soundnum, max_volume, obj.segnum,
			obj.pos_x, obj.pos_y, obj.pos_z,
			undefined, max_distance
		);

		return - 1;

	}

	// Find free slot
	let i;

	for ( i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags === 0 ) break;

	}

	if ( i === MAX_SOUND_OBJECTS ) return - 1;

	const so = _soundObjects[ i ];
	so.signature = _nextSignature ++;
	so.flags = SOF_USED | SOF_LINK_TO_OBJ | SOF_PLAY_FOREVER;
	so.soundnum = soundKey;
	so.objnum = objnum;
	so.max_volume = max_volume;
	so.max_distance = max_distance;
	so.volume = 0;
	so.pan = 0.5;
	so.objsignature = obj.signature;
	updateSoundObjectLocation(
		so, obj.segnum, obj.pos_x, obj.pos_y, obj.pos_z
	);

	startSoundObject( i );

	return so.signature;

}

// Link a sound to a fixed position (e.g. a wall/door)
export function digi_link_sound_to_pos( soundnum, segnum, sidenum, pos_x, pos_y, pos_z, forever, max_volume ) {

	return digi_link_sound_to_pos2(
		soundnum, segnum, sidenum, pos_x, pos_y, pos_z,
		forever, max_volume, DEFAULT_SOUND_MAX_DISTANCE
	);

}

export function digi_link_sound_to_pos2( soundnum, segnum, sidenum, pos_x, pos_y, pos_z, forever, max_volume, max_distance ) {

	if ( max_volume === undefined ) max_volume = 1.0;
	if ( max_distance === undefined ) max_distance = DEFAULT_SOUND_MAX_DISTANCE;
	if ( Number.isFinite( max_volume ) !== true || max_volume < 0 ||
		Number.isFinite( max_distance ) !== true || max_distance <= 0 ||
		Number.isInteger( segnum ) !== true || segnum < 0 ||
		Number.isInteger( sidenum ) !== true || sidenum < 0 || sidenum >= 6 ||
		Number.isFinite( pos_x ) !== true || Number.isFinite( pos_y ) !== true ||
		Number.isFinite( pos_z ) !== true ) return - 1;
	const soundKey = prepareLinkedSound( soundnum );
	if ( soundKey === - 1 ) return - 1;

	// If not forever, just play a one-shot 3D sound
	if ( forever !== true && forever !== 1 ) {

		digi_play_sample_world(
			soundnum, max_volume, segnum, pos_x, pos_y, pos_z,
			undefined, max_distance
		);
		return - 1;

	}

	// Find free slot
	let i;

	for ( i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags === 0 ) break;

	}

	if ( i === MAX_SOUND_OBJECTS ) return - 1;

	const so = _soundObjects[ i ];
	so.signature = _nextSignature ++;
	so.flags = SOF_USED | SOF_LINK_TO_POS | SOF_PLAY_FOREVER;
	so.soundnum = soundKey;
	so.segnum = segnum;
	so.sidenum = sidenum;
	so.pos_x = pos_x;
	so.pos_y = pos_y;
	so.pos_z = pos_z;
	so.max_volume = max_volume;
	so.max_distance = max_distance;
	so.volume = 0;
	so.pan = 0.5;
	updateSoundObjectLocation( so, segnum, pos_x, pos_y, pos_z );

	startSoundObject( i );

	return so.signature;

}

// Kill all sounds linked to a specific object
export function digi_kill_sound_linked_to_object( objnum ) {

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_LINK_TO_OBJ ) !== 0 ) {

			if ( so.objnum === objnum ) {

				stopSoundObject( i );

			}

		}

	}

}

// Kill sounds linked to a specific segment/side/sound combo
export function digi_kill_sound_linked_to_segment( segnum, sidenum, soundnum ) {

	const soundKey = resolveSoundIndex( soundnum );
	if ( soundKey === - 1 ) return;

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_LINK_TO_POS ) !== 0 ) {

			if ( so.segnum === segnum && so.sidenum === sidenum && so.soundnum === soundKey ) {

				stopSoundObject( i );

			}

		}

	}

}

// Sync all sound objects each frame — update positions of object-linked sounds,
// remove sounds whose linked objects have died
export function digi_sync_sounds() {

	if ( _audioContext === null ) return;
	if ( _soundPauseDepth > 0 ) return;

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) === 0 ) continue;

		let located = false;

		if ( ( so.flags & SOF_LINK_TO_OBJ ) !== 0 ) {

			// Update position from linked object
			if ( _getObject !== null ) {

				const obj = _getObject( so.objnum );

				if ( obj === null || obj.signature !== so.objsignature ) {

					// Object is dead — stop the sound
					stopSoundObject( i );
					continue;

				}

				located = updateSoundObjectLocation(
					so, obj.segnum, obj.pos_x, obj.pos_y, obj.pos_z
				);

			}

		} else if ( ( so.flags & SOF_LINK_TO_POS ) !== 0 ) {

			located = updateSoundObjectLocation(
				so, so.segnum, so.pos_x, so.pos_y, so.pos_z
			);

		}

		if ( located !== true || so.volume < MIN_SOUND_OBJECT_VOLUME ) {

			if ( ( so.flags & SOF_PLAYING ) !== 0 ) stopSoundObjectPlayback( so );
			continue;

		}

		if ( ( so.flags & SOF_PLAYING ) === 0 ) {

			startSoundObject( i );

		} else if ( so.leftGainNode !== null && so.rightGainNode !== null ) {

			setStereoGains(
				so.leftGainNode, so.rightGainNode, so.volume * _digiVolume, so.pan
			);

		}

	}

}

// Pause persistent ambient/object loops without suspending the shared Web
// Audio context.  D1 nests pause ownership and only stops playback on the
// outermost pause, preserving each sound object's link metadata for restart.
export function digi_pause_all() {

	if ( _soundPauseDepth === 0 ) {

		for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

			const so = _soundObjects[ i ];
			if ( ( so.flags & SOF_USED ) !== 0 &&
				( so.flags & SOF_PLAYING ) !== 0 &&
				( so.flags & SOF_PLAY_FOREVER ) !== 0 ) {

				stopSoundObjectPlayback( so );

			}

		}

	}

	_soundPauseDepth ++;

}

export function digi_resume_all() {

	if ( _soundPauseDepth === 0 ) return;
	_soundPauseDepth --;
	if ( _soundPauseDepth === 0 ) digi_sync_sounds();

}

// Stop every digital sound channel and release every sound object.
// Ported from: digi_init_sounds() / digi_stop_digi_sounds().
export function digi_stop_all_sounds() {

	// Generic 2D/3D sources own the shared channel count, per-sound count,
	// channel-stealing entry, and possibly the latest-sample entry.  Invalidate
	// each callback and finalize ownership before stop(), since a test double or
	// browser may dispatch onended synchronously or later.
	while ( _activeSourceEntries.length > 0 ) {

		const entry = _activeSourceEntries[ _activeSourceEntries.length - 1 ];
		entry.source.onended = null;
		finalizeActiveSourceEntry( entry );

		try {

			entry.source.stop();

		} catch ( e ) { /* already stopped */ }

	}

	// All live play-once entries are removed by the identity check in the
	// finalizer.  Clear any stale ownership left by an already-ended source.
	_latestSourceBySample.clear();

	// Persistent sound objects use generation ownership, so stopping a slot
	// first makes synchronous and late callbacks harmless before it is released.
	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags !== 0 ) {

			stopSoundObject( i );

		}

	}

}

// Check if a specific sound ID is currently playing (sound objects + one-shots)
export function digi_is_sound_playing( soundId ) {

	const soundKey = resolveSoundIndex( soundId );
	if ( soundKey === - 1 ) return false;

	// Check generic 2D and 3D one-shot sounds
	if ( ( _soundInstanceCounts.get( soundKey ) || 0 ) > 0 ) return true;

	// Check sound objects
	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_PLAYING ) !== 0 ) {

			if ( so.soundnum === soundKey ) return true;

		}

	}

	return false;

}

// Play a sound, stopping any previous instance first (for continuous sounds like refueling)
// Ported from: DIGI.C digi_play_sample_once() — stops previous then replays from start
export function digi_play_sample_once( soundId, volume ) {

	const soundKey = resolveSoundIndex( soundId );
	if ( soundKey === - 1 ) return;

	// Stop previous instance of this sound if still playing
	if ( _latestSourceBySample.has( soundKey ) === true ) {

		const oldSource = _latestSourceBySample.get( soundKey );
		// Web Audio dispatches onended asynchronously.  Release the old owner's
		// channel before starting its replacement, or a full pool can evict a
		// second, unrelated sound while this stopped source is still counted.
		for ( let i = 0; i < _activeSourceEntries.length; i ++ ) {

			const entry = _activeSourceEntries[ i ];
			if ( entry.source !== oldSource ) continue;
			oldSource.onended = null;
			finalizeActiveSourceEntry( entry );
			break;

		}
		if ( _latestSourceBySample.get( soundKey ) === oldSource ) _latestSourceBySample.delete( soundKey );
		try { oldSource.stop(); } catch ( e ) { /* already stopped */ }

	}

	digi_play_sample( soundId, volume );

}

// Set SFX volume (0.0 to 1.0)
export function digi_set_digi_volume( vol ) {

	if ( Number.isFinite( vol ) !== true ) return false;
	_digiVolume = Math.max( 0, Math.min( 1, vol ) );

	if ( _audioContext !== null ) digi_sync_sounds();
	return true;

}

// Select the size of D1's ordinary digital channel pool.  Changing detail
// level resets those channels but does not interrupt the separately reserved
// linked sound-object channels.
export function digi_set_max_channels( count ) {

	if ( Number.isFinite( count ) !== true ) return false;

	const clampedCount = Math.max(
		1, Math.min( MAX_CONCURRENT_SOUNDS_LIMIT, Math.trunc( count ) )
	);
	if ( clampedCount === _maxConcurrentSounds ) return true;

	// Stop every ordinary channel with exact-once bookkeeping before stop(),
	// since a Web Audio implementation may dispatch onended synchronously.
	while ( _activeSourceEntries.length > 0 ) {

		const entry = _activeSourceEntries[ 0 ];
		entry.source.onended = null;
		finalizeActiveSourceEntry( entry );
		try {

			entry.source.stop();

		} catch ( e ) { /* already stopped */ }

	}
	_latestSourceBySample.clear();
	_ordinaryChannels.fill( null );

	_maxConcurrentSounds = clampedCount;
	_nextOrdinaryChannel %= _maxConcurrentSounds;
	return true;

}

export function digi_get_max_channels() {

	return _maxConcurrentSounds;

}

// Get the shared AudioContext (for songs.js to reuse)
export function digi_get_audio_context() {

	if ( ensureAudioContext() !== true ) return null;
	return _audioContext;

}

// Get the master gain node (for songs.js to connect to)
export function digi_get_master_gain() {

	return _masterGain;

}

// Resume audio context after user gesture (required by browser policy)
export function digi_resume() {

	if ( _audioContext !== null && _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

}
