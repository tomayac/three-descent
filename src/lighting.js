// Ported from: descent-master/MAIN/LIGHTING.C
// RGB dynamic lighting enhancement (DXX-Rebirth style)

import {
	Vertices, Segments, Num_segments,
	GameTime, FrameCount
} from './mglobal.js';
import {
	MAX_VERTICES, MAX_VERTICES_PER_SEGMENT
} from './segment.js';
import { Vclips, Weapon_info, N_weapon_types, Powerup_info, N_powerup_types } from './bm.js';

// RGB per-vertex dynamic lighting: 3 floats (R, G, B) per vertex
const Dynamic_light = new Float32Array( MAX_VERTICES * 3 );

const render_vertices = new Int16Array( MAX_VERTICES );
const render_vertex_flags = new Uint8Array( MAX_VERTICES );
let n_render_vertices = 0;

const MIN_LIGHT_DIST = 4.0;

// D1's viewer light is an always-available soft radial headlight unless its
// brightness is explicitly disabled.  use_beam is zero in the shipped D1
// gameplay path, so object lighting depends only on viewer distance here.
const HEADLIGHT_BRIGHTNESS = 0.5;
const HEADLIGHT_MAX_DIST = 64.0;
const HEADLIGHT_MAX_DIST_SCALE = 32.0;
const OBJECT_LIGHT_RATE = 4.0;

const MUZZLE_QUEUE_MAX = 8;
const FLASH_LEN = 1.0 / 3.0;
const FLASH_SCALE = 3.0 / FLASH_LEN;

const Muzzle_data = [];

for ( let i = 0; i < MUZZLE_QUEUE_MAX; i ++ ) {

	Muzzle_data.push( { create_time: 0, segnum: 0, pos_x: 0, pos_y: 0, pos_z: 0 } );

}

let Muzzle_queue_head = 0;

// Raw 16.16-fix per-object flicker offsets (used with GameTime in the flare flicker XOR).
// Ported from: Obj_light_xlate[16] in LIGHTING.C:232
const Obj_light_xlate = [
	0x1234, 0x3321, 0x2468, 0x1735,
	0x0123, 0x19af, 0x3f03, 0x232a,
	0x2123, 0x39af, 0x0f03, 0x132a,
	0x3123, 0x29af, 0x1f03, 0x032a
];

// Time-varying flare flicker contribution, in light units.
// Ported from: LIGHTING.C:314 — (GameTime ^ Obj_light_xlate[objnum & 0xf]) & 0x3fff.
// GameTime is in seconds, so scale to 16.16 fix for the integer XOR/mask, then back.
function flare_flicker( idx ) {

	return ( ( ( GameTime * 65536 ) ^ Obj_light_xlate[ idx & 0x0f ] ) & 0x3fff ) / 65536;

}

let FLARE_ID = 9;
const PARENT_ROBOT = 1;

// Weapon type constants (matching laser.js)
const WEAPON_SPREADFIRE_INDEX = 12;
const WEAPON_SPREADFIRE_BLOB = 20;
const WEAPON_PLASMA_INDEX = 13;
const WEAPON_FUSION_INDEX = 14;
const WEAPON_CONCUSSION_INDEX = 8;
const WEAPON_HOMING_INDEX = 15;
const WEAPON_SMART_INDEX = 17;
const WEAPON_MEGA_INDEX = 18;
const WEAPON_SMART_HOMING_INDEX = 19;

// RGB light color table for weapon types (normalized 0-1)
// Pre-allocated arrays to avoid per-frame allocation (Golden Rule #5)
const _weaponColors = {
	robot:       [ 0.0, 1.0, 0.27 ],  // green (0x00ff44)
	laser:       [ 1.0, 0.27, 0.0 ],  // orange-red (0xff4400)
	spreadfire:  [ 1.0, 1.0, 0.0 ],   // bright yellow
	plasma:      [ 0.0, 0.53, 1.0 ],  // blue (0x0088ff)
	fusion:      [ 1.0, 0.0, 1.0 ],   // magenta
	concussion:  [ 1.0, 0.53, 0.0 ],  // orange
	homing:      [ 1.0, 0.4, 0.0 ],   // dark orange
	smart:       [ 1.0, 0.0, 1.0 ],   // magenta
	flare:       [ 1.0, 1.0, 0.67 ],  // warm yellow-white
	defaultCol:  [ 1.0, 0.27, 0.0 ]   // fallback = laser orange
};

