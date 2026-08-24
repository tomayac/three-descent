// Ported from: descent-master/MAIN/LASER.C
// Laser/weapon creation, movement, and collision

import * as THREE from 'three';
import { GameTime, Segments } from './mglobal.js';
import { find_point_seg } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, HIT_WALL } from './fvi.js';
import { Weapon_info, Vclips, N_weapon_types,
	WEAPON_RENDER_NONE, WEAPON_RENDER_LASER, WEAPON_RENDER_BLOB, WEAPON_RENDER_POLYMODEL, WEAPON_RENDER_VCLIP,
	LASER_ID, CONCUSSION_ID, VULCAN_ID, SPREADFIRE_ID, PLASMA_ID, FUSION_ID,
	Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info } from './bm.js';
import { Polygon_models, buildModelMesh, polyobj_clone_model_mesh,
	polyobj_wrap_model_lod } from './polyobj.js';
import { phys_apply_force_to_player, phys_apply_rot } from './physics.js';
import { digi_play_sample, digi_play_sample_once, digi_play_sample_world,
	SOUND_GOOD_SELECTION_PRIMARY, SOUND_GOOD_SELECTION_SECONDARY,
	SOUND_ALREADY_SELECTED } from './digi.js';
import { OBJ_PLAYER } from './object.js';

// Parent type constants
export const PARENT_PLAYER = 0;
export const PARENT_ROBOT = 1;

// Constants
const MAX_WEAPONS = 50;
const NDL = 5;
const PLAYER_HIT_RADIUS = 3.0;

// Homing missile constants (from LASER.C / LASER.H)
const HOMING_MISSILE_STRAIGHT_TIME = 0.125;	// 1/8 second straight flight before tracking
const MIN_TRACKABLE_DOT = 0.75;				// Cone angle for target acquisition
const MAX_TRACKABLE_DIST = 250.0;			// Max tracking distance
const NUM_SMART_CHILDREN = 6;				// Children per smart bomb
const MAX_SMART_DISTANCE = 150.0;			// Smart bomb target search radius

// Weapon_info indices for special weapons
const WEAPON_SMART_INDEX = 17;				// Smart missile
const PLAYER_SMART_HOMING_ID = 19;		// Player smart homing child
const ROBOT_SMART_HOMING_ID = 29;		// Robot smart homing child
const WEAPON_MEGA_INDEX = 18;				// Mega missile
export const PROXIMITY_ID = 16;				// Proximity bomb (weapon_info index)
export const FLARE_ID = 9;					// Flare (weapon_info index)

// A proximity mine remains related to its owner through exactly two seconds.
const PROXIMITY_OWNER_IMMUNITY_TIME = 2.0;

// Player weapon state
export let Primary_weapon = 0;		// 0=laser, 1=vulcan, 2=spreadfire, 3=plasma, 4=fusion
export let Secondary_weapon = 0;	// 0=concussion, 1=homing, 2=proximity, 3=smart, 4=mega
let Next_laser_fire_time = 0;
let Next_missile_fire_time = 0;
let Last_laser_fire_time = 0;		// Tracks last successful fire (for stale-time reset)

// Ported from: WEAPON.H #define REARM_TIME (F1_0)
const REARM_TIME = 1.0;	// 1 second delay after switching weapons

// Spreadfire toggle: alternates between horizontal (0) and vertical (1) spread
// Ported from: LASER.C Spreadfire_toggle
let Spreadfire_toggle = 0;

// Weapon selection result codes
export const WEAPON_SELECT_CHANGED = 0;
export const WEAPON_SELECT_ALREADY = 1;
export const WEAPON_SELECT_UNAVAILABLE = - 1;

// Player weapon flags getter (set via laser_set_externals)
let _getPlayerPrimaryFlags = null;
let _getPlayerSecondaryFlags = null;
let _getPlayerSecondaryAmmo = null;

// Ported from: select_weapon() in WEAPON.C lines 306-357
// Returns: WEAPON_SELECT_CHANGED, WEAPON_SELECT_ALREADY, or WEAPON_SELECT_UNAVAILABLE
export function set_primary_weapon( w, waitForRearm ) {

	// do_weapon_select() validates ownership and ammo before select_weapon(),
	// including when the requested weapon is already selected.  Internal state
	// restoration calls omit waitForRearm and intentionally bypass this check.
	if ( waitForRearm === true ) {

		if ( _getPlayerPrimaryFlags !== null ) {

			const flags = _getPlayerPrimaryFlags();
			if ( ( flags & ( 1 << w ) ) === 0 ) return WEAPON_SELECT_UNAVAILABLE;

		}

		const weaponInfoIndex = Primary_weapon_to_weapon_info[ w ];
		if ( weaponInfoIndex === VULCAN_ID && _getVulcanAmmo !== null &&
			_getVulcanAmmo() < Weapon_info[ weaponInfoIndex ].ammo_usage ) {

			return WEAPON_SELECT_UNAVAILABLE;

		}

	}

	if ( Primary_weapon === w ) {

		if ( waitForRearm === true ) digi_play_sample( SOUND_ALREADY_SELECTED, 1.0 );
		return WEAPON_SELECT_ALREADY;

	}

	if ( waitForRearm === true ) {

		digi_play_sample_once( SOUND_GOOD_SELECTION_PRIMARY, 1.0 );
		Next_laser_fire_time = GameTime + REARM_TIME;

	}

	Primary_weapon = w;
	return WEAPON_SELECT_CHANGED;

}

// Ported from: select_weapon() in WEAPON.C lines 306-357
// Returns: WEAPON_SELECT_CHANGED, WEAPON_SELECT_ALREADY, or WEAPON_SELECT_UNAVAILABLE
export function set_secondary_weapon( w, waitForRearm ) {

	// Secondary selection requires the complete player_has_weapon() result:
	// ownership, ammunition, and energy.  Check it before the already-selected
	// cue, just as do_weapon_select() does in WEAPON.C.
	if ( waitForRearm === true ) {

		if ( _getPlayerSecondaryFlags !== null ) {

			const flags = _getPlayerSecondaryFlags();
			if ( ( flags & ( 1 << w ) ) === 0 ) return WEAPON_SELECT_UNAVAILABLE;

		}

		const weaponInfoIndex = Secondary_weapon_to_weapon_info[ w ];
		const weaponInfo = Weapon_info[ weaponInfoIndex ];
		if ( weaponInfo === undefined ) return WEAPON_SELECT_UNAVAILABLE;
		if ( _getPlayerSecondaryAmmo !== null &&
			_getPlayerSecondaryAmmo( w ) < weaponInfo.ammo_usage ) {

			return WEAPON_SELECT_UNAVAILABLE;

		}
		if ( _getPlayerEnergy !== null && _getPlayerEnergy() < weaponInfo.energy_usage ) {

			return WEAPON_SELECT_UNAVAILABLE;

		}

	}

	if ( Secondary_weapon === w ) {

		if ( waitForRearm === true ) digi_play_sample_once( SOUND_ALREADY_SELECTED, 1.0 );
		return WEAPON_SELECT_ALREADY;

	}

	if ( waitForRearm === true ) {

		digi_play_sample_once( SOUND_GOOD_SELECTION_SECONDARY, 1.0 );
		Next_missile_fire_time = GameTime + REARM_TIME;

	}

	Secondary_weapon = w;
	return WEAPON_SELECT_CHANGED;

}

// Weapon pool
const weapons = [];
let Weapon_next_signature = 0;


// PIG file and palette references (set via laser_set_externals)
let _pigFile = null;
let _palette = null;

// Texture cache: PIG bitmap index → THREE.DataTexture
const _weaponTextureCache = new Map();

// External references (set via laser_set_externals)
let _scene = null;
let _robots = null;
let _clutter = null;
let _debris = null;
let _onRobotHit = null;
let _onClutterHit = null;
let _onDebrisHit = null;
let _onPlayerHit = null;
let _onWallHit = null;
let _getPlayerPos = null;
let _getPlayerEnergy = null;
let _setPlayerEnergy = null;
let _getVulcanAmmo = null;
let _setVulcanAmmo = null;
let _getSecondaryAmmo = null;
let _setSecondaryAmmo = null;
let _onBadassExplosion = null;	// ( pos, segnum, damage, distance, visual, parent type/id )
let _onAutoSelectPrimary = null;
let _onAutoSelectSecondary = null;
let _onPlayerFiredLaser = null;	// ( weaponIndex, dir_x, dir_y, dir_z ) => void — notify AI of danger laser
let _getPlayerLaserLevel = null;
let _isPlayerCloaked = null;
let _getDifficultyLevel = null;
let _getPlayerVelocity = null;
let _getPlayerObject = null;

// D1 emits the local player's launch sound only after the weapon object has
// been created.  Keep this separate from the accepted-fire result so an
// exhausted object pool still consumes ammo/energy and advances weapon state
// without playing a phantom shot.
export function play_player_weapon_fire_sound( weaponInfoIndex ) {

	if ( weaponInfoIndex < 0 || weaponInfoIndex >= Weapon_info.length ) return;
	const wi = Weapon_info[ weaponInfoIndex ];
	if ( wi === undefined || wi.flash_sound < 0 ) return;

	digi_play_sample( wi.flash_sound, weaponInfoIndex === VULCAN_ID ? 0.5 : 1.0 );

}

// Pre-allocated working values (Golden Rule #5)
const _dirVec = new THREE.Vector3();
const _orientMatrix = new THREE.Matrix4();

// Pre-allocated result for ray-sphere intersection
const _sphereIntResult = { dist: 0, hit_x: 0, hit_y: 0, hit_z: 0 };

// Ray-sphere intersection test
// Ported from: check_vector_to_sphere_1() in FVI.C lines 664-724
// Tests line segment p0→p1 against sphere at sphere_pos with radius sphere_rad.
// Returns distance to intersection (>0 if hit), 0 if no hit.
// Hit point stored in _sphereIntResult.
function check_vector_to_sphere( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, sp_x, sp_y, sp_z, sphere_rad ) {

	// d = p1 - p0 (ray direction, unnormalized)
	const d_x = p1_x - p0_x;
	const d_y = p1_y - p0_y;
	const d_z = p1_z - p0_z;

	// w = sphere_pos - p0 (vector from ray origin to sphere center)
	const w_x = sp_x - p0_x;
	const w_y = sp_y - p0_y;
	const w_z = sp_z - p0_z;

	const mag_d = Math.sqrt( d_x * d_x + d_y * d_y + d_z * d_z );

	if ( mag_d < 0.0001 ) {

		// Zero-length segment: check if p0 is inside sphere
		const int_dist = Math.sqrt( w_x * w_x + w_y * w_y + w_z * w_z );
		_sphereIntResult.hit_x = p0_x;
		_sphereIntResult.hit_y = p0_y;
		_sphereIntResult.hit_z = p0_z;
		_sphereIntResult.dist = int_dist;
		return ( int_dist < sphere_rad ) ? int_dist : 0;

	}

	// Normalized ray direction
	const dn_x = d_x / mag_d;
	const dn_y = d_y / mag_d;
	const dn_z = d_z / mag_d;

	// Project w onto ray direction
	const w_dist = dn_x * w_x + dn_y * w_y + dn_z * w_z;

	if ( w_dist < 0 ) return 0;	// Moving away from sphere
	if ( w_dist > mag_d + sphere_rad ) return 0;	// Cannot reach sphere

	// Closest point on ray to sphere center
	const cp_x = p0_x + dn_x * w_dist;
	const cp_y = p0_y + dn_y * w_dist;
	const cp_z = p0_z + dn_z * w_dist;

	// Distance from closest point to sphere center
	const dx = cp_x - sp_x;
	const dy = cp_y - sp_y;
	const dz = cp_z - sp_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist < sphere_rad ) {

		const dist2 = dist * dist;
		const rad2 = sphere_rad * sphere_rad;
		const shorten = Math.sqrt( rad2 - dist2 );

		const int_dist = w_dist - shorten;

		if ( int_dist > mag_d || int_dist < 0 ) {

			// Inside sphere — don't move
			_sphereIntResult.hit_x = p0_x;
			_sphereIntResult.hit_y = p0_y;
			_sphereIntResult.hit_z = p0_z;
			_sphereIntResult.dist = 1;
			return 1;

		}

		// Intersection point
		_sphereIntResult.hit_x = p0_x + dn_x * int_dist;
		_sphereIntResult.hit_y = p0_y + dn_y * int_dist;
		_sphereIntResult.hit_z = p0_z + dn_z * int_dist;
		_sphereIntResult.dist = int_dist;
		return int_dist;

	}

	return 0;

}

