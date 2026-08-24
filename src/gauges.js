// Ported from: descent-master/MAIN/GAUGES.C
// Cockpit HUD using original game bitmaps rendered as Three.js texture

import * as THREE from 'three';
import {
	Gauges, cockpit_bitmap, Num_cockpits,
	GAUGE_SHIELDS, GAUGE_INVULNERABLE, GAUGE_ENERGY_LEFT, GAUGE_ENERGY_RIGHT,
	GAUGE_NUMERICAL, GAUGE_BLUE_KEY, GAUGE_GOLD_KEY, GAUGE_RED_KEY,
	GAUGE_BLUE_KEY_OFF, GAUGE_GOLD_KEY_OFF, GAUGE_RED_KEY_OFF,
	SB_GAUGE_BLUE_KEY, SB_GAUGE_GOLD_KEY, SB_GAUGE_RED_KEY,
	SB_GAUGE_BLUE_KEY_OFF, SB_GAUGE_GOLD_KEY_OFF, SB_GAUGE_RED_KEY_OFF,
	SB_GAUGE_ENERGY, GAUGE_LIVES, GAUGE_SHIPS,
	RETICLE_CROSS, RETICLE_PRIMARY, RETICLE_SECONDARY,
	GAUGE_HOMING_WARNING_ON, GAUGE_HOMING_WARNING_OFF,
	SML_RETICLE_CROSS, SML_RETICLE_PRIMARY, SML_RETICLE_SECONDARY,
	Weapon_info, Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info
} from './bm.js';
import { hud_update_timers, hud_has_messages, hud_draw_messages } from './hud.js';
import { hostage_get_in_level, hostage_get_level_saved } from './hostage.js';

// --- Constants from GAUGES.C (320x200 coordinate space) ---

// Cockpit modes (from GAME.H)
const CM_FULL_COCKPIT = 0;
const CM_REAR_VIEW = 1;
const CM_STATUS_BAR = 2;
const CM_FULL_SCREEN = 3;

let _cockpitMode = CM_FULL_COCKPIT;

// Full cockpit gauge positions
const SHIELD_GAUGE_X = 146;
const SHIELD_GAUGE_Y = 155;
const SHIP_GAUGE_X = 151;
const SHIP_GAUGE_Y = 160;

const LEFT_ENERGY_GAUGE_X = 70;
const LEFT_ENERGY_GAUGE_Y = 131;
const LEFT_ENERGY_GAUGE_W = 64;
const LEFT_ENERGY_GAUGE_H = 8;

const RIGHT_ENERGY_GAUGE_X = 190;
const RIGHT_ENERGY_GAUGE_Y = 131;

const NUMERICAL_GAUGE_X = 154;
const NUMERICAL_GAUGE_Y = 130;

// Key positions (full cockpit)
const GAUGE_BLUE_KEY_X = 45;
const GAUGE_BLUE_KEY_Y = 152;
const GAUGE_GOLD_KEY_X = 44;
const GAUGE_GOLD_KEY_Y = 162;
const GAUGE_RED_KEY_X = 43;
const GAUGE_RED_KEY_Y = 172;

// Weapon display positions (full cockpit)
const PRIMARY_W_PIC_X = 64;
const PRIMARY_W_PIC_Y = 154;
const PRIMARY_W_TEXT_X = 87;
const PRIMARY_W_TEXT_Y = 157;
const PRIMARY_AMMO_X = 93;
const PRIMARY_AMMO_Y = 171;

const SECONDARY_W_PIC_X = 234;
const SECONDARY_W_PIC_Y = 154;
const SECONDARY_W_TEXT_X = 207;
const SECONDARY_W_TEXT_Y = 157;
const SECONDARY_AMMO_X = 213;
const SECONDARY_AMMO_Y = 171;

// Score/Lives (full screen overlay)
const SCORE_Y = 4;
const LIVES_Y = 4;

// Energy bar scanline spans (from weapon_window_left[] in GAUGES.C)
// Each pair: [left_offset, right_offset] relative to energy gauge
const weapon_window_left = [
	[ 0, 53 ], [ 1, 53 ], [ 2, 53 ], [ 3, 53 ], [ 4, 53 ], [ 5, 53 ], [ 6, 53 ],
	[ 7, 53 ], [ 8, 53 ], [ 9, 53 ], [ 10, 53 ], [ 11, 53 ], [ 12, 53 ], [ 13, 53 ],
	[ 14, 53 ], [ 15, 53 ], [ 16, 53 ], [ 17, 53 ], [ 18, 53 ], [ 19, 53 ], [ 20, 53 ],
	[ 21, 53 ], [ 22, 53 ], [ 23, 53 ], [ 24, 53 ], [ 25, 53 ], [ 26, 53 ], [ 27, 53 ],
	[ 28, 53 ], [ 29, 53 ], [ 30, 53 ], [ 31, 53 ], [ 32, 53 ], [ 33, 53 ], [ 34, 53 ],
	[ 35, 53 ], [ 36, 53 ], [ 37, 53 ], [ 38, 53 ]
];

// Weapon names (from WEAPON.C / LASER.H)
const PRIMARY_NAMES = [ 'LASER', 'VULCAN', 'SPREADFIRE', 'PLASMA', 'FUSION' ];
const SECONDARY_NAMES = [ 'CONCUSSION\nMISSILE', 'HOMING\nMISSILE', 'PROXIMITY\nBOMB', 'SMART\nMISSILE', 'MEGA\nMISSILE' ];

// --- Canvas state ---

const COCKPIT_W = 320;
const COCKPIT_H = 200;
const COCKPIT_SCALE = 3; // Canvas supersampling for crisp text

let _canvas = null;
let _ctx = null;

// --- Three.js objects ---

let _texture = null;
let _mesh = null;
let _hudScene = null;
let _hudCamera = null;

// --- Bitmap cache (ImageData objects keyed by PIG bitmap index) ---

const _bitmapCache = new Map();
let _pigFile = null;
let _palette = null;
let _cockpitDrawn = false;

// --- Dirty flag for canvas update optimization ---
// Only redraw canvas and upload to GPU when state has actually changed
let _dirty = true;

// --- Game state ---

