// Ported from: descent-master/MAIN/FIREBALL.C
// Explosion and impact visual effects using vclip animated sprites
// Debris system for exploding polygon models

import * as THREE from 'three';
import { Vclips } from './bm.js';
import { Robot_info, N_robot_types, Player_ship, Dying_modelnums } from './bm.js';
import { Polygon_models, buildModelMesh, buildSubmodelMesh,
	polyobj_clone_model_mesh, polyobj_apply_texture_override,
	polyobj_wrap_model_lod } from './polyobj.js';
import { find_point_seg } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, HIT_WALL } from './fvi.js';
import { OBJ_PLAYER, OBJ_ROBOT, PF_BOUNCE, PF_USES_THRUST } from './object.js';
import { Segments, Vertices, Side_to_verts, Walls, Textures } from './mglobal.js';
import { WallAnims, find_connect_side, wall_set_tmap_num } from './wall.js';
import { digi_play_sample_world, SOUND_EXPLODING_WALL } from './digi.js';

// Vclip constants (from VCLIP.H)
export const VCLIP_SMALL_EXPLOSION = 2;
export const VCLIP_PLAYER_HIT = 1;
export const VCLIP_BIG_PLAYER_EXPLOSION = 58;
export const VCLIP_PLAYER_APPEARANCE = 61;
export const VCLIP_MORPHING_ROBOT = 10;
export const VCLIP_VOLATILE_WALL_HIT = 5;
export const VCLIP_POWERUP_DISAPPEARANCE = 62;

// Polygon-object destruction explosions are 2.5 times the object's radius.
// Direct object_create_explosion() callers already supply their final size.
// Ported from: FIREBALL.C EXPLOSION_SCALE and explode_object().
export const EXPLOSION_SCALE = 2.5;

function applyParentTextureOverride( mesh, parentObj ) {

	if ( mesh === null || mesh === undefined || parentObj === null || parentObj === undefined ||
		parentObj.rtype === null || parentObj.rtype === undefined ) return false;
	const tmapOverride = parentObj.rtype.tmap_override;
	if ( Number.isInteger( tmapOverride ) !== true || tmapOverride < 0 ||
		tmapOverride >= Textures.length ) return false;
	return polyobj_apply_texture_override(
		mesh, Textures[ tmapOverride ], _pigFile, _palette
	);

}

// What vclip does this object explode with?
// Ported from: get_explosion_vclip() in FIREBALL.C lines 901-916
// stage 0 = hit spark (exp1), stage 1 = death explosion (exp2)
export function get_explosion_vclip( obj_type, obj_id, stage ) {

	if ( obj_type === OBJ_ROBOT ) {

		if ( obj_id >= 0 && obj_id < N_robot_types ) {

			if ( stage === 0 && Robot_info[ obj_id ].exp1_vclip_num > - 1 ) {

				return Robot_info[ obj_id ].exp1_vclip_num;

			} else if ( stage === 1 && Robot_info[ obj_id ].exp2_vclip_num > - 1 ) {

				return Robot_info[ obj_id ].exp2_vclip_num;

			}

		}

	} else if ( obj_type === OBJ_PLAYER && Player_ship.loaded === true && Player_ship.expl_vclip_num > - 1 ) {

		return Player_ship.expl_vclip_num;

	}

	return VCLIP_SMALL_EXPLOSION;	// default

}

// Debris lifetime in seconds (from FIREBALL.C: #define DEBRIS_LIFE (f1_0 * 2))
const DEBRIS_LIFE = 2.0;

// Pool
const MAX_EXPLOSIONS = 30;
const explosions = [];
const EXPLOSION_PHYSICS_STEP = 1.0 / 64.0;

// Debris pool
const MAX_DEBRIS = 30;
const debrisList = [];
let Debris_next_signature = 0;

// External refs
let _scene = null;
let _buildTexture = null;	// callback( bitmapIndex ) => THREE.Texture
let _pigFile = null;
let _palette = null;

// Texture cache keyed by PIG bitmap index
const _textureCache = new Map();

// Reusable orientation state for debris updates (Golden Rule #5)
const _debrisMatrix = new THREE.Matrix4();
const _debrisEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
const _debrisRotation = new THREE.Quaternion();

// FIREBALL.C installs these fixed-angle rotational velocities on every debris
// object.  One full fixang revolution is 2*PI radians.
const FIXANG_TO_RADIANS = 2 * Math.PI / 65536;
const DEBRIS_ROTVEL_X = Math.trunc( 10 * 0x2000 / 3 ) * FIXANG_TO_RADIANS;
const DEBRIS_ROTVEL_Y = Math.trunc( 10 * 0x4000 / 3 ) * FIXANG_TO_RADIANS;
const DEBRIS_ROTVEL_Z = Math.trunc( 10 * 0x7000 / 3 ) * FIXANG_TO_RADIANS;

