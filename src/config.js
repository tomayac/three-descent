// Game settings (persisted to localStorage)

const SETTINGS_KEY = 'descent_settings';

// Defaults
let _invertMouseY = false;
let _textureFiltering = 'nearest'; // 'nearest' or 'linear'
let _digiVolume = 4;
let _musicVolume = 4;
let _reverseStereo = false;
let _soundChannels = 16;
export const CONFIG_VOLUME_MAX = 8;
export const CONFIG_SOUND_CHANNEL_COUNTS = Object.freeze( [ 2, 4, 8, 12, 16 ] );
const DEFAULT_KEY_BINDINGS = Object.freeze( {
	thrust_forward: Object.freeze( [ 'KeyW', 'ArrowUp' ] ),
	thrust_backward: Object.freeze( [ 'KeyS', 'ArrowDown' ] ),
	thrust_left: Object.freeze( [ 'KeyA', 'ArrowLeft' ] ),
	thrust_right: Object.freeze( [ 'KeyD', 'ArrowRight' ] ),
	thrust_up: Object.freeze( [ 'Space' ] ),
	thrust_down: Object.freeze( [ 'ShiftLeft', 'ShiftRight' ] ),
	roll_left: Object.freeze( [ 'KeyQ' ] ),
	roll_right: Object.freeze( [ 'KeyE' ] ),
	cruise_faster: Object.freeze( [ 'KeyR' ] ),
	cruise_slower: Object.freeze( [ 'KeyT' ] ),
	fire_flare: Object.freeze( [ 'KeyF' ] ),
	toggle_automap: Object.freeze( [ 'Tab' ] ),
	toggle_cockpit: Object.freeze( [ 'F3' ] ),
	reset_cruise: Object.freeze( [ 'Backspace' ] ),
	toggle_rear_view: Object.freeze( [ 'KeyH' ] ),
	pause_game: Object.freeze( [ 'Escape', 'KeyP' ] ),
} );

const _keyBindingActions = Object.freeze( Object.keys( DEFAULT_KEY_BINDINGS ) );
let _keyBindings = createDefaultKeyBindings();

// Callbacks when texture filtering changes (so render.js/polyobj.js can update)
const _onTextureFilteringChangedCallbacks = [];
const _onDigiVolumeChangedCallbacks = [];
const _onMusicVolumeChangedCallbacks = [];
const _onReverseStereoChangedCallbacks = [];
const _onSoundChannelsChangedCallbacks = [];

function sanitizeVolume( value ) {

	if ( Number.isFinite( value ) !== true ) return null;
	return Math.max( 0, Math.min( CONFIG_VOLUME_MAX, Math.round( value ) ) );

}

function sanitizeSoundChannels( value ) {

	if ( Number.isInteger( value ) !== true ) return null;
	if ( CONFIG_SOUND_CHANNEL_COUNTS.indexOf( value ) === - 1 ) return null;
	return value;

}

function createDefaultKeyBindings() {

	const out = {};

	for ( let i = 0; i < _keyBindingActions.length; i ++ ) {

		const action = _keyBindingActions[ i ];
		out[ action ] = DEFAULT_KEY_BINDINGS[ action ].slice();

	}

	return out;

}

function sanitizeBindingList( action, value ) {

	const fallback = DEFAULT_KEY_BINDINGS[ action ];
	const result = [];

	if ( typeof value === 'string' ) {

		if ( value !== '' ) result.push( value );

	} else if ( Array.isArray( value ) ) {

		for ( let i = 0; i < value.length; i ++ ) {

			const code = value[ i ];
			if ( typeof code !== 'string' || code === '' ) continue;
			if ( result.indexOf( code ) === - 1 ) result.push( code );

		}

	}

	if ( result.length <= 0 ) return fallback.slice();

	// Keep at most two binds per action (primary + alternate).
	if ( result.length > 2 ) result.length = 2;

	return result;

}

function saveKeyBindingsFromData( data ) {

	if ( data === null || data === undefined ) return;
	if ( typeof data !== 'object' ) return;

	for ( let i = 0; i < _keyBindingActions.length; i ++ ) {

		const action = _keyBindingActions[ i ];
		_keyBindings[ action ] = sanitizeBindingList( action, data[ action ] );

	}

}

// Load settings from localStorage
function loadSettings() {

	try {

		const json = localStorage.getItem( SETTINGS_KEY );

		if ( json !== null ) {

			const data = JSON.parse( json );

			if ( data.invertMouseY === true || data.invertMouseY === false ) {

				_invertMouseY = data.invertMouseY;

			}

			if ( data.textureFiltering === 'nearest' || data.textureFiltering === 'linear' ) {

				_textureFiltering = data.textureFiltering;

			}

			const digiVolume = sanitizeVolume( data.digiVolume );
			if ( digiVolume !== null ) _digiVolume = digiVolume;

			const musicVolume = sanitizeVolume( data.musicVolume );
			if ( musicVolume !== null ) _musicVolume = musicVolume;

			if ( data.reverseStereo === true || data.reverseStereo === false ) {

				_reverseStereo = data.reverseStereo;

			}

			const soundChannels = sanitizeSoundChannels( data.soundChannels );
			if ( soundChannels !== null ) _soundChannels = soundChannels;

			saveKeyBindingsFromData( data.keyBindings );

		}

	} catch ( e ) {

		// Ignore parse errors, use defaults

	}

}

