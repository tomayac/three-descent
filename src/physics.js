// Ported from: descent-master/MAIN/PHYSICS.C
// Player physics simulation: linear and rotational sub-stepping with drag

import { find_point_seg, find_connect_side } from './gameseg.js';
import {
	find_vector_intersection, HIT_NONE, HIT_WALL, HIT_OBJECT, HIT_BAD_P0,
	FQ_CHECK_OBJS, FQ_GET_SEGLIST, MAX_FVI_SEGS, fvi_set_ignore_obj_list
} from './fvi.js';
import { wall_hit_process as fvi_wall_hit_process } from './wall.js';
import { check_trigger as fvi_check_trigger } from './switch.js';
import { GameTime, Segments, Num_segments, Objects } from './mglobal.js';
import { SIDE_IS_TRI_02, SIDE_IS_TRI_13 } from './segment.js';
import { OBJ_PLAYER, OF_SHOULD_BE_DEAD, PF_PERSISTENT, obj_relink } from './object.js';

// --- Player ship physics constants (ported from bitmaps.bin $PLAYER_SHIP) ---
export const PLAYER_MASS = 4.0;
export const PLAYER_DRAG = 0.033;
export const PLAYER_MAX_THRUST = 7.8;
export const PLAYER_MAX_ROTTHRUST = 0.14;
export const PLAYER_WIGGLE = 0.5;
export const PHYSICS_FT = 1.0 / 64.0;	// Sub-step time (F1_0/64)
export const PLAYER_RADIUS = 2.5;	// Fallback radius before a canonical player model is registered

// Wall-hit damage constants (from COLLIDE.C lines 650-652)
const DAMAGE_SCALE = 128.0;
const DAMAGE_THRESHOLD = 1.0 / 3.0;	// F1_0/3
const WALL_LOUDNESS_SCALE = 20.0;

// Callback for wall-hit damage — injected by gameseq.js
let _onPlayerWallHit = null;
let _onPlayerObjectHit = null;

export function physics_set_wall_hit_callback( fn ) {

	_onPlayerWallHit = fn;

}

export function physics_set_object_hit_callback( fn ) {

	_onPlayerObjectHit = fn;

}

// Turn banking constants (converted from fixed-angle units to radians)
// Ported from: PHYSICS.C lines 269-272
const FIXANG_TO_RAD = ( Math.PI * 2.0 ) / 65536.0;
const TURNROLL_SCALE = 0.154;	// (0x4ec4/2)/65536
const ROLL_RATE = 0x2000 * FIXANG_TO_RAD;	// ~0.785 rad/s (45°/s)

// Auto-level constants (from PHYSICS.C do_physics_align_object)
// DAMP_ANG = 0x400 fixang -> ~0.098 rad (~5.6°)
const DAMP_ANG = 0x400 * FIXANG_TO_RAD;

// Player velocity in Descent coordinates (persistent across frames)
const playerVelocity = { x: 0, y: 0, z: 0 };
// Player rotational velocity (pitch, heading, bank) in radians/sec
const playerRotVel = { x: 0, y: 0, z: 0 };
// Current player forward vector in Descent coordinates.  phys_apply_rot() is
// called from collision and weapon code which deliberately knows nothing about
// the Three.js camera, so game.js keeps this canonical direction synchronized.
const playerForward = { x: 0, y: 0, z: 1 };
// Turn banking angle (visual bank during yaw rotation)
let turnroll = 0;

export function getPlayerVelocity() { return playerVelocity; }
export function getPlayerRotVelocity() { return playerRotVel; }
export function getTurnroll() { return turnroll; }

export function physics_set_player_forward( x, y, z ) {

	if ( Number.isFinite( x ) !== true || Number.isFinite( y ) !== true ||
		Number.isFinite( z ) !== true ) return false;
	const magnitude = Math.sqrt( x * x + y * y + z * z );
	if ( magnitude <= 1e-12 ) return false;
	const inverse = 1.0 / magnitude;
	playerForward.x = x * inverse;
	playerForward.y = y * inverse;
	playerForward.z = z * inverse;
	return true;

}

export function physics_set_player_rot_velocity( pitch, heading, bank ) {

	if ( Number.isFinite( pitch ) !== true || Number.isFinite( heading ) !== true ||
		Number.isFinite( bank ) !== true ) return false;
	playerRotVel.x = pitch;
	playerRotVel.y = heading;
	playerRotVel.z = bank;
	return true;

}