let _shields = 100;
let _energy = 100;
let _primaryWeapon = 0;
let _secondaryWeapon = 0;
let _missileGun = 0;	// which missile gun fires next (Missile_gun); low bit picks the reticle frame
let _laserLevel = 0;
let _vulcanAmmo = 0;
const _secondaryAmmo = [ 0, 0, 0, 0, 0 ];
let _quadLasers = false;
let _keysBlue = false;
let _keysRed = false;
let _keysGold = false;
let _score = 0;
let _lives = 3;

// --- Damage flash ---
// Ported from: GAME.C PALETTE_FLASH_ADD + diminish_palette_towards_normal()
// Accumulates palette add values and decays at DIMINISH_RATE units/sec

const DIMINISH_RATE = 16;	// Palette decay rate (units/second, from GAME.C line 2153)
let _paletteRedAdd = 0;
let _paletteGreenAdd = 0;
let _paletteBlueAdd = 0;

// White-out flash for mine destruction (0.0 to 1.0)
let _whiteFlashAlpha = 0;
let _countdownSecondsLeft = - 1;	// Reactor self-destruct countdown ("T-%d s"), -1 = inactive

// --- Homing missile warning ---
// Ported from: GAUGES.C lines 809-870

let _homingObjectDist = - 1;	// Distance of nearest homing weapon (-1 = none)
let _lastWarningBeepTime = 0;	// GameTime when we last played the warning beep
let _gameTime = 0;				// Current game time for blinking
let _playerDead = false;		// Don't show warning when dead
let _endlevelActive = false;	// End-level flythrough suppresses homing warnings
let _playerExploded = false;	// True after death explosion starts (for "press any key" message)
let _digi_play_sample = null;	// Sound callback (injected to avoid circular imports)
let _SOUND_HOMING_WARNING = - 1;	// Sound ID for homing warning beep

// --- Cloak/Invulnerability state ---
// Ported from: hud_show_cloak_invuln() in GAUGES.C lines 1010-1036
let _cloakTimeRemaining = 0;		// Seconds remaining, 0 = not cloaked
let _invulnerableTimeRemaining = 0;	// Seconds remaining, 0 = not invulnerable

// --- Score popup state ---
// Ported from: hud_show_score_added() in GAUGES.C lines 667-701
let _scoreDisplay = 0;		// Points being shown in popup
let _scoreTime = 0;			// Remaining display time (seconds)


// ===========================================================================
// Public API
// ===========================================================================

export function gauges_init( camera, pigFile, palette ) {

	_pigFile = pigFile;
	_palette = palette;

	// Off-screen canvas at scaled resolution for crisp text
	_canvas = document.createElement( 'canvas' );
	_canvas.width = COCKPIT_W * COCKPIT_SCALE;
	_canvas.height = COCKPIT_H * COCKPIT_SCALE;
	_ctx = _canvas.getContext( '2d' );

	// Disable image smoothing for crisp pixel-art bitmaps
	_ctx.imageSmoothingEnabled = false;

	// Create CanvasTexture
	_texture = new THREE.CanvasTexture( _canvas );
	_texture.minFilter = THREE.NearestFilter;
	_texture.magFilter = THREE.NearestFilter;
	_texture.colorSpace = THREE.SRGBColorSpace;

	// Fullscreen plane — child of camera
	const geometry = new THREE.PlaneGeometry( 1, 1 );
	const material = new THREE.MeshBasicMaterial( {
		map: _texture,
		transparent: true,
		depthTest: false,
		depthWrite: false
	} );

	_mesh = new THREE.Mesh( geometry, material );
	_mesh.frustumCulled = false;

	// HUD overlay scene with orthographic camera
	_hudScene = new THREE.Scene();
	_hudCamera = new THREE.OrthographicCamera( - 0.5, 0.5, 0.5, - 0.5, 0.1, 10 );
	_hudCamera.position.z = 1;
	_hudScene.add( _mesh );

	// Pre-cache cockpit bitmap
	_cockpitDrawn = false;
	_dirty = true;

}

export function gauges_update( state ) {

	if ( state.shields !== undefined && state.shields !== _shields ) { _shields = state.shields; _dirty = true; }
	if ( state.energy !== undefined && state.energy !== _energy ) { _energy = state.energy; _dirty = true; }
	if ( state.primaryWeapon !== undefined && state.primaryWeapon !== _primaryWeapon ) { _primaryWeapon = state.primaryWeapon; _dirty = true; }
	if ( state.secondaryWeapon !== undefined && state.secondaryWeapon !== _secondaryWeapon ) { _secondaryWeapon = state.secondaryWeapon; _dirty = true; }
	if ( state.missileGun !== undefined && state.missileGun !== _missileGun ) { _missileGun = state.missileGun; _dirty = true; }
	if ( state.laserLevel !== undefined && state.laserLevel !== _laserLevel ) { _laserLevel = state.laserLevel; _dirty = true; }
	if ( state.vulcanAmmo !== undefined && state.vulcanAmmo !== _vulcanAmmo ) { _vulcanAmmo = state.vulcanAmmo; _dirty = true; }

	if ( state.secondaryAmmo !== undefined ) {

		for ( let i = 0; i < 5; i ++ ) {

			if ( state.secondaryAmmo[ i ] !== _secondaryAmmo[ i ] ) {

				_secondaryAmmo[ i ] = state.secondaryAmmo[ i ];
				_dirty = true;

			}

		}

	}

	if ( state.quadLasers !== undefined && state.quadLasers !== _quadLasers ) { _quadLasers = state.quadLasers; _dirty = true; }
	if ( state.keysBlue !== undefined && state.keysBlue !== _keysBlue ) { _keysBlue = state.keysBlue; _dirty = true; }
	if ( state.keysRed !== undefined && state.keysRed !== _keysRed ) { _keysRed = state.keysRed; _dirty = true; }
	if ( state.keysGold !== undefined && state.keysGold !== _keysGold ) { _keysGold = state.keysGold; _dirty = true; }
	if ( state.score !== undefined && state.score !== _score ) { _score = state.score; _dirty = true; }
	if ( state.lives !== undefined && state.lives !== _lives ) { _lives = state.lives; _dirty = true; }
	if ( state.playerDead !== undefined && state.playerDead !== _playerDead ) { _playerDead = state.playerDead; _dirty = true; }
	if ( state.playerExploded !== undefined && state.playerExploded !== _playerExploded ) { _playerExploded = state.playerExploded; _dirty = true; }

	// These update without setting dirty — their active states are checked in gauges_draw()
	if ( state.homingObjectDist !== undefined ) _homingObjectDist = state.homingObjectDist;
	if ( state.gameTime !== undefined ) _gameTime = state.gameTime;
	if ( state.cloakTimeRemaining !== undefined ) _cloakTimeRemaining = state.cloakTimeRemaining;
	if ( state.invulnerableTimeRemaining !== undefined ) _invulnerableTimeRemaining = state.invulnerableTimeRemaining;

}