// Cached weapon model meshes (weapon_type → THREE.Group template)
const _weaponModelCache = new Map();

function get_random_laser_offset() {

	// Ported from: LASER.C line 1127
	// Laser_offset = ((F1_0*2)*(rand()%10))/10 -> 0.0,0.2,...,1.8
	return 2.0 * ( Math.floor( Math.random() * 10 ) / 10.0 );

}

// Build a DataTexture from a PIG bitmap index (cached)
// Ported from draw_object_blob() which calls g3_draw_bitmap()
function getWeaponTexture( bitmapIndex ) {

	if ( _weaponTextureCache.has( bitmapIndex ) ) {

		return _weaponTextureCache.get( bitmapIndex );

	}

	if ( _pigFile === null || _palette === null ) return null;

	const pixels = _pigFile.getBitmapPixels( bitmapIndex );
	if ( pixels === null ) return null;

	const bm = _pigFile.bitmaps[ bitmapIndex ];
	const w = bm.width;
	const h = bm.height;
	const rgba = new Uint8Array( w * h * 4 );

	for ( let i = 0; i < w * h; i ++ ) {

		const palIdx = pixels[ i ];

		if ( palIdx === 255 ) {

			// Transparent pixel
			rgba[ i * 4 + 0 ] = 0;
			rgba[ i * 4 + 1 ] = 0;
			rgba[ i * 4 + 2 ] = 0;
			rgba[ i * 4 + 3 ] = 0;

		} else {

			rgba[ i * 4 + 0 ] = _palette[ palIdx * 3 + 0 ];
			rgba[ i * 4 + 1 ] = _palette[ palIdx * 3 + 1 ];
			rgba[ i * 4 + 2 ] = _palette[ palIdx * 3 + 2 ];
			rgba[ i * 4 + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( rgba, w, h );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestFilter;
	texture.needsUpdate = true;

	_weaponTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Build a weapon model mesh from POF data, with additive blending for glow
// Ported from: draw_polygon_object() for weapon rendering in OBJECT.C
function buildWeaponModelMesh( weapon_type ) {

	if ( _weaponModelCache.has( weapon_type ) ) {

		return polyobj_clone_model_mesh( _weaponModelCache.get( weapon_type ) );

	}

	if ( weapon_type >= N_weapon_types ) return null;

	const wi = Weapon_info[ weapon_type ];
	if ( wi.render_type !== WEAPON_RENDER_POLYMODEL ) return null;

	const model = Polygon_models[ wi.model_num ];
	if ( model === null || model === undefined ) return null;

	let group = buildModelMesh( model, _pigFile, _palette );
	if ( group === null ) return null;

	// Outer model: render opaque with original POF model colors
	// Ported from original Descent which rendered weapon polymodels as opaque flat-shaded polys.
	// The colors come from RGB 5-5-5 flat polys and textures in the POF model data.
	// We just ensure double-sided rendering — no additive blending needed for the outer model.
	group.traverse( ( child ) => {

		if ( child.isMesh === true ) {

			child.material = child.material.clone();
			child.material.side = THREE.DoubleSide;

		}

	} );
	group = polyobj_wrap_model_lod( group, model, _pigFile, _palette );

	// Inner model: D1 draws this through the same opaque polygon-model path as
	// the outer model.  It is a second geometric shell, not an additive sprite.
	if ( wi.model_num_inner >= 0 ) {

		const innerModel = Polygon_models[ wi.model_num_inner ];
		if ( innerModel !== null && innerModel !== undefined ) {

			const innerGroup = buildModelMesh( innerModel, _pigFile, _palette );
			if ( innerGroup !== null ) {

				innerGroup.userData.isWeaponInnerModel = true;

				group.add( innerGroup );

			}

		}

	}

	_weaponModelCache.set( weapon_type, group );
	return polyobj_clone_model_mesh( group );

}

// Construct the zero-bank fallback used by vm_vector_to_matrix().
// Ported from: VECMAT.C vm_vector_2_matrix() / vm_vector_to_matrix_f().
function setWeaponOrientationFromForward( w, fwd_x, fwd_y, fwd_z ) {

	const fmag = Math.sqrt( fwd_x * fwd_x + fwd_y * fwd_y + fwd_z * fwd_z );
	if ( fmag <= 0.000001 ) return false;
	fwd_x /= fmag;
	fwd_y /= fmag;
	fwd_z /= fmag;

	let right_x;
	let right_y;
	let right_z;
	let up_x;
	let up_y;
	let up_z;
	const horizontal = Math.sqrt( fwd_x * fwd_x + fwd_z * fwd_z );

	if ( horizontal <= 0.000001 ) {

		right_x = 1;
		right_y = 0;
		right_z = 0;
		up_x = 0;
		up_y = 0;
		up_z = fwd_y < 0 ? 1 : - 1;

	} else {

		right_x = fwd_z / horizontal;
		right_y = 0;
		right_z = - fwd_x / horizontal;
		up_x = fwd_y * right_z - fwd_z * right_y;
		up_y = fwd_z * right_x - fwd_x * right_z;
		up_z = fwd_x * right_y - fwd_y * right_x;

	}

	w.orient_rvec_x = right_x;
	w.orient_rvec_y = right_y;
	w.orient_rvec_z = right_z;
	w.orient_uvec_x = up_x;
	w.orient_uvec_y = up_y;
	w.orient_uvec_z = up_z;
	w.orient_fvec_x = fwd_x;
	w.orient_fvec_y = fwd_y;
	w.orient_fvec_z = fwd_z;
	return true;

}

// Construct a weapon orientation from its firing direction and its parent's
// up vector.  D1 preserves the parent's bank at weapon creation.
// Ported from: VECMAT.C vm_vector_2_matrix() with uvec supplied.
function setWeaponOrientationFromForwardUp( w, fwd_x, fwd_y, fwd_z, up_x, up_y, up_z ) {

	const fmag = Math.sqrt( fwd_x * fwd_x + fwd_y * fwd_y + fwd_z * fwd_z );
	const umag = Math.sqrt( up_x * up_x + up_y * up_y + up_z * up_z );
	if ( fmag <= 0.000001 || umag <= 0.000001 ) {

		return setWeaponOrientationFromForward( w, fwd_x, fwd_y, fwd_z );

	}

	fwd_x /= fmag;
	fwd_y /= fmag;
	fwd_z /= fmag;
	up_x /= umag;
	up_y /= umag;
	up_z /= umag;

	let right_x = up_y * fwd_z - up_z * fwd_y;
	let right_y = up_z * fwd_x - up_x * fwd_z;
	let right_z = up_x * fwd_y - up_y * fwd_x;
	const rmag = Math.sqrt( right_x * right_x + right_y * right_y + right_z * right_z );
	if ( rmag <= 0.000001 ) {

		return setWeaponOrientationFromForward( w, fwd_x, fwd_y, fwd_z );

	}
	right_x /= rmag;
	right_y /= rmag;
	right_z /= rmag;

	// Recompute up so the result is orthogonal even when the supplied parent
	// vector contains fixed-point drift.
	up_x = fwd_y * right_z - fwd_z * right_y;
	up_y = fwd_z * right_x - fwd_x * right_z;
	up_z = fwd_x * right_y - fwd_y * right_x;

	w.orient_rvec_x = right_x;
	w.orient_rvec_y = right_y;
	w.orient_rvec_z = right_z;
	w.orient_uvec_x = up_x;
	w.orient_uvec_y = up_y;
	w.orient_uvec_z = up_z;
	w.orient_fvec_x = fwd_x;
	w.orient_fvec_y = fwd_y;
	w.orient_fvec_z = fwd_z;
	return true;

}

function findWeaponParentObject( parent_type, parent_num, parent_signature ) {

	if ( parent_type === PARENT_PLAYER ) {

		return _getPlayerObject !== null ? _getPlayerObject() : null;

	}
	if ( parent_type !== PARENT_ROBOT || _robots === null ) return null;
	for ( let i = 0; i < _robots.length; i ++ ) {

		const entry = _robots[ i ];
		if ( entry === null || entry === undefined || entry.obj === null || entry.obj === undefined ) continue;
		if ( entry.objnum !== parent_num ) continue;
		if ( Number.isInteger( parent_signature ) === true && entry.obj.signature !== parent_signature ) continue;
		return entry.obj;

	}
	return null;

}

function initializeWeaponOrientation( w, dir_x, dir_y, dir_z, parentUpOverride ) {

	let parent = null;
	if ( parentUpOverride !== null && parentUpOverride !== undefined ) {

		parent = parentUpOverride;

	} else {

		parent = findWeaponParentObject( w.parent_type, w.parent_num, w.parent_signature );

	}

	if ( parent !== null && parent !== undefined &&
		Number.isFinite( parent.orient_uvec_x ) === true &&
		Number.isFinite( parent.orient_uvec_y ) === true &&
		Number.isFinite( parent.orient_uvec_z ) === true ) {

		setWeaponOrientationFromForwardUp(
			w, dir_x, dir_y, dir_z,
			parent.orient_uvec_x, parent.orient_uvec_y, parent.orient_uvec_z
		);

	} else {

		setWeaponOrientationFromForward( w, dir_x, dir_y, dir_z );

	}

}

function applyWeaponOrientation( mesh, w ) {

	_orientMatrix.set(
		w.orient_rvec_x, w.orient_uvec_x, - w.orient_fvec_x, 0,
		w.orient_rvec_y, w.orient_uvec_y, - w.orient_fvec_y, 0,
		- w.orient_rvec_z, - w.orient_uvec_z, w.orient_fvec_z, 0,
		0, 0, 0, 1
	);
	mesh.quaternion.setFromRotationMatrix( _orientMatrix );

}

// Visible homing missiles turn their model toward the new velocity rather
// than snapping to it.  vm_vector_to_matrix() intentionally resets bank.
// Ported from: LASER.C homing_missile_turn_towards_velocity().
function turnWeaponOrientationTowardsVelocity( w, dt ) {

	const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
	if ( speed <= 0.000001 ) return;
	const scale = dt * 8.0;
	setWeaponOrientationFromForward(
		w,
		w.orient_fvec_x + w.vel_x / speed * scale,
		w.orient_fvec_y + w.vel_y / speed * scale,
		w.orient_fvec_z + w.vel_z / speed * scale
	);

}

// Fallback colors for weapons without bitmaps (keyed by weapon_type)
function getFallbackColor( weapon_type, parent_type ) {

	if ( parent_type === PARENT_ROBOT ) return 0x00ff44;
	if ( weapon_type === 12 || weapon_type === 20 ) return 0xffff00;	// spreadfire
	if ( weapon_type === 13 ) return 0x0088ff;	// plasma
	if ( weapon_type === 14 ) return 0xff00ff;	// fusion
	if ( weapon_type === 8 ) return 0xff8800;	// concussion
	if ( weapon_type === 15 || weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID ) return 0xff6600;	// homing
	if ( weapon_type === WEAPON_SMART_INDEX || weapon_type === WEAPON_MEGA_INDEX ) return 0xff00ff;	// smart/mega
	if ( weapon_type === FLARE_ID ) return 0xffffaa;	// flare (bright yellow-white)
	return 0xff4400;	// laser

}

class WeaponObj {

	constructor() {

		this.active = false;
		this.parent_type = PARENT_PLAYER;
		this.parent_num = - 1;
		this.parent_signature = - 1;
		this.parent_object_type = OBJ_PLAYER;
		this.parent_object_id = 0;
		this.weapon_type = 0;	// weapon_info index
		this.silent = false;		// OF_SILENT — suppress wall-hit sound/awareness

		// Position in Descent coordinates
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;

		// Velocity in Descent coordinates
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;

		this.segnum = 0;
		this.lifeleft = 0;
		this.damage = 5.0;
		this.shields = 5.0;
		this.signature = 0;
		this.size = 0.5;			// collision radius

		// Full D1 orientation basis.  Polygon weapons preserve their parent's
		// bank at creation and homing missiles turn this basis independently of
		// their physics velocity.
		this.orient_rvec_x = 1;
		this.orient_rvec_y = 0;
		this.orient_rvec_z = 0;
		this.orient_uvec_x = 0;
		this.orient_uvec_y = 1;
		this.orient_uvec_z = 0;
		this.orient_fvec_x = 0;
		this.orient_fvec_y = 0;
		this.orient_fvec_z = 1;

		// Thrust vector (Descent coordinates) — for thrust-based weapons
		this.thrust_x = 0;
		this.thrust_y = 0;
		this.thrust_z = 0;
		this.mass = 1.0;
		this.drag = 0;
		this.max_speed = 0;		// speed cap for thrust weapons

		// Homing tracking
		this.track_goal = - 1;		// target index in _robots (-1 = none)
		this.creation_time = 0;		// GameTime when created
		this.track_revalidate = 0;	// frames until next target re-validation (every 4 frames)

		// Persistent weapon tracking (fusion passes through targets)
		// Ported from: LASER.C obj->ctype.laser_info.last_hitobj
		this.last_hitobj = - 1;

		// PF_STICK state (used by flares only in Descent 1)
		this.stuck = false;
		this.stuck_wallnum = - 1;	// wall_num this weapon is stuck to (for kill_stuck_objects)

		// Bounce grace period for smart homing children
		// Ported from: LASER.C lines 278-281 — PF_BOUNCE set at creation,
		// cleared at HOMING_MISSILE_STRAIGHT_TIME (0.125s)
		this.bounce_grace = false;

		// Three.js mesh reference (sprite for blob/laser/vclip weapons)
		this.mesh = null;

		// Three.js model mesh (Group for polymodel weapons)
		this.modelMesh = null;
		this.innerModelMesh = null;

	}

}

// Get weapon properties with fallback defaults
function getDifficultyLevel() {

	const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	return Number.isInteger( difficulty ) && difficulty >= 0 && difficulty < NDL ? difficulty : 1;

}

function getWeaponSpeed( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].speed[ getDifficultyLevel() ];

	}

	return 80.0;

}

function getWeaponDamage( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].strength[ getDifficultyLevel() ];

	}

	return 5.0;

}