function debris_quick_magnitude( x, y, z ) {

	let largest = Math.abs( x );
	let middle = Math.abs( y );
	let smallest = Math.abs( z );
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	if ( middle < smallest ) { const t = middle; middle = smallest; smallest = t; }
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	return largest + middle * 3 / 8 + smallest * 3 / 16;

}

class ExplosionObj {

	constructor() {

		this.active = false;
		this.lifeleft = 0;
		this.playTime = 0;
		this.vclipNum = 0;
		this.numFrames = 0;
		this.baseSize = 0;
		this.sprite = null;
		this.lastFrame = - 1;	// track frame to avoid unnecessary texture swaps
		this.hasPhysics = false;
		this.segnum = - 1;
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;
		this.thrust_x = 0;
		this.thrust_y = 0;
		this.thrust_z = 0;
		this.mass = 0;
		this.drag = 0;
		this.physicsFlags = 0;

	}

}

// Debris object — represents a piece of a destroyed polygon model
// Ported from: object_create_debris() in FIREBALL.C
class DebrisObj {

	constructor() {

		this.active = false;
		this.signature = 0;
		this.mesh = null;
		this.model_num = - 1;
		this.subobj_num = - 1;
		this.size = 0;
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;
		this.rotvel_x = 0;
		this.rotvel_y = 0;
		this.rotvel_z = 0;
		this.lifeleft = 0;
		// Position in Descent coordinates
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;
		this.segnum = - 1;	// Current segment (for wall collision)

	}

}

// Get or create texture for a vclip frame
function getVclipTexture( vclipNum, frameIndex ) {

	const vc = Vclips[ vclipNum ];
	if ( vc === undefined || frameIndex >= vc.frames.length ) return null;

	const bmIdx = vc.frames[ frameIndex ];
	if ( _textureCache.has( bmIdx ) ) return _textureCache.get( bmIdx );

	if ( _buildTexture === null ) return null;

	const tex = _buildTexture( bmIdx );
	if ( tex !== null ) {

		_textureCache.set( bmIdx, tex );

	}

	return tex;

}

// Initialize explosion pool
// buildTexture: callback( bitmapIndex ) => THREE.Texture
export function fireball_init( scene, buildTexture, pigFile, palette ) {

	_scene = scene;
	_buildTexture = buildTexture;
	_pigFile = pigFile;
	_palette = palette;
	Debris_next_signature = 0;

	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = new ExplosionObj();

		// Each explosion gets its own SpriteMaterial (per-instance texture)
		e.sprite = new THREE.Sprite( new THREE.SpriteMaterial( {
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			depthTest: true
		} ) );
		e.sprite.visible = false;

		explosions.push( e );

	}

	// Pre-create debris pool slots
	for ( let i = 0; i < MAX_DEBRIS; i ++ ) {

		debrisList.push( new DebrisObj() );

	}

}

// Create a visual explosion at a position (Descent coordinates)
// vclip_num defaults to VCLIP_SMALL_EXPLOSION if not specified
export function object_create_explosion( pos_x, pos_y, pos_z, size, vclip_num ) {

	if ( _scene === null ) return null;
	if ( vclip_num === undefined ) vclip_num = VCLIP_SMALL_EXPLOSION;

	const vc = Vclips[ vclip_num ];
	if ( vc === undefined || vc.num_frames === 0 || vc.frames.length === 0 ) return null;

	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = explosions[ i ];
		if ( e.active === true ) continue;

		e.active = true;
		e.vclipNum = vclip_num;
		e.numFrames = vc.num_frames;
		e.playTime = vc.play_time > 0 ? vc.play_time : 0.5;
		e.lifeleft = e.playTime;
		e.baseSize = size;
		e.lastFrame = - 1;
		e.hasPhysics = false;
		e.segnum = - 1;
		e.pos_x = pos_x;
		e.pos_y = pos_y;
		e.pos_z = pos_z;
		e.vel_x = 0;
		e.vel_y = 0;
		e.vel_z = 0;
		e.thrust_x = 0;
		e.thrust_y = 0;
		e.thrust_z = 0;
		e.mass = 0;
		e.drag = 0;
		e.physicsFlags = 0;

		// Set first frame texture
		const tex = getVclipTexture( vclip_num, 0 );
		if ( tex !== null ) {

			e.sprite.material.map = tex;
			e.sprite.material.needsUpdate = true;

		}

		// Position in Three.js coordinates (negate Z)
		e.sprite.visible = true;
		e.sprite.position.set( pos_x, pos_y, - pos_z );

		e.sprite.scale.set( size, size, 1 );

		_scene.add( e.sprite );

		return e;

	}

	return null;

}