export function gauges_set_externals( ext ) {

	if ( ext.digi_play_sample !== undefined ) _digi_play_sample = ext.digi_play_sample;
	if ( ext.SOUND_HOMING_WARNING !== undefined ) _SOUND_HOMING_WARNING = ext.SOUND_HOMING_WARNING;

}

// Add points to score popup display
// Ported from: add_points_to_score() in GAUGES.C lines 1179-1219
export function gauges_add_score_points( points ) {

	_scoreTime += 2.0;		// Add 2 seconds display time
	_scoreDisplay += points;
	if ( _scoreTime > 4.0 ) _scoreTime = 4.0;	// Cap at 4 seconds
	_dirty = true;

}

export function gauges_flash_damage( color ) {

	// Ported from: PALETTE_FLASH_ADD in COLLIDE.C
	// Each hit adds ~20 units to palette (f2i(damage*4) where typical damage=5)
	// Decay at DIMINISH_RATE (16) units/sec matches original fade timing
	if ( color === 'blue' ) {

		_paletteBlueAdd += 20;

	} else {

		_paletteRedAdd += 20;

	}

	_dirty = true;

}

// Set persistent white flash overlay (0.0 = none, 1.0 = fully white)
// Used for mine destruction white-out effect
// Set cockpit mode (called from game.js when F3/H changes mode)
// Ported from: select_cockpit() in GAME.C
export function gauges_set_cockpit_mode( mode ) {

	if ( mode !== _cockpitMode ) {

		_cockpitMode = mode;
		_cockpitDrawn = false; // Force redraw of cockpit background
		_dirty = true;

	}

}

// Expose canvas context for other modules (e.g. game.js) to draw HUD elements
// that originate from their respective C source files (Golden Rule #1)
export function gauges_get_canvas_ctx() { return _ctx; }
export function gauges_mark_dirty() { _dirty = true; }
export function gauges_needs_upload() { if ( _texture !== null ) _texture.needsUpdate = true; }

export function gauges_set_white_flash( alpha ) {

	if ( alpha !== _whiteFlashAlpha ) {

		_whiteFlashAlpha = alpha;
		_dirty = true;

	}

}

// Reactor self-destruct countdown seconds ("T-%d s" gauge); -1 = inactive.
// Ported from: render_countdown_gauge() in GAME.C lines 1395-1407
export function gauges_set_countdown_seconds( secs ) {

	if ( secs !== _countdownSecondsLeft ) {

		_countdownSecondsLeft = secs;
		_dirty = true;

	}

}

// Draw the reactor self-destruct countdown ("T-%d s") near the top of the screen.
// Ported from: render_countdown_gauge() in GAME.C lines 1395-1407
//   gr_set_fontcolor( gr_getcolor( 0, 63, 0 ), -1 ); gr_printf( 0x8000, y, "T-%d s", Fuelcen_seconds_left );
function drawCountdownGauge( ctx ) {

	if ( _countdownSecondsLeft < 0 || _countdownSecondsLeft >= 127 ) return;

	ctx.fillStyle = '#00fc00';	// gr_getcolor( 0, 63, 0 )
	ctx.font = 'bold 8px monospace';
	ctx.textAlign = 'center';
	ctx.fillText( 'T-' + _countdownSecondsLeft + ' s', COCKPIT_W / 2, 20 );
	ctx.textAlign = 'left';

}