function getWeaponLifetime( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].lifetime;

	}

	return 12.0;

}

function getWeaponFireWait( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].fire_wait;

	}

	return 0.25;

}

// Set external references
export function laser_set_externals( ext ) {

	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.robots !== undefined ) _robots = ext.robots;
	if ( ext.clutter !== undefined ) _clutter = ext.clutter;
	if ( ext.debris !== undefined ) _debris = ext.debris;
	if ( ext.onRobotHit !== undefined ) _onRobotHit = ext.onRobotHit;
	if ( ext.onClutterHit !== undefined ) _onClutterHit = ext.onClutterHit;
	if ( ext.onDebrisHit !== undefined ) _onDebrisHit = ext.onDebrisHit;
	if ( ext.onPlayerHit !== undefined ) _onPlayerHit = ext.onPlayerHit;
	if ( ext.onWallHit !== undefined ) _onWallHit = ext.onWallHit;
	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getPlayerEnergy !== undefined ) _getPlayerEnergy = ext.getPlayerEnergy;
	if ( ext.setPlayerEnergy !== undefined ) _setPlayerEnergy = ext.setPlayerEnergy;
	if ( ext.getVulcanAmmo !== undefined ) _getVulcanAmmo = ext.getVulcanAmmo;
	if ( ext.setVulcanAmmo !== undefined ) _setVulcanAmmo = ext.setVulcanAmmo;
	if ( ext.getSecondaryAmmo !== undefined ) _getSecondaryAmmo = ext.getSecondaryAmmo;
	if ( ext.setSecondaryAmmo !== undefined ) _setSecondaryAmmo = ext.setSecondaryAmmo;
	if ( ext.onBadassExplosion !== undefined ) _onBadassExplosion = ext.onBadassExplosion;
	if ( ext.onAutoSelectPrimary !== undefined ) _onAutoSelectPrimary = ext.onAutoSelectPrimary;
	if ( ext.onAutoSelectSecondary !== undefined ) _onAutoSelectSecondary = ext.onAutoSelectSecondary;
	if ( ext.onPlayerFiredLaser !== undefined ) _onPlayerFiredLaser = ext.onPlayerFiredLaser;
	if ( ext.getPlayerPrimaryFlags !== undefined ) _getPlayerPrimaryFlags = ext.getPlayerPrimaryFlags;
	if ( ext.getPlayerSecondaryFlags !== undefined ) _getPlayerSecondaryFlags = ext.getPlayerSecondaryFlags;
	if ( ext.getPlayerSecondaryAmmo !== undefined ) _getPlayerSecondaryAmmo = ext.getPlayerSecondaryAmmo;
	if ( ext.getPlayerLaserLevel !== undefined ) _getPlayerLaserLevel = ext.getPlayerLaserLevel;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;
	if ( ext.getPlayerVelocity !== undefined ) _getPlayerVelocity = ext.getPlayerVelocity;
	if ( ext.getPlayerObject !== undefined ) _getPlayerObject = ext.getPlayerObject;

}

// Get weapon object by pool index for danger_laser checking
// Returns null if index invalid or weapon inactive
// Ported from: Objects[danger_laser_num] access in AI.C line 1619
export function laser_get_weapon( idx ) {

	if ( idx < 0 || idx >= MAX_WEAPONS ) return null;
	const w = weapons[ idx ];
	if ( w.active !== true ) return null;
	return w;

}

// Initialize weapon pool with pre-built sprites
export function laser_init() {

	Weapon_next_signature = 0;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = new WeaponObj();

		// Each weapon gets its own SpriteMaterial (needed for per-weapon texture/opacity)
		const material = new THREE.SpriteMaterial( {
			transparent: true,
			blending: THREE.AdditiveBlending,
			depthWrite: false
		} );

		w.mesh = new THREE.Sprite( material );
		w.mesh.visible = false;

		weapons.push( w );

	}

}

// Configure weapon visual for a weapon type
// Ported from: draw_object_blob() and draw_weapon_vclip() in OBJECT.C / VCLIP.C
function configureWeaponVisual( w, weapon_type, parent_type ) {

	// Check if this is a polymodel weapon (lasers, missiles)
	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];

		if ( wi.render_type === WEAPON_RENDER_POLYMODEL && _pigFile !== null ) {

			// Build 3D model mesh
			const modelMesh = buildWeaponModelMesh( weapon_type );
			if ( modelMesh !== null ) {

				w.modelMesh = modelMesh;
				w.innerModelMesh = null;
				modelMesh.traverse( ( child ) => {

					if ( child.userData.isWeaponInnerModel === true ) w.innerModelMesh = child;

				} );
				w.mesh.visible = false;	// hide sprite
				return;

			}

		}

	}

	// Fall through to sprite rendering for blob/laser/vclip/fallback
	configureWeaponSprite( w, weapon_type, parent_type );

}

// Configure sprite material and scale for a weapon type
// Ported from: draw_object_blob() and draw_weapon_vclip() in OBJECT.C / VCLIP.C
function configureWeaponSprite( w, weapon_type, parent_type ) {

	w.innerModelMesh = null;
	const mat = w.mesh.material;
	let texture = null;
	let blobSize = 2.0; // default diameter in world units

	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];

		if ( ( wi.render_type === WEAPON_RENDER_BLOB || wi.render_type === WEAPON_RENDER_LASER ) && wi.bitmap !== - 1 ) {

			// Blob/laser weapon: use single bitmap
			texture = getWeaponTexture( wi.bitmap );

		} else if ( wi.render_type === WEAPON_RENDER_VCLIP && wi.weapon_vclip >= 0 ) {

			// VClip weapon: use first frame of animation
			const vc = Vclips[ wi.weapon_vclip ];
			if ( vc !== undefined && vc.num_frames > 0 ) {

				texture = getWeaponTexture( vc.frames[ 0 ] );

			}

		}

		// Use blob_size from Weapon_info (already float from fixed-point conversion)
		if ( wi.blob_size > 0 ) {

			blobSize = wi.blob_size * 2.0; // blob_size is radius, sprite needs diameter

		}

	}

	if ( texture !== null ) {

		mat.map = texture;
		mat.color.set( 0xffffff );

		// Aspect-ratio correction from draw_object_blob():
		// if wider than tall, scale height down; if taller than wide, scale width down
		const bm_w = texture.image.width;
		const bm_h = texture.image.height;

		if ( bm_w > bm_h ) {

			w.mesh.scale.set( blobSize, blobSize * ( bm_h / bm_w ), 1 );

		} else {

			w.mesh.scale.set( blobSize * ( bm_w / bm_h ), blobSize, 1 );

		}

	} else {

		// Fallback: colored sprite without texture
		mat.map = null;
		mat.color.set( getFallbackColor( weapon_type, parent_type ) );
		w.mesh.scale.set( blobSize, blobSize, 1 );

	}

	mat.needsUpdate = true;

}

// Get light color for a weapon type
// Find best homing target for a weapon
// Ported from: find_homing_object() in LASER.C lines 540-599
// Returns: robot index (>=0), TRACK_PLAYER (-2) for player target, or -1 for no target
const TRACK_PLAYER = - 2;