// Static color arrays for non-weapon light sources (Golden Rule #5)
const _muzzleColor = [ 1.0, 0.8, 0.4 ];     // warm orange-yellow
const _explosionColor = [ 1.0, 0.6, 0.2 ];   // orange-fire
const _robotColor = [ 1.0, 0.8, 0.5 ];       // warm dim
const _powerupColor = [ 0.8, 1.0, 0.8 ];     // soft green-white
const _flareColor = _weaponColors.flare;      // reuse

function getWeaponLightColor( weapon_type, parent_type ) {

	if ( parent_type === PARENT_ROBOT ) return _weaponColors.robot;

	if ( weapon_type === WEAPON_SPREADFIRE_INDEX || weapon_type === WEAPON_SPREADFIRE_BLOB ) return _weaponColors.spreadfire;
	if ( weapon_type === WEAPON_PLASMA_INDEX ) return _weaponColors.plasma;
	if ( weapon_type === WEAPON_FUSION_INDEX ) return _weaponColors.fusion;
	if ( weapon_type === WEAPON_CONCUSSION_INDEX ) return _weaponColors.concussion;
	if ( weapon_type === WEAPON_HOMING_INDEX || weapon_type === WEAPON_SMART_HOMING_INDEX ) return _weaponColors.homing;
	if ( weapon_type === WEAPON_SMART_INDEX || weapon_type === WEAPON_MEGA_INDEX ) return _weaponColors.smart;
	if ( weapon_type === FLARE_ID ) return _weaponColors.flare;

	return _weaponColors.defaultCol;

}

let _getActiveExplosions = null;
let _getActiveWeapons = null;

export function lighting_set_externals( ext ) {

	if ( ext.getActiveExplosions !== undefined ) _getActiveExplosions = ext.getActiveExplosions;
	if ( ext.getActiveWeapons !== undefined ) _getActiveWeapons = ext.getActiveWeapons;
	if ( ext.FLARE_ID !== undefined ) FLARE_ID = ext.FLARE_ID;

}

function apply_light( obj_intensity, obj_seg, obj_x, obj_y, obj_z, cr, cg, cb ) {

	if ( obj_intensity <= 0 ) return;

	const obji_64 = obj_intensity * 64;

	// Dim sources: only process vertices in object's own segment
	if ( obji_64 <= 8.0 ) {

		if ( obj_seg < 0 || obj_seg >= Num_segments ) return;

		const seg = Segments[ obj_seg ];

		for ( let v = 0; v < MAX_VERTICES_PER_SEGMENT; v ++ ) {

			const vertnum = seg.verts[ v ];
			if ( vertnum < 0 ) continue;

			const vx = Vertices[ vertnum * 3 + 0 ];
			const vy = Vertices[ vertnum * 3 + 1 ];
			const vz = Vertices[ vertnum * 3 + 2 ];

			const dx = obj_x - vx;
			const dy = obj_y - vy;
			const dz = obj_z - vz;

			let dist = ( dx * dx + dy * dy + dz * dz ) / 16;

			if ( dist < obji_64 ) {

				if ( dist < MIN_LIGHT_DIST ) dist = MIN_LIGHT_DIST;
				const contribution = obj_intensity / dist;
				const vi3 = vertnum * 3;
				Dynamic_light[ vi3 + 0 ] += contribution * cr;
				Dynamic_light[ vi3 + 1 ] += contribution * cg;
				Dynamic_light[ vi3 + 2 ] += contribution * cb;

			}

		}

	} else {

		// Bright source: check all render vertices
		// Ported from: LIGHTING.C lines 188-203 — uses linear distance (no squaring)
		for ( let vv = 0; vv < n_render_vertices; vv ++ ) {

			const vertnum = render_vertices[ vv ];

			const vx = Vertices[ vertnum * 3 + 0 ];
			const vy = Vertices[ vertnum * 3 + 1 ];
			const vz = Vertices[ vertnum * 3 + 2 ];

			const dx = obj_x - vx;
			const dy = obj_y - vy;
			const dz = obj_z - vz;

			let dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

			if ( dist < obji_64 ) {

				if ( dist < MIN_LIGHT_DIST ) dist = MIN_LIGHT_DIST;
				const contribution = obj_intensity / dist;
				const vi3 = vertnum * 3;
				Dynamic_light[ vi3 + 0 ] += contribution * cr;
				Dynamic_light[ vi3 + 1 ] += contribution * cg;
				Dynamic_light[ vi3 + 2 ] += contribution * cb;

			}

		}

	}

}