export function gauges_draw( dt, endlevelActive = false ) {

	if ( _ctx === null ) return;

	if ( endlevelActive !== _endlevelActive ) {

		_endlevelActive = endlevelActive;
		_dirty = true;

	}

	// --- Always update timers (regardless of dirty state) ---

	// Diminish palette effects toward normal
	// Ported from: diminish_palette_towards_normal() in GAME.C lines 2157-2184
	if ( _paletteRedAdd > 0 || _paletteGreenAdd > 0 || _paletteBlueAdd > 0 ) {

		const dec = DIMINISH_RATE * dt;
		if ( _paletteRedAdd > 0 ) { _paletteRedAdd -= dec; if ( _paletteRedAdd < 0 ) _paletteRedAdd = 0; }
		if ( _paletteGreenAdd > 0 ) { _paletteGreenAdd -= dec; if ( _paletteGreenAdd < 0 ) _paletteGreenAdd = 0; }
		if ( _paletteBlueAdd > 0 ) { _paletteBlueAdd -= dec; if ( _paletteBlueAdd < 0 ) _paletteBlueAdd = 0; }
		_dirty = true;

	}

	if ( _scoreTime > 0 ) {

		_scoreTime -= dt;
		if ( _scoreTime <= 0 ) { _scoreTime = 0; _scoreDisplay = 0; }
		_dirty = true;

	}

	hud_update_timers( dt );

	// --- Always play homing warning beep (audio, independent of draw) ---
	playHomingWarningBeep();

	// --- Check for animated elements that need redraw ---

	if ( _homingObjectDist >= 0 && _playerDead !== true && _endlevelActive !== true ) _dirty = true;
	if ( _cloakTimeRemaining > 0 ) _dirty = true;
	if ( _invulnerableTimeRemaining > 0 ) _dirty = true;
	if ( _whiteFlashAlpha > 0 ) _dirty = true;
	if ( _playerExploded === true ) _dirty = true;
	if ( hud_has_messages() === true ) _dirty = true;

	// Skip canvas redraw and GPU upload if nothing changed
	if ( _dirty !== true ) return;
	_dirty = false;

	// --- Canvas redraw ---

	const ctx = _ctx;

	// Clear canvas at full resolution
	ctx.clearRect( 0, 0, _canvas.width, _canvas.height );

	// Apply scale so all drawing uses 320x200 logical coordinates
	ctx.save();
	ctx.setTransform( COCKPIT_SCALE, 0, 0, COCKPIT_SCALE, 0, 0 );
	ctx.imageSmoothingEnabled = false;

	// Draw cockpit or full-screen mode
	// Ported from: draw_hud() / render_gauges() in GAME.C and GAUGES.C
	if ( _cockpitMode === CM_REAR_VIEW ) {

		// Rear view: draw cockpit background only, no gauges
		// Ported from: draw_hud() in GAUGES.C lines 2067-2120
		// Original skips all HUD elements when Rear_view or CM_REAR_VIEW
		drawCockpitBackground( ctx );

		ctx.fillStyle = '#00ff00';
		ctx.font = 'bold 10px monospace';
		ctx.textAlign = 'center';
		ctx.fillText( 'REAR VIEW', COCKPIT_W / 2, COCKPIT_H - 75 );
		ctx.textAlign = 'left';

	} else if ( _cockpitMode === CM_FULL_COCKPIT ) {

		// Full cockpit: draw cockpit frame and all gauges
		drawCockpitBackground( ctx );
		drawShieldGauge( ctx );
		drawEnergyBars( ctx );
		drawNumericalDisplay( ctx );
		drawKeys( ctx );
		drawPlayerShip( ctx );
		drawWeaponInfo( ctx, 0 );
		drawWeaponInfo( ctx, 1 );
		drawHomingWarning( ctx );

	} else if ( _cockpitMode === CM_STATUS_BAR ) {

		drawStatusBarHUD( ctx );

	} else {

		// Full screen mode: draw compact text-based HUD info instead of cockpit
		drawFullScreenHUD( ctx );

	}

	if ( _cockpitMode !== CM_REAR_VIEW ) {

		// Draw reticle at center of game view (not cockpit center)
		drawReticle( ctx );

		// Draw score and lives (top area, above cockpit)
		drawScoreLives( ctx );

		// Draw cloak/invulnerability indicators
		// Ported from: hud_show_cloak_invuln() in GAUGES.C lines 1010-1036
		drawCloakInvulnIndicators( ctx );

		// Draw score popup
		// Ported from: hud_show_score_added() in GAUGES.C lines 667-701
		drawScorePopup( ctx );

	}

	// Draw reactor self-destruct countdown timer ("T-%d s")
	// Ported from: render_countdown_gauge() in GAME.C lines 1395-1407
	drawCountdownGauge( ctx );

	// Draw "press any key" message during death
	// Ported from: player_dead_message() in HUD.C lines 320-332
	drawPlayerDeadMessage( ctx );

	// Draw HUD messages
	hud_draw_messages( ctx, _cockpitMode );

	// Damage flash (palette effect)
	// Ported from: gr_palette_step_up() — palette add values map to overlay alpha
	if ( _paletteRedAdd > 0 || _paletteBlueAdd > 0 ) {

		// Max palette add ~64 maps to ~0.5 alpha overlay
		const r = Math.min( _paletteRedAdd / 64.0, 1.0 );
		const b = Math.min( _paletteBlueAdd / 64.0, 1.0 );
		const alpha = Math.max( r, b ) * 0.4;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = ( b > r ) ? '#0044ff' : '#ff0000';
		ctx.fillRect( 0, 0, COCKPIT_W, COCKPIT_H );
		ctx.globalAlpha = 1.0;

	}

	// White-out flash (mine destruction)
	// Ported from: FUELCEN.C PALETTE_FLASH_SET
	if ( _whiteFlashAlpha > 0 ) {

		ctx.globalAlpha = Math.min( _whiteFlashAlpha, 1.0 );
		ctx.fillStyle = '#ffffff';
		ctx.fillRect( 0, 0, COCKPIT_W, COCKPIT_H );
		ctx.globalAlpha = 1.0;

	}

	ctx.restore();

	_texture.needsUpdate = true;

}

// ===========================================================================
// Internal: Bitmap rendering
// ===========================================================================

// Get or create an ImageData for a PIG bitmap
function getBitmapImageData( pigBitmapIndex ) {

	if ( pigBitmapIndex < 0 ) return null;
	if ( _bitmapCache.has( pigBitmapIndex ) ) return _bitmapCache.get( pigBitmapIndex );

	if ( _pigFile === null || _palette === null ) return null;

	const pixels = _pigFile.getBitmapPixels( pigBitmapIndex );
	if ( pixels === null ) return null;

	const bm = _pigFile.bitmaps[ pigBitmapIndex ];
	const w = bm.width;
	const h = bm.height;

	const imageData = _ctx.createImageData( w, h );
	const data = imageData.data;

	for ( let i = 0; i < w * h; i ++ ) {

		const palIdx = pixels[ i ];

		if ( palIdx === 255 ) {

			// Transparent
			data[ i * 4 + 0 ] = 0;
			data[ i * 4 + 1 ] = 0;
			data[ i * 4 + 2 ] = 0;
			data[ i * 4 + 3 ] = 0;

		} else {

			data[ i * 4 + 0 ] = _palette[ palIdx * 3 + 0 ];
			data[ i * 4 + 1 ] = _palette[ palIdx * 3 + 1 ];
			data[ i * 4 + 2 ] = _palette[ palIdx * 3 + 2 ];
			data[ i * 4 + 3 ] = 255;

		}

	}

	_bitmapCache.set( pigBitmapIndex, imageData );
	return imageData;

}

// Get or create a cached canvas element for a PIG bitmap (for use with drawImage)
function getBitmapCanvas( pigBitmapIndex ) {

	const key = 'canvas_' + pigBitmapIndex;
	let cached = _bitmapCache.get( key );

	if ( cached !== undefined ) return cached;

	const imageData = getBitmapImageData( pigBitmapIndex );
	if ( imageData === null ) return null;

	const tempCanvas = document.createElement( 'canvas' );
	tempCanvas.width = imageData.width;
	tempCanvas.height = imageData.height;
	const tempCtx = tempCanvas.getContext( '2d' );
	tempCtx.putImageData( imageData, 0, 0 );
	cached = tempCanvas;
	_bitmapCache.set( key, cached );

	return cached;

}

// Draw a PIG bitmap at position (x, y) — uses drawImage to respect canvas transforms
function drawBitmap( ctx, pigBitmapIndex, x, y ) {

	const bitmapCanvas = getBitmapCanvas( pigBitmapIndex );
	if ( bitmapCanvas === null ) return;

	ctx.drawImage( bitmapCanvas, x, y );

}