function find_homing_object( w ) {

	// Robot-fired weapons track the player (not other robots)
	// Ported from: LASER.C lines 560-563 — "Not in network mode. If not fired by player, then track player."
	// In C: if (parent_num != player) { if (!cloaked) best_objnum = ConsoleObject - Objects; }
	if ( w.parent_type !== PARENT_PLAYER ) {

		// Robot-fired homing weapons acquire the player unconditionally (as long as the
		// player is not cloaked) — C applies NO tracking-cone or distance gate here.
		// Ported from: find_homing_object() in LASER.C:559-563:
		//   if (parent_num != player) { if (!cloaked) best_objnum = ConsoleObject - Objects; }
		if ( _isPlayerCloaked !== null && _isPlayerCloaked() === true ) return - 1;
		return TRACK_PLAYER;

	}

	// Player-fired weapons track robots
	if ( _robots === null ) return - 1;

	// Get weapon forward direction from velocity
	const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
	if ( speed < 0.001 ) return - 1;

	const fwd_x = w.vel_x / speed;
	const fwd_y = w.vel_y / speed;
	const fwd_z = w.vel_z / speed;

	let bestDot = MIN_TRACKABLE_DOT;
	let bestIndex = - 1;

	for ( let r = 0; r < _robots.length; r ++ ) {

		const robot = _robots[ r ];
		if ( robot.alive !== true ) continue;

		// Vector from weapon to robot
		const dx = robot.obj.pos_x - w.pos_x;
		const dy = robot.obj.pos_y - w.pos_y;
		const dz = robot.obj.pos_z - w.pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist > MAX_TRACKABLE_DIST ) continue;
		if ( dist < 0.001 ) continue;

		// Normalized direction to target
		const nx = dx / dist;
		const ny = dy / dist;
		const nz = dz / dist;

		// Dot product with weapon forward direction
		const dot = fwd_x * nx + fwd_y * ny + fwd_z * nz;

		if ( dot > bestDot ) {

			// LOS check: don't track through walls
			// Ported from: find_homing_object_complete() in LASER.C — object_to_object_visibility()
			const losResult = find_vector_intersection(
				w.pos_x, w.pos_y, w.pos_z,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				w.segnum, 0.0,
				- 1, 0
			);

			if ( losResult.hit_type === HIT_WALL ) continue;

			bestDot = dot;
			bestIndex = r;

		}

	}

	return bestIndex;

}

// Create smart bomb children when a smart missile explodes
// Ported from: create_smart_children() in LASER.C
function create_smart_children( w ) {

	if ( _robots === null ) return;

	// Find visible targets within MAX_SMART_DISTANCE
	// Robot blobs can't track robots (LASER.C line 1301-1304)
	const targets = [];

	if ( w.parent_type !== PARENT_ROBOT ) {

		// Player-fired smart: target robots
		for ( let r = 0; r < _robots.length; r ++ ) {

			const robot = _robots[ r ];
			if ( robot.alive !== true ) continue;

			const dx = robot.obj.pos_x - w.pos_x;
			const dy = robot.obj.pos_y - w.pos_y;
			const dz = robot.obj.pos_z - w.pos_z;
			const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

			if ( dist < MAX_SMART_DISTANCE ) {

				targets.push( { index: r, dist: dist } );

			}

		}

	}

	// Create NUM_SMART_CHILDREN homing children
	for ( let i = 0; i < NUM_SMART_CHILDREN; i ++ ) {

		let dir_x, dir_y, dir_z;

		if ( targets.length > 0 ) {

			// Pick random target
			const t = targets[ Math.floor( Math.random() * targets.length ) ];
			const robot = _robots[ t.index ];

			dir_x = robot.obj.pos_x - w.pos_x;
			dir_y = robot.obj.pos_y - w.pos_y;
			dir_z = robot.obj.pos_z - w.pos_z;
			const dist = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );

			if ( dist > 0.001 ) {

				dir_x /= dist;
				dir_y /= dist;
				dir_z /= dist;

			}

			// Add 25% random noise (from original: vm_vec_scale_add2(&vec, &rand, F1_0/4))
			dir_x += ( Math.random() - 0.5 ) * 0.5;
			dir_y += ( Math.random() - 0.5 ) * 0.5;
			dir_z += ( Math.random() - 0.5 ) * 0.5;

			const mag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
			if ( mag > 0.001 ) {

				dir_x /= mag;
				dir_y /= mag;
				dir_z /= mag;

			}

		} else {

			// No targets: random direction
			dir_x = Math.random() - 0.5;
			dir_y = Math.random() - 0.5;
			dir_z = Math.random() - 0.5;
			const mag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
			if ( mag > 0.001 ) {

				dir_x /= mag;
				dir_y /= mag;
				dir_z /= mag;

			}

		}

		const homingType = ( w.parent_type === PARENT_ROBOT ) ? ROBOT_SMART_HOMING_ID : PLAYER_SMART_HOMING_ID;

		const childIdx = Laser_create_new(
			dir_x, dir_y, dir_z,
			w.pos_x, w.pos_y, w.pos_z,
			w.segnum, w.parent_type, homingType,
			1.0, undefined, i !== 0, undefined, w.parent_num, w.parent_signature, w
		);
		if ( childIdx !== - 1 ) {

			weapons[ childIdx ].parent_object_type = w.parent_object_type;
			weapons[ childIdx ].parent_object_id = w.parent_object_id;

		}

		// Laser_create_new() receives make_sound=1 for only the first smart
		// child in D1.  Player/robot launch sounds are owned by their callers in
		// this port, so reproduce this weapon-parent cue here at the child.
		if ( i === 0 && childIdx !== - 1 && homingType < N_weapon_types ) {

			const childInfo = Weapon_info[ homingType ];
			if ( childInfo.flash_sound >= 0 ) {

				const child = weapons[ childIdx ];
				digi_play_sample_world(
					childInfo.flash_sound, 1.0, child.segnum,
					child.pos_x, child.pos_y, child.pos_z
				);

			}

		}

		// Set initial tracking target
		if ( childIdx !== - 1 && targets.length > 0 ) {

			weapons[ childIdx ].track_goal = targets[ Math.floor( Math.random() * targets.length ) ].index;

		}

	}

}

// Handle special weapon effects on impact (smart children, area damage)
function handleWeaponExplosion( w ) {

	// Badass (area) damage for weapons with damage_radius
	if ( w.weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ w.weapon_type ];
		if ( wi.damage_radius > 0 && _onBadassExplosion !== null ) {

			_onBadassExplosion(
				w.pos_x, w.pos_y, w.pos_z, w.segnum,
				w.damage, wi.damage_radius, w.damage,
				wi.impact_size, wi.robot_hit_vclip,
				w.parent_object_type, w.parent_object_id
			);

		}

	}

	// Smart missile: spawn 6 homing children after the parent blast.
	if ( w.weapon_type === WEAPON_SMART_INDEX ) {

		create_smart_children( w );

	}

}

// Fixed-point Descent's vm_vec_dist_quick approximation in world units.
function quickWeaponDistance( weapon1, weapon2 ) {

	return quickVectorMagnitude(
		weapon1.pos_x - weapon2.pos_x,
		weapon1.pos_y - weapon2.pos_y,
		weapon1.pos_z - weapon2.pos_z
	);

}