// FIREBALL.C copies the destroyed object's physics_info into its secondary
// explosion.  Keep static impact/muzzle fireballs on MT_NONE, while allowing
// the delayed object-death path to opt into that copied motion explicitly.
export function explosion_copy_physics(
	explosion, segnum, physics, velocity_x, velocity_y, velocity_z
) {

	if ( explosion === null || explosion === undefined || explosion.active !== true ||
		physics === null || physics === undefined ) return false;

	let resolvedSegnum = Number.isInteger( segnum ) === true ? segnum : - 1;
	if ( resolvedSegnum < 0 ) {

		resolvedSegnum = find_point_seg(
			explosion.pos_x, explosion.pos_y, explosion.pos_z, - 1
		);

	}
	if ( resolvedSegnum < 0 ) return false;

	explosion.segnum = resolvedSegnum;
	explosion.vel_x = Number.isFinite( velocity_x ) === true ? velocity_x
		: ( Number.isFinite( physics.velocity_x ) === true ? physics.velocity_x : 0 );
	explosion.vel_y = Number.isFinite( velocity_y ) === true ? velocity_y
		: ( Number.isFinite( physics.velocity_y ) === true ? physics.velocity_y : 0 );
	explosion.vel_z = Number.isFinite( velocity_z ) === true ? velocity_z
		: ( Number.isFinite( physics.velocity_z ) === true ? physics.velocity_z : 0 );
	explosion.thrust_x = Number.isFinite( physics.thrust_x ) === true ? physics.thrust_x : 0;
	explosion.thrust_y = Number.isFinite( physics.thrust_y ) === true ? physics.thrust_y : 0;
	explosion.thrust_z = Number.isFinite( physics.thrust_z ) === true ? physics.thrust_z : 0;
	explosion.mass = Number.isFinite( physics.mass ) === true ? physics.mass : 0;
	explosion.drag = Number.isFinite( physics.drag ) === true ? physics.drag : 0;
	explosion.physicsFlags = Number.isInteger( physics.flags ) === true ? physics.flags : 0;
	explosion.hasPhysics = true;
	return true;

}

function advance_explosion_velocity( explosion, dt ) {

	if ( explosion.drag <= 0 ) return;
	let count = Math.floor( dt / EXPLOSION_PHYSICS_STEP );
	const remainder = dt - count * EXPLOSION_PHYSICS_STEP;
	const fraction = remainder / EXPLOSION_PHYSICS_STEP;
	const drag = explosion.drag;

	if ( ( explosion.physicsFlags & PF_USES_THRUST ) !== 0 && explosion.mass > 0 ) {

		const accel_x = explosion.thrust_x / explosion.mass;
		const accel_y = explosion.thrust_y / explosion.mass;
		const accel_z = explosion.thrust_z / explosion.mass;
		while ( count > 0 ) {

			explosion.vel_x = ( explosion.vel_x + accel_x ) * ( 1.0 - drag );
			explosion.vel_y = ( explosion.vel_y + accel_y ) * ( 1.0 - drag );
			explosion.vel_z = ( explosion.vel_z + accel_z ) * ( 1.0 - drag );
			count --;

		}
		const scale = 1.0 - fraction * drag;
		explosion.vel_x = ( explosion.vel_x + accel_x * fraction ) * scale;
		explosion.vel_y = ( explosion.vel_y + accel_y * fraction ) * scale;
		explosion.vel_z = ( explosion.vel_z + accel_z * fraction ) * scale;

	} else {

		let totalDrag = 1.0;
		while ( count > 0 ) {

			totalDrag *= 1.0 - drag;
			count --;

		}
		totalDrag *= 1.0 - fraction * drag;
		explosion.vel_x *= totalDrag;
		explosion.vel_y *= totalDrag;
		explosion.vel_z *= totalDrag;

	}

}