// Draw a PIG bitmap using drawImage (supports compositing/transparency)
function drawBitmapComposited( ctx, pigBitmapIndex, x, y ) {

	drawBitmap( ctx, pigBitmapIndex, x, y );

}

// ===========================================================================
// Internal: Drawing functions
// ===========================================================================

// Draw compact text HUD for full screen mode (no cockpit frame)
// Ported from: GAUGES.C render_gauges() — CM_FULL_SCREEN draws text-based info
function drawFullScreenHUD( ctx ) {

	ctx.font = 'bold 8px monospace';

	// Shield/Energy numbers (bottom-left)
	const shield = Math.max( 0, Math.floor( _shields ) );
	const energy = Math.max( 0, Math.floor( _energy ) );

	// C always draws these green (gr_getcolor(0,31,0)); there is no low-value warning color.
	// Ported from: hud_show_shield()/hud_show_energy() in GAUGES.C:904, 1038
	ctx.fillStyle = '#00ff00';
	ctx.textAlign = 'left';
	ctx.fillText( 'SHIELD: ' + shield, 4, COCKPIT_H - 18 );
	ctx.fillText( 'ENERGY: ' + energy, 4, COCKPIT_H - 8 );

	// Key indicators (bottom-left, above shield/energy)
	let keyY = COCKPIT_H - 30;
	if ( _keysBlue === true ) { ctx.fillStyle = '#4444ff'; ctx.fillText( 'BLUE', 4, keyY ); keyY -= 10; }
	if ( _keysGold === true ) { ctx.fillStyle = '#ffff00'; ctx.fillText( 'GOLD', 4, keyY ); keyY -= 10; }
	if ( _keysRed === true ) { ctx.fillStyle = '#ff0000'; ctx.fillText( 'RED', 4, keyY ); }

	// Hostage progress for the current level.
	const levelHostages = hostage_get_in_level();
	if ( levelHostages > 0 ) {

		ctx.fillStyle = '#00cc00';
		ctx.fillText( 'HOSTAGES: ' + hostage_get_level_saved() + '/' + levelHostages, 4, keyY - 10 );

	}

	// Primary weapon (bottom-right)
	// Ported from: GAUGES.C hud_show_weapons_mode() lines 948-954
	ctx.textAlign = 'right';
	ctx.fillStyle = '#00ff00';
	let primaryName = PRIMARY_NAMES[ _primaryWeapon ] || 'LASER';
	let primaryExtra = '';
	if ( _primaryWeapon === 0 ) {

		if ( _quadLasers === true ) primaryName = 'QUAD ' + primaryName;
		primaryExtra = ' ' + ( _laserLevel + 1 );

	} else if ( _primaryWeapon === 1 ) {

		primaryExtra = ' ' + _vulcanAmmo;

	}
	ctx.fillText( primaryName + primaryExtra, COCKPIT_W - 4, COCKPIT_H - 18 );

	// Secondary weapon (bottom-right)
	const secondaryName = ( SECONDARY_NAMES[ _secondaryWeapon ] || 'CONCUSSION' ).replace( '\n', ' ' );
	ctx.fillText( secondaryName + ' x' + _secondaryAmmo[ _secondaryWeapon ], COCKPIT_W - 4, COCKPIT_H - 8 );

	ctx.textAlign = 'left';

	// Homing warning still needed
	drawHomingWarning( ctx );

}

function drawStatusBarHUD( ctx ) {

	// Draw status bar background strip at the bottom of the 320x200 canvas.
	let barY = COCKPIT_H - 40;
	const sbCockpitIdx = cockpit_bitmap[ CM_STATUS_BAR ];

	if ( sbCockpitIdx >= 0 ) {

		const bm = getBitmapCanvas( sbCockpitIdx );
		if ( bm !== null ) {

			barY = COCKPIT_H - bm.height;
			ctx.drawImage( bm, 0, barY );

		} else {

			ctx.fillStyle = '#000000';
			ctx.fillRect( 0, barY, COCKPIT_W, 40 );

		}

	} else {

		ctx.fillStyle = '#000000';
		ctx.fillRect( 0, barY, COCKPIT_W, 40 );

	}

	// Status bar key icons use SB_GAUGE_* assets.
	const sbBlueIdx = Gauges[ _keysBlue === true ? SB_GAUGE_BLUE_KEY : SB_GAUGE_BLUE_KEY_OFF ];
	const sbGoldIdx = Gauges[ _keysGold === true ? SB_GAUGE_GOLD_KEY : SB_GAUGE_GOLD_KEY_OFF ];
	const sbRedIdx = Gauges[ _keysRed === true ? SB_GAUGE_RED_KEY : SB_GAUGE_RED_KEY_OFF ];

	if ( sbBlueIdx >= 0 ) drawBitmapComposited( ctx, sbBlueIdx, 6, barY + 7 );
	if ( sbGoldIdx >= 0 ) drawBitmapComposited( ctx, sbGoldIdx, 19, barY + 7 );
	if ( sbRedIdx >= 0 ) drawBitmapComposited( ctx, sbRedIdx, 32, barY + 7 );

	// Optional status bar energy frame bitmap from original gauge table.
	const sbEnergyIdx = Gauges[ SB_GAUGE_ENERGY ];
	if ( sbEnergyIdx >= 0 ) drawBitmapComposited( ctx, sbEnergyIdx, 48, barY + 5 );

	ctx.font = '6px monospace';
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	ctx.fillStyle = '#00cc00';
	ctx.fillText( 'SH ' + Math.max( 0, Math.floor( _shields ) ), 52, barY + 7 );
	ctx.fillText( 'EN ' + Math.max( 0, Math.floor( _energy ) ), 52, barY + 15 );

	const levelHostages = hostage_get_in_level();
	if ( levelHostages > 0 ) {

		ctx.fillText( 'HO ' + hostage_get_level_saved() + '/' + levelHostages, 52, barY + 23 );

	}

	// Compact weapon text at right side.
	let primaryName = PRIMARY_NAMES[ _primaryWeapon ] || 'LASER';
	if ( _primaryWeapon === 0 && _quadLasers === true ) primaryName = 'QUAD';
	if ( _primaryWeapon === 1 ) primaryName = 'VUL ' + _vulcanAmmo;

	const secondaryName = ( SECONDARY_NAMES[ _secondaryWeapon ] || 'CONCUSSION' ).replace( '\n', ' ' );
	const secondaryAmmo = _secondaryAmmo[ _secondaryWeapon ];

	ctx.textAlign = 'right';
	ctx.fillText( primaryName, COCKPIT_W - 6, barY + 7 );
	ctx.fillText( secondaryName + ' x' + secondaryAmmo, COCKPIT_W - 6, barY + 15 );

	drawHomingWarning( ctx );

}