function quickVectorMagnitude( x, y, z ) {

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

function updateWeaponInnerModelVisibility( weapon ) {

	if ( weapon.innerModelMesh === null ) return;
	if ( _getPlayerPos === null ) {

		weapon.innerModelMesh.visible = true;
		return;

	}

	const viewer = _getPlayerPos();
	const distance = quickVectorMagnitude(
		viewer.x - weapon.pos_x,
		viewer.y - weapon.pos_y,
		viewer.z - weapon.pos_z
	);
	weapon.innerModelMesh.visible = distance < 10.0;

}

// LASER.C laser_are_related(): sibling weapons ignore each other unless either
// one is a proximity mine.  Children inherit the original shooter's identity.
function weaponsAreRelated( weapon1, weapon2 ) {

	if ( weapon1.parent_type !== weapon2.parent_type ||
		weapon1.parent_signature !== weapon2.parent_signature ) return false;
	return weapon1.weapon_type !== PROXIMITY_ID && weapon2.weapon_type !== PROXIMITY_ID;

}

// COLLIDE.C maybe_kill_weapon(), specialized for the weapon/weapon pair.
function maybeKillWeaponWithWeapon( weapon, otherWeapon ) {

	if ( weapon.weapon_type === PROXIMITY_ID ) {

		kill_weapon( weapon );
		return;

	}

	const wi = weapon.weapon_type >= 0 && weapon.weapon_type < N_weapon_types
		? Weapon_info[ weapon.weapon_type ] : null;
	if ( wi !== null && wi.persistent !== 0 ) return;

	weapon.shields -= otherWeapon.shields / 2;
	if ( weapon.shields <= 0 ) {

		weapon.shields = 0;
		kill_weapon( weapon );

	}

}

// COLLIDE.C maybe_detonate_weapon().  A destroyable radius weapon either
// explodes at close range or has its remaining life shortened at long range.
function maybeDetonateWeapon( weapon, otherWeapon, collision_x, collision_y, collision_z ) {

	if ( weapon.weapon_type < 0 || weapon.weapon_type >= N_weapon_types ) return false;
	const wi = Weapon_info[ weapon.weapon_type ];
	if ( wi.damage_radius <= 0 ) return false;

	const distance = quickWeaponDistance( weapon, otherWeapon );
	if ( distance < 5 ) {

		maybeKillWeaponWithWeapon( weapon, otherWeapon );
		if ( weapon.active !== true ) {

			handleWeaponExplosion( weapon );
			digi_play_sample_world(
				wi.robot_hit_sound, 1.0, weapon.segnum,
				collision_x, collision_y, collision_z
			);

		}

	} else {

		weapon.lifeleft = Math.min( distance / 64, 1.0 );

	}
	return true;

}

// COLLIDE.C collide_weapon_and_weapon().
function collideWeaponAndWeapon( weapon1, weapon2, collision_x, collision_y, collision_z ) {

	if ( weapon1.weapon_type < 0 || weapon1.weapon_type >= N_weapon_types ||
		weapon2.weapon_type < 0 || weapon2.weapon_type >= N_weapon_types ) return;

	const wi1 = Weapon_info[ weapon1.weapon_type ];
	const wi2 = Weapon_info[ weapon2.weapon_type ];
	if ( wi1.destroyable === 0 && wi2.destroyable === 0 ) return;

	// Extra source safeguard for same-kind children from one shooter.  The
	// general sibling filter above normally catches this except for proximity.
	if ( weapon1.weapon_type === weapon2.weapon_type &&
		weapon1.parent_type === weapon2.parent_type &&
		weapon1.parent_num === weapon2.parent_num ) return;

	if ( wi1.destroyable !== 0 &&
		maybeDetonateWeapon( weapon1, weapon2, collision_x, collision_y, collision_z ) ) {

		maybeKillWeaponWithWeapon( weapon2, weapon1 );

	}

	if ( wi2.destroyable !== 0 &&
		maybeDetonateWeapon( weapon2, weapon1, collision_x, collision_y, collision_z ) ) {

		maybeKillWeaponWithWeapon( weapon1, weapon2 );

	}

}

// Create a new weapon bolt
// weapon_type: index into Weapon_info[] array
// damage_multiplier: optional multiplier for damage (fusion charge)
export function Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, parent_type, weapon_type, damage_multiplier, laser_offset_override, silent, parent_speed_override, parent_num_override, parent_signature_override, parent_orientation_override ) {

	if ( _scene === null ) return - 1;

	if ( parent_type === undefined ) parent_type = PARENT_PLAYER;
	if ( weapon_type === undefined ) weapon_type = 0;
	if ( damage_multiplier === undefined ) damage_multiplier = 1.0;

	let speed = getWeaponSpeed( weapon_type );
	const baseDamage = getWeaponDamage( weapon_type );
	const damage = baseDamage * damage_multiplier;
	const lifetime = getWeaponLifetime( weapon_type );

	// Get thrust/drag/mass from Weapon_info
	// Ported from: Laser_create_new() in LASER.C lines 382-400
	let weapon_thrust = 0;
	let weapon_drag = 0;
	let weapon_mass = 1.0;

	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];
		weapon_thrust = wi.thrust;
		weapon_drag = wi.drag;
		weapon_mass = wi.mass > 0 ? wi.mass : 1.0;

	}

	// Thrust-based weapons start at half speed (they accelerate up to max)
	// Ported from: LASER.C line 388-389
	const max_speed = speed;
	if ( weapon_thrust > 0 ) {

		speed = speed / 2;

		// Smart homing children start at 1/4 speed (not 1/2)
		// Ported from: LASER.C create_smart_children() speed adjustment
		if ( weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID ) {

			speed = max_speed / 4;

		}

	}

	// Proximity mines inherit the parent's full speed, using the parent's
	// forward velocity only to choose its sign. This is intentionally not a
	// projection: LASER.C adds |parent velocity| to the mine's launch speed.
	if ( weapon_type === PROXIMITY_ID ) {

		let parentSpeed = 0;
		if ( Number.isFinite( parent_speed_override ) ) {

			parentSpeed = parent_speed_override;

		} else if ( parent_type === PARENT_PLAYER && _getPlayerVelocity !== null ) {

			const parentVelocity = _getPlayerVelocity();
			parentSpeed = Math.sqrt(
				parentVelocity.x * parentVelocity.x +
				parentVelocity.y * parentVelocity.y +
				parentVelocity.z * parentVelocity.z
			);
			if ( parentVelocity.x * dir_x + parentVelocity.y * dir_y + parentVelocity.z * dir_z < 0 ) {

				parentSpeed = - parentSpeed;

			}

		}
		speed += parentSpeed;

	}

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active === true ) continue;

		const signature = Weapon_next_signature ++;
		w.active = true;
		w.parent_type = parent_type;
		w.parent_num = Number.isInteger( parent_num_override )
			? parent_num_override : ( parent_type === PARENT_PLAYER ? 0 : - signature - 1 );
		w.parent_signature = Number.isInteger( parent_signature_override )
			? parent_signature_override : ( parent_type === PARENT_PLAYER ? 0 : - signature - 1 );
		const parentObject = findWeaponParentObject(
			w.parent_type, w.parent_num, w.parent_signature
		);
		w.parent_object_type = parentObject !== null && Number.isInteger( parentObject.type )
			? parentObject.type : ( parent_type === PARENT_PLAYER ? OBJ_PLAYER : - 1 );
		w.parent_object_id = parentObject !== null && Number.isInteger( parentObject.id )
			? parentObject.id : ( parent_type === PARENT_PLAYER ? 0 : - 1 );
		w.weapon_type = weapon_type;
		w.silent = silent === true;
		w.pos_x = pos_x;
		w.pos_y = pos_y;
		w.pos_z = pos_z;
		w.vel_x = dir_x * speed;
		w.vel_y = dir_y * speed;
		w.vel_z = dir_z * speed;
		initializeWeaponOrientation( w, dir_x, dir_y, dir_z, parent_orientation_override );
		w.segnum = segnum;
		w.lifeleft = lifetime;
		w.damage = damage;
		w.shields = baseDamage;
		w.signature = signature;

		// Laser_create_new() chooses the collision radius from render data.
		// Invisible weapons use radius 1; blobs/vclips use blob_size; polygon
		// weapons use model radius divided by their length/width ratio.
		w.size = 1.0;
		if ( weapon_type >= 0 && weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ weapon_type ];
			if ( wi.render_type === WEAPON_RENDER_BLOB ||
				wi.render_type === WEAPON_RENDER_LASER ||
				wi.render_type === WEAPON_RENDER_VCLIP ) {

				if ( wi.blob_size > 0 ) w.size = wi.blob_size;

			} else if ( wi.render_type === WEAPON_RENDER_POLYMODEL &&
				wi.model_num >= 0 && wi.model_num < Polygon_models.length &&
				wi.po_len_to_width_ratio > 0 ) {

				const model = Polygon_models[ wi.model_num ];
				if ( model !== null && model !== undefined && model.rad > 0 ) {

					w.size = model.rad / wi.po_len_to_width_ratio;

				}

			}

		}
		w.creation_time = GameTime;
		w.track_goal = - 1;
		w.last_hitobj = - 1;
		w.stuck = false;
		w.stuck_wallnum = - 1;

		// Smart homing children get bounce grace to avoid instant wall collision
		// Ported from: LASER.C lines 278-281 — PF_BOUNCE set on smart homing children
		w.bounce_grace = ( weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID );

		// Set thrust properties
		// Ported from: LASER.C lines 397-400
		// thrust = velocity * (weapon_thrust / weapon_speed)
		w.drag = weapon_drag;
		w.mass = weapon_mass;
		w.max_speed = max_speed;

		if ( weapon_thrust > 0 && speed > 0.001 ) {

			const thrustScale = weapon_thrust / speed;
			w.thrust_x = w.vel_x * thrustScale;
			w.thrust_y = w.vel_y * thrustScale;
			w.thrust_z = w.vel_z * thrustScale;

		} else {

			w.thrust_x = 0;
			w.thrust_y = 0;
			w.thrust_z = 0;

		}

		// Set initial homing target for homing weapons
		if ( weapon_type < N_weapon_types && Weapon_info[ weapon_type ].homing_flag !== 0 ) {

			w.track_goal = find_homing_object( w );

		}

		// Configure visual (sprite or 3D model) based on weapon type
		configureWeaponVisual( w, weapon_type, parent_type );

		// Move bolt forward so its tail (not center) is at the gun barrel.
		// Ported from LASER.C lines 348-371: "fire the laser from the gun tip
		// so that the back end of the laser bolt is at the gun tip."
		// offset = Laser_offset (random jitter) + laser_length / 2
		if ( w.modelMesh !== null ) {

			// Ported from LASER.C lines 286 and 360:
			// laser_length = Polygon_models[model_num].rad * 2, then add laser_length/2.
			let laserHalfLength = 0;
			if ( weapon_type < N_weapon_types ) {

				const wi = Weapon_info[ weapon_type ];
				if ( wi !== undefined && wi.model_num >= 0 && wi.model_num < Polygon_models.length ) {

					const model = Polygon_models[ wi.model_num ];
					if ( model !== null && model !== undefined && model.rad > 0 ) {

						laserHalfLength = model.rad;

					}

				}

			}

			let laserOffset = laser_offset_override;
			if ( laserOffset === undefined ) {

				laserOffset = get_random_laser_offset();

			}

			const totalOffset = laserHalfLength + laserOffset;

			// Push position forward along fire direction (Descent coords)
			pos_x += dir_x * totalOffset;
			pos_y += dir_y * totalOffset;
			pos_z += dir_z * totalOffset;

			// Verify the new position is still in a valid segment
			const newSeg = find_point_seg( pos_x, pos_y, pos_z, segnum );
			if ( newSeg !== - 1 ) {

				w.pos_x = pos_x;
				w.pos_y = pos_y;
				w.pos_z = pos_z;
				w.segnum = newSeg;

			}

			// Polymodel weapon: position and orient the 3D model
			w.modelMesh.position.set( w.pos_x, w.pos_y, - w.pos_z );
			applyWeaponOrientation( w.modelMesh, w );
			updateWeaponInnerModelVisibility( w );
			w.modelMesh.visible = true;
			_scene.add( w.modelMesh );

		} else {

			// Sprite weapon
			w.mesh.visible = true;
			w.mesh.position.set( pos_x, pos_y, - pos_z );
			_scene.add( w.mesh );

		}

		return i;

	}

	return - 1;

}

// Fire player primary weapon
// Returns true if weapon was fired
export function Laser_player_fire( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, gameTime, damage_multiplier, laser_offset_override ) {

	// Reset fire timer if stale (e.g., after automap or long pause)
	// Ported from: LASER.C Laser_player_fire_spread_delay() stale-time check
	if ( Last_laser_fire_time + 0.1 < gameTime ) {

		Next_laser_fire_time = gameTime;

	}

	// Check fire rate
	if ( gameTime < Next_laser_fire_time ) return false;

	// Laser level 0-3 maps directly to weapon_info indices 0-3
	// Ported from: LASER.C Laser_player_fire() — laser_level IS the weapon_type
	let weapon_info_index = Primary_weapon_to_weapon_info[ Primary_weapon ];
	if ( Primary_weapon === 0 && _getPlayerLaserLevel !== null ) {

		weapon_info_index = _getPlayerLaserLevel();

	}

	const fire_wait = getWeaponFireWait( weapon_info_index );

	// Vulcan uses ammo instead of energy
	if ( Primary_weapon === 1 ) {

		if ( _getVulcanAmmo !== null ) {

			const ammo = _getVulcanAmmo();
			if ( ammo <= 0 ) {

				// Auto-select a different weapon
				if ( _onAutoSelectPrimary !== null ) _onAutoSelectPrimary();
				return false;

			}

			_setVulcanAmmo( ammo - 1 );

		}

	} else {

		// All other primary weapons use energy
		if ( _getPlayerEnergy !== null && _setPlayerEnergy !== null ) {

			const energy = _getPlayerEnergy();
			let energyCost = 0;

			if ( weapon_info_index < N_weapon_types ) {

				energyCost = Weapon_info[ weapon_info_index ].energy_usage;

			}

			// Default cost if not specified
			if ( energyCost <= 0 ) energyCost = 1.0;

			// Lower difficulty = cheaper energy cost
			// Ported from: do_laser_firing_player() in LASER.C line 1058
			// Trainee(0): 50%, Rookie(1): 75%, Hotshot+(2+): 100%
			const difficulty = getDifficultyLevel();
			if ( difficulty < 2 ) {

				energyCost = energyCost * ( difficulty + 2 ) / 4;

			}

			if ( energy < energyCost ) {

				// Auto-select a different weapon
				if ( _onAutoSelectPrimary !== null ) _onAutoSelectPrimary();
				return false;

			}

			_setPlayerEnergy( energy - energyCost );

		}

	}

	Next_laser_fire_time = gameTime + fire_wait;
	Last_laser_fire_time = gameTime;

	// Spreadfire: 3 bolts in a spread pattern with alternating horizontal/vertical
	// Ported from: LASER.C Laser_player_fire_spread() using Spreadfire_toggle
	if ( Primary_weapon === 2 ) {

		// Center bolt
		const centerIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override );

		// Notify AI of danger laser for robot evasion
		// Ported from: Player_fired_laser_this_frame in LASER.C line 822
		if ( centerIdx !== - 1 && _onPlayerFiredLaser !== null ) {

			_onPlayerFiredLaser( centerIdx, dir_x, dir_y, dir_z );

		}
		if ( centerIdx !== - 1 ) play_player_weapon_fire_sound( weapon_info_index );

		// Compute right and up vectors for spread
		// Ported from: LASER.C Laser_player_fire_spread() — F1_0/16 = 0.0625
		const spread = 0.0625;
		let sx, sy, sz;

		if ( Spreadfire_toggle === 0 ) {

			// Horizontal spread: use right vector
			// Cross dir with world up (0,1,0) to get right
			// cross(dir, up) = (dy*0 - dz*1, dz*0 - dx*0, dx*1 - dy*0) = (-dz, 0, dx)
			// Actually cross(up, dir) = (1*dz - 0*dy, 0*dx - 0*dz, 0*dy - 1*dx) = (dz, 0, -dx)
			sx = dir_z;
			sy = 0;
			sz = - dir_x;

			if ( Math.abs( dir_y ) > 0.9 ) {

				// Dir is near vertical, use X as alternate
				sx = 0;
				sy = - dir_z;
				sz = dir_y;

			}

		} else {

			// Vertical spread: use up vector
			// up = cross(dir, right), where right = cross(up_world, dir)
			let rx = dir_z, ry = 0, rz = - dir_x;

			if ( Math.abs( dir_y ) > 0.9 ) {

				rx = 0; ry = - dir_z; rz = dir_y;

			}

			const rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );
			if ( rmag > 0.001 ) { rx /= rmag; ry /= rmag; rz /= rmag; }

			// up = forward × right
			sx = dir_y * rz - dir_z * ry;
			sy = dir_z * rx - dir_x * rz;
			sz = dir_x * ry - dir_y * rx;

		}

		const smag = Math.sqrt( sx * sx + sy * sy + sz * sz );
		if ( smag > 0.001 ) {

			sx /= smag; sy /= smag; sz /= smag;

		}

		Spreadfire_toggle = 1 - Spreadfire_toggle;

		// Right/up spread bolt
		Laser_create_new(
			dir_x + sx * spread, dir_y + sy * spread, dir_z + sz * spread,
			pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override, true
		);

		// Left/down spread bolt
		Laser_create_new(
			dir_x - sx * spread, dir_y - sy * spread, dir_z - sz * spread,
			pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override, true
		);

		return true;

	}

	// Vulcan cannon: add random spread to direction
	// Ported from: LASER.C lines 1146-1150 — rand()/8 - 32767/16 spread per axis
	if ( Primary_weapon === 1 ) {

		const spread = 0.03;	// ~1.7 degrees angular spread
		dir_x += ( Math.random() - 0.5 ) * spread;
		dir_y += ( Math.random() - 0.5 ) * spread;
		dir_z += ( Math.random() - 0.5 ) * spread;

		// Re-normalize
		const dmag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
		if ( dmag > 0.001 ) { dir_x /= dmag; dir_y /= dmag; dir_z /= dmag; }

	}

	// Normal single bolt
	const boltIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, damage_multiplier, laser_offset_override );

	// Notify AI of danger laser for robot evasion
	// Ported from: Player_fired_laser_this_frame in LASER.C line 822
	if ( boltIdx !== - 1 && _onPlayerFiredLaser !== null ) {

		_onPlayerFiredLaser( boltIdx, dir_x, dir_y, dir_z );

	}
	if ( boltIdx !== - 1 ) play_player_weapon_fire_sound( weapon_info_index );

	return true;

}