function saveSettings() {

	try {

		localStorage.setItem( SETTINGS_KEY, JSON.stringify( {
			invertMouseY: _invertMouseY,
			textureFiltering: _textureFiltering,
			digiVolume: _digiVolume,
			musicVolume: _musicVolume,
			reverseStereo: _reverseStereo,
			soundChannels: _soundChannels,
			keyBindings: _keyBindings,
		} ) );

	} catch ( e ) {

		// Ignore storage errors

	}

}

// Initialize on module load
loadSettings();

// --- Public API ---

export function config_get_invert_mouse_y() {

	return _invertMouseY;

}

export function config_set_invert_mouse_y( value ) {

	_invertMouseY = value;
	saveSettings();

}

export function config_get_texture_filtering() {

	return _textureFiltering;

}

export function config_set_texture_filtering( value ) {

	_textureFiltering = value;
	saveSettings();

	for ( let i = 0; i < _onTextureFilteringChangedCallbacks.length; i ++ ) {

		_onTextureFilteringChangedCallbacks[ i ]( value );

	}

}

export function config_on_texture_filtering_changed( cb ) {

	_onTextureFilteringChangedCallbacks.push( cb );

}

export function config_get_digi_volume() {

	return _digiVolume;

}

export function config_set_digi_volume( value ) {

	const volume = sanitizeVolume( value );
	if ( volume === null ) return false;
	if ( volume === _digiVolume ) return true;

	_digiVolume = volume;
	saveSettings();
	for ( let i = 0; i < _onDigiVolumeChangedCallbacks.length; i ++ ) {

		_onDigiVolumeChangedCallbacks[ i ]( volume );

	}
	return true;

}

export function config_on_digi_volume_changed( cb ) {

	_onDigiVolumeChangedCallbacks.push( cb );

}

export function config_get_music_volume() {

	return _musicVolume;

}

export function config_set_music_volume( value ) {

	const volume = sanitizeVolume( value );
	if ( volume === null ) return false;
	if ( volume === _musicVolume ) return true;

	_musicVolume = volume;
	saveSettings();
	for ( let i = 0; i < _onMusicVolumeChangedCallbacks.length; i ++ ) {

		_onMusicVolumeChangedCallbacks[ i ]( volume );

	}
	return true;

}

export function config_on_music_volume_changed( cb ) {

	_onMusicVolumeChangedCallbacks.push( cb );

}

export function config_get_reverse_stereo() {

	return _reverseStereo;

}

export function config_set_reverse_stereo( value ) {

	if ( value !== true && value !== false ) return false;
	if ( value === _reverseStereo ) return true;

	_reverseStereo = value;
	saveSettings();
	for ( let i = 0; i < _onReverseStereoChangedCallbacks.length; i ++ ) {

		_onReverseStereoChangedCallbacks[ i ]( value );

	}
	return true;

}

export function config_on_reverse_stereo_changed( cb ) {

	_onReverseStereoChangedCallbacks.push( cb );

}

export function config_get_sound_channels() {

	return _soundChannels;

}

export function config_set_sound_channels( value ) {

	const channels = sanitizeSoundChannels( value );
	if ( channels === null ) return false;
	if ( channels === _soundChannels ) return true;

	_soundChannels = channels;
	saveSettings();
	for ( let i = 0; i < _onSoundChannelsChangedCallbacks.length; i ++ ) {

		_onSoundChannelsChangedCallbacks[ i ]( channels );

	}
	return true;

}

export function config_on_sound_channels_changed( cb ) {

	_onSoundChannelsChangedCallbacks.push( cb );

}

export function config_get_key_binding_actions() {

	return _keyBindingActions;

}

export function config_get_key_binding_codes( action ) {

	if ( _keyBindings[ action ] === undefined ) return [];
	return _keyBindings[ action ];

}

export function config_get_key_binding_primary( action ) {

	const codes = config_get_key_binding_codes( action );
	if ( codes.length <= 0 ) return '';
	return codes[ 0 ];

}

export function config_set_key_binding_primary( action, code ) {

	if ( _keyBindings[ action ] === undefined ) return false;
	if ( typeof code !== 'string' || code === '' ) return false;

	const current = _keyBindings[ action ];
	const next = [ code ];

	for ( let i = 0; i < current.length; i ++ ) {

		const existing = current[ i ];
		if ( existing === code ) continue;
		next.push( existing );
		if ( next.length >= 2 ) break;

	}

	_keyBindings[ action ] = next;
	saveSettings();
	return true;

}

export function config_reset_key_binding( action ) {

	if ( _keyBindings[ action ] === undefined ) return false;
	_keyBindings[ action ] = DEFAULT_KEY_BINDINGS[ action ].slice();
	saveSettings();
	return true;

}