function advance_explosion_physics( explosion, dt ) {

	if ( explosion.hasPhysics !== true || Number.isFinite( dt ) !== true || dt <= 0 ) return;
	advance_explosion_velocity( explosion, dt );

	let pos_x = explosion.pos_x;
	let pos_y = explosion.pos_y;
	let pos_z = explosion.pos_z;
	let segnum = explosion.segnum;
	let remaining = dt;

	for ( let iteration = 0; iteration < 3 && remaining > 0.0001; iteration ++ ) {

		const target_x = pos_x + explosion.vel_x * remaining;
		const target_y = pos_y + explosion.vel_y * remaining;
		const target_z = pos_z + explosion.vel_z * remaining;
		const travel_x = target_x - pos_x;
		const travel_y = target_y - pos_y;
		const travel_z = target_z - pos_z;
		const travelLength = Math.sqrt(
			travel_x * travel_x + travel_y * travel_y + travel_z * travel_z
		);
		const hit = find_vector_intersection(
			pos_x, pos_y, pos_z,
			target_x, target_y, target_z,
			segnum, explosion.baseSize, - 1, 0
		);

		if ( hit.hit_type === HIT_NONE ) {

			pos_x = hit.hit_pnt_x;
			pos_y = hit.hit_pnt_y;
			pos_z = hit.hit_pnt_z;
			if ( hit.hit_seg >= 0 ) segnum = hit.hit_seg;
			remaining = 0;
			break;

		}

		if ( hit.hit_type !== HIT_WALL ) {

			explosion.hasPhysics = false;
			break;

		}

		const moved_x = hit.hit_pnt_x - pos_x;
		const moved_y = hit.hit_pnt_y - pos_y;
		const moved_z = hit.hit_pnt_z - pos_z;
		const movedLength = Math.sqrt(
			moved_x * moved_x + moved_y * moved_y + moved_z * moved_z
		);
		const movedFraction = travelLength > 1e-12
			? Math.max( 0, Math.min( 1, movedLength / travelLength ) ) : 1;
		remaining *= 1.0 - movedFraction;
		pos_x = hit.hit_pnt_x;
		pos_y = hit.hit_pnt_y;
		pos_z = hit.hit_pnt_z;
		if ( hit.hit_seg >= 0 ) segnum = hit.hit_seg;

		const normalVelocity = explosion.vel_x * hit.hit_wallnorm_x +
			explosion.vel_y * hit.hit_wallnorm_y +
			explosion.vel_z * hit.hit_wallnorm_z;
		if ( normalVelocity < 0 ) {

			const response = ( explosion.physicsFlags & PF_BOUNCE ) !== 0 ? 2 : 1;
			explosion.vel_x -= hit.hit_wallnorm_x * normalVelocity * response;
			explosion.vel_y -= hit.hit_wallnorm_y * normalVelocity * response;
			explosion.vel_z -= hit.hit_wallnorm_z * normalVelocity * response;

		}

	}

	explosion.pos_x = pos_x;
	explosion.pos_y = pos_y;
	explosion.pos_z = pos_z;
	explosion.segnum = segnum;
	explosion.sprite.position.set( pos_x, pos_y, - pos_z );

}

// Create a single debris piece from a submodel of a destroyed object
// Ported from: object_create_debris() in FIREBALL.C
function object_create_debris(
	model_num, subobj_num, pos_x, pos_y, pos_z,
	pvx = 0, pvy = 0, pvz = 0, parentObj = null
) {

	if ( _scene === null || _pigFile === null || _palette === null ) return;

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return;

	// Build (or get cached) mesh for this submodel
	const sourceMesh = buildSubmodelMesh( model, subobj_num, _pigFile, _palette );
	if ( sourceMesh === null ) return;

	// Find an inactive debris slot
	let d = null;
	for ( let i = 0; i < MAX_DEBRIS; i ++ ) {

		if ( debrisList[ i ].active !== true ) {

			d = debrisList[ i ];
			break;

		}

	}

	if ( d === null ) return;	// No free slots

	// Clean up any previous mesh in this slot
	if ( d.mesh !== null ) {

		_scene.remove( d.mesh );
		d.mesh = null;

	}

	// Geometry remains shared, while light/glow/live-texture material state is
	// owned by this debris instance.
	d.mesh = polyobj_clone_model_mesh( sourceMesh );
	applyParentTextureOverride( d.mesh, parentObj );
	d.active = true;
	d.signature = Debris_next_signature ++;
	d.model_num = model_num;
	d.subobj_num = subobj_num;
	d.size = model.submodel_rads[ subobj_num ];
	d.lifeleft = DEBRIS_LIFE;

	// Position at parent's location (Descent coordinates)
	d.pos_x = pos_x;
	d.pos_y = pos_y;
	d.pos_z = pos_z;
	// obj_create() links debris to parent->segnum.  A point on a portal belongs
	// to both adjacent segments, so an exhaustive lookup can silently choose the
	// lower-numbered neighbor and make the first physics sweep start on the wrong
	// side of a wall.
	d.segnum = parentObj !== null && parentObj !== undefined &&
		Number.isInteger( parentObj.segnum ) === true && parentObj.segnum >= 0 &&
		parentObj.segnum < Segments.length
		? parentObj.segnum : find_point_seg( pos_x, pos_y, pos_z, - 1 );

	// FIREBALL.C creates three signed 15-bit components and normalizes them with
	// vm_vec_normalize_quick(), not Euclidean length.  Its speed expression is
	// integer arithmetic, so the launch speed is one of the integers 10..40.
	let vx = 16384 - Math.floor( Math.random() * 32768 );
	let vy = 16384 - Math.floor( Math.random() * 32768 );
	let vz = 16384 - Math.floor( Math.random() * 32768 );
	const vmag = debris_quick_magnitude( vx, vy, vz );
	if ( vmag > 0 ) {

		vx /= vmag;
		vy /= vmag;
		vz /= vmag;

	}

	// Quick-normalized direction * integer speed 10-40, plus the destroyed
	// object's velocity.
	// Ported from FIREBALL.C:362 — vm_vec_add2(&velocity, &parent->velocity).
	const speedRandom = Math.floor( Math.random() * 32768 );
	const speed = 10 + Math.floor( 30 * speedRandom / 32767 );
	d.vel_x = vx * speed + pvx;
	d.vel_y = vy * speed + pvy;
	d.vel_z = vz * speed + pvz;

	// Fixed rotation velocities from FIREBALL.C.  The physics simulation treats
	// these as local pitch, heading, and bank rates.
	d.rotvel_x = DEBRIS_ROTVEL_X;
	d.rotvel_y = DEBRIS_ROTVEL_Y;
	d.rotvel_z = DEBRIS_ROTVEL_Z;

	// obj_create() copies the parent's orientation into each debris object.
	// Convert the canonical Descent basis to Three's reflected-Z basis.
	if ( parentObj !== null && parentObj !== undefined ) {

		_debrisMatrix.set(
			parentObj.orient_rvec_x, parentObj.orient_uvec_x, - parentObj.orient_fvec_x, 0,
			parentObj.orient_rvec_y, parentObj.orient_uvec_y, - parentObj.orient_fvec_y, 0,
			- parentObj.orient_rvec_z, - parentObj.orient_uvec_z, parentObj.orient_fvec_z, 0,
			0, 0, 0, 1
		);
		d.mesh.quaternion.setFromRotationMatrix( _debrisMatrix );

	} else {

		d.mesh.quaternion.identity();

	}

	// Position mesh in Three.js coordinates
	d.mesh.position.set( pos_x, pos_y, - pos_z );
	_scene.add( d.mesh );

}