// Get the weapon_info index for the player's current laser level
// Used by game.js for dual/quad fire and fire sound lookup
export function get_player_laser_weapon_info_index() {

	if ( Primary_weapon === 0 && _getPlayerLaserLevel !== null ) {

		return _getPlayerLaserLevel();

	}

	return Primary_weapon_to_weapon_info[ Primary_weapon ];

}

// Fire player secondary weapon (missiles)
export function Laser_player_fire_secondary( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, gameTime ) {

	if ( gameTime < Next_missile_fire_time ) return false;

	// Check secondary ammo
	if ( _getSecondaryAmmo !== null && _setSecondaryAmmo !== null ) {

		const ammo = _getSecondaryAmmo( Secondary_weapon );
		if ( ammo <= 0 ) {

			// Auto-select a different secondary weapon
			if ( _onAutoSelectSecondary !== null ) _onAutoSelectSecondary();
			return false;

		}

		_setSecondaryAmmo( Secondary_weapon, ammo - 1 );

	}

	const weapon_info_index = Secondary_weapon_to_weapon_info[ Secondary_weapon ];
	const fire_wait = getWeaponFireWait( weapon_info_index );

	Next_missile_fire_time = gameTime + fire_wait;

	const missileIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index );
	if ( missileIdx !== - 1 ) play_player_weapon_fire_sound( weapon_info_index );

	// Mega missile recoil: push player backward with random tumble
	// Ported from: do_laser_firing_player() in LASER.C lines 1421-1438
	// Linear: -forward * 128 (fvec << 7), Rotation: -forward * 8 + random(-0.25,+0.25)
	if ( Secondary_weapon === 4 ) {

		phys_apply_force_to_player( - dir_x * 128.0, - dir_y * 128.0, - dir_z * 128.0 );
		phys_apply_rot(
			- dir_x * 8.0 + ( Math.random() - 0.5 ) * 0.5,
			- dir_y * 8.0 + ( Math.random() - 0.5 ) * 0.5,
			- dir_z * 8.0 + ( Math.random() - 0.5 ) * 0.5
		);

	}

	// Notify AI of danger laser for robot evasion
	if ( missileIdx !== - 1 && _onPlayerFiredLaser !== null ) {

		_onPlayerFiredLaser( missileIdx, dir_x, dir_y, dir_z );

	}

	return true;

}

// Fire a flare (F key)
// Ported from: Flare_create() in LASER.C lines 857-887
export function Flare_create( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum ) {

	if ( _getPlayerEnergy === null || _setPlayerEnergy === null ) return false;

	const wi = Weapon_info[ FLARE_ID ];
	let energyCost = ( wi !== undefined && wi.energy_usage > 0 ) ? wi.energy_usage : 1.0;
	const difficulty = getDifficultyLevel();
	if ( difficulty < 2 ) energyCost = energyCost * ( difficulty + 2 ) / 4;

	const energy = _getPlayerEnergy();
	if ( energy <= 0 ) return false;

	_setPlayerEnergy( Math.max( 0, energy - energyCost ) );

	const flareIdx = Laser_create_new(
		dir_x, dir_y, dir_z, pos_x, pos_y, pos_z,
		segnum, PARENT_PLAYER, FLARE_ID
	);
	if ( flareIdx !== - 1 ) play_player_weapon_fire_sound( FLARE_ID );
	return true;

}

// Remove a weapon from the scene
function kill_weapon( w ) {

	w.active = false;
	w.mesh.visible = false;

	if ( _scene !== null ) {

		if ( w.modelMesh !== null ) {

			w.modelMesh.visible = false;
			_scene.remove( w.modelMesh );
			w.modelMesh = null;
			w.innerModelMesh = null;

		} else {

			_scene.remove( w.mesh );

		}

	}

}