function drawCockpitBackground( ctx ) {

	const bmIdx = cockpit_bitmap[ _cockpitMode ];
	if ( bmIdx < 0 ) return;

	// The cockpit bitmap is 320x200 and fills the entire canvas
	// Use putImageData for the background (no compositing needed)
	drawBitmap( ctx, bmIdx, 0, 0 );

}

function drawShieldGauge( ctx ) {

	// Shield gauge bitmap: 10 levels (0-9)
	// bm_num = shield>=100 ? 9 : (shield/10)
	// Display: GAUGE_SHIELDS + (9 - bm_num)
	const shield = Math.max( 0, Math.min( 200, _shields ) );
	const bm_num = shield >= 100 ? 9 : Math.floor( shield / 10 );
	const gaugeIdx = Gauges[ GAUGE_SHIELDS + 9 - bm_num ];

	if ( gaugeIdx >= 0 ) {

		drawBitmapComposited( ctx, gaugeIdx, SHIELD_GAUGE_X, SHIELD_GAUGE_Y );

	}

}

function drawEnergyBars( ctx ) {

	// Left energy bar: draw full bar bitmap, then black out empty portion
	const leftIdx = Gauges[ GAUGE_ENERGY_LEFT ];
	const rightIdx = Gauges[ GAUGE_ENERGY_RIGHT ];

	if ( leftIdx < 0 || rightIdx < 0 ) return;

	const energy = Math.max( 0, Math.min( 100, _energy ) );

	// Draw left energy bar
	drawBitmapComposited( ctx, leftIdx, LEFT_ENERGY_GAUGE_X, LEFT_ENERGY_GAUGE_Y );

	// Black out the empty portion from the top
	// not_energy = 61 - (energy * 61) / 100 in original (but bars are 64x8)
	const not_energy_left = Math.floor( 64 - ( energy * 64 ) / 100 );

	if ( not_energy_left > 0 ) {

		ctx.fillStyle = '#000000';

		// Left bar fills from right to left, so black out from left
		ctx.fillRect( LEFT_ENERGY_GAUGE_X, LEFT_ENERGY_GAUGE_Y, not_energy_left, LEFT_ENERGY_GAUGE_H );

	}

	// Draw right energy bar
	drawBitmapComposited( ctx, rightIdx, RIGHT_ENERGY_GAUGE_X, RIGHT_ENERGY_GAUGE_Y );

	// Right bar fills from left to right, black out from right
	if ( not_energy_left > 0 ) {

		ctx.fillStyle = '#000000';
		const rw = 64;
		ctx.fillRect( RIGHT_ENERGY_GAUGE_X + rw - not_energy_left, RIGHT_ENERGY_GAUGE_Y,
			not_energy_left, LEFT_ENERGY_GAUGE_H );

	}

}

function drawNumericalDisplay( ctx ) {

	// Numerical gauge shows shield and energy numbers
	const numIdx = Gauges[ GAUGE_NUMERICAL ];
	if ( numIdx < 0 ) return;

	drawBitmapComposited( ctx, numIdx, NUMERICAL_GAUGE_X, NUMERICAL_GAUGE_Y );

	// Draw energy number at top (orange color: palette 25,18,6)
	// Ported from: GAUGES.C draw_numerical_display() line 1436 — energy at y=2
	const energyVal = Math.max( 0, Math.ceil( _energy ) );
	ctx.font = '7px monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.fillStyle = 'rgb(204,148,49)';
	ctx.fillText( String( energyVal ), NUMERICAL_GAUGE_X + 9, NUMERICAL_GAUGE_Y + 3 );

	// Draw shield number at bottom (blue-ish color: palette 14,14,23 scaled to 0-255)
	// Ported from: GAUGES.C draw_numerical_display() line 1433 — shield at y=15
	const shieldVal = Math.max( 0, Math.ceil( _shields ) );
	ctx.fillStyle = 'rgb(114,114,188)';
	ctx.fillText( String( shieldVal ), NUMERICAL_GAUGE_X + 9, NUMERICAL_GAUGE_Y + 13 );

}

function drawKeys( ctx ) {

	// Blue key
	const blueIdx = Gauges[ _keysBlue === true ? GAUGE_BLUE_KEY : GAUGE_BLUE_KEY + 3 ];
	if ( blueIdx >= 0 ) drawBitmapComposited( ctx, blueIdx, GAUGE_BLUE_KEY_X, GAUGE_BLUE_KEY_Y );

	// Gold key
	const goldIdx = Gauges[ _keysGold === true ? GAUGE_GOLD_KEY : GAUGE_GOLD_KEY + 3 ];
	if ( goldIdx >= 0 ) drawBitmapComposited( ctx, goldIdx, GAUGE_GOLD_KEY_X, GAUGE_GOLD_KEY_Y );

	// Red key
	const redIdx = Gauges[ _keysRed === true ? GAUGE_RED_KEY : GAUGE_RED_KEY + 3 ];
	if ( redIdx >= 0 ) drawBitmapComposited( ctx, redIdx, GAUGE_RED_KEY_X, GAUGE_RED_KEY_Y );

}

function drawPlayerShip( ctx ) {

	// Player ship icon inside shield gauge
	const shipIdx = Gauges[ GAUGE_SHIPS ];
	if ( shipIdx >= 0 ) {

		drawBitmapComposited( ctx, shipIdx, SHIP_GAUGE_X, SHIP_GAUGE_Y );

	}

}