function cast_muzzle_flash_light() {

	const current_time = GameTime;

	for ( let i = 0; i < MUZZLE_QUEUE_MAX; i ++ ) {

		if ( Muzzle_data[ i ].create_time > 0 ) {

			const time_since_flash = current_time - Muzzle_data[ i ].create_time;

			if ( time_since_flash < FLASH_LEN ) {

				const intensity = ( FLASH_LEN - time_since_flash ) * FLASH_SCALE;
				apply_light( intensity,
					Muzzle_data[ i ].segnum,
					Muzzle_data[ i ].pos_x,
					Muzzle_data[ i ].pos_y,
					Muzzle_data[ i ].pos_z,
					_muzzleColor[ 0 ], _muzzleColor[ 1 ], _muzzleColor[ 2 ] );

			} else {

				Muzzle_data[ i ].create_time = 0;

			}

		}

	}

}

export function lighting_add_muzzle_flash( pos_x, pos_y, pos_z, segnum ) {

	const m = Muzzle_data[ Muzzle_queue_head ];
	m.create_time = GameTime;
	m.segnum = segnum;
	m.pos_x = pos_x;
	m.pos_y = pos_y;
	m.pos_z = pos_z;

	Muzzle_queue_head = ( Muzzle_queue_head + 1 ) % MUZZLE_QUEUE_MAX;

}