// Blow up a polygon model — create debris for each submodel
// Ported from: explode_model() in FIREBALL.C
export function explode_model(
	model_num, pos_x, pos_y, pos_z,
	pvx = 0, pvy = 0, pvz = 0, parentEntry = null
) {

	if ( model_num < 0 || model_num >= Polygon_models.length ) return;
	const originalModelNum = model_num;
	const parentObj = parentEntry !== null && parentEntry !== undefined &&
		parentEntry.obj !== null && parentEntry.obj !== undefined
		? parentEntry.obj : parentEntry;
	if ( model_num < Dying_modelnums.length && Dying_modelnums[ model_num ] >= 0 ) {

		model_num = Dying_modelnums[ model_num ];

	}
	if ( model_num < 0 || model_num >= Polygon_models.length ) return;

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return;
	if ( parentObj !== null && parentObj !== undefined &&
		parentObj.rtype !== null && parentObj.rtype !== undefined ) {

		parentObj.rtype.model_num = model_num;

	}
	const centerOnly = model.n_models > 1;
	const parentMesh = parentEntry !== null && parentEntry !== undefined
		? parentEntry.mesh : null;
	let replacementMesh = null;
	if ( parentMesh !== null && parentMesh !== undefined &&
		( centerOnly === true || model_num !== originalModelNum ) ) {

		let replacementSource;
		if ( centerOnly === true ) {

			replacementSource = buildSubmodelMesh( model, 0, _pigFile, _palette );

		} else {

			if ( model.mesh === null ) model.mesh = buildModelMesh( model, _pigFile, _palette );
			replacementSource = model.mesh;

		}
		if ( replacementSource !== null ) {

			replacementMesh = polyobj_clone_model_mesh( replacementSource );
			if ( centerOnly !== true && ( parentObj === null || parentObj === undefined ||
				parentObj.rtype === null || parentObj.rtype === undefined ||
				parentObj.rtype.subobj_flags === 0 ) ) {

				replacementMesh = polyobj_wrap_model_lod(
					replacementMesh, model, _pigFile, _palette
				);

			}
			applyParentTextureOverride( replacementMesh, parentObj );
			replacementMesh.position.copy( parentMesh.position );
			replacementMesh.quaternion.copy( parentMesh.quaternion );
			replacementMesh.scale.copy( parentMesh.scale );
			replacementMesh.visible = parentMesh.visible;
			replacementMesh.renderOrder = parentMesh.renderOrder;

		}

	}

	if ( centerOnly === true ) {

		// Create debris for each submodel (skip 0 = center body)
		for ( let i = 1; i < model.n_models; i ++ ) {

			object_create_debris( model_num, i, pos_x, pos_y, pos_z, pvx, pvy, pvz, parentObj );

		}

		// D1 leaves the original object alive and renders only submodel 0 until
		// the secondary explosion reaches its deletion time.  Replace the full
		// hierarchy with that centered root-only model instead of launching the
		// root itself as debris.
		if ( parentObj !== null && parentObj !== undefined &&
			parentObj.rtype !== null && parentObj.rtype !== undefined ) {

			parentObj.rtype.subobj_flags = 1;

		}

	}
	if ( replacementMesh !== null ) {

		const meshParent = parentMesh.parent;
		if ( meshParent !== null ) {

			meshParent.add( replacementMesh );
			meshParent.remove( parentMesh );

		} else if ( _scene !== null ) {

			_scene.remove( parentMesh );
			_scene.add( replacementMesh );

		}
		parentEntry.mesh = replacementMesh;
		if ( parentEntry.submodelGroups !== undefined ) parentEntry.submodelGroups = null;

	}

}