// Compute turn banking angle from yaw rotational velocity
// Ported from: set_object_turnroll() in PHYSICS.C lines 404-426
// Smoothly interpolates current turnroll toward desired bank at ROLL_RATE
export function set_object_turnroll( dt ) {

	const desired_bank = playerRotVel.y * TURNROLL_SCALE;

	if ( turnroll !== desired_bank ) {

		let max_roll = ROLL_RATE * dt;
		const delta_ang = desired_bank - turnroll;

		if ( Math.abs( delta_ang ) < max_roll ) {

			max_roll = delta_ang;

		} else if ( delta_ang < 0 ) {

			max_roll = - max_roll;

		}

		turnroll += max_roll;

	}

}

// Auto-level the player ship: gradually rotate toward "upright" orientation
// Ported from: do_physics_align_object() in PHYSICS.C lines 312-402
// Finds segment side normal most aligned with current up vector, then rolls toward it.
//
// camera = THREE.PerspectiveCamera (has .quaternion for orientation)
// playerSegnum = player's current segment (used to derive desired up from segment normals)
// dt = frame delta time in seconds
//
// Pre-allocated working vectors (Golden Rule #5)
const _alignForward = { x: 0, y: 0, z: 0 };
const _alignUp = { x: 0, y: 0, z: 0 };
const _alignDesired = { x: 0, y: 0, z: 0 };