export function set_dynamic_light( visibleSegments, robots, powerups, stuckFlares ) {

	// Build unique render vertex list from visible segments
	n_render_vertices = 0;
	render_vertex_flags.fill( 0 );

	for ( const segnum of visibleSegments ) {

		const seg = Segments[ segnum ];
		if ( seg === undefined ) continue;

		for ( let v = 0; v < MAX_VERTICES_PER_SEGMENT; v ++ ) {

			const vnum = seg.verts[ v ];
			if ( vnum < 0 ) continue;

			if ( render_vertex_flags[ vnum ] === 0 ) {

				render_vertex_flags[ vnum ] = 1;
				render_vertices[ n_render_vertices ] = vnum;
				n_render_vertices ++;

			}

		}

	}

	// Clear RGB channels for all render vertices
	for ( let i = 0; i < n_render_vertices; i ++ ) {

		const vi3 = render_vertices[ i ] * 3;
		Dynamic_light[ vi3 + 0 ] = 0;
		Dynamic_light[ vi3 + 1 ] = 0;
		Dynamic_light[ vi3 + 2 ] = 0;

	}

	cast_muzzle_flash_light();

	// Explosions
	if ( _getActiveExplosions !== null ) {

		const explosions = _getActiveExplosions();

		for ( let i = 0; i < explosions.length; i ++ ) {

			const e = explosions[ i ];
			if ( e.active !== true ) continue;

			const vc = Vclips[ e.vclipNum ];
			if ( vc === undefined ) continue;

			let obj_intensity;
			if ( e.lifeleft < 4.0 ) {

				obj_intensity = ( e.lifeleft / e.playTime ) * vc.light_value;

			} else {

				obj_intensity = vc.light_value;

			}

			if ( obj_intensity > 0 ) {

				apply_light( obj_intensity, - 1,
					e.sprite.position.x, e.sprite.position.y, - e.sprite.position.z,
					_explosionColor[ 0 ], _explosionColor[ 1 ], _explosionColor[ 2 ] );

			}

		}

	}

	// Weapons
	if ( _getActiveWeapons !== null ) {

		const weapons = _getActiveWeapons();

		for ( let i = 0; i < weapons.length; i ++ ) {

			const w = weapons[ i ];
			if ( w.active !== true ) continue;

			let obj_intensity = 0;

			if ( w.weapon_type < N_weapon_types ) {

				obj_intensity = Weapon_info[ w.weapon_type ].light;

			}

			// Flare: flickering light
			if ( w.weapon_type === FLARE_ID ) {

				const base = Math.min( obj_intensity, w.lifeleft );
				obj_intensity = 2 * ( base + flare_flicker( i ) );

			}

			if ( obj_intensity > 0 ) {

				const col = getWeaponLightColor( w.weapon_type, w.parent_type );
				apply_light( obj_intensity, w.segnum, w.pos_x, w.pos_y, w.pos_z,
					col[ 0 ], col[ 1 ], col[ 2 ] );

			}

		}

	}

	// Robots (constant F1_0/2)
	if ( robots !== null ) {

		for ( let i = 0; i < robots.length; i ++ ) {

			const robot = robots[ i ];
			if ( robot.alive !== true ) continue;

			apply_light( 0.5, robot.obj.segnum,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				_robotColor[ 0 ], _robotColor[ 1 ], _robotColor[ 2 ] );

		}

	}

	// Powerups
	if ( powerups !== null ) {

		for ( let i = 0; i < powerups.length; i ++ ) {

			const pu = powerups[ i ];
			if ( pu.alive !== true ) continue;
			if ( pu.obj === undefined ) continue;

			let obj_intensity = 0.333; // F1_0/3 default

			if ( pu.obj.id >= 0 && pu.obj.id < N_powerup_types ) {

				const pi = Powerup_info[ pu.obj.id ];
				if ( pi !== undefined && pi.light > 0 ) {

					obj_intensity = pi.light;

				}

			}

			if ( obj_intensity > 0 ) {

				apply_light( obj_intensity, pu.obj.segnum,
					pu.obj.pos_x, pu.obj.pos_y, pu.obj.pos_z,
					_powerupColor[ 0 ], _powerupColor[ 1 ], _powerupColor[ 2 ] );

			}

		}

	}

	// Stuck flares
	if ( stuckFlares !== null && stuckFlares.count > 0 ) {

		let baseFlareLight = 0;

		if ( FLARE_ID < N_weapon_types ) {

			baseFlareLight = Weapon_info[ FLARE_ID ].light;

		}

		for ( let i = 0; i < stuckFlares.count; i ++ ) {

			const f = stuckFlares.data[ i ];
			const base = Math.min( baseFlareLight, f.lifeleft );
			const obj_intensity = 2 * ( base + flare_flicker( f.idx ) );

			if ( obj_intensity > 0 ) {

				apply_light( obj_intensity, - 1, f.pos_x, f.pos_y, f.pos_z,
					_flareColor[ 0 ], _flareColor[ 1 ], _flareColor[ 2 ] );

			}

		}

	}

}

export function compute_seg_dynamic_light( segnum ) {

	if ( segnum < 0 || segnum >= Num_segments ) return 0;

	const seg = Segments[ segnum ];
	let sum = 0;

	// Average the R channel as a scalar approximation for object illumination
	for ( let v = 0; v < 8; v ++ ) {

		sum += Dynamic_light[ seg.verts[ v ] * 3 ];

	}

	return sum / 8;

}