// Get active explosions array for dynamic lighting
// Used by lighting.js to compute light from explosions
export function fireball_get_active() {

	return explosions;

}

// Preallocated debris pool, used by the central object-light update.
export function fireball_get_debris() {

	return debrisList;

}

// Destroy one live debris object after a player weapon collision.
// Ported from: collide_weapon_and_debris() -> explode_object(debris, 0)
export function fireball_destroy_debris( debris ) {

	if ( debris === null || debris === undefined || debris.active !== true ) return false;

	object_create_explosion(
		debris.pos_x, debris.pos_y, debris.pos_z,
		debris.size * EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION
	);

	debris.active = false;
	if ( debris.mesh !== null ) {

		if ( _scene !== null ) _scene.remove( debris.mesh );
		debris.mesh = null;

	}

	return true;

}

// Clean up all active debris (called on level change)
export function debris_cleanup() {

	// Clean up active explosions and their lights
	for ( let i = 0; i < explosions.length; i ++ ) {

		const e = explosions[ i ];
		if ( e.active === true ) {

			e.active = false;
			e.hasPhysics = false;
			e.sprite.visible = false;
			if ( _scene !== null ) _scene.remove( e.sprite );

		}

	}

	// Clean up active debris
	for ( let i = 0; i < debrisList.length; i ++ ) {

		const d = debrisList[ i ];
		if ( d.active === true ) {

			d.active = false;
			if ( d.mesh !== null ) {

				if ( _scene !== null ) _scene.remove( d.mesh );
				d.mesh = null;

			}

		}

	}

	// Reset any active exploding walls
	init_exploding_walls();

}

// Update all active explosions and debris
export function fireball_process( dt ) {

	// --- Process explosions ---
	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = explosions[ i ];
		if ( e.active !== true ) continue;

		e.lifeleft -= dt;
		if ( e.lifeleft <= 0 ) {

			e.active = false;
			e.hasPhysics = false;
			e.sprite.visible = false;
			_scene.remove( e.sprite );

			continue;

		}
		advance_explosion_physics( e, dt );

		// Calculate current animation frame from lifeleft
		// From VCLIP.C: bitmapnum = (nf - fixdiv((nf-1)*timeleft, play_time)) - 1
		const nf = e.numFrames;
		let frameNum = Math.floor( nf - ( ( nf - 1 ) * e.lifeleft / e.playTime ) ) - 1;
		if ( frameNum < 0 ) frameNum = 0;
		if ( frameNum >= nf ) frameNum = nf - 1;

		// Update texture only when frame changes
		if ( frameNum !== e.lastFrame ) {

			e.lastFrame = frameNum;
			const tex = getVclipTexture( e.vclipNum, frameNum );
			if ( tex !== null ) {

				e.sprite.material.map = tex;
				e.sprite.material.needsUpdate = true;

			}

		}

	}

	// --- Process debris ---
	// Ported from: do_debris_frame() in FIREBALL.C
	for ( let i = 0; i < debrisList.length; i ++ ) {

		const d = debrisList[ i ];
		if ( d.active !== true ) continue;

		d.lifeleft -= dt;

		if ( d.lifeleft <= 0 ) {

			// Debris expires — create small explosion at its position
			object_create_explosion(
				d.pos_x, d.pos_y, d.pos_z,
				d.size * EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION
			);

			d.active = false;
			if ( d.mesh !== null ) {

				_scene.remove( d.mesh );
				d.mesh = null;

			}

			continue;

		}

		// Update position: pos += vel * dt (no drag, per original)
		const new_x = d.pos_x + d.vel_x * dt;
		const new_y = d.pos_y + d.vel_y * dt;
		const new_z = d.pos_z + d.vel_z * dt;

		// Sweep the debris sphere through the mine.  An endpoint-only segment
		// lookup can place a fast fragment in the segment beyond a closed door;
		// D1 moves OBJ_DEBRIS through FVI and collide_debris_and_wall() explodes
		// it at the first solid contact.
		const hit = find_vector_intersection(
			d.pos_x, d.pos_y, d.pos_z,
			new_x, new_y, new_z,
			d.segnum, d.size, - 1, 0
		);
		const newSeg = hit.hit_seg;

		if ( hit.hit_type !== HIT_NONE || newSeg === - 1 ) {

			// Hit a wall — explode and deactivate
			const impact_x = hit.hit_type === HIT_WALL ? hit.hit_pnt_x : d.pos_x;
			const impact_y = hit.hit_type === HIT_WALL ? hit.hit_pnt_y : d.pos_y;
			const impact_z = hit.hit_type === HIT_WALL ? hit.hit_pnt_z : d.pos_z;
			object_create_explosion(
				impact_x, impact_y, impact_z,
				d.size * EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION
			);

			d.active = false;
			if ( d.mesh !== null ) {

				_scene.remove( d.mesh );
				d.mesh = null;

			}

			continue;

		}

		d.pos_x = hit.hit_pnt_x;
		d.pos_y = hit.hit_pnt_y;
		d.pos_z = hit.hit_pnt_z;
		d.segnum = newSeg;

		// Update mesh position (Three.js coordinates: negate Z)
		d.mesh.position.set( d.pos_x, d.pos_y, - d.pos_z );

		// PHYSICS.C post-multiplies the current orientation by a local
		// pitch/heading/bank rotation.  In Three's reflected-Z basis that is
		// YXZ Euler (-pitch, -heading, +bank), not independent XYZ increments.
		_debrisEuler.set(
			- d.rotvel_x * dt,
			- d.rotvel_y * dt,
			d.rotvel_z * dt,
			'YXZ'
		);
		_debrisRotation.setFromEuler( _debrisEuler );
		d.mesh.quaternion.multiply( _debrisRotation ).normalize();

	}

	// --- Process exploding walls ---
	do_exploding_wall_frame( dt );

}