function drawWeaponInfo( ctx, weaponType ) {

	// weaponType: 0 = primary, 1 = secondary
	let textX, textY, ammoX, ammoY;

	if ( weaponType === 0 ) {

		textX = PRIMARY_W_TEXT_X;
		textY = PRIMARY_W_TEXT_Y;
		ammoX = PRIMARY_AMMO_X;
		ammoY = PRIMARY_AMMO_Y;

	} else {

		textX = SECONDARY_W_TEXT_X;
		textY = SECONDARY_W_TEXT_Y;
		ammoX = SECONDARY_AMMO_X;
		ammoY = SECONDARY_AMMO_Y;

	}

	ctx.font = '5px monospace';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#00cc00';

	if ( weaponType === 0 ) {

		// Primary weapon name
		// Ported from: GAUGES.C draw_weapon_info_sub() lines 1498-1513
		let name = PRIMARY_NAMES[ _primaryWeapon ] || 'LASER';

		if ( _primaryWeapon === 0 ) {

			name += '\nLVL: ' + ( _laserLevel + 1 );

			// Show "QUAD" below level when player has quad lasers
			if ( _quadLasers === true ) {

				name += '\nQUAD';

			}

		}

		const lines = name.split( '\n' );

		for ( let i = 0; i < lines.length; i ++ ) {

			ctx.fillText( lines[ i ], textX, textY + i * 7 );

		}

		// Vulcan ammo
		if ( _primaryWeapon === 1 ) {

			ctx.fillStyle = '#cc0000';
			ctx.fillText( String( _vulcanAmmo ), ammoX, ammoY );

		}

	} else {

		// Secondary weapon name
		const name = SECONDARY_NAMES[ _secondaryWeapon ] || 'CONCUSSION\nMISSILE';
		const lines = name.split( '\n' );

		for ( let i = 0; i < lines.length; i ++ ) {

			ctx.fillText( lines[ i ], textX, textY + i * 7 );

		}

		// Ammo count
		ctx.fillStyle = '#cc0000';
		const ammo = _secondaryAmmo[ _secondaryWeapon ];
		ctx.textAlign = 'right';
		ctx.fillText( String( ammo ).padStart( 3, '0' ), ammoX + 14, ammoY );

	}

}

function drawReticle( ctx ) {

	// Draw reticle at center of game view
	// Ported from: GAUGES.C show_reticle() lines 1821-1869
	const cx = COCKPIT_W / 2;
	// In full cockpit mode, 3D viewport is top 70% — center at y=70 in 320x200 space.
	// In status bar mode, gameplay window is top 160px.
	let cy = COCKPIT_H / 2;
	if ( _cockpitMode === CM_FULL_COCKPIT || _cockpitMode === CM_REAR_VIEW ) cy = 70;
	if ( _cockpitMode === CM_STATUS_BAR ) cy = 80;

	// Determine primary weapon readiness (has energy/ammo)
	// Ported from: player_has_weapon() — check energy for energy weapons, ammo for vulcan
	let primaryReady = 0;

	if ( _primaryWeapon === 1 ) {

		// Vulcan uses ammo
		primaryReady = ( _vulcanAmmo > 0 ) ? 1 : 0;

	} else {

		// All other primaries use energy
		let energyCost = 1.0;
		const wiIndex = Primary_weapon_to_weapon_info[ _primaryWeapon ];

		if ( wiIndex !== undefined && Weapon_info[ wiIndex ] !== undefined ) {

			const eu = Weapon_info[ wiIndex ].energy_usage;
			if ( eu > 0 ) energyCost = eu;

		}

		primaryReady = ( _energy >= energyCost ) ? 1 : 0;

	}

	// Quad lasers: primary_bm_num goes to 2 when laser + quad + ready
	// Ported from: GAUGES.C line 1840
	if ( primaryReady > 0 && _primaryWeapon === 0 && _quadLasers === true ) {

		primaryReady = 2;

	}

	// Determine secondary weapon readiness (has ammo)
	// Ported from: GAUGES.C line 1838
	let secondaryReady = ( _secondaryAmmo[ _secondaryWeapon ] > 0 ) ? 1 : 0;

	// Adjust secondary bitmap index for weapon type
	// Ported from: GAUGES.C lines 1843-1846
	// Concussion (0) and Homing (1) use base indices 0-1
	// Others (Proximity=2, Smart=3, Mega=4) add 3 → indices 3-4
	if ( _secondaryWeapon !== 0 && _secondaryWeapon !== 1 ) {

		secondaryReady += 3;	// now 3 (not ready) or 4 (ready)

	} else if ( secondaryReady > 0 && ( _missileGun & 1 ) === 0 ) {

		// Concussion/Homing: show the alternate reticle frame for the gun that fires next.
		// Ported from: GAUGES.C:1846 — else if (secondary_bm_num && !(Missile_gun&1)) secondary_bm_num++;
		secondaryReady ++;

	}

	// Cross is lit if either primary or secondary is ready
	// Ported from: GAUGES.C line 1848
	const crossReady = ( primaryReady > 0 || secondaryReady > 0 ) ? 1 : 0;

	// Status bar mode uses the small reticle assets.
	const useSmallReticle = ( _cockpitMode === CM_STATUS_BAR );
	const crossBase = useSmallReticle === true ? SML_RETICLE_CROSS : RETICLE_CROSS;
	const primaryBase = useSmallReticle === true ? SML_RETICLE_PRIMARY : RETICLE_PRIMARY;
	const secondaryBase = useSmallReticle === true ? SML_RETICLE_SECONDARY : RETICLE_SECONDARY;

	const crossIdx = Gauges[ crossBase + crossReady ];
	if ( crossIdx >= 0 ) drawBitmapComposited( ctx, crossIdx, cx - 4, cy - 2 );

	const priIdx = Gauges[ primaryBase + primaryReady ];
	if ( priIdx >= 0 ) drawBitmapComposited( ctx, priIdx, cx - 15, cy + 6 );

	const secIdx = Gauges[ secondaryBase + secondaryReady ];
	if ( secIdx >= 0 ) drawBitmapComposited( ctx, secIdx, cx - 12, cy + 1 );

}

function drawScoreLives( ctx ) {

	// Status bar has its own compact bottom strip info.
	if ( _cockpitMode === CM_STATUS_BAR ) return;

	// Score (top right)
	ctx.font = '7px monospace';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#00cc00';
	ctx.fillText( 'SCORE: ' + _score, COCKPIT_W - 4, SCORE_Y );

	// Lives (top left) — show spare lives (total - 1)
	// Ported from: draw_player_lives() in GAUGES.C — displays (lives-1) spare ships
	const spareLives = _lives - 1;
	if ( spareLives > 0 ) {

		const livesIdx = Gauges[ GAUGE_LIVES ];

		if ( livesIdx >= 0 ) {

			drawBitmapComposited( ctx, livesIdx, 4, LIVES_Y );

		}

		ctx.textAlign = 'left';
		ctx.fillText( 'x ' + spareLives, 14, LIVES_Y );

	}

}

