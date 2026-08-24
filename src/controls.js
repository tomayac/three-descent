// Ported from: descent-master/MAIN/CONTROLS.C
// Input controls: keyboard, mouse, pointer lock

import {
	config_get_key_binding_actions,
	config_get_key_binding_codes,
	config_get_key_binding_primary,
	config_set_key_binding_primary,
	config_reset_key_binding
} from './config.js';

// Input state
const keys = {};
let mouseX = 0;
let mouseY = 0;
let wheelDelta = 0;
let isPointerLocked = false;

// Weapon firing state
let fireButtonDown = false;
let secondaryFireButtonDown = false;

// Callback for key actions (weapon selection, automap toggle)
let _onKeyAction = null;

const ACTION_LABELS = Object.freeze( {
	thrust_forward: 'THRUST FORWARD',
	thrust_backward: 'THRUST BACKWARD',
	thrust_left: 'STRAFE LEFT',
	thrust_right: 'STRAFE RIGHT',
	thrust_up: 'THRUST UP',
	thrust_down: 'THRUST DOWN',
	roll_left: 'ROLL LEFT',
	roll_right: 'ROLL RIGHT',
	cruise_faster: 'CRUISE FASTER',
	cruise_slower: 'CRUISE SLOWER',
	fire_flare: 'FIRE FLARE',
	toggle_automap: 'TOGGLE AUTOMAP',
	toggle_cockpit: 'TOGGLE COCKPIT',
	reset_cruise: 'RESET CRUISE',
	toggle_rear_view: 'TOGGLE REAR VIEW',
	pause_game: 'PAUSE MENU',
} );

const _bindableActions = [];
const BINDABLE_ACTION_IDS = Object.freeze( [
	'thrust_forward',
	'thrust_backward',
	'thrust_left',
	'thrust_right',
	'thrust_up',
	'thrust_down',
	'roll_left',
	'roll_right',
	'fire_flare',
	'toggle_automap',
	'toggle_rear_view',
	'pause_game',
] );
const _keyBindingActions = config_get_key_binding_actions();

for ( let i = 0; i < BINDABLE_ACTION_IDS.length; i ++ ) {

	const id = BINDABLE_ACTION_IDS[ i ];
	if ( _keyBindingActions.indexOf( id ) === - 1 ) continue;
	_bindableActions.push( { id: id, label: ACTION_LABELS[ id ] || id.toUpperCase() } );

}

export function controls_set_key_action_callback( cb ) {

	_onKeyAction = cb;

}

// Initialize input handlers
export function controls_init( domElement ) {

	window.addEventListener( 'keydown', onKeyDown );
	window.addEventListener( 'keyup', onKeyUp );
	window.addEventListener( 'resize', onResize );

	domElement.addEventListener( 'click', () => {

		domElement.requestPointerLock();

	} );

	// Prevent context menu on right-click (used for secondary fire)
	domElement.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	document.addEventListener( 'pointerlockchange', () => {

		isPointerLocked = ( document.pointerLockElement === domElement );

	} );

	document.addEventListener( 'mousemove', onMouseMove );
	document.addEventListener( 'wheel', onWheel, { passive: false } );

	// Fire button (left mouse)
	document.addEventListener( 'mousedown', onMouseDown );
	document.addEventListener( 'mouseup', onMouseUp );

}

// External references for resize
let _camera = null;
let _renderer = null;

export function controls_set_resize_refs( camera, renderer ) {

	_camera = camera;
	_renderer = renderer;

}

// --- Getters ---

export function controls_get_keys() { return keys; }
export function controls_get_mouse_x() { return mouseX; }
export function controls_get_mouse_y() { return mouseY; }
export function controls_is_pointer_locked() { return isPointerLocked; }
export function controls_is_fire_down() { return fireButtonDown; }
export function controls_is_secondary_fire_down() { return secondaryFireButtonDown; }
export function controls_set_secondary_fire_down( v ) { secondaryFireButtonDown = v; }
export function controls_consume_wheel() { const d = wheelDelta; wheelDelta = 0; return d; }

export function controls_get_bindable_actions() {

	return _bindableActions;

}

export function controls_get_action_label( action ) {

	if ( ACTION_LABELS[ action ] === undefined ) return action.toUpperCase();
	return ACTION_LABELS[ action ];

}

export function controls_get_action_primary_code( action ) {

	return config_get_key_binding_primary( action );

}

export function controls_set_action_primary_code( action, code ) {

	return config_set_key_binding_primary( action, code );

}

export function controls_reset_action_binding( action ) {

	return config_reset_key_binding( action );

}

export function controls_is_action_down( action ) {

	const codes = config_get_key_binding_codes( action );

	for ( let i = 0; i < codes.length; i ++ ) {

		const code = codes[ i ];
		if ( keys[ code ] === true ) return true;

	}

	return false;

}

export function controls_event_matches_action( e, action ) {

	const codes = config_get_key_binding_codes( action );

	for ( let i = 0; i < codes.length; i ++ ) {

		if ( e.code === codes[ i ] ) return true;

	}

	return false;

}

// Consume mouse delta (reset after reading)
// Pre-allocated result object to avoid per-frame allocation (Golden Rule #5)
const _mouseResult = { x: 0, y: 0 };

export function controls_consume_mouse() {

	_mouseResult.x = mouseX;
	_mouseResult.y = mouseY;
	mouseX = 0;
	mouseY = 0;
	return _mouseResult;

}

// --- Event handlers ---

function onKeyDown( e ) {

	keys[ e.code ] = true;

	// Delegate key actions (weapon selection, automap) to game.js callback
	if ( _onKeyAction !== null ) {

		_onKeyAction( e );

	}

}

function onKeyUp( e ) {

	keys[ e.code ] = false;

}

function onMouseDown( e ) {

	if ( isPointerLocked === true && e.button === 0 ) {

		fireButtonDown = true;

	}

	// Right-click fires secondary weapon
	if ( isPointerLocked === true && e.button === 2 ) {

		secondaryFireButtonDown = true;

	}

}

function onMouseUp( e ) {

	if ( e.button === 0 ) {

		fireButtonDown = false;

	}

	if ( e.button === 2 ) {

		secondaryFireButtonDown = false;

	}

}

const GAME_ASPECT = 320 / 200;

function onResize() {

	if ( _camera === null || _renderer === null ) return;

	const vw = window.innerWidth;
	const vh = window.innerHeight;

	let w, h;

	if ( vw / vh > GAME_ASPECT ) {

		h = vh;
		w = Math.floor( vh * GAME_ASPECT );

	} else {

		w = vw;
		h = Math.floor( vw / GAME_ASPECT );

	}

	_renderer.setSize( w, h );

}

function onMouseMove( e ) {

	if ( isPointerLocked === true ) {

		mouseX += e.movementX;
		mouseY += e.movementY;

	}

}

function onWheel( e ) {

	wheelDelta += e.deltaY;
	e.preventDefault();

}