// Update all active weapons: move, check collisions, expire
// Ported from: Laser_do_weapon_sequence() in LASER.C
export function laser_do_weapon_sequence( dt ) {

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;

		// Lifetime check
		w.lifeleft -= dt;
		if ( w.lifeleft < 0 ) {

			// Every weapon with a damage radius explodes when it expires,
			// whether it is moving or stuck. No wall is hit by an expiry.
			if ( w.weapon_type < N_weapon_types && Weapon_info[ w.weapon_type ].damage_radius > 0 ) {

				handleWeaponExplosion( w );

			}

			kill_weapon( w );
			continue;

		}

		// --- Homing tracking (update velocity before movement) ---
		if ( w.weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ w.weapon_type ];
			if ( wi.homing_flag !== 0 ) {

				// Only track after straight flight period
				if ( GameTime - w.creation_time > HOMING_MISSILE_STRAIGHT_TIME ) {

					// Smart homing children: clear bounce grace when tracking starts
					// Ported from: LASER.C lines 950-953
					if ( w.bounce_grace === true ) {

						w.bounce_grace = false;

					}

					// Validate current target
					// track_goal: -1 = no target, TRACK_PLAYER (-2) = player, >=0 = robot index
					if ( w.track_goal >= 0 ) {

						if ( _robots === null || w.track_goal >= _robots.length || _robots[ w.track_goal ].alive !== true ) {

							w.track_goal = - 1;

						}

					}

					// Re-validate / search for new target every 4 frames
					// Ported from: LASER.C line 943 — (d_tick_count & 3) gate
					if ( w.track_goal === - 1 || w.track_revalidate <= 0 ) {

						w.track_goal = find_homing_object( w );
						w.track_revalidate = 4;

					}

					w.track_revalidate --;

					// Resolve target position
					// track_goal: TRACK_PLAYER (-2) = player, >=0 = robot index
					let hasTarget = false;
					let tgt_x = 0, tgt_y = 0, tgt_z = 0;

					if ( w.track_goal === TRACK_PLAYER && _getPlayerPos !== null ) {

						const pp = _getPlayerPos();
						tgt_x = pp.x;
						tgt_y = pp.y;
						tgt_z = pp.z;
						hasTarget = true;

					} else if ( w.track_goal >= 0 && _robots !== null && w.track_goal < _robots.length ) {

						const target = _robots[ w.track_goal ];
						if ( target.alive === true ) {

							tgt_x = target.obj.pos_x;
							tgt_y = target.obj.pos_y;
							tgt_z = target.obj.pos_z;
							hasTarget = true;

						} else {

							w.track_goal = - 1;

						}

					}

					// Blend velocity toward target
					if ( hasTarget === true ) {

						const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
						if ( speed > 0.001 ) {

							// Current direction (normalized)
							const cur_x = w.vel_x / speed;
							const cur_y = w.vel_y / speed;
							const cur_z = w.vel_z / speed;

							// Direction to target
							let tx = tgt_x - w.pos_x;
							let ty = tgt_y - w.pos_y;
							let tz = tgt_z - w.pos_z;
							const tdist = Math.sqrt( tx * tx + ty * ty + tz * tz );

							if ( tdist > 0.001 ) {

								tx /= tdist;
								ty /= tdist;
								tz /= tdist;

								// Blend: newDir = normalize(currentDir + targetDir)
								// Ported from LASER.C: vm_vec_add2(&temp_vec, &vector_to_object)
								let nx = cur_x + tx;
								let ny = cur_y + ty;
								let nz = cur_z + tz;

								// Non-polymodel weapons (smart children) add target dir twice
								// for harder tracking. Ported from LASER.C line 968-969.
								if ( wi.render_type !== WEAPON_RENDER_POLYMODEL ) {

									nx += tx;
									ny += ty;
									nz += tz;

								}

								const nmag = Math.sqrt( nx * nx + ny * ny + nz * nz );

								if ( nmag > 0.001 ) {

									nx /= nmag;
									ny /= nmag;
									nz /= nmag;

									// Subtract off life proportional to amount turned.
									// Ported from LASER.C lines 989-1003
									const newDot = cur_x * nx + cur_y * ny + cur_z * nz;
									let absdot = Math.abs( 1.0 - newDot );

									if ( absdot > 0.125 ) {

										if ( absdot > 0.25 ) absdot = 0.25;
										const lifelost = absdot * 16 * dt;
										w.lifeleft -= lifelost;

									}

									w.vel_x = nx * speed;
									w.vel_y = ny * speed;
									w.vel_z = nz * speed;
									if ( wi.render_type === WEAPON_RENDER_POLYMODEL ) {

										turnWeaponOrientationTowardsVelocity( w, dt );

									}

									// Update thrust direction to match new velocity
									if ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) {

										const thrustMag = Math.sqrt( w.thrust_x * w.thrust_x + w.thrust_y * w.thrust_y + w.thrust_z * w.thrust_z );
										w.thrust_x = nx * thrustMag;
										w.thrust_y = ny * thrustMag;
										w.thrust_z = nz * thrustMag;

									}

								}

							}

						}

					}

				}

			}

		}

		// --- Apply thrust and drag to velocity ---
		// Ported from: do_physics_sim() in PHYSICS.C lines 641-680
		if ( w.drag > 0 ) {

			const hasThrust = w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0;
			if ( hasThrust === true ) {

				// Thrust-based: acceleration = thrust / mass, then apply drag
				const invMass = 1.0 / w.mass;
				w.vel_x += w.thrust_x * invMass * dt;
				w.vel_y += w.thrust_y * invMass * dt;
				w.vel_z += w.thrust_z * invMass * dt;

			}

			let dragFactor;
			if ( hasThrust === true ) {

				// Retain the existing thrust integration until weapon thrust is
				// converted to the fixed 1/64-second physics stepping as a unit.
				dragFactor = Math.pow( 1.0 - w.drag, dt );

			} else {

				// PHYSICS.C applies drag once per 1/64-second quantum plus a
				// linearly scaled partial quantum. Proximity mines use this path.
				const dragSteps = dt * 64.0;
				const wholeSteps = Math.floor( dragSteps );
				const partialStep = dragSteps - wholeSteps;
				dragFactor = Math.pow( 1.0 - w.drag, wholeSteps ) * ( 1.0 - partialStep * w.drag );

			}
			w.vel_x *= dragFactor;
			w.vel_y *= dragFactor;
			w.vel_z *= dragFactor;

		}

		// Homing speed acceleration: if below max_speed, accelerate toward it
		// Ported from: LASER.C lines 974-977
		if ( w.weapon_type < N_weapon_types && Weapon_info[ w.weapon_type ].homing_flag !== 0 && w.max_speed > 0 ) {

			const curSpeed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
			if ( curSpeed > 0.001 && curSpeed + 1.0 < w.max_speed ) {

				const newSpeed = curSpeed + w.max_speed * dt / 2;
				const accelScale = newSpeed / curSpeed;
				w.vel_x *= accelScale;
				w.vel_y *= accelScale;
				w.vel_z *= accelScale;

			}

		}

		// Clamp speed for thrust-based weapons
		// Ported from: LASER.C lines 1014-1025
		if ( w.max_speed > 0 && ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) ) {

			const curSpeed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
			if ( curSpeed > w.max_speed ) {

				const scale = w.max_speed / curSpeed;
				w.vel_x *= scale;
				w.vel_y *= scale;
				w.vel_z *= scale;

			}

		}

		// --- Compute new position using FVI ray cast ---
		// Ported from: Laser_do_weapon_sequence() in LASER.C — ray-sphere collision
		const new_x = w.pos_x + w.vel_x * dt;
		const new_y = w.pos_y + w.vel_y * dt;
		const new_z = w.pos_z + w.vel_z * dt;

		// Proximity mines are radius-3 physics objects in D1. Keep the existing
		// point-ray behavior for other projectiles until their radii are ported.
		const wallCollisionRadius = w.weapon_type === PROXIMITY_ID ? w.size : 0.0;
		const fvi_result = find_vector_intersection(
			w.pos_x, w.pos_y, w.pos_z,
			new_x, new_y, new_z,
			w.segnum, wallCollisionRadius,
			- 1, 0
		);

		// Compute wall hit distance (used to compare against object hits)
		let wallHitDist = Infinity;

		if ( fvi_result.hit_type === HIT_WALL ) {

			const wdx = fvi_result.hit_pnt_x - w.pos_x;
			const wdy = fvi_result.hit_pnt_y - w.pos_y;
			const wdz = fvi_result.hit_pnt_z - w.pos_z;
			wallHitDist = Math.sqrt( wdx * wdx + wdy * wdy + wdz * wdz );

		}

		// Fallback: if FVI returned HIT_NONE but find_point_seg fails, treat as wall hit at endpoint
		let newSeg = w.segnum;
		if ( fvi_result.hit_type !== HIT_WALL ) {

			newSeg = ( fvi_result.hit_seg !== - 1 ) ? fvi_result.hit_seg : find_point_seg( new_x, new_y, new_z, w.segnum );

			if ( newSeg === - 1 ) {

				// Outside mine — treat as wall hit at current position
				wallHitDist = 0;
				newSeg = w.segnum;

			}

		} else {

			// Wall hit — use FVI result segment
			if ( fvi_result.hit_seg !== - 1 ) newSeg = fvi_result.hit_seg;

		}

		// --- Ray-sphere object collision ---
		// Ported from: check_vector_to_sphere_1() in FVI.C
		// Test the full p0→p1 ray segment against each potential target sphere.
		// Track closest object hit and compare against wall hit distance.
		let closestObjDist = Infinity;
		let closestObjKind = 0;		// 1 = robot, 2 = player, 3 = clutter, 4 = debris, 5 = weapon
		let closestObjIndex = - 1;
		let closestHit_x = 0, closestHit_y = 0, closestHit_z = 0;

		// Player weapons check against robots
		if ( w.parent_type === PARENT_PLAYER && _robots !== null ) {

			for ( let r = 0; r < _robots.length; r ++ ) {

				const robot = _robots[ r ];
				if ( robot.alive !== true ) continue;
				if ( robot.morphing === true ) continue;

				// Skip persistent weapon re-hitting same target
				if ( w.last_hitobj === r ) continue;

				const hitRadius = robot.obj.size + w.size;
				const hitDist = check_vector_to_sphere(
					w.pos_x, w.pos_y, w.pos_z,
					new_x, new_y, new_z,
					robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
					hitRadius
				);

				if ( hitDist > 0 && hitDist < closestObjDist ) {

					closestObjDist = hitDist;
					closestObjKind = 1;
					closestObjIndex = r;
					closestHit_x = _sphereIntResult.hit_x;
					closestHit_y = _sphereIntResult.hit_y;
					closestHit_z = _sphereIntResult.hit_z;

				}

			}

		}

		// All weapons collide with polygon clutter.  D1 dispatches this through
		// collide_weapon_and_clutter(), independently of the weapon's parent.
		if ( _clutter !== null ) {

			for ( let c = 0; c < _clutter.length; c ++ ) {

				const clutter = _clutter[ c ];
				if ( clutter.alive !== true || clutter.obj === null || clutter.obj === undefined ) continue;

				const obj = clutter.obj;
				const hitRadius = obj.size + w.size;
				const hitDist = check_vector_to_sphere(
					w.pos_x, w.pos_y, w.pos_z,
					new_x, new_y, new_z,
					obj.pos_x, obj.pos_y, obj.pos_z,
					hitRadius
				);

				if ( hitDist > 0 && hitDist < closestObjDist ) {

					closestObjDist = hitDist;
					closestObjKind = 3;
					closestObjIndex = c;
					closestHit_x = _sphereIntResult.hit_x;
					closestHit_y = _sphereIntResult.hit_y;
					closestHit_z = _sphereIntResult.hit_z;

				}

			}

		}

		// Only player weapons destroy debris.  The original collision dispatch
		// ignores robot weapons for this object pair.
		if ( w.parent_type === PARENT_PLAYER && _debris !== null ) {

			for ( let d = 0; d < _debris.length; d ++ ) {

				const debris = _debris[ d ];
				if ( debris.active !== true ) continue;

				const hitRadius = debris.size + w.size;
				const hitDist = check_vector_to_sphere(
					w.pos_x, w.pos_y, w.pos_z,
					new_x, new_y, new_z,
					debris.pos_x, debris.pos_y, debris.pos_z,
					hitRadius
				);

				if ( hitDist > 0 && hitDist < closestObjDist ) {

					closestObjDist = hitDist;
					closestObjKind = 4;
					closestObjIndex = d;
					closestHit_x = _sphereIntResult.hit_x;
					closestHit_y = _sphereIntResult.hit_y;
					closestHit_z = _sphereIntResult.hit_z;

				}

			}

		}

		// Destroyable radius weapons can be shot down by other projectiles.
		// FVI normally filters sibling weapons before dispatching this pair.
		for ( let otherIndex = 0; otherIndex < weapons.length; otherIndex ++ ) {

			if ( otherIndex === i ) continue;
			const otherWeapon = weapons[ otherIndex ];
			if ( otherWeapon.active !== true ||
				otherWeapon.weapon_type < 0 || otherWeapon.weapon_type >= N_weapon_types ||
				w.weapon_type < 0 || w.weapon_type >= N_weapon_types ) continue;

			const wi = Weapon_info[ w.weapon_type ];
			const otherWi = Weapon_info[ otherWeapon.weapon_type ];
			if ( ( wi.destroyable === 0 || wi.damage_radius <= 0 ) &&
				( otherWi.destroyable === 0 || otherWi.damage_radius <= 0 ) ) continue;
			if ( weaponsAreRelated( w, otherWeapon ) ) continue;
			if ( w.weapon_type === otherWeapon.weapon_type &&
				w.parent_type === otherWeapon.parent_type &&
				w.parent_num === otherWeapon.parent_num ) continue;

			const hitRadius = otherWeapon.size + w.size;
			const hitDist = check_vector_to_sphere(
				w.pos_x, w.pos_y, w.pos_z,
				new_x, new_y, new_z,
				otherWeapon.pos_x, otherWeapon.pos_y, otherWeapon.pos_z,
				hitRadius
			);

			if ( hitDist > 0 && hitDist < closestObjDist ) {

				closestObjDist = hitDist;
				closestObjKind = 5;
				closestObjIndex = otherIndex;
				closestHit_x = _sphereIntResult.hit_x;
				closestHit_y = _sphereIntResult.hit_y;
				closestHit_z = _sphereIntResult.hit_z;

			}

		}

		// Robot weapons check against the player immediately. A player's own
		// proximity mine becomes unrelated to the player only after two seconds.
		// Skip persistent weapon re-hitting player (last_hitobj == -2)
		// Ported from: laser_are_related() and last_hitobj tracking in LASER.C
		const canHitPlayer = w.parent_type === PARENT_ROBOT ||
			( w.parent_type === PARENT_PLAYER && w.weapon_type === PROXIMITY_ID &&
				GameTime > w.creation_time + PROXIMITY_OWNER_IMMUNITY_TIME );
		if ( canHitPlayer === true && _getPlayerPos !== null && w.last_hitobj !== - 2 ) {

			const pp = _getPlayerPos();
			const playerHitRadius = PLAYER_HIT_RADIUS +
				( w.weapon_type === PROXIMITY_ID ? w.size : 0.0 );
			const hitDist = check_vector_to_sphere(
				w.pos_x, w.pos_y, w.pos_z,
				new_x, new_y, new_z,
				pp.x, pp.y, pp.z,
				playerHitRadius
			);

			if ( hitDist > 0 && hitDist < closestObjDist ) {

				closestObjDist = hitDist;
				closestObjKind = 2;
				closestObjIndex = - 2;	// retained player sentinel for last_hitobj
				closestHit_x = _sphereIntResult.hit_x;
				closestHit_y = _sphereIntResult.hit_y;
				closestHit_z = _sphereIntResult.hit_z;

			}

		}

		// Determine what was hit first: wall or object
		let hitSomething = false;

		if ( closestObjDist < wallHitDist && closestObjKind !== 0 ) {

			// Object hit is closer than wall
			w.pos_x = closestHit_x;
			w.pos_y = closestHit_y;
			w.pos_z = closestHit_z;
			const objectHitSeg = find_point_seg(
				closestHit_x, closestHit_y, closestHit_z, w.segnum
			);
			if ( objectHitSeg !== - 1 ) w.segnum = objectHitSeg;

			// Check if weapon is persistent (e.g., fusion cannon)
			// Ported from: LASER.C — persistent weapons pass through targets
			const isPersistent = ( w.weapon_type < N_weapon_types && Weapon_info[ w.weapon_type ].persistent !== 0 );

			if ( closestObjKind === 2 ) {

				// Hit player — track for persistent weapons
				// Ported from: LASER.C last_hitobj = player object num
				w.last_hitobj = - 2;

				const hasDamageRadius = w.weapon_type < N_weapon_types &&
					Weapon_info[ w.weapon_type ].damage_radius > 0;
				if ( _onPlayerHit !== null ) {

					_onPlayerHit(
						w.damage, closestHit_x, closestHit_y, closestHit_z,
						hasDamageRadius
					);

				}

				if ( isPersistent !== true ) {

					handleWeaponExplosion( w );
					kill_weapon( w );
					hitSomething = true;

				}

			} else if ( closestObjKind === 1 ) {

				// Hit robot
				w.last_hitobj = closestObjIndex;

				handleWeaponExplosion( w );

				if ( _onRobotHit !== null ) {

					_onRobotHit(
						closestObjIndex, w.damage, w.weapon_type,
						w.vel_x, w.vel_y, w.vel_z,
						closestHit_x, closestHit_y, closestHit_z
					);

				}

				if ( isPersistent !== true ) {

					kill_weapon( w );
					hitSomething = true;

				}

			} else if ( closestObjKind === 3 ) {

				// Clutter owns a small impact explosion and the positional
				// SOUND_LASER_HIT_CLUTTER cue.  Unlike robot impacts, D1 does not
				// detonate a damage-radius weapon here.
				if ( _onClutterHit !== null ) {

					_onClutterHit(
						_clutter[ closestObjIndex ], w.damage, w.weapon_type,
						w.segnum, closestHit_x, closestHit_y, closestHit_z
					);

				}

				if ( isPersistent !== true ) {

					kill_weapon( w );
					hitSomething = true;

				}

			} else if ( closestObjKind === 4 ) {

				// D1 destroys player-hit debris immediately, then detonates any
				// radius weapon at the contact point and consumes the weapon.
				if ( _onDebrisHit !== null ) {

					_onDebrisHit(
						_debris[ closestObjIndex ], w.segnum,
						closestHit_x, closestHit_y, closestHit_z
					);

				}

				if ( w.weapon_type < N_weapon_types &&
					Weapon_info[ w.weapon_type ].damage_radius > 0 ) {

					handleWeaponExplosion( w );

				}

				kill_weapon( w );
				hitSomething = true;

			} else {

				const otherWeapon = weapons[ closestObjIndex ];
				const combinedSize = otherWeapon.size + w.size;
				let collision_x = closestHit_x;
				let collision_y = closestHit_y;
				let collision_z = closestHit_z;
				if ( combinedSize > 0 ) {

					// PHYSICS.C computes the shared surface point between the two
					// weapon centers after placing the moving weapon at closestHit.
					const scale = otherWeapon.size / combinedSize;
					collision_x = otherWeapon.pos_x + ( closestHit_x - otherWeapon.pos_x ) * scale;
					collision_y = otherWeapon.pos_y + ( closestHit_y - otherWeapon.pos_y ) * scale;
					collision_z = otherWeapon.pos_z + ( closestHit_z - otherWeapon.pos_z ) * scale;

				}

				collideWeaponAndWeapon(
					w, otherWeapon, collision_x, collision_y, collision_z
				);
				if ( w.active !== true ) hitSomething = true;

			}

		} else if ( wallHitDist < Infinity ) {

			// Wall hit (or outside mine)
			if ( fvi_result.hit_type === HIT_WALL ) {

				w.pos_x = fvi_result.hit_pnt_x;
				w.pos_y = fvi_result.hit_pnt_y;
				w.pos_z = fvi_result.hit_pnt_z;
				if ( fvi_result.hit_seg !== - 1 ) w.segnum = fvi_result.hit_seg;

			}

			// Flares stick to walls. Proximity mines use their Weapon_info bounce
			// flag and therefore continue through the reflection path below.
			// Ported from: PHYSICS.C line 754 — PF_STICK flag handling
			if ( w.weapon_type === FLARE_ID ) {

				// collide_object_with_wall() runs before PF_STICK is applied in the
				// original, so a player flare can operate a door before it sticks.
				if ( w.weapon_type === FLARE_ID && fvi_result.hit_type === HIT_WALL && _onWallHit !== null ) {

					const wallSeg = ( fvi_result.hit_side_seg !== - 1 ) ? fvi_result.hit_side_seg : w.segnum;
					_onWallHit( w.pos_x, w.pos_y, w.pos_z, wallSeg, fvi_result.hit_side, w.damage, w.weapon_type,
						w.parent_type === PARENT_PLAYER, w.silent,
						w.parent_object_type, w.parent_object_id );

				}

				w.stuck = true;

				// Store wall_num for kill_stuck_objects()
				// Ported from: add_stuck_object() in WALL.C line 989-996
				if ( fvi_result.hit_side_seg >= 0 && fvi_result.hit_side >= 0 ) {

					const hitSeg = Segments[ fvi_result.hit_side_seg ];
					if ( hitSeg !== undefined ) {

						w.stuck_wallnum = hitSeg.sides[ fvi_result.hit_side ].wall_num;

					}

				}
				w.vel_x = 0;
				w.vel_y = 0;
				w.vel_z = 0;
				w.thrust_x = 0;
				w.thrust_y = 0;
				w.thrust_z = 0;

				// Update mesh position to wall contact point
				if ( w.modelMesh !== null ) {

					w.modelMesh.position.set( w.pos_x, w.pos_y, - w.pos_z );

				} else {

					w.mesh.position.set( w.pos_x, w.pos_y, - w.pos_z );

				}

				hitSomething = true;

			} else {

				// Check if weapon has bounce flag — reflect off walls instead of exploding
				// Ported from: PHYSICS.C lines 940-946 — PF_BOUNCE velocity reflection
				// Also: smart homing children get temporary bounce grace (LASER.C lines 278-281)
				const wiBounce = ( w.bounce_grace === true ) ? 1
					: ( w.weapon_type < N_weapon_types ) ? Weapon_info[ w.weapon_type ].bounce : 0;

				if ( wiBounce !== 0 && fvi_result.hit_type === HIT_WALL ) {

					// Reflect velocity: v -= 2 * (v . n) * n
					const nx = fvi_result.hit_wallnorm_x;
					const ny = fvi_result.hit_wallnorm_y;
					const nz = fvi_result.hit_wallnorm_z;
					const dot = w.vel_x * nx + w.vel_y * ny + w.vel_z * nz;

					if ( dot < 0 ) {

						w.vel_x -= 2.0 * dot * nx;
						w.vel_y -= 2.0 * dot * ny;
						w.vel_z -= 2.0 * dot * nz;

					}

					// Also reflect thrust direction
					if ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) {

						const tdot = w.thrust_x * nx + w.thrust_y * ny + w.thrust_z * nz;
						if ( tdot < 0 ) {

							w.thrust_x -= 2.0 * tdot * nx;
							w.thrust_y -= 2.0 * tdot * ny;
							w.thrust_z -= 2.0 * tdot * nz;

						}

					}

					hitSomething = true;

				} else {

					let wallHandledExplosion = false;
					if ( _onWallHit !== null ) {

						// Use hit_side_seg/hit_side from FVI for precise blastable wall detection
						const wallSeg = ( fvi_result.hit_side_seg !== - 1 ) ? fvi_result.hit_side_seg : w.segnum;
						wallHandledExplosion = _onWallHit(
							w.pos_x, w.pos_y, w.pos_z, wallSeg, fvi_result.hit_side,
							w.damage, w.weapon_type, w.parent_type === PARENT_PLAYER, w.silent,
							w.parent_object_type, w.parent_object_id
						) === true;

					}
					if ( wallHandledExplosion !== true ) handleWeaponExplosion( w );

					kill_weapon( w );
					hitSomething = true;

				}

			}

		}

		if ( hitSomething === true ) {

			updateWeaponInnerModelVisibility( w );
			continue;

		}

		// Update position
		w.pos_x = new_x;
		w.pos_y = new_y;
		w.pos_z = new_z;
		w.segnum = newSeg;

		// Update mesh and light position
		if ( w.modelMesh !== null ) {

			w.modelMesh.position.set( new_x, new_y, - new_z );
			applyWeaponOrientation( w.modelMesh, w );
			updateWeaponInnerModelVisibility( w );

		} else {

			w.mesh.position.set( new_x, new_y, - new_z );

		}

		// Animate vclip weapons (swap sprite texture per frame)
		// Ported from: draw_weapon_vclip() in VCLIP.C
		if ( w.weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ w.weapon_type ];
			if ( wi.render_type === WEAPON_RENDER_VCLIP && wi.weapon_vclip >= 0 ) {

				const vc = Vclips[ wi.weapon_vclip ];
				if ( vc !== undefined && vc.num_frames > 1 && vc.play_time > 0 ) {

					// modtime = lifeleft % play_time (loop animation)
					let modtime = w.lifeleft;
					while ( modtime > vc.play_time ) modtime -= vc.play_time;

					// Calculate frame index
					let frame = Math.floor( ( vc.num_frames * ( vc.play_time - modtime ) ) / vc.play_time );
					if ( frame >= vc.num_frames ) frame = vc.num_frames - 1;
					if ( frame < 0 ) frame = 0;

					const tex = getWeaponTexture( vc.frames[ frame ] );
					if ( tex !== null ) {

						w.mesh.material.map = tex;
						w.mesh.material.needsUpdate = true;

					}

				}

			}

		}

	}

}