export function do_physics_align_object( camera, playerSegnum, dt ) {

	if ( camera === null ) return;

	// Extract camera forward vector in Descent coordinates (negate Z)
	// camera forward in Three.js is (0,0,-1) rotated by quaternion
	const q = camera.quaternion;
	// Optimized quaternion rotation of (0,0,-1):
	// Three.js forward (0,0,-1) → Descent forward (negate z) = (0,0,1) in Descent
	// Actually: get Three.js forward then convert
	const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

	// Rotate (0,0,-1) by quaternion: result = q * (0,0,-1) * q^-1
	// Derived from standard quaternion rotation matrix: R*v where v=(0,0,-1) = -column3(R)
	const fx_three = - 2.0 * ( qx * qz + qw * qy );
	const fy_three = 2.0 * ( qw * qx - qy * qz );
	const fz_three = - ( 1.0 - 2.0 * ( qx * qx + qy * qy ) );

	// Convert to Descent coords (negate Z)
	_alignForward.x = fx_three;
	_alignForward.y = fy_three;
	_alignForward.z = - fz_three;

	// Rotate (0,1,0) by quaternion: column2 of standard quaternion rotation matrix
	const ux_three = 2.0 * ( qx * qy - qw * qz );
	const uy_three = 1.0 - 2.0 * ( qx * qx + qz * qz );
	const uz_three = 2.0 * ( qy * qz + qw * qx );

	// Convert to Descent coords (negate Z)
	_alignUp.x = ux_three;
	_alignUp.y = uy_three;
	_alignUp.z = - uz_three;

	let segnum = playerSegnum;
	if ( segnum < 0 || segnum >= Num_segments ) {

		segnum = find_point_seg( camera.position.x, camera.position.y, - camera.position.z, playerSegnum );

	}

	if ( segnum < 0 || segnum >= Num_segments ) return;

	const seg = Segments[ segnum ];

	// Find side normal most aligned with current up vector.
	// Ported from: PHYSICS.C lines 324-336
	let largest_d = - 1e9;
	let best_side = - 1;

	for ( let i = 0; i < 6; i ++ ) {

		const n0 = seg.sides[ i ].normals[ 0 ];
		const d = n0.x * _alignUp.x + n0.y * _alignUp.y + n0.z * _alignUp.z;
		if ( d > largest_d ) {

			largest_d = d;
			best_side = i;

		}

	}

	if ( best_side < 0 ) return;

	const best = seg.sides[ best_side ];

	// For triangulated sides use average of both face normals, otherwise face 0 normal.
	// Ported from: PHYSICS.C lines 349-373
	if ( best.type === SIDE_IS_TRI_02 || best.type === SIDE_IS_TRI_13 ) {

		_alignDesired.x = best.normals[ 0 ].x + best.normals[ 1 ].x;
		_alignDesired.y = best.normals[ 0 ].y + best.normals[ 1 ].y;
		_alignDesired.z = best.normals[ 0 ].z + best.normals[ 1 ].z;
		const dm = Math.sqrt(
			_alignDesired.x * _alignDesired.x +
			_alignDesired.y * _alignDesired.y +
			_alignDesired.z * _alignDesired.z
		);
		if ( dm < 0.0001 ) return;
		_alignDesired.x /= dm;
		_alignDesired.y /= dm;
		_alignDesired.z /= dm;

	} else {

		_alignDesired.x = best.normals[ 0 ].x;
		_alignDesired.y = best.normals[ 0 ].y;
		_alignDesired.z = best.normals[ 0 ].z;

	}

	const desired_x = _alignDesired.x;
	const desired_y = _alignDesired.y;
	const desired_z = _alignDesired.z;

	// Check that desired up is not nearly parallel to forward
	// (dot product of desired_up and forward should be < 0.5)
	// Ported from: PHYSICS.C line 375 — labs(vm_vec_dot(&desired_upvec,&obj->orient.fvec)) < f1_0/2
	const fwdDotDesired = Math.abs(
		_alignForward.x * desired_x + _alignForward.y * desired_y + _alignForward.z * desired_z
	);

	if ( fwdDotDesired >= 0.5 ) return;	// Ship pointing nearly straight up/down — can't auto-level

	// Project desired up onto the plane perpendicular to forward
	// projected = desired - (desired . forward) * forward
	const dot_df = desired_x * _alignForward.x + desired_y * _alignForward.y + desired_z * _alignForward.z;
	let proj_x = desired_x - dot_df * _alignForward.x;
	let proj_y = desired_y - dot_df * _alignForward.y;
	let proj_z = desired_z - dot_df * _alignForward.z;

	// Normalize projected desired up
	const proj_mag = Math.sqrt( proj_x * proj_x + proj_y * proj_y + proj_z * proj_z );
	if ( proj_mag < 0.001 ) return;
	proj_x /= proj_mag;
	proj_y /= proj_mag;
	proj_z /= proj_mag;

	// Also project current up onto the plane perpendicular to forward
	const dot_uf = _alignUp.x * _alignForward.x + _alignUp.y * _alignForward.y + _alignUp.z * _alignForward.z;
	let cur_x = _alignUp.x - dot_uf * _alignForward.x;
	let cur_y = _alignUp.y - dot_uf * _alignForward.y;
	let cur_z = _alignUp.z - dot_uf * _alignForward.z;

	const cur_mag = Math.sqrt( cur_x * cur_x + cur_y * cur_y + cur_z * cur_z );
	if ( cur_mag < 0.001 ) return;
	cur_x /= cur_mag;
	cur_y /= cur_mag;
	cur_z /= cur_mag;

	// Compute angle between projected current up and projected desired up
	// Using cross product magnitude for signed angle around forward axis
	let dot_cp = cur_x * proj_x + cur_y * proj_y + cur_z * proj_z;
	if ( dot_cp > 1.0 ) dot_cp = 1.0;
	if ( dot_cp < - 1.0 ) dot_cp = - 1.0;

	// Cross product cur × proj, dotted with forward gives signed angle direction
	const cross_x = cur_y * proj_z - cur_z * proj_y;
	const cross_y = cur_z * proj_x - cur_x * proj_z;
	const cross_z = cur_x * proj_y - cur_y * proj_x;
	const cross_dot_fwd = cross_x * _alignForward.x + cross_y * _alignForward.y + cross_z * _alignForward.z;

	const delta_ang = Math.atan2( cross_dot_fwd, dot_cp );

	// Include turnroll in the delta (ported from PHYSICS.C line 383)
	const total_delta = delta_ang + turnroll;

	// Only correct if above damping threshold
	// Ported from: PHYSICS.C line 385 — if (abs(delta_ang) > DAMP_ANG)
	if ( Math.abs( total_delta ) <= DAMP_ANG ) return;

	// Limit rotation rate to ROLL_RATE * dt
	// Ported from: PHYSICS.C lines 388-391
	let roll_ang = ROLL_RATE * dt;

	if ( Math.abs( total_delta ) < roll_ang ) {

		roll_ang = total_delta;

	} else if ( total_delta < 0 ) {

		roll_ang = - roll_ang;

	}

	// Apply bank correction around forward axis (Three.js Z axis in camera space)
	// In Three.js camera space, Z-rotation is bank/roll
	// The sign is inverted because Three.js Z points toward viewer (opposite to Descent forward)
	camera.rotateZ( roll_ang );

}

// Reset player physics state (velocity + rotational velocity)
// Called on respawn, restart, and level transitions
export function physics_reset() {

	playerVelocity.x = 0;
	playerVelocity.y = 0;
	playerVelocity.z = 0;
	playerRotVel.x = 0;
	playerRotVel.y = 0;
	playerRotVel.z = 0;
	playerForward.x = 0;
	playerForward.y = 0;
	playerForward.z = 1;
	turnroll = 0;

}