function compute_headlight_light( pos_x, pos_y, pos_z, viewer_x, viewer_y, viewer_z ) {

	if ( Number.isFinite( viewer_x ) !== true || Number.isFinite( viewer_y ) !== true ||
		Number.isFinite( viewer_z ) !== true ) return 0;

	const dx = pos_x - viewer_x;
	const dy = pos_y - viewer_y;
	const dz = pos_z - viewer_z;
	const distance = Math.sqrt( dx * dx + dy * dy + dz * dz );
	if ( distance >= HEADLIGHT_MAX_DIST ) return 0;

	const distanceScale = ( HEADLIGHT_MAX_DIST - distance ) / HEADLIGHT_MAX_DIST_SCALE;
	// compute_object_light() passes F1_0 as face_light: 1/4 + face_light/2.
	return HEADLIGHT_BRIGHTNESS * distanceScale * 0.75;

}

// Compute D1's per-object light without allocating a color/result object.  The
// smoothed monochrome static component is stored on the logical runtime owner;
// RGB dynamic channels and the viewer headlight are added unsmoothed each frame.
// The caller reads objectLightR/G/B from state and applies them to its mesh.
export function compute_object_light( state, segnum, pos_x, pos_y, pos_z,
	viewer_x, viewer_y, viewer_z, frameTime, viewerToken ) {

	if ( state === null || state === undefined ) return false;

	let staticTarget = 0;
	if ( segnum >= 0 && segnum < Num_segments ) {

		staticTarget = Segments[ segnum ].static_light;

	}

	const signature = Number.isFinite( state.signature ) ? state.signature : 0;
	let staticLight = state._objectStaticLight;

	if ( state._objectLightSignature !== signature || state._objectLightViewer !== viewerToken ||
		Number.isFinite( staticLight ) !== true ) {

		staticLight = staticTarget;
		state._objectLightSignature = signature;
		state._objectLightViewer = viewerToken;

	} else {

		const delta = staticTarget - staticLight;
		const safeFrameTime = Number.isFinite( frameTime ) ? frameTime : 0;
		const frameDelta = OBJECT_LIGHT_RATE * Math.max( safeFrameTime, 0 );

		if ( Math.abs( delta ) <= frameDelta ) {

			staticLight = staticTarget;

		} else if ( delta < 0 ) {

			staticLight -= frameDelta;

		} else {

			staticLight += frameDelta;

		}

	}

	state._objectStaticLight = staticLight;

	let dynamicRed = 0;
	let dynamicGreen = 0;
	let dynamicBlue = 0;

	if ( segnum >= 0 && segnum < Num_segments ) {

		const seg = Segments[ segnum ];
		for ( let v = 0; v < 8; v ++ ) {

			const offset = seg.verts[ v ] * 3;
			dynamicRed += Dynamic_light[ offset + 0 ];
			dynamicGreen += Dynamic_light[ offset + 1 ];
			dynamicBlue += Dynamic_light[ offset + 2 ];

		}

		dynamicRed /= 8;
		dynamicGreen /= 8;
		dynamicBlue /= 8;

	}

	const headlight = compute_headlight_light(
		pos_x, pos_y, pos_z, viewer_x, viewer_y, viewer_z
	);
	state.objectLightR = staticLight + headlight + dynamicRed;
	state.objectLightG = staticLight + headlight + dynamicGreen;
	state.objectLightB = staticLight + headlight + dynamicBlue;
	return true;

}

export function get_dynamic_light() {

	return Dynamic_light;

}

export function lighting_init( scene ) {

	for ( let i = 0; i < MUZZLE_QUEUE_MAX; i ++ ) {

		Muzzle_data[ i ].create_time = 0;

	}

	Muzzle_queue_head = 0;
	Dynamic_light.fill( 0 );

}

export function lighting_frame( playerPos, robots, powerups, stuckFlares ) {

	// No-op: dynamic lighting handled by set_dynamic_light()

}

export function lighting_cleanup() {

	Dynamic_light.fill( 0 );
	n_render_vertices = 0;

	for ( let i = 0; i < MUZZLE_QUEUE_MAX; i ++ ) {

		Muzzle_data[ i ].create_time = 0;

	}

	Muzzle_queue_head = 0;

}