// Get distance of nearest homing weapon targeting the player
// Ported from: LASER.C lines 958-963 (homing_object_dist update in laser_do_weapon_sequence)
// Returns distance in Descent units, or -1 if no homing weapon is tracking the player
export function laser_get_homing_object_dist() {

	if ( _getPlayerPos === null ) return - 1;

	const pp = _getPlayerPos();
	let minDist = - 1;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.parent_type !== PARENT_ROBOT ) continue;

		// Check if this is a homing weapon
		if ( w.weapon_type >= N_weapon_types ) continue;
		if ( Weapon_info[ w.weapon_type ].homing_flag === 0 ) continue;

		// Compute distance to player
		const dx = w.pos_x - pp.x;
		const dy = w.pos_y - pp.y;
		const dz = w.pos_z - pp.z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( minDist < 0 || dist < minDist ) {

			minDist = dist;

		}

	}

	return minDist;

}

// Get active weapons array for dynamic lighting
// Used by lighting.js to compute light from active weapon bolts
export function laser_get_active_weapons() {

	return weapons;

}

// Keep homing targets and persistent-weapon hit suppression attached to the
// same liveRobots entry when that array is compacted after a runtime-spawned
// robot dies.  Negative player/untracked sentinels are intentionally unaffected.
export function laser_remap_robot_index( oldIndex, newIndex ) {

	for ( let i = 0; i < weapons.length; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.track_goal === oldIndex ) w.track_goal = newIndex;
		if ( w.last_hitobj === oldIndex ) w.last_hitobj = newIndex;

	}

}

// Return pre-allocated array of stuck flare positions for dynamic lighting
// Ported from: set_dynamic_light() flare handling in LIGHTING.C lines 313-314
// Used by lighting.js to add flickering PointLights for stuck flares
const _stuckFlareData = [];
let _stuckFlareCount = 0;

for ( let i = 0; i < 8; i ++ ) {

	_stuckFlareData.push( { pos_x: 0, pos_y: 0, pos_z: 0, idx: 0, lifeleft: 0 } );

}

export function laser_get_stuck_flares() {

	_stuckFlareCount = 0;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		if ( _stuckFlareCount >= 8 ) break;

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.stuck !== true ) continue;
		if ( w.weapon_type !== FLARE_ID ) continue;

		const f = _stuckFlareData[ _stuckFlareCount ];
		f.pos_x = w.pos_x;
		f.pos_y = w.pos_y;
		f.pos_z = w.pos_z;
		f.idx = i;
		f.lifeleft = w.lifeleft;
		_stuckFlareCount ++;

	}

	return { data: _stuckFlareData, count: _stuckFlareCount };

}

// Kill any weapons stuck to the given wall (called when doors open or walls blast)
// Ported from: kill_stuck_objects() in WALL.C lines 1028-1048
export function laser_kill_stuck_on_wall( wallnum ) {

	if ( wallnum === - 1 ) return;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.stuck !== true ) continue;
		if ( w.stuck_wallnum !== wallnum ) continue;

		// Set short lifespan so weapon disappears quickly (0.25s like original)
		w.lifeleft = 0.25;
		w.stuck_wallnum = - 1;

	}

}