// Apply an instantaneous force to an object, changing its velocity
// Ported from: phys_apply_force() in PHYSICS.C lines 1163-1173
// obj may be a canonical object or a live robot wrapper with obj + aiLocal.
// A null obj targets playerVelocity.
export function phys_apply_force( obj, force_x, force_y, force_z ) {

	// For player object — modify playerVelocity directly
	if ( obj === null ) {

		// Null = player object (special case, since player doesn't use Objects[])
		if ( PLAYER_MASS > 0 ) {

			const invMass = 1.0 / PLAYER_MASS;
			playerVelocity.x += force_x * invMass;
			playerVelocity.y += force_y * invMass;
			playerVelocity.z += force_z * invMass;

		}

		return;

	}

	// Live robot wrappers keep the canonical physics data under obj.obj while AI
	// integrates velocity from the wrapper's aiLocal state.
	const physicsObject = obj.obj !== undefined && obj.obj !== null ? obj.obj : obj;
	const mass = ( physicsObject.mtype !== null && physicsObject.mtype !== undefined &&
		physicsObject.mtype.mass > 0 ) ? physicsObject.mtype.mass : 4.0;
	const invMass = 1.0 / mass;

	// Robots store velocity in aiLocal, not mtype.phys_info
	if ( obj.aiLocal !== undefined && obj.aiLocal !== null ) {

		obj.aiLocal.vel_x += force_x * invMass;
		obj.aiLocal.vel_y += force_y * invMass;
		obj.aiLocal.vel_z += force_z * invMass;

	} else if ( physicsObject.mtype !== null && physicsObject.mtype !== undefined ) {

		physicsObject.mtype.velocity_x += force_x * invMass;
		physicsObject.mtype.velocity_y += force_y * invMass;
		physicsObject.mtype.velocity_z += force_z * invMass;

	}

}

// Apply force to player specifically (convenience wrapper)
export function phys_apply_force_to_player( force_x, force_y, force_z ) {

	phys_apply_force( null, force_x, force_y, force_z );

}

function wrap_rotation_delta( angle ) {

	if ( angle > Math.PI ) return angle - Math.PI * 2.0;
	if ( angle < - Math.PI ) return angle + Math.PI * 2.0;
	return angle;

}

function set_rotvel_and_saturate( current, delta ) {

	// PHYSICS.C does not add torque here.  It replaces the angular rate, with a
	// small reversal damped to one quarter so an impact cannot instantly flip a
	// ship already rotating in the opposite direction.
	if ( current * delta < 0 && Math.abs( delta ) < Math.PI / 4.0 ) {

		return delta / 4.0;

	}
	return delta;

}

// Apply rotational force to the player.
// Ported from: physics_turn_towards_vector() + phys_apply_rot() in PHYSICS.C.
// The force is a world-space direction and magnitude.  D1 converts it to a
// desired pitch/heading rate; it does not add its XYZ components as Euler rates.
export function phys_apply_rot( force_x, force_y, force_z ) {

	if ( PLAYER_MASS <= 0 ) return;
	if ( Number.isFinite( force_x ) !== true || Number.isFinite( force_y ) !== true ||
		Number.isFinite( force_z ) !== true ) return;

	const forceMagnitude = Math.sqrt(
		force_x * force_x + force_y * force_y + force_z * force_z
	);
	if ( forceMagnitude <= 1e-12 ) return;

	// Source vecmag is |force|/8.  Tiny forces use a four-second turn rate;
	// stronger forces use mass/vecmag, clamped to half a second for non-robots.
	const scaledMagnitude = forceMagnitude / 8.0;
	let rate;
	if ( scaledMagnitude < 1.0 / 256.0 ||
		scaledMagnitude < PLAYER_MASS / 16384.0 ) {

		rate = 4.0;

	} else {

		rate = PLAYER_MASS / scaledMagnitude;
		if ( rate < 0.5 ) rate = 0.5;

	}

	const inverseForce = 1.0 / forceMagnitude;
	const goal_x = force_x * inverseForce;
	const goal_y = force_y * inverseForce;
	const goal_z = force_z * inverseForce;
	const goalPitch = Math.asin( Math.max( - 1.0, Math.min( 1.0, - goal_y ) ) );
	const goalHeading = Math.atan2( goal_x, goal_z );
	const currentPitch = Math.asin(
		Math.max( - 1.0, Math.min( 1.0, - playerForward.y ) )
	);
	const currentHeading = Math.atan2( playerForward.x, playerForward.z );

	let deltaPitch = wrap_rotation_delta( goalPitch - currentPitch ) / rate;
	let deltaHeading = wrap_rotation_delta( goalHeading - currentHeading ) / rate;

	// Source boosts small angular rates so modest glancing forces remain visible.
	if ( Math.abs( deltaPitch ) < Math.PI / 8.0 ) deltaPitch *= 4.0;
	if ( Math.abs( deltaHeading ) < Math.PI / 8.0 ) deltaHeading *= 4.0;

	playerRotVel.x = set_rotvel_and_saturate( playerRotVel.x, deltaPitch );
	playerRotVel.y = set_rotvel_and_saturate( playerRotVel.y, deltaHeading );
	playerRotVel.z = 0;

}