// --- Cloak/Invulnerability indicators ---
// Ported from: hud_show_cloak_invuln() in GAUGES.C lines 1010-1036

function drawCloakInvulnIndicators( ctx ) {

	ctx.save();
	ctx.font = '6px monospace';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';

	// Cloak indicator
	if ( _cloakTimeRemaining > 0 ) {

		// Show solid if > 3 seconds remaining, blink if <= 3 seconds
		// Blink toggles every 0.5s (1 Hz). Ported from: GAUGES.C line 1020 — (GameTime & 0x8000)
		const show = ( _cloakTimeRemaining > 3.0 ) || ( ( Math.floor( _gameTime * 2 ) & 1 ) === 0 );

		if ( show === true ) {

			ctx.fillStyle = '#00cc00';
			ctx.fillText( 'CLOAKED', 2, COCKPIT_H - 48 );

		}

	}

	// Invulnerability indicator
	if ( _invulnerableTimeRemaining > 0 ) {

		// Show solid if > 4 seconds remaining, blink if <= 4 seconds
		// Blink toggles every 0.5s (1 Hz). Ported from: GAUGES.C line 1031 — (GameTime & 0x8000)
		const show = ( _invulnerableTimeRemaining > 4.0 ) || ( ( Math.floor( _gameTime * 2 ) & 1 ) === 0 );

		if ( show === true ) {

			ctx.fillStyle = '#ffcc00';
			ctx.fillText( 'INVULNERABLE', 2, COCKPIT_H - 56 );

		}

	}

	ctx.restore();

}

// --- Score popup animation ---
// Ported from: hud_show_score_added() in GAUGES.C lines 667-701

function drawScorePopup( ctx ) {

	if ( _scoreDisplay === 0 || _scoreTime <= 0 ) return;

	// Color fades: green channel = floor(score_time * 20) + 10, clamped 10-31
	// Scale palette 0-31 to 0-255 for RGB
	let color = Math.floor( _scoreTime * 20 ) + 10;
	if ( color < 10 ) color = 10;
	if ( color > 31 ) color = 31;
	const green = Math.floor( ( color / 31 ) * 255 );

	ctx.save();
	ctx.font = '7px monospace';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'top';
	ctx.fillStyle = 'rgb(0,' + green + ',0)';
	ctx.fillText( String( _scoreDisplay ), COCKPIT_W - 14, 14 );
	ctx.restore();

}

// --- Player dead message ---
// Ported from: player_dead_message() in HUD.C lines 320-332

function drawPlayerDeadMessage( ctx ) {

	if ( _playerExploded !== true ) return;

	ctx.save();
	ctx.font = '6px monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#00cc00';
	ctx.fillText( 'PRESS ANY KEY TO CONTINUE', COCKPIT_W / 2, COCKPIT_H - 75 );
	ctx.restore();

}

// --- Homing missile warning display ---
// Ported from: show_homing_warning() + hud_show_homing_warning() in GAUGES.C lines 833-881

// Homing warning bitmap position (full cockpit)
// Ported from: GAUGES.C line 853 — gr_ubitmapm(7, 171, ...)
const HOMING_WARNING_X = 7;
const HOMING_WARNING_Y = 171;

function drawHomingWarning( ctx ) {

	if ( _playerDead === true || _endlevelActive === true ) return;

	if ( _homingObjectDist >= 0 ) {

		// Blink warning — use GameTime bit 0x4000 equivalent
		// In C: GameTime is F1_0 per second (65536), bit 0x4000 toggles ~2 Hz
		// In JS: _gameTime is seconds, so toggle every 0.25s
		const blink = ( Math.floor( _gameTime * 4 ) & 1 ) === 0;
		const warningY = ( _cockpitMode === CM_STATUS_BAR ) ? ( COCKPIT_H - 26 ) : HOMING_WARNING_Y;
		const lockY = ( _cockpitMode === CM_STATUS_BAR ) ? ( COCKPIT_H - 32 ) : ( COCKPIT_H - 75 );

		if ( blink === true ) {

			// Draw "ON" warning bitmap at cockpit position
			drawBitmap( ctx, Gauges[ GAUGE_HOMING_WARNING_ON ], HOMING_WARNING_X, warningY );

			// Draw "LOCK" text at bottom center of view
			// Ported from: hud_show_homing_warning() in GAUGES.C line 871
			ctx.save();
			ctx.font = '7px monospace';
			ctx.fillStyle = '#00ff00';
			ctx.textAlign = 'center';
			ctx.fillText( 'LOCK', COCKPIT_W / 2, lockY );
			ctx.restore();

		} else {

			// Draw "OFF" warning bitmap (blank indicator)
			drawBitmap( ctx, Gauges[ GAUGE_HOMING_WARNING_OFF ], HOMING_WARNING_X, warningY );

		}

	}

}

// Play homing warning beep sound — beep frequency inversely proportional to distance
// Ported from: play_homing_warning() in GAUGES.C lines 809-830
function playHomingWarningBeep() {

	if ( _endlevelActive === true || _playerDead === true ) return;
	if ( _homingObjectDist < 0 ) return;
	if ( _digi_play_sample === null ) return;

	// Beep delay scales with distance: closer = faster beeping
	// C: beep_delay = dist/128, clamped to [F1_0/8, F1_0] = [0.125s, 1.0s]
	let beepDelay = _homingObjectDist / 128.0;
	if ( beepDelay > 1.0 ) beepDelay = 1.0;
	if ( beepDelay < 0.125 ) beepDelay = 0.125;

	// Play beep every beepDelay/2 seconds
	if ( _gameTime - _lastWarningBeepTime > beepDelay / 2.0 ) {

		_digi_play_sample( _SOUND_HOMING_WARNING, 1.0 );
		_lastWarningBeepTime = _gameTime;

	}

}

// ===========================================================================
// Internal: Layout
// ===========================================================================

export function gauges_get_hud_scene() { return _hudScene; }
export function gauges_get_hud_camera() { return _hudCamera; }