// ============================================================
// Exploding wall system
// Ported from: explode_wall() and do_exploding_wall_frame() in FIREBALL.C lines 1136-1283
// Progressive fireball cascade on walls with WCF_EXPLODES flag
// ============================================================

const MAX_EXPLODING_WALLS = 10;
const EXPL_WALL_TIME = 1.0;			// 1 second total explosion time (f1_0 in original)
const EXPL_WALL_TOTAL_FIREBALLS = 32;	// total fireballs spawned over explosion duration
const EXPL_WALL_FIREBALL_SIZE = 4.5;	// 0x48000 / 65536 = ~4.5 (smallest fireball size)

// Exploding wall slots — pre-allocated (Golden Rule #5)
const expl_wall_list = [];

for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

	expl_wall_list.push( { segnum: - 1, sidenum: 0, time: 0 } );

}

// Badass explosion callback for wall fireballs that do area damage
// (pos_x, pos_y, pos_z, maxDamage, maxDistance) => void
let _onBadassWallExplosion = null;

export function fireball_set_badass_wall_callback( fn ) {

	_onBadassWallExplosion = fn;

}

// Initialize exploding walls (called at level start)
// Ported from: init_exploding_walls() in FIREBALL.C lines 1149-1155
export function init_exploding_walls() {

	for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		expl_wall_list[ i ].segnum = - 1;

	}

}