// Rotational physics sub-stepping
// Ported from: do_physics_sim_rot() in PHYSICS.C
// rotThrust = { x, y, z } rotational thrust input
// dt = frame time
export function do_physics_sim_rot( rotThrust_x, rotThrust_y, rotThrust_z, dt ) {

	const rotDrag = PLAYER_DRAG * 2.5;

	const rotAccel_x = rotThrust_x / PLAYER_MASS;
	const rotAccel_y = rotThrust_y / PLAYER_MASS;
	const rotAccel_z = rotThrust_z / PLAYER_MASS;

	let count = Math.floor( dt / PHYSICS_FT );
	const r = dt - count * PHYSICS_FT;
	const k = r / PHYSICS_FT;

	// Full sub-steps
	while ( count > 0 ) {

		playerRotVel.x += rotAccel_x;
		playerRotVel.y += rotAccel_y;
		playerRotVel.z += rotAccel_z;

		const scale = 1.0 - rotDrag;
		playerRotVel.x *= scale;
		playerRotVel.y *= scale;
		playerRotVel.z *= scale;

		count --;

	}

	// Remaining fraction
	playerRotVel.x += rotAccel_x * k;
	playerRotVel.y += rotAccel_y * k;
	playerRotVel.z += rotAccel_z * k;

	const kScale = 1.0 - k * rotDrag;
	playerRotVel.x *= kScale;
	playerRotVel.y *= kScale;
	playerRotVel.z *= kScale;

	return playerRotVel;

}

// Linear physics sub-stepping
// Ported from: do_physics_sim() in PHYSICS.C
// thrust = { x, y, z } linear thrust from controls
// up_dx/dy/dz = camera up vector in Descent coords (for wiggle)
// dt = frame time
// Returns frame displacement { x, y, z }
//
// Pre-allocated result object (Golden Rule #5)
const _frameResult = { x: 0, y: 0, z: 0 };

export function do_physics_sim( thrust_x, thrust_y, thrust_z, up_dx, up_dy, up_dz, dt ) {

	// Ship wiggle: sinusoidal vertical bobbing (ported from read_flying_controls PF_WIGGLE)
	const swiggle = Math.sin( GameTime * 2.0 * Math.PI );
	playerVelocity.x += up_dx * swiggle * PLAYER_WIGGLE;
	playerVelocity.y += up_dy * swiggle * PLAYER_WIGGLE;
	playerVelocity.z += up_dz * swiggle * PLAYER_WIGGLE;

	// Apply drag + thrust to velocity
	const accel_x = thrust_x / PLAYER_MASS;
	const accel_y = thrust_y / PLAYER_MASS;
	const accel_z = thrust_z / PLAYER_MASS;

	let count = Math.floor( dt / PHYSICS_FT );
	const r = dt - count * PHYSICS_FT;
	const k = r / PHYSICS_FT;

	// Full sub-steps
	while ( count > 0 ) {

		playerVelocity.x += accel_x;
		playerVelocity.y += accel_y;
		playerVelocity.z += accel_z;

		const scale = 1.0 - PLAYER_DRAG;
		playerVelocity.x *= scale;
		playerVelocity.y *= scale;
		playerVelocity.z *= scale;

		count --;

	}

	// Remaining fraction
	playerVelocity.x += accel_x * k;
	playerVelocity.y += accel_y * k;
	playerVelocity.z += accel_z * k;

	const kScale = 1.0 - k * PLAYER_DRAG;
	playerVelocity.x *= kScale;
	playerVelocity.y *= kScale;
	playerVelocity.z *= kScale;

	// Compute frame movement
	_frameResult.x = playerVelocity.x * dt;
	_frameResult.y = playerVelocity.y * dt;
	_frameResult.z = playerVelocity.z * dt;

	return _frameResult;

}

// Apply movement with FVI-based collision detection and wall sliding
// Ported from: PHYSICS.C do_physics_sim() — iterative wall-sliding loop
// p0 = start position (Descent coords), frame = movement delta
// playerSegnum = current segment
// Returns { x, y, z, segnum } — new position and segment
//
// Pre-allocated result object (Golden Rule #5)
const _moveResult = { x: 0, y: 0, z: 0, segnum: 0 };

// Pre-allocated segment list for trigger checking (Golden Rule #5)
// Ported from: phys_seglist[] / n_phys_segs in PHYSICS.C line 429
const MAX_PHYS_SEGS = MAX_FVI_SEGS;
const _phys_seglist = new Int16Array( MAX_PHYS_SEGS );
let _n_phys_segs = 0;
const MAX_IGNORE_OBJS = 100;
const _phys_ignore_obj_list = new Int16Array( MAX_IGNORE_OBJS );
let _n_phys_ignore_objs = 0;