// Start an exploding wall sequence
// Ported from: explode_wall() in FIREBALL.C lines 1158-1181
export function explode_wall( segnum, sidenum ) {

	// Find a free slot
	let i;
	for ( i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		if ( expl_wall_list[ i ].segnum === - 1 ) break;

	}

	if ( i === MAX_EXPLODING_WALLS ) {

		console.warn( 'FIREBALL: No free slot for exploding wall!' );
		return;

	}

	expl_wall_list[ i ].segnum = segnum;
	expl_wall_list[ i ].sidenum = sidenum;
	expl_wall_list[ i ].time = 0;

	// Play one long sound for the whole door wall explosion
	// Ported from: FIREBALL.C line 1178-1179
	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sidenum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 4; v ++ ) {

		const vi = seg.verts[ sv[ v ] ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	cx /= 4;
	cy /= 4;
	cz /= 4;

	digi_play_sample_world( SOUND_EXPLODING_WALL, 1.0, segnum, cx, cy, cz );

}

// Process all exploding walls per frame
// Ported from: do_exploding_wall_frame() in FIREBALL.C lines 1185-1283
function do_exploding_wall_frame( dt ) {

	for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		const segnum = expl_wall_list[ i ].segnum;
		if ( segnum === - 1 ) continue;

		const sidenum = expl_wall_list[ i ].sidenum;

		const oldfrac = expl_wall_list[ i ].time / EXPL_WALL_TIME;

		expl_wall_list[ i ].time += dt;
		if ( expl_wall_list[ i ].time > EXPL_WALL_TIME ) {

			expl_wall_list[ i ].time = EXPL_WALL_TIME;

		}

		// At 75% of explosion time, set wall texture to final (destroyed) frame
		// Ported from: FIREBALL.C lines 1203-1216
		if ( expl_wall_list[ i ].time > ( EXPL_WALL_TIME * 3 ) / 4 ) {

			const seg = Segments[ segnum ];
			const wall_num = seg.sides[ sidenum ].wall_num;

			if ( wall_num !== - 1 ) {

				const a = Walls[ wall_num ].clip_num;

				if ( a >= 0 ) {

					const n = WallAnims[ a ].num_frames;
					const child_segnum = seg.children[ sidenum ];

					if ( child_segnum >= 0 ) {

						const cside = find_connect_side( segnum, child_segnum );

						if ( cside !== - 1 ) {

							wall_set_tmap_num( segnum, sidenum, child_segnum, cside, a, n - 1 );

						}

					}

				}

			}

		}

		const newfrac = expl_wall_list[ i ].time / EXPL_WALL_TIME;

		// Quadratic fireball count: count = TOTAL * frac^2
		// Ported from: FIREBALL.C lines 1220-1221
		const old_count = Math.floor( EXPL_WALL_TOTAL_FIREBALLS * oldfrac * oldfrac );
		const new_count = Math.floor( EXPL_WALL_TOTAL_FIREBALLS * newfrac * newfrac );

		// Create new fireballs for this frame
		// Ported from: FIREBALL.C lines 1229-1275
		for ( let e = old_count; e < new_count; e ++ ) {

			const seg = Segments[ segnum ];
			const sv = Side_to_verts[ sidenum ];

			// Get three vertices of the wall face
			const vi0 = seg.verts[ sv[ 0 ] ];
			const vi1 = seg.verts[ sv[ 1 ] ];
			const vi2 = seg.verts[ sv[ 2 ] ];

			const v0x = Vertices[ vi0 * 3 + 0 ];
			const v0y = Vertices[ vi0 * 3 + 1 ];
			const v0z = Vertices[ vi0 * 3 + 2 ];
			const v1x = Vertices[ vi1 * 3 + 0 ];
			const v1y = Vertices[ vi1 * 3 + 1 ];
			const v1z = Vertices[ vi1 * 3 + 2 ];
			const v2x = Vertices[ vi2 * 3 + 0 ];
			const v2y = Vertices[ vi2 * 3 + 1 ];
			const v2z = Vertices[ vi2 * 3 + 2 ];

			// Edge vectors from v1
			const e0x = v0x - v1x;
			const e0y = v0y - v1y;
			const e0z = v0z - v1z;
			const e1x = v2x - v1x;
			const e1y = v2y - v1y;
			const e1z = v2z - v1z;

			// Random position on face: pos = v1 + rand*e0 + rand*e1
			// Ported from: vm_vec_scale_add with rand()*2 (rand() returns 0..32767, *2 gives 0..65534, ~0..1.0 in fixed)
			const r0 = Math.random();
			const r1 = Math.random();

			let px = v1x + e0x * r0 + e1x * r1;
			let py = v1y + e0y * r0 + e1y * r1;
			let pz = v1z + e0z * r0 + e1z * r1;

			// Fireball size increases with progression
			const size = EXPL_WALL_FIREBALL_SIZE + ( 2 * EXPL_WALL_FIREBALL_SIZE * e / EXPL_WALL_TOTAL_FIREBALLS );

			// Offset from wall along face normal — starts far, gets closer
			// Ported from: FIREBALL.C lines 1258-1260
			let nx = e0y * e1z - e0z * e1y;
			let ny = e0z * e1x - e0x * e1z;
			let nz = e0x * e1y - e0y * e1x;
			const nmag = Math.sqrt( nx * nx + ny * ny + nz * nz );

			if ( nmag > 0.001 ) {

				nx /= nmag;
				ny /= nmag;
				nz /= nmag;
				const offset = size * ( EXPL_WALL_TOTAL_FIREBALLS - e ) / EXPL_WALL_TOTAL_FIREBALLS;
				px += nx * offset;
				py += ny * offset;
				pz += nz * offset;

			}

			if ( ( e & 3 ) !== 0 ) {

				// 3 of 4 are normal explosions (visual only)
				object_create_explosion( px, py, pz, size, VCLIP_SMALL_EXPLOSION );

			} else {

				// 1 of 4 are badass (do area damage)
				// Ported from: FIREBALL.C lines 1265-1272
				// damage=4, radius=20, force=50
				object_create_explosion( px, py, pz, size, VCLIP_SMALL_EXPLOSION );

				if ( _onBadassWallExplosion !== null ) {

					_onBadassWallExplosion( px, py, pz, 4.0, 20.0, 50.0 );

				}

			}

		}

		// Check if explosion is complete
		if ( expl_wall_list[ i ].time >= EXPL_WALL_TIME ) {

			expl_wall_list[ i ].segnum = - 1;	// Free slot

		}

	}

}