export function do_physics_move( p0_x, p0_y, p0_z, frame_x, frame_y, frame_z, playerSegnum, dt, playerObjnum = - 1 ) {

	const checkObjects = playerObjnum >= 0 && playerObjnum < Objects.length &&
		Objects[ playerObjnum ].type === OBJ_PLAYER;
	const playerObject = checkObjects === true ? Objects[ playerObjnum ] : null;
	const playerRadius = playerObject !== null && playerObject.size > 0 ? playerObject.size : PLAYER_RADIUS;

	// OBJECT.C snapshots last_pos once at the beginning of an object's move.
	// Collision callbacks may advance the canonical pose several times afterward.
	if ( playerObject !== null ) {

		playerObject.last_pos_x = p0_x;
		playerObject.last_pos_y = p0_y;
		playerObject.last_pos_z = p0_z;

	}

	if ( frame_x === 0 && frame_y === 0 && frame_z === 0 ) {

		_moveResult.x = p0_x;
		_moveResult.y = p0_y;
		_moveResult.z = p0_z;
		_moveResult.segnum = playerSegnum;
		return _moveResult;

	}

	let p1_x = p0_x + frame_x;
	let p1_y = p0_y + frame_y;
	let p1_z = p0_z + frame_z;

	let curSeg = playerSegnum;
	let simTime = dt;
	const MAX_FVI_ITERS = 8;

	// Track segments traversed for trigger checking
	// Ported from: phys_seglist[] / n_phys_segs in PHYSICS.C line 429
	_n_phys_segs = 0;
	_n_phys_ignore_objs = 0;

	for ( let iter = 0; iter < MAX_FVI_ITERS; iter ++ ) {

		const attemptStart_x = p0_x;
		const attemptStart_y = p0_y;
		const attemptStart_z = p0_z;
		const attemptSeg = curSeg;
		const frameVec_x = p1_x - p0_x;
		const frameVec_y = p1_y - p0_y;
		const frameVec_z = p1_z - p0_z;
		const attemptedDist = Math.sqrt(
			frameVec_x * frameVec_x + frameVec_y * frameVec_y + frameVec_z * frameVec_z
		);

		if ( ! ( attemptedDist > 0 ) ) break;

		let hit;
		fvi_set_ignore_obj_list( _phys_ignore_obj_list, _n_phys_ignore_objs );
		try {

			hit = find_vector_intersection(
				p0_x, p0_y, p0_z,
				p1_x, p1_y, p1_z,
				curSeg, playerRadius,
				playerObjnum, ( checkObjects === true ? FQ_CHECK_OBJS : 0 ) | FQ_GET_SEGLIST
			);

		} finally {

			// The original query carries its own ignore list. Never leak the outer
			// movement query's list into callbacks or another FVI invocation.
			fvi_set_ignore_obj_list( null, 0 );

		}

		// Preserve this query's complete portal path before any collision callback
		// can issue a nested FVI call and overwrite the shared result object.
		if ( hit.n_segs > 0 ) {

			if ( _n_phys_segs > 0 && _phys_seglist[ _n_phys_segs - 1 ] === hit.seglist[ 0 ] ) {

				_n_phys_segs --;

			}

			for ( let i = 0; i < hit.n_segs && _n_phys_segs < MAX_PHYS_SEGS - 1; i ++ ) {

				_phys_seglist[ _n_phys_segs ++ ] = hit.seglist[ i ];

			}

		}

		const hitType = hit.hit_type;
		const hitPnt_x = hit.hit_pnt_x;
		const hitPnt_y = hit.hit_pnt_y;
		const hitPnt_z = hit.hit_pnt_z;
		const hitSeg = hit.hit_seg;
		const hitSide = hit.hit_side;
		const hitSideSeg = hit.hit_side_seg;
		const hitObject = hit.hit_object;
		const hitNorm_x = hit.hit_wallnorm_x;
		const hitNorm_y = hit.hit_wallnorm_y;
		const hitNorm_z = hit.hit_wallnorm_z;

		if ( hitType === HIT_NONE ) {

			// Moved unobstructed
			p0_x = hitPnt_x;
			p0_y = hitPnt_y;
			p0_z = hitPnt_z;

			if ( hitSeg !== - 1 ) {

				curSeg = hitSeg;

			}

			// Keep the canonical player at the accepted endpoint.
			if ( playerObject !== null ) {

				playerObject.pos_x = p0_x;
				playerObject.pos_y = p0_y;
				playerObject.pos_z = p0_z;
				if ( curSeg !== playerObject.segnum ) obj_relink( playerObjnum, curSeg );

			}

			break;

		} else if ( hitType === HIT_WALL ) {

			// Move to hit point
			p0_x = hitPnt_x;
			p0_y = hitPnt_y;
			p0_z = hitPnt_z;

			// Consume only the fraction of this attempt that was actually travelled.
			// Ported from: PHYSICS.C attempted_dist/actual_dist sim_time update.
			const moved_x = p0_x - attemptStart_x;
			const moved_y = p0_y - attemptStart_y;
			const moved_z = p0_z - attemptStart_z;
			const actualDist = Math.sqrt( moved_x * moved_x + moved_y * moved_y + moved_z * moved_z );
			const movedDot = moved_x * frameVec_x + moved_y * frameVec_y + moved_z * frameVec_z;
			let movedBackwards = false;
			let movedTime = 0;

			if ( actualDist > 0 && movedDot < 0 ) {

				// FVI occasionally reports a wall point behind the attempt start. The
				// original restores the position/segment and retries the full time.
				p0_x = attemptStart_x;
				p0_y = attemptStart_y;
				p0_z = attemptStart_z;
				curSeg = attemptSeg;
				movedBackwards = true;

			} else {

				const oldSimTime = simTime;
				const newSimTime = oldSimTime * ( attemptedDist - actualDist ) / attemptedDist;

				if ( Number.isFinite( newSimTime ) && newSimTime >= 0 && newSimTime <= oldSimTime ) {

					simTime = newSimTime;
					movedTime = oldSimTime - newSimTime;

				} else {

					// Preserve the old time budget for a bogus FVI distance, matching
					// PHYSICS.C's guard against negative or increasing sim_time.
					simTime = oldSimTime;

				}

			}

			if ( movedBackwards !== true && hitSeg !== - 1 ) {

				curSeg = hitSeg;

			}

			// The original advances and relinks the object before wall callbacks.
			if ( playerObject !== null ) {

				playerObject.pos_x = p0_x;
				playerObject.pos_y = p0_y;
				playerObject.pos_z = p0_z;
				if ( curSeg !== playerObject.segnum ) obj_relink( playerObjnum, curSeg );

			}

			// Process contact with a wall/door. Triggers are dispatched only for
			// portals actually crossed, after all FVI attempts are concatenated.
			if ( hitSideSeg !== - 1 && hitSide !== - 1 ) {

				fvi_wall_hit_process( hitSideSeg, hitSide );

			}

			// Wall sliding: remove velocity component along wall normal
			const nx = hitNorm_x;
			const ny = hitNorm_y;
			const nz = hitNorm_z;
			const wall_part = playerVelocity.x * nx + playerVelocity.y * ny + playerVelocity.z * nz;
			const moved_wall_part = moved_x * nx + moved_y * ny + moved_z * nz;

			// Player wall-hit damage
			// Ported from: collide_player_and_wall() in COLLIDE.C lines 654-693
			if ( _onPlayerWallHit !== null && movedTime > 0 && moved_wall_part < 0 ) {

				const hitspeed = - moved_wall_part / movedTime;
				const damage = hitspeed / DAMAGE_SCALE;

				if ( damage >= DAMAGE_THRESHOLD ) {

					const volume = Math.min( ( hitspeed - DAMAGE_SCALE * DAMAGE_THRESHOLD ) / WALL_LOUDNESS_SCALE, 1.0 );
					_onPlayerWallHit( damage, volume, hitPnt_x, hitPnt_y, hitPnt_z,
						hitSideSeg, hitSide );

				}

			}

			if ( wall_part < 0 ) {

				// Slide along wall: remove velocity component along wall normal
				// Ported from: PHYSICS.C line 940-946
				// PF_BOUNCE multiplies wall_part by 2 for elastic bounce
				// Player does NOT have PF_BOUNCE — pure slide (factor = 1.0)
				const bounce_factor = 1.0;
				playerVelocity.x -= nx * wall_part * bounce_factor;
				playerVelocity.y -= ny * wall_part * bounce_factor;
				playerVelocity.z -= nz * wall_part * bounce_factor;

			}

			// Retry from the accepted hit point with the slid velocity and the
			// exact time left in this frame.
			if ( simTime > 0 ) {

				p1_x = p0_x + playerVelocity.x * simTime;
				p1_y = p0_y + playerVelocity.y * simTime;
				p1_z = p0_z + playerVelocity.z * simTime;
				continue; // Try again with remaining movement

			}

			break;

		} else if ( hitType === HIT_OBJECT ) {

			// Move to the player-center position at first object contact.
			p0_x = hitPnt_x;
			p0_y = hitPnt_y;
			p0_z = hitPnt_z;

			// Consume the portion of this attempt used to reach the object, exactly as
			// for a wall hit. Object contacts at the attempt start consume no time.
			const moved_x = p0_x - attemptStart_x;
			const moved_y = p0_y - attemptStart_y;
			const moved_z = p0_z - attemptStart_z;
			const actualDist = Math.sqrt( moved_x * moved_x + moved_y * moved_y + moved_z * moved_z );
			const oldSimTime = simTime;
			const newSimTime = oldSimTime * ( attemptedDist - actualDist ) / attemptedDist;

			if ( Number.isFinite( newSimTime ) && newSimTime >= 0 && newSimTime <= oldSimTime ) {

				simTime = newSimTime;

			}

			if ( hitSeg !== - 1 ) {

				curSeg = hitSeg;

			}

			// Make the accepted contact pose visible to collision callbacks and any
			// nested FVI they issue, just as the canonical C object is at this point.
			if ( playerObject !== null ) {

				playerObject.pos_x = p0_x;
				playerObject.pos_y = p0_y;
				playerObject.pos_z = p0_z;
				if ( curSeg !== playerObject.segnum ) obj_relink( playerObjnum, curSeg );

			}

			const oldVel_x = playerVelocity.x;
			const oldVel_y = playerVelocity.y;
			const oldVel_z = playerVelocity.z;

			let collisionAllowsRetry = true;
			if ( _onPlayerObjectHit !== null && hitObject !== - 1 ) {

				// collide_two_objects receives the surface point between the two sphere
				// centers, weighted by their radii—not the moving sphere's center.
				const target = Objects[ hitObject ];
				let collision_x = hitPnt_x;
				let collision_y = hitPnt_y;
				let collision_z = hitPnt_z;

				if ( target !== undefined && target !== null ) {

					const radiusSum = target.size + playerRadius;
					if ( radiusSum > 0 ) {

						const scale = target.size / radiusSum;
						collision_x = target.pos_x + ( hitPnt_x - target.pos_x ) * scale;
						collision_y = target.pos_y + ( hitPnt_y - target.pos_y ) * scale;
						collision_z = target.pos_z + ( hitPnt_z - target.pos_z ) * scale;

					}

				}

				collisionAllowsRetry = _onPlayerObjectHit(
					hitObject, collision_x, collision_y, collision_z,
					p0_x, p0_y, p0_z, curSeg
				) !== false;

			}

			// Pickups/hostages and ignored contacts leave velocity unchanged. Mark the
			// object for this move and continue through the remaining simulation time.
			const persistent = playerObject !== null && playerObject.mtype !== null &&
				( playerObject.mtype.flags & PF_PERSISTENT ) !== 0;
			const moverDead = playerObject !== null && ( playerObject.flags & OF_SHOULD_BE_DEAD ) !== 0;
			const velocityUnchanged = oldVel_x === playerVelocity.x && oldVel_y === playerVelocity.y &&
				oldVel_z === playerVelocity.z;
			if ( collisionAllowsRetry === true && moverDead !== true &&
				( persistent === true || velocityUnchanged === true ) &&
				hitObject >= 0 && _n_phys_ignore_objs < MAX_IGNORE_OBJS ) {

				_phys_ignore_obj_list[ _n_phys_ignore_objs ++ ] = hitObject;
				if ( simTime > 0 ) {

					p1_x = p0_x + playerVelocity.x * simTime;
					p1_y = p0_y + playerVelocity.y * simTime;
					p1_z = p0_z + playerVelocity.z * simTime;
					continue;

				}

			}

			// A physical bump changed velocity, so finish this move at contact.
			break;

		} else if ( hitType === HIT_BAD_P0 ) {

			// Start point not in segment — try to recover
			const newSeg = find_point_seg( p0_x, p0_y, p0_z, curSeg );

			if ( newSeg !== - 1 ) {

				curSeg = newSeg;
				continue; // Retry with corrected segment

			}

			break;

		} else {

			break;

		}

	}

	fvi_set_ignore_obj_list( null, 0 );

	// Check triggers on segment transitions
	// Ported from: OBJECT.C lines 2007-2023 — check_trigger for each segment traversed
	if ( _n_phys_segs > 1 && curSeg !== playerSegnum ) {

		for ( let i = 0; i < _n_phys_segs - 1; i ++ ) {

			const connect_side = find_connect_side( _phys_seglist[ i + 1 ], _phys_seglist[ i ] );

			if ( connect_side !== - 1 ) {

				fvi_check_trigger( _phys_seglist[ i ], connect_side );

			}

		}

	}

	_moveResult.x = p0_x;
	_moveResult.y = p0_y;
	_moveResult.z = p0_z;
	_moveResult.segnum = curSeg;
	return _moveResult;

}
