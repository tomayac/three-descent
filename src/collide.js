// Ported from: descent-master/MAIN/COLLIDE.C
// Collision detection and response

import { Segments, Num_segments, GameTime } from './mglobal.js';
import { TmapInfos, TMI_VOLATILE, Powerup_info, N_powerup_types } from './bm.js';
import { Robot_info, N_robot_types, Weapon_info, N_weapon_types } from './bm.js';
import { get_side_dist, compute_center_point_on_side } from './gameseg.js';
import {
	wall_hit_process, wall_is_doorway, WID_FLY_FLAG,
	WHP_NOT_SPECIAL, WHP_NO_KEY, WHP_BLASTABLE
} from './wall.js';
import { cntrlcen_notify_hit } from './cntrlcen.js';
import { find_vector_intersection, HIT_WALL, FQ_TRANSWALL } from './fvi.js';
import { find_point_seg } from './gameseg.js';
import { object_create_explosion, explosion_copy_physics, explode_model, fireball_destroy_debris, get_explosion_vclip, EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION, VCLIP_PLAYER_HIT, VCLIP_VOLATILE_WALL_HIT } from './fireball.js';
import { check_effect_blowup } from './effects.js';
import { OBJ_PLAYER, OBJ_ROBOT, OBJ_POWERUP, OBJ_CLUTTER, CT_NONE, MT_PHYSICS,
	OF_EXPLODING, OF_DESTROYED, OF_SHOULD_BE_DEAD, PF_PERSISTENT } from './object.js';
import { ai_do_robot_hit, create_awareness_event, start_boss_death_sequence,
	ai_set_boss_hit, ai_do_cloak_stuff, ai_apply_rotational_force } from './ai.js';
import { phys_apply_force, phys_apply_force_to_player, phys_apply_rot,
	getPlayerVelocity, getPlayerRotVelocity, physics_set_player_rot_velocity } from './physics.js';
import { digi_play_sample, digi_play_sample_world,
	SOUND_WEAPON_HIT_BLASTABLE,
	SOUND_PLAYER_GOT_HIT, SOUND_EXPLODING_WALL, SOUND_VOLATILE_WALL_HISS,
	SOUND_VOLATILE_WALL_HIT,
	SOUND_HOSTAGE_RESCUED, SOUND_CLOAK_OFF,
	SOUND_ROBOT_HIT_PLAYER, SOUND_ROBOT_HIT,
	SOUND_LASER_HIT_CLUTTER,
	SOUND_CONTROL_CENTER_HIT, SOUND_CONTROL_CENTER_DESTROYED,
	SOUND_WEAPON_HIT_DOOR } from './digi.js';

// Powerup type constants (from POWERUP.H)
export const POW_EXTRA_LIFE = 0;
export const POW_ENERGY = 1;
export const POW_SHIELD_BOOST = 2;
export const POW_LASER = 3;
export const POW_KEY_BLUE = 4;
export const POW_KEY_RED = 5;
export const POW_KEY_GOLD = 6;
export const POW_MISSILE_1 = 10;
export const POW_MISSILE_4 = 11;
export const POW_QUAD_FIRE = 12;
export const POW_VULCAN_WEAPON = 13;
export const POW_SPREADFIRE_WEAPON = 14;
export const POW_PLASMA_WEAPON = 15;
export const POW_FUSION_WEAPON = 16;
export const POW_PROXIMITY_WEAPON = 17;
export const POW_HOMING_AMMO_1 = 18;
export const POW_HOMING_AMMO_4 = 19;
export const POW_SMARTBOMB_WEAPON = 20;
export const POW_MEGA_WEAPON = 21;
export const POW_VULCAN_AMMO = 22;
export const POW_CLOAK = 23;
export const POW_INVULNERABILITY = 25;

// Vulcan ammo constants (from POWERUP.H)
const VULCAN_WEAPON_AMMO_AMOUNT = 196;
const VULCAN_AMMO_AMOUNT = 98;
const VULCAN_AMMO_MAX = VULCAN_WEAPON_AMMO_AMOUNT * 4; // 784

// Score constants
const CONTROL_CEN_SCORE = 5000;
const HOSTAGE_SCORE = 1000;

// External callbacks (set via collide_set_externals)
let _getPlayerShields = null;
let _setPlayerShields = null;
let _getPlayerEnergy = null;
let _setPlayerEnergy = null;
let _getPlayerLaserLevel = null;
let _setPlayerLaserLevel = null;
let _getPlayerPrimaryFlags = null;
let _setPlayerPrimaryFlags = null;
let _getPlayerSecondaryFlags = null;
let _setPlayerSecondaryFlags = null;
let _getPlayerSecondaryAmmo = null;
let _setPlayerSecondaryAmmo = null;
let _getPlayerVulcanAmmo = null;
let _setPlayerVulcanAmmo = null;
let _getPlayerKeys = null;
let _setPlayerKey = null;
let _getPlayerLives = null;
let _setPlayerLives = null;
let _addPlayerScore = null;
let _addPlayerKills = null;
let _addHostageSaved = null;
let _addLevelHostagesSaved = null;
let _getHostagesInLevel = null;
let _getHostagesSavedInLevel = null;
let _getPlayerPos = null;
let _getPlayerSegnum = null;
let _getScene = null;
let _updateHUD = null;
let _showMessage = null;
let _flashDamage = null;
let _startPlayerDeath = null;
let _startSelfDestruct = null;
let _spawnDroppedPowerup = null;
let _spawnDroppedRobot = null;
let _liveRobots = null;
let _isPlayerInvulnerable = null;
let _isPlayerCloaked = null;
let _activateCloak = null;
let _activateInvulnerability = null;
let _getPlayerQuadLasers = null;
let _setPlayerQuadLasers = null;
let _getDifficultyLevel = null;
let _onReactorDestroyedVisual = null;

// Number of difficulty levels (from GAME.H: #define NDL 5)
const NDL = 5;

// Volatile wall scrape sound throttle
let lastVolatileScrapeTime = 0;

export function collide_set_externals( ext ) {

	if ( ext.getPlayerShields !== undefined ) _getPlayerShields = ext.getPlayerShields;
	if ( ext.setPlayerShields !== undefined ) _setPlayerShields = ext.setPlayerShields;
	if ( ext.getPlayerEnergy !== undefined ) _getPlayerEnergy = ext.getPlayerEnergy;
	if ( ext.setPlayerEnergy !== undefined ) _setPlayerEnergy = ext.setPlayerEnergy;
	if ( ext.getPlayerLaserLevel !== undefined ) _getPlayerLaserLevel = ext.getPlayerLaserLevel;
	if ( ext.setPlayerLaserLevel !== undefined ) _setPlayerLaserLevel = ext.setPlayerLaserLevel;
	if ( ext.getPlayerPrimaryFlags !== undefined ) _getPlayerPrimaryFlags = ext.getPlayerPrimaryFlags;
	if ( ext.setPlayerPrimaryFlags !== undefined ) _setPlayerPrimaryFlags = ext.setPlayerPrimaryFlags;
	if ( ext.getPlayerSecondaryFlags !== undefined ) _getPlayerSecondaryFlags = ext.getPlayerSecondaryFlags;
	if ( ext.setPlayerSecondaryFlags !== undefined ) _setPlayerSecondaryFlags = ext.setPlayerSecondaryFlags;
	if ( ext.getPlayerSecondaryAmmo !== undefined ) _getPlayerSecondaryAmmo = ext.getPlayerSecondaryAmmo;
	if ( ext.setPlayerSecondaryAmmo !== undefined ) _setPlayerSecondaryAmmo = ext.setPlayerSecondaryAmmo;
	if ( ext.getPlayerVulcanAmmo !== undefined ) _getPlayerVulcanAmmo = ext.getPlayerVulcanAmmo;
	if ( ext.setPlayerVulcanAmmo !== undefined ) _setPlayerVulcanAmmo = ext.setPlayerVulcanAmmo;
	if ( ext.getPlayerKeys !== undefined ) _getPlayerKeys = ext.getPlayerKeys;
	if ( ext.setPlayerKey !== undefined ) _setPlayerKey = ext.setPlayerKey;
	if ( ext.getPlayerLives !== undefined ) _getPlayerLives = ext.getPlayerLives;
	if ( ext.setPlayerLives !== undefined ) _setPlayerLives = ext.setPlayerLives;
	if ( ext.addPlayerScore !== undefined ) _addPlayerScore = ext.addPlayerScore;
	if ( ext.addPlayerKills !== undefined ) _addPlayerKills = ext.addPlayerKills;
	if ( ext.addHostageSaved !== undefined ) _addHostageSaved = ext.addHostageSaved;
	if ( ext.addLevelHostagesSaved !== undefined ) _addLevelHostagesSaved = ext.addLevelHostagesSaved;
	if ( ext.getHostagesInLevel !== undefined ) _getHostagesInLevel = ext.getHostagesInLevel;
	if ( ext.getHostagesSavedInLevel !== undefined ) _getHostagesSavedInLevel = ext.getHostagesSavedInLevel;
	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getPlayerSegnum !== undefined ) _getPlayerSegnum = ext.getPlayerSegnum;
	if ( ext.getScene !== undefined ) _getScene = ext.getScene;
	if ( ext.updateHUD !== undefined ) _updateHUD = ext.updateHUD;
	if ( ext.showMessage !== undefined ) _showMessage = ext.showMessage;
	if ( ext.flashDamage !== undefined ) _flashDamage = ext.flashDamage;
	if ( ext.startPlayerDeath !== undefined ) _startPlayerDeath = ext.startPlayerDeath;
	if ( ext.startSelfDestruct !== undefined ) _startSelfDestruct = ext.startSelfDestruct;
	if ( ext.spawnDroppedPowerup !== undefined ) _spawnDroppedPowerup = ext.spawnDroppedPowerup;
	if ( ext.spawnDroppedRobot !== undefined ) _spawnDroppedRobot = ext.spawnDroppedRobot;
	if ( ext.liveRobots !== undefined ) _liveRobots = ext.liveRobots;
	if ( ext.isPlayerInvulnerable !== undefined ) _isPlayerInvulnerable = ext.isPlayerInvulnerable;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;
	if ( ext.activateCloak !== undefined ) _activateCloak = ext.activateCloak;
	if ( ext.activateInvulnerability !== undefined ) _activateInvulnerability = ext.activateInvulnerability;
	if ( ext.getPlayerQuadLasers !== undefined ) _getPlayerQuadLasers = ext.getPlayerQuadLasers;
	if ( ext.setPlayerQuadLasers !== undefined ) _setPlayerQuadLasers = ext.setPlayerQuadLasers;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;
	if ( ext.onReactorDestroyedVisual !== undefined ) _onReactorDestroyedVisual = ext.onReactorDestroyedVisual;

}

function getPlayerSoundSegnum( fallback ) {

	return _getPlayerSegnum !== null ? _getPlayerSegnum() : fallback;

}

// Fixed-point Descent's allocation-free vm_vec_mag_quick approximation.
function quickVectorMagnitude( x, y, z ) {

	let largest = Math.abs( x );
	let middle = Math.abs( y );
	let smallest = Math.abs( z );
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	if ( middle < smallest ) { const t = middle; middle = smallest; smallest = t; }
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	return largest + middle * 3 / 8 + smallest * 3 / 16;

}

// ---------------------------------------------------------------
// bump_two_objects — apply collision forces between two objects
// Ported from: bump_two_objects() in COLLIDE.C lines 613-636
// ---------------------------------------------------------------
export function bump_two_objects( robot, robotVel_x, robotVel_y, robotVel_z, robotMass ) {

	if ( _getPlayerPos === null ) return;

	// obj0 is the robot and obj1 is the player. COLLIDE.C applies
	// (robot velocity - player velocity) to the player, then its opposite to
	// the robot.
	// Ported from: bump_two_objects() in COLLIDE.C lines 613-636
	const pv = getPlayerVelocity();
	const rel_x = robotVel_x - pv.x;
	const rel_y = robotVel_y - pv.y;
	const rel_z = robotVel_z - pv.z;

	const playerMass = 4.0; // PLAYER_MASS from physics.js
	const massFactor = 2.0 * robotMass * playerMass / ( robotMass + playerMass );

	// Force = massFactor * relative_velocity (Newton's 3rd law elastic collision)
	const force_x = rel_x * massFactor;
	const force_y = rel_y * massFactor;
	const force_z = rel_z * massFactor;

	// Apply to player: force/4 (linear only), then derive impact damage from
	// that exact applied force.  D1 does not use the robot's raw speed here;
	// relative velocity and both masses are already represented by force.
	// Ported from: bump_this_object() in COLLIDE.C lines 583-588
	const playerForce_x = force_x * 0.25;
	const playerForce_y = force_y * 0.25;
	const playerForce_z = force_z * 0.25;
	phys_apply_force_to_player( playerForce_x, playerForce_y, playerForce_z );
	const playerDamage = quickVectorMagnitude(
		playerForce_x, playerForce_y, playerForce_z
	) / playerMass / 8.0;
	apply_damage_to_player( playerDamage );

	// Apply opposite force to a normal robot: full linear force plus the
	// difficulty-scaled rotational whack from bump_this_object().  Bosses are
	// deliberately immune to this collision response in D1.
	// Ported from: bump_this_object() in COLLIDE.C lines 592-606
	const robotType = robot.obj.id;
	const isBoss = robotType >= 0 && robotType < N_robot_types &&
		Robot_info[ robotType ].boss_flag > 0;
	const isPersistent = robot.obj.mtype !== null && robot.obj.mtype !== undefined &&
		( robot.obj.mtype.flags & PF_PERSISTENT ) !== 0;
	if ( isBoss !== true && isPersistent !== true ) {

		const robotForce_x = - force_x;
		const robotForce_y = - force_y;
		const robotForce_z = - force_z;
		phys_apply_force( robot, robotForce_x, robotForce_y, robotForce_z );
		const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
		const rotationScale = 1.0 / ( 4 + difficulty );
		ai_apply_rotational_force(
			robot,
			robotForce_x * rotationScale,
			robotForce_y * rotationScale,
			robotForce_z * rotationScale
		);
		collide_robot_collision_damage(
			robot, robotForce_x, robotForce_y, robotForce_z
		);

	}

}

// ---------------------------------------------------------------
// collide_robot_and_player — handle robot physically bumping into player
// Ported from: collide_robot_and_player() in COLLIDE.C lines 1052-1066
// Called from ai.js when robot is within contact distance of player
// ---------------------------------------------------------------
export function collide_robot_and_player(
	robot, robotVel_x, robotVel_y, robotVel_z, robotMass, robotIndex = - 1,
	collision_x, collision_y, collision_z, collisionSegnum
) {

	const obj = robot.obj;

	// The player creates this awareness event, not the robot.  Its segment is
	// the propagation origin used to alert other nearby robots.
	// Ported from: COLLIDE.C line 1054 — create_awareness_event(player, PA_PLAYER_COLLISION)
	const playerPos = _getPlayerPos !== null ? _getPlayerPos() : null;
	const playerSeg = Number.isInteger( collisionSegnum ) === true
		? collisionSegnum
		: getPlayerSoundSegnum( obj.segnum );
	if ( playerPos !== null ) {

		create_awareness_event(
			playerSeg, playerPos.x, playerPos.y, playerPos.z, 3
		); // PA_PLAYER_COLLISION

	}

	// Alert robot it was hit
	if ( robotIndex < 0 && _liveRobots !== null ) {

		for ( let i = 0; i < _liveRobots.length; i ++ ) {

			if ( _liveRobots[ i ] === robot ) {

				robotIndex = i;
				break;

			}

		}

	}
	if ( robotIndex >= 0 ) ai_do_robot_hit( robotIndex );

	// Play bump sound
	const sound_x = Number.isFinite( collision_x ) === true ? collision_x : obj.pos_x;
	const sound_y = Number.isFinite( collision_y ) === true ? collision_y : obj.pos_y;
	const sound_z = Number.isFinite( collision_z ) === true ? collision_z : obj.pos_z;
	const sound_seg = Number.isInteger( collisionSegnum ) === true
		? collisionSegnum
		: getPlayerSoundSegnum( obj.segnum );
	digi_play_sample_world(
		SOUND_ROBOT_HIT_PLAYER, 1.0, sound_seg, sound_x, sound_y, sound_z
	);

	// Apply physics bump
	bump_two_objects( robot, robotVel_x, robotVel_y, robotVel_z, robotMass );

}

function bump_player_from_static_object() {

	// bump_two_objects() special-cases either non-physics object before its
	// ordinary elastic collision path.  The physics object receives exactly
	// -velocity*mass, cancelling its motion without collision damage or an
	// angular kick.  Reactors and level clutter use that stationary path.
	// Ported from: bump_two_objects() in COLLIDE.C lines 613-627.
	const pv = getPlayerVelocity();
	const playerMass = 4.0;
	phys_apply_force_to_player(
		- pv.x * playerMass,
		- pv.y * playerMass,
		- pv.z * playerMass
	);

}

// ---------------------------------------------------------------
// collide_player_and_controlcen
// Ported from: collide_player_and_controlcen() in COLLIDE.C lines 1146-1157
// ---------------------------------------------------------------
export function collide_player_and_controlcen( controlcenObj, collision_x, collision_y, collision_z ) {

	if ( controlcenObj === null || controlcenObj === undefined ) return;

	cntrlcen_notify_hit();
	ai_do_cloak_stuff();
	digi_play_sample_world(
		SOUND_ROBOT_HIT_PLAYER, 1.0, getPlayerSoundSegnum( controlcenObj.segnum ),
		collision_x, collision_y, collision_z
	);
	bump_player_from_static_object( controlcenObj, collision_x, collision_y, collision_z );

}

// ---------------------------------------------------------------
// collide_player_and_clutter
// Ported from: collide_player_and_clutter() in COLLIDE.C lines 1778-1781
// ---------------------------------------------------------------
export function collide_player_and_clutter( clutterObj, collision_x, collision_y, collision_z ) {

	if ( clutterObj === null || clutterObj === undefined ) return;

	digi_play_sample_world(
		SOUND_ROBOT_HIT_PLAYER, 1.0, getPlayerSoundSegnum( clutterObj.segnum ),
		collision_x, collision_y, collision_z
	);
	bump_player_from_static_object( clutterObj, collision_x, collision_y, collision_z );

}

// ---------------------------------------------------------------
// apply_damage_to_player
// Ported from: apply_damage_to_player() in COLLIDE.C lines 1548-1595
// ---------------------------------------------------------------
export function apply_damage_to_player( damage ) {

	if ( _getPlayerShields === null ) return;

	const shields = _getPlayerShields();
	if ( shields < 0 ) return;		// Already dead

	// Collision-specific sounds and hit explosions belong to their callers.
	// This generic routine owns only the shield/death state transition.
	if ( _isPlayerInvulnerable !== null && _isPlayerInvulnerable() === true ) {

		return;

	}

	_setPlayerShields( shields - damage );

	if ( _flashDamage !== null ) _flashDamage();
	if ( _updateHUD !== null ) _updateHUD();

	if ( _getPlayerShields() < 0 ) {

		if ( _startPlayerDeath !== null ) _startPlayerDeath();

	}

}

// ---------------------------------------------------------------
// collide_player_and_weapon
// Ported from: collide_player_and_weapon() in COLLIDE.C lines 1598-1621
// ---------------------------------------------------------------
export function collide_player_and_weapon(
	damage, pos_x, pos_y, pos_z, hasDamageRadius
) {

	const invulnerable = _isPlayerInvulnerable !== null &&
		_isPlayerInvulnerable() === true;
	digi_play_sample_world(
		invulnerable === true ? SOUND_WEAPON_HIT_DOOR : SOUND_PLAYER_GOT_HIT,
		1.0, getPlayerSoundSegnum( - 1 ), pos_x, pos_y, pos_z
	);
	object_create_explosion( pos_x, pos_y, pos_z, 5.0, VCLIP_PLAYER_HIT );

	// Radius weapons apply their damage through collide_badass_explosion().
	if ( hasDamageRadius !== true ) apply_damage_to_player( damage );

}

// ---------------------------------------------------------------
// collide_player_and_nasty_robot
// Ported from: collide_player_and_nasty_robot() in COLLIDE.C lines 1655-1667
// Melee robot damages player by contact (attack_type 1)
// ---------------------------------------------------------------
export function collide_player_and_nasty_robot( damage, claw_sound, pos_x, pos_y, pos_z ) {

	// Play claw sound at impact point
	if ( claw_sound >= 0 ) {

		digi_play_sample_world(
			claw_sound, 1.0, getPlayerSoundSegnum( - 1 ), pos_x, pos_y, pos_z
		);

	}

	// Create explosion at impact point (from C: i2f(10)/2 = 5.0)
	object_create_explosion( pos_x, pos_y, pos_z, 5.0, VCLIP_PLAYER_HIT );

	apply_damage_to_player( damage );

}

// Drop the object payload selected either from the level object's guaranteed
// metadata or from Robot_info's probability-based defaults.  FIREBALL.C sends
// the destroyed robot's current velocity to object_create_egg(); in this port
// AI velocity is authoritative for live robots, with mtype as a fallback.
function drop_robot_contents( robot, containsType, containsId, containsCount ) {

	if ( containsCount <= 0 ) return;

	if ( containsType === OBJ_POWERUP ) {

		if ( _spawnDroppedPowerup === null ) return;
		for ( let d = 0; d < containsCount; d ++ ) {

			_spawnDroppedPowerup(
				containsId,
				robot.obj.pos_x,
				robot.obj.pos_y,
				robot.obj.pos_z,
				robot.obj.segnum
			);

		}
		return;

	}

	if ( containsType === OBJ_ROBOT ) {

		if ( _spawnDroppedRobot === null ) return;

		let vel_x = 0;
		let vel_y = 0;
		let vel_z = 0;
		if ( robot.aiLocal !== undefined && robot.aiLocal !== null ) {

			vel_x = robot.aiLocal.vel_x;
			vel_y = robot.aiLocal.vel_y;
			vel_z = robot.aiLocal.vel_z;

		} else if ( robot.obj.mtype !== undefined && robot.obj.mtype !== null ) {

			vel_x = robot.obj.mtype.velocity_x;
			vel_y = robot.obj.mtype.velocity_y;
			vel_z = robot.obj.mtype.velocity_z;

		}

		for ( let d = 0; d < containsCount; d ++ ) {

			const result = _spawnDroppedRobot(
				containsId,
				robot.obj.pos_x,
				robot.obj.pos_y,
				robot.obj.pos_z,
				robot.obj.segnum,
				vel_x, vel_y, vel_z
			);
			if ( result === false || ( typeof result === 'number' && result < 0 ) ) break;

		}
		return;

	}

	console.warn( 'DROP: Ignoring invalid contains_type=' + containsType + ' id=' + containsId );

}

// ---------------------------------------------------------------
// collide_weapon_and_clutter
// Ported from: collide_weapon_and_clutter() in COLLIDE.C lines 1212-1227
// ---------------------------------------------------------------
export function collide_weapon_and_clutter(
	clutter, damage, weapon_type, weapon_segnum,
	collision_x, collision_y, collision_z
) {

	if ( clutter === null || clutter === undefined || clutter.alive !== true ) return;
	const obj = clutter.obj;
	if ( obj === null || obj === undefined || obj.type !== OBJ_CLUTTER ) return;

	if ( obj.shields >= 0 ) obj.shields -= damage;

	// D1 locates the sound in the weapon's segment and the visual in the
	// clutter object's segment.  The position is the exact collision point.
	digi_play_sample_world(
		SOUND_LASER_HIT_CLUTTER, 1.0, weapon_segnum,
		collision_x, collision_y, collision_z
	);
	object_create_explosion(
		collision_x, collision_y, collision_z,
		obj.size / 4, VCLIP_SMALL_EXPLOSION
	);

	if ( obj.shields < 0 && ( obj.flags & ( OF_EXPLODING | OF_DESTROYED ) ) === 0 ) {

		// explode_object(clutter, STANDARD_EXPL_DELAY): make it inert now, then
		// let gameseq create the secondary explosion and model debris in 1/4 s.
		obj.flags |= OF_EXPLODING;
		obj.control_type = CT_NONE;
		clutter.explosionDelay = 0.25;

	}

}

// ---------------------------------------------------------------
// collide_weapon_and_debris
// Ported from: collide_weapon_and_debris() in COLLIDE.C lines 1833-1846
// ---------------------------------------------------------------
export function collide_weapon_and_debris(
	debris, weapon_segnum, collision_x, collision_y, collision_z
) {

	if ( debris === null || debris === undefined || debris.active !== true ) return false;

	digi_play_sample_world(
		SOUND_ROBOT_HIT, 1.0, weapon_segnum,
		collision_x, collision_y, collision_z
	);
	return fireball_destroy_debris( debris );

}

// Begin the delayed second stage of a robot explosion.
// Ported from: explode_object() in FIREBALL.C.  The robot becomes inert now,
// while its death vclip, contents, exp2 sound, and model debris are created by
// collide_process_robot_explosion() after STANDARD_EXPL_DELAY (1/4 second).
export function collide_start_robot_explosion( robot, delay = 0.25 ) {

	if ( robot === null || robot === undefined || robot.isReactor === true ) return false;
	if ( robot.obj === null || robot.obj === undefined ) return false;
	if ( Number.isFinite( robot.explosionDelay ) === true && robot.explosionDelay >= 0 ) return false;

	robot.alive = false;
	robot.explosionDelay = Number.isFinite( delay ) === true ? Math.max( delay, 0 ) : 0.25;
	robot.explosionDeleteDelay = - 1;
	robot.obj.flags |= OF_EXPLODING;
	robot.obj.flags &= ~ OF_SHOULD_BE_DEAD;
	robot.obj.control_type = CT_NONE;
	return true;

}

function finish_robot_damage( robot, awardScore ) {

	if ( robot === null || robot === undefined || robot.isReactor === true ) return false;
	if ( robot.obj === null || robot.obj === undefined || robot.obj.shields >= 0 ) return false;

	const rtype = robot.obj.id;
	let started = false;
	if ( rtype >= 0 && rtype < N_robot_types && Robot_info[ rtype ].boss_flag > 0 ) {

		started = start_boss_death_sequence( robot );

	} else {

		started = collide_start_robot_explosion( robot, 0.25 );

	}

	if ( started !== true ) return false;
	if ( awardScore === true && rtype >= 0 && rtype < N_robot_types &&
		_addPlayerScore !== null ) {

		_addPlayerScore( Robot_info[ rtype ].score_value );

	}
	if ( _addPlayerKills !== null ) _addPlayerKills( 1 );
	if ( _updateHUD !== null ) _updateHUD();

	if ( Robot_info[ rtype ] === undefined || Robot_info[ rtype ].boss_flag <= 0 ) {

		console.log( 'Robot destroyed! (' +
			( _liveRobots.filter( r => r.alive === true && r.isReactor !== true ).length ) +
			' remaining)' );

	}
	return true;

}

function apply_damage_to_live_robot( robot, damage, awardScore ) {

	if ( robot === null || robot === undefined || robot.isReactor === true ||
		robot.alive !== true || robot.obj === null || robot.obj === undefined ) return false;
	if ( ( robot.obj.flags & ( OF_EXPLODING | OF_DESTROYED ) ) !== 0 ||
		robot.obj.shields < 0 ) return false;
	robot.obj.shields -= damage;
	return robot.obj.shields < 0 ? finish_robot_damage( robot, awardScore ) : false;

}

// Robot impacts with players or other robots pass damage_flag=1 to
// bump_two_objects().  D1 derives
// collision damage from the full force magnitude, divides by the struck
// robot's mass and eight, then gives claw robots another quarter scale (all
// other robots use one half).  Robot-owned kills count, but award no score.
// Ported from: apply_force_damage() in COLLIDE.C lines 517-547.
export function collide_robot_collision_damage( robot, force_x, force_y, force_z ) {

	if ( robot === null || robot === undefined || robot.isReactor === true ||
		robot.alive !== true || robot.obj === null || robot.obj === undefined ) return false;
	const rtype = robot.obj.id;
	if ( rtype < 0 || rtype >= N_robot_types ) return false;
	const isBoss = Robot_info[ rtype ].boss_flag > 0;
	const isPersistent = robot.obj.mtype !== null && robot.obj.mtype !== undefined &&
		( robot.obj.mtype.flags & PF_PERSISTENT ) !== 0;
	if ( isBoss === true || isPersistent === true ) return false;

	const mass = robot.obj.mtype !== null && robot.obj.mtype !== undefined &&
		robot.obj.mtype.mass > 0 ? robot.obj.mtype.mass : 4.0;
	let damage = quickVectorMagnitude( force_x, force_y, force_z ) / mass / 8.0;
	damage /= Robot_info[ rtype ].attack_type === 1 ? 4.0 : 2.0;
	return apply_damage_to_live_robot( robot, damage, false );

}

function destroy_reactor( robot ) {

	robot.alive = false;
	robot.obj.flags |= OF_EXPLODING;
	robot.obj.flags &= ~ OF_SHOULD_BE_DEAD;
	robot.obj.control_type = CT_NONE;

	if ( robot.obj.rtype !== null ) {

		const velocity = robot.aiLocal;
		explode_model(
			robot.obj.rtype.model_num,
			robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
			velocity !== null && velocity !== undefined ? velocity.vel_x : 0,
			velocity !== null && velocity !== undefined ? velocity.vel_y : 0,
			velocity !== null && velocity !== undefined ? velocity.vel_z : 0,
			robot
		);

	}

	const scene = _getScene !== null ? _getScene() : null;
	let reactorMeshReplaced = false;
	if ( _onReactorDestroyedVisual !== null ) {

		reactorMeshReplaced = ( _onReactorDestroyedVisual( robot ) === true );

	}
	if ( reactorMeshReplaced !== true ) {

		robot.obj.flags |= OF_SHOULD_BE_DEAD;
		if ( scene !== null ) scene.remove( robot.mesh );

	}

	const deathVclip = get_explosion_vclip( robot.obj.type, robot.obj.id, 0 );
	object_create_explosion(
		robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
		robot.obj.size * EXPLOSION_SCALE, deathVclip
	);

	if ( _addPlayerScore !== null ) _addPlayerScore( CONTROL_CEN_SCORE );
	if ( _updateHUD !== null ) _updateHUD();

	console.log( 'REACTOR DESTROYED! Self-destruct initiated!' );
	digi_play_sample_world(
		SOUND_CONTROL_CENTER_DESTROYED, 1.0, robot.obj.segnum,
		robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z
	);
	if ( _startSelfDestruct !== null ) _startSelfDestruct();
	return true;

}

function apply_damage_to_live_reactor( robot, damage, playerOwned ) {

	if ( playerOwned !== true || robot === null || robot === undefined ||
		robot.isReactor !== true || robot.alive !== true ||
		robot.obj === null || robot.obj === undefined ) return false;
	if ( ( robot.obj.flags & ( OF_EXPLODING | OF_DESTROYED ) ) !== 0 ||
		robot.obj.shields < 0 ) return false;

	cntrlcen_notify_hit();
	ai_do_cloak_stuff();
	robot.obj.shields -= damage;
	return robot.obj.shields < 0 ? destroy_reactor( robot ) : false;

}

// A robot occupying a materialization center is bumped toward the last
// flyable side and takes one shield of damage.  The kill belongs to the level,
// but not to the player score.  Ported from collide_robot_and_materialization_center().
export function collide_robot_and_materialization_center( robotIndex ) {

	if ( _liveRobots === null || Number.isInteger( robotIndex ) !== true ||
		robotIndex < 0 || robotIndex >= _liveRobots.length ) return false;
	const robot = _liveRobots[ robotIndex ];
	if ( robot === null || robot === undefined || robot.isReactor === true ||
		robot.obj === null || robot.obj === undefined || robot.obj.type !== OBJ_ROBOT ||
		( robot.obj.flags & OF_SHOULD_BE_DEAD ) !== 0 ) return false;
	if ( robot.alive !== true && ( robot.obj.flags & OF_EXPLODING ) === 0 ) return false;

	const obj = robot.obj;
	digi_play_sample_world(
		SOUND_ROBOT_HIT, 1.0, obj.segnum,
		obj.pos_x, obj.pos_y, obj.pos_z
	);
	if ( obj.id >= 0 && obj.id < N_robot_types &&
		Robot_info[ obj.id ].exp1_vclip_num > - 1 ) {

		object_create_explosion(
			obj.pos_x, obj.pos_y, obj.pos_z,
			obj.size * 3 / 8,
			Robot_info[ obj.id ].exp1_vclip_num
		);

	}

	let exit_x = 0;
	let exit_y = 0;
	let exit_z = 0;
	let hasExit = false;
	if ( obj.segnum >= 0 && obj.segnum < Num_segments ) {

		for ( let side = 0; side < 6; side ++ ) {

			if ( ( wall_is_doorway( obj.segnum, side ) & WID_FLY_FLAG ) === 0 ) continue;
			const center = compute_center_point_on_side( obj.segnum, side );
			exit_x = center.x - obj.pos_x;
			exit_y = center.y - obj.pos_y;
			exit_z = center.z - obj.pos_z;
			hasExit = true;

		}

	}
	if ( hasExit === true ) {

		const magnitude = quickVectorMagnitude( exit_x, exit_y, exit_z );
		if ( magnitude > 0 ) {

			const scale = 8 / magnitude;
			phys_apply_force( robot, exit_x * scale, exit_y * scale, exit_z * scale );

		}

	}

	if ( robot.alive === true && obj.shields >= 0 ) {

		obj.shields -= 1;
		finish_robot_damage( robot, false );

	}
	return true;

}

function remove_robot_explosion_mesh( robot ) {

	if ( robot.mesh === null || robot.mesh === undefined ) return;
	robot.mesh.visible = false;
	if ( robot.mesh.parent !== null ) robot.mesh.parent.remove( robot.mesh );

}

// Advance one pending robot explosion.  Returns true only on the frame that
// the delayed second stage is emitted.
export function collide_process_robot_explosion( robot, dt ) {

	if ( robot === null || robot === undefined || robot.isReactor === true ) return false;
	if ( robot.obj === null || robot.obj === undefined ) return false;
	if ( Number.isFinite( robot.explosionDelay ) !== true || robot.explosionDelay < 0 ) {

		if ( Number.isFinite( robot.explosionDeleteDelay ) !== true ||
			robot.explosionDeleteDelay < 0 ) return false;
		if ( Number.isFinite( dt ) === true && dt > 0 ) robot.explosionDeleteDelay -= dt;
		if ( robot.explosionDeleteDelay > 0 ) return false;
		robot.explosionDeleteDelay = - 1;
		robot.obj.flags |= OF_SHOULD_BE_DEAD;
		remove_robot_explosion_mesh( robot );
		return false;

	}

	if ( Number.isFinite( dt ) === true && dt > 0 ) robot.explosionDelay -= dt;
	if ( robot.explosionDelay > 0 ) return false;
	robot.explosionDelay = - 1;

	const obj = robot.obj;

	// do_explosion_sequence(): secondary blast first, then contained objects,
	// exp2 sound, and finally the polygon-model debris.
	const deathVclip = get_explosion_vclip( OBJ_ROBOT, obj.id, 1 );
	const deathExplosion = object_create_explosion(
		obj.pos_x, obj.pos_y, obj.pos_z,
		obj.size * EXPLOSION_SCALE, deathVclip
	);
	if ( deathExplosion !== null && obj.movement_type === MT_PHYSICS &&
		obj.mtype !== null && obj.mtype !== undefined ) {

		const velocity = robot.aiLocal;
		explosion_copy_physics(
			deathExplosion, obj.segnum, obj.mtype,
			velocity !== null && velocity !== undefined ? velocity.vel_x : obj.mtype.velocity_x,
			velocity !== null && velocity !== undefined ? velocity.vel_y : obj.mtype.velocity_y,
			velocity !== null && velocity !== undefined ? velocity.vel_z : obj.mtype.velocity_z
		);

	}

	if ( obj.contains_count > 0 ) {

		drop_robot_contents(
			robot,
			obj.contains_type,
			obj.contains_id,
			obj.contains_count
		);

	} else if ( obj.id >= 0 && obj.id < N_robot_types ) {

		const ri = Robot_info[ obj.id ];
		if ( ri.contains_count > 0 && ri.contains_prob > 0 &&
			Math.floor( Math.random() * 16 ) < ri.contains_prob ) {

			// FIREBALL.C: ((rand() * contains_count) >> 15) + 1.
			const count = Math.floor( Math.random() * ri.contains_count ) + 1;
			drop_robot_contents( robot, ri.contains_type, ri.contains_id, count );

		}

	}

	if ( obj.id >= 0 && obj.id < N_robot_types ) {

		const exp2Sound = Robot_info[ obj.id ].exp2_sound_num;
		if ( exp2Sound >= 0 ) {

			digi_play_sample_world(
				exp2Sound, 1.0, obj.segnum,
				obj.pos_x, obj.pos_y, obj.pos_z
			);

		}

	}

	if ( obj.rtype !== null && obj.rtype !== undefined ) {

		const velocity = robot.aiLocal;
		explode_model(
			obj.rtype.model_num,
			obj.pos_x, obj.pos_y, obj.pos_z,
			velocity !== null && velocity !== undefined ? velocity.vel_x : 0,
			velocity !== null && velocity !== undefined ? velocity.vel_y : 0,
			velocity !== null && velocity !== undefined ? velocity.vel_z : 0,
			robot
		);

	}

	if ( deathExplosion !== null && Number.isFinite( deathExplosion.playTime ) === true ) {

		robot.explosionDeleteDelay = Math.max( deathExplosion.playTime / 2, 0 );

	} else {

		robot.explosionDeleteDelay = - 1;
		obj.flags |= OF_SHOULD_BE_DEAD;
		remove_robot_explosion_mesh( robot );

	}

	return true;

}

// ---------------------------------------------------------------
// collide_robot_and_weapon / apply_damage_to_robot
// Ported from: collide_robot_and_weapon() in COLLIDE.C lines 1276-1365
//              apply_damage_to_robot() in COLLIDE.C lines 1233-1274
// ---------------------------------------------------------------
export function collide_robot_and_weapon(
	robotIndex, damage, weapon_type, vel_x, vel_y, vel_z,
	collision_x, collision_y, collision_z, awardScore = true
) {

	if ( _liveRobots === null || robotIndex < 0 || robotIndex >= _liveRobots.length ) return;

	const robot = _liveRobots[ robotIndex ];
	if ( robot === null || robot === undefined || robot.alive !== true ||
		robot.obj === null || robot.obj === undefined ) return;
	const sound_x = Number.isFinite( collision_x ) === true ? collision_x : robot.obj.pos_x;
	const sound_y = Number.isFinite( collision_y ) === true ? collision_y : robot.obj.pos_y;
	const sound_z = Number.isFinite( collision_z ) === true ? collision_z : robot.obj.pos_z;

	if ( robot.isReactor === true ) {

		// collide_weapon_and_controlcen() owns this impact cue.  The damage helper
		// separately performs the player-only ownership check and reactor wake-up.
		digi_play_sample_world(
			SOUND_CONTROL_CENTER_HIT, 1.0, robot.obj.segnum,
			sound_x, sound_y, sound_z
		);
		apply_damage_to_live_reactor( robot, damage, true );
		return;

	}

	// Play per-robot first-explosion sound (exp1_sound_num) on hit
	// Ported from: COLLIDE.C line 1330-1331 — Robot_info[robot->id].exp1_sound_num
	const rtype_hit = robot.obj.id;
	if ( rtype_hit >= 0 && rtype_hit < N_robot_types ) {

		const exp1_sound = Robot_info[ rtype_hit ].exp1_sound_num;
		if ( exp1_sound >= 0 ) {

			digi_play_sample_world(
				exp1_sound, 1.0, robot.obj.segnum,
				sound_x, sound_y, sound_z
			);

		}

		// Create per-robot hit spark (stage 0, exp1_vclip_num) at the impact point.
		// Ported from: collide_robot_and_weapon() in COLLIDE.C lines 1322-1323
		if ( Robot_info[ rtype_hit ].exp1_vclip_num > - 1 ) {

			object_create_explosion(
				sound_x, sound_y, sound_z,
				robot.obj.size * 3 / 8,
				Robot_info[ rtype_hit ].exp1_vclip_num
			);

		}

	}

	// Notify AI that this robot was hit (makes it immediately aware)
	ai_do_robot_hit( robotIndex );

	// Set Boss_hit_this_frame for boss cloak/teleport acceleration
	// Ported from: COLLIDE.C line 1279-1280
	{

		const rtype = robot.obj.id;
		if ( rtype >= 0 && rtype < N_robot_types && Robot_info[ rtype ].boss_flag > 0 ) {

			ai_set_boss_hit();

		}

	}

	// Propagate awareness to nearby robots (PA_WEAPON_ROBOT_COLLISION = 4)
	// Ported from: COLLIDE.C line 1054
	create_awareness_event( robot.obj.segnum, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z, 4 );
	const robotDied = apply_damage_to_live_robot( robot, damage, awardScore );

	// Surviving robots receive bump_two_objects(robot, weapon, 0).  Weapons are
	// not handled by bump_this_object(), so only the robot receives this impulse.
	// Ported from: COLLIDE.C lines 1308-1309, 625-630, and 587-600.
	if ( robotDied !== true && robot.alive === true &&
		Number.isFinite( vel_x ) && Number.isFinite( vel_y ) && Number.isFinite( vel_z ) &&
		robot.aiLocal !== undefined && robot.aiLocal !== null ) {

		const rtype = robot.obj.id;
		const isBoss = rtype >= 0 && rtype < N_robot_types &&
			Robot_info[ rtype ].boss_flag > 0;
		const isPersistent = robot.obj.mtype !== null && robot.obj.mtype !== undefined &&
			( robot.obj.mtype.flags & PF_PERSISTENT ) !== 0;
		if ( isBoss !== true && isPersistent !== true ) {

			const robotMass = robot.obj.mtype !== null && robot.obj.mtype !== undefined &&
				robot.obj.mtype.mass > 0 ? robot.obj.mtype.mass : 4.0;
			const weaponMass = weapon_type >= 0 && weapon_type < N_weapon_types &&
				Weapon_info[ weapon_type ].mass > 0 ? Weapon_info[ weapon_type ].mass : 1.0;
			const massScale = 2.0 * robotMass * weaponMass / ( robotMass + weaponMass );
			const force_x = - ( robot.aiLocal.vel_x - vel_x ) * massScale;
			const force_y = - ( robot.aiLocal.vel_y - vel_y ) * massScale;
			const force_z = - ( robot.aiLocal.vel_z - vel_z ) * massScale;
			phys_apply_force( robot, force_x, force_y, force_z );
			const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
			const rotationScale = 1.0 / ( 4 + difficulty );
			ai_apply_rotational_force(
				robot,
				force_x * rotationScale,
				force_y * rotationScale,
				force_z * rotationScale
			);

		}

	}

}

// ---------------------------------------------------------------
// collide_weapon_and_wall
// Ported from: collide_weapon_and_wall() in COLLIDE.C lines 862-982
// ---------------------------------------------------------------
function play_player_wall_result_sound( wallType, segnum, pos_x, pos_y, pos_z ) {

	if ( wallType === WHP_NO_KEY ) {

		digi_play_sample_world( SOUND_WEAPON_HIT_DOOR, 1.0, segnum, pos_x, pos_y, pos_z );

	} else if ( wallType === WHP_BLASTABLE ) {

		digi_play_sample_world( SOUND_WEAPON_HIT_BLASTABLE, 1.0, segnum, pos_x, pos_y, pos_z );

	}

}

export function collide_weapon_and_wall(
	pos_x, pos_y, pos_z, segnum, hit_side, damage, weapon_type,
	playerWeapon = true, silent = false, parentType = - 1, parentId = - 1
) {

	const wallDamage = damage === undefined ? 5.0 : damage;
	let wallType = WHP_NOT_SPECIAL;
	let blewUp = false;

	// Check for destructible monitors (eclip with dest_bm_num)
	// Ported from: collide_weapon_and_wall() in COLLIDE.C line 877
	if ( segnum >= 0 && hit_side >= 0 && hit_side <= 5 ) {

		blewUp = ( check_effect_blowup( segnum, hit_side, pos_x, pos_y, pos_z ) === 1 );
		wallType = wall_hit_process( segnum, hit_side, wallDamage, playerWeapon );

	}

	// Check for volatile (lava) walls — create badass explosion instead of normal impact
	// Ported from: collide_weapon_and_wall() in COLLIDE.C lines 895-911
	if ( segnum >= 0 && hit_side >= 0 && hit_side <= 5 ) {

		const seg = Segments[ segnum ];
		if ( seg !== undefined ) {

			const side = seg.sides[ hit_side ];
			const tmi1 = TmapInfos[ side.tmap_num ];
			const tmap2 = side.tmap_num2 & 0x3fff;
			const tmi2 = tmap2 > 0 ? TmapInfos[ tmap2 ] : null;

			if ( ( tmi1 !== undefined && ( tmi1.flags & TMI_VOLATILE ) !== 0 ) ||
				( tmi2 !== null && tmi2 !== undefined && ( tmi2.flags & TMI_VOLATILE ) !== 0 ) ) {

				// Volatile wall hit — create large badass explosion
				// Constants from COLLIDE.C lines 855-858
				const VOLATILE_WALL_EXPL_STRENGTH = 10.0;	// i2f(10)
				const VOLATILE_WALL_IMPACT_SIZE = 3.0;		// i2f(3)
				const VOLATILE_WALL_DAMAGE_FORCE = 5.0;		// i2f(5)
				const VOLATILE_WALL_DAMAGE_RADIUS = 30.0;	// i2f(30)

				let explSize = VOLATILE_WALL_IMPACT_SIZE;
				let explDamage = VOLATILE_WALL_EXPL_STRENGTH;
				let explRadius = VOLATILE_WALL_DAMAGE_RADIUS;
				let explForce = VOLATILE_WALL_DAMAGE_FORCE;

				if ( weapon_type !== undefined && weapon_type >= 0 && weapon_type < N_weapon_types ) {

					const wi = Weapon_info[ weapon_type ];
					explSize += wi.impact_size;
					const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					explDamage += wi.strength[ difficulty ] / 4;
					explRadius += wi.damage_radius;
					explForce += wi.strength[ difficulty ] / 2;

				}

				digi_play_sample_world( SOUND_VOLATILE_WALL_HIT, 1.0, segnum, pos_x, pos_y, pos_z );
				object_create_explosion( pos_x, pos_y, pos_z, explSize, VCLIP_VOLATILE_WALL_HIT );
				collide_badass_explosion(
					pos_x, pos_y, pos_z, explDamage, explRadius, explForce,
					undefined, undefined, false, parentType, parentId
				);

				// OF_SILENT does not suppress the volatile-wall blast itself, but it
				// does suppress player wall-result audio and robot awareness.
				if ( playerWeapon === true && silent !== true ) {

					create_awareness_event( segnum, pos_x, pos_y, pos_z, 2 );
					play_player_wall_result_sound( wallType, segnum, pos_x, pos_y, pos_z );

				}

				// The volatile-wall path already incorporated the weapon's blast.
				return true;

			}

		}

	}

	// Use per-weapon impact vclip and sound if available
	// Ported from: collide_weapon_and_wall() in COLLIDE.C
	let hit_vclip = undefined;	// default = VCLIP_SMALL_EXPLOSION
	let hit_sound = - 1;
	let hit_size = 1.0;

	if ( weapon_type !== undefined && weapon_type >= 0 && weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];
		if ( wi.wall_hit_vclip >= 0 ) hit_vclip = wi.wall_hit_vclip;
		if ( wi.wall_hit_sound >= 0 ) hit_sound = wi.wall_hit_sound;
		if ( wi.impact_size > 0 ) hit_size = wi.impact_size;

	}

	object_create_explosion( pos_x, pos_y, pos_z, hit_size, hit_vclip );
	if ( silent !== true && playerWeapon === true ) {

		if ( wallType === WHP_NOT_SPECIAL ) {

			if ( blewUp !== true ) {

				if ( hit_sound >= 0 ) {

					digi_play_sample_world( hit_sound, 1.0, segnum, pos_x, pos_y, pos_z );

				}

			}

		} else {

			play_player_wall_result_sound( wallType, segnum, pos_x, pos_y, pos_z );

		}

	} else if ( silent !== true ) {

		if ( hit_sound >= 0 ) {

			digi_play_sample_world( hit_sound, 1.0, segnum, pos_x, pos_y, pos_z );

		}

	}

	// Propagate awareness to nearby robots (PA_WEAPON_WALL_COLLISION = 2)
	// Ported from: COLLIDE.C lines 675, 931
	if ( silent !== true && playerWeapon === true && segnum >= 0 ) {

		create_awareness_event( segnum, pos_x, pos_y, pos_z, 2 );

	}

	// Ordinary walls leave radius-weapon detonation to the weapon caller.
	return false;

}

// ---------------------------------------------------------------
// collide_badass_explosion (area damage)
// Ported from: apply_force_damage() in COLLIDE.C lines 517-575
// Also: object_create_badass_explosion() in FIREBALL.C
// ---------------------------------------------------------------
export function collide_badass_explosion(
	pos_x, pos_y, pos_z, maxDamage, maxDistance, maxForce = maxDamage,
	visualSize = maxDistance * 0.15, visualVclip = undefined,
	createVisual = true, parentType = - 1, parentId = - 1
) {

	if ( _liveRobots === null ) return;

	// Find segment of explosion for LOS checks
	const explosionSeg = find_point_seg( pos_x, pos_y, pos_z, - 1 );

	// Damage the robots that existed when the blast began.  A killed robot can
	// eject live robot children synchronously; FIREBALL.C's object scan does not
	// revisit those new objects as part of the same explosion.
	const robotCount = _liveRobots.length;

	// Damage all robots within radius (linear falloff) with LOS check
	// Ported from: apply_force_damage() in COLLIDE.C — object_to_object_visibility() check
	for ( let r = 0; r < robotCount; r ++ ) {

		const robot = _liveRobots[ r ];
		if ( robot.alive !== true ) continue;
		if ( robot.isReactor === true && parentType !== OBJ_PLAYER ) continue;
		if ( robot.isReactor !== true && parentType === OBJ_ROBOT &&
			robot.obj.id === parentId ) continue;

		const dx = robot.obj.pos_x - pos_x;
		const dy = robot.obj.pos_y - pos_y;
		const dz = robot.obj.pos_z - pos_z;
		const dist = quickVectorMagnitude( dx, dy, dz );

		if ( dist < maxDistance ) {

			// LOS check: don't damage through opaque walls (but damage through grates)
			// Ported from: FIREBALL.C line 188 — object_to_object_visibility(obj, obj0p, FQ_TRANSWALL)
			if ( explosionSeg !== - 1 ) {

				const losResult = find_vector_intersection(
					pos_x, pos_y, pos_z,
					robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
					explosionSeg, 0.0,
					- 1, FQ_TRANSWALL
				);

				if ( losResult.hit_type === HIT_WALL ) continue;

			}

			// Linear damage falloff: full damage at center, zero at maxDistance
			const damage = maxDamage * ( 1.0 - dist / maxDistance );
			const force = maxForce * ( 1.0 - dist / maxDistance );
			if ( robot.isReactor !== true && force > 0 && dist > 0 ) {

				const forceScale = force / dist;
				const force_x = dx * forceScale;
				const force_y = dy * forceScale;
				const force_z = dz * forceScale;
				phys_apply_force( robot, force_x, force_y, force_z );
				const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
				const rotationScale = - 2.0 * ( 7 - difficulty ) / 8.0;
				ai_apply_rotational_force(
					robot,
					force_x * rotationScale,
					force_y * rotationScale,
					force_z * rotationScale
				);

			}
			if ( damage > 0.1 ) {

				if ( robot.isReactor === true ) {

					apply_damage_to_live_reactor( robot, damage, true );

				} else {

					apply_damage_to_live_robot(
						robot, damage, parentType === OBJ_PLAYER
					);

				}

			}

		}

	}

	// Damage player within radius
	if ( _getPlayerShields !== null ) {

		const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
		if ( pp !== null ) {

			const pdx = pp.x - pos_x;
			const pdy = pp.y - pos_y;
			const pdz = pp.z - pos_z;
			const pdist = quickVectorMagnitude( pdx, pdy, pdz );

			if ( pdist < maxDistance ) {

				// LOS check: don't damage player through opaque walls (but damage through grates)
				// Ported from: FIREBALL.C line 188 — object_to_object_visibility uses FQ_TRANSWALL
				if ( explosionSeg !== - 1 ) {

					const losResult = find_vector_intersection(
						pos_x, pos_y, pos_z,
						pp.x, pp.y, pp.z,
						explosionSeg, 0.0,
						- 1, FQ_TRANSWALL
					);

					if ( losResult.hit_type === HIT_WALL ) {

						// Skip player damage — wall blocks explosion
					} else {

						const damage = maxDamage * ( 1.0 - pdist / maxDistance );
						const force = maxForce * ( 1.0 - pdist / maxDistance );
						if ( force > 0 && pdist > 0 ) {

							const forceScale = force / pdist;
							phys_apply_force_to_player(
								pdx * forceScale, pdy * forceScale, pdz * forceScale
							);
							const rotationScale = parentType === - 1 || parentType === OBJ_PLAYER
								? 0.5 : 0.25;
							phys_apply_rot(
								pdx * forceScale * rotationScale,
								pdy * forceScale * rotationScale,
								pdz * forceScale * rotationScale
							);

						}
						if ( damage > 0.1 && _getPlayerShields() >= 0 ) {

							apply_damage_to_player( damage );

						}

					}

				} else {

					const damage = maxDamage * ( 1.0 - pdist / maxDistance );
					const force = maxForce * ( 1.0 - pdist / maxDistance );
					if ( force > 0 && pdist > 0 ) {

						const forceScale = force / pdist;
						phys_apply_force_to_player(
							pdx * forceScale, pdy * forceScale, pdz * forceScale
						);
						const rotationScale = parentType === - 1 || parentType === OBJ_PLAYER
							? 0.5 : 0.25;
						phys_apply_rot(
							pdx * forceScale * rotationScale,
							pdy * forceScale * rotationScale,
							pdz * forceScale * rotationScale
						);

					}
					if ( damage > 0.1 && _getPlayerShields() >= 0 ) {

						apply_damage_to_player( damage );

					}

				}

			}

		}

	}

	// Most callers retain the port's radius-derived visual size.  Specialized
	// source paths, such as player destruction, supply D1's explicit size/clip.
	if ( createVisual !== true ) return null;
	return object_create_explosion(
		pos_x, pos_y, pos_z, visualSize, visualVclip
	);

}

// ---------------------------------------------------------------
// scrape_object_on_wall
// Ported from: scrape_object_on_wall() in COLLIDE.C lines 701-762
// Check all sides of player's segment for volatile wall damage
// ---------------------------------------------------------------
export function scrape_object_on_wall( playerSeg, dt ) {

	if ( _getPlayerShields === null || playerSeg < 0 || playerSeg >= Num_segments ) return;
	if ( _getPlayerShields() < 0 ) return;

	const seg = Segments[ playerSeg ];
	const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
	if ( pp === null ) return;

	const SCRAPE_RADIUS = 2.5;	// Same as PLAYER_RADIUS in game.js

	for ( let s = 0; s < 6; s ++ ) {

		const side = seg.sides[ s ];
		const tmi = TmapInfos[ side.tmap_num ];

		if ( tmi.damage <= 0 ) continue;

		// Check distance from player to this wall
		const dist = get_side_dist( pp.x, pp.y, pp.z, seg, s );

		if ( dist < SCRAPE_RADIUS ) {

			// Apply damage scaled by frame time
			const damage = tmi.damage * dt;

			// Invulnerability suppresses only shield damage. D1 deliberately keeps
			// the red flash, wall hiss, and rotational jolt for damaging-wall scrapes.
			if ( _isPlayerInvulnerable === null || _isPlayerInvulnerable() !== true ) {

				_setPlayerShields( _getPlayerShields() - damage );

			}
			if ( _flashDamage !== null ) _flashDamage();
			if ( _updateHUD !== null ) _updateHUD();

			// Push away from the damaging face with the source's small randomized
			// normal perturbation.  D1 applies a fixed force of eight here; it does
			// not feed a tiny random vector through phys_apply_rot().
			let random_x = ( Math.floor( Math.random() * 32768 ) - 16384 ) | 1;
			let random_y = Math.floor( Math.random() * 32768 ) - 16384;
			let random_z = Math.floor( Math.random() * 32768 ) - 16384;
			let randomMagnitude = quickVectorMagnitude( random_x, random_y, random_z );
			if ( randomMagnitude <= 0 ) randomMagnitude = 1;
			random_x /= randomMagnitude;
			random_y /= randomMagnitude;
			random_z /= randomMagnitude;

			const normal = side.normals[ 0 ];
			let hit_x = normal.x + random_x / 8.0;
			let hit_y = normal.y + random_y / 8.0;
			let hit_z = normal.z + random_z / 8.0;
			let hitMagnitude = quickVectorMagnitude( hit_x, hit_y, hit_z );
			if ( hitMagnitude <= 0 ) hitMagnitude = 1;
			hit_x /= hitMagnitude;
			hit_y /= hitMagnitude;
			hit_z /= hitMagnitude;
			phys_apply_force_to_player( hit_x * 8.0, hit_y * 8.0, hit_z * 8.0 );

			// COLLIDE.C directly replaces pitch and bank with two signed 15-bit
			// random angular rates, preserving the current heading rate.
			const rotvel = getPlayerRotVelocity();
			const randomPitch = ( Math.floor( Math.random() * 32768 ) - 16384 ) *
				( Math.PI / 65536.0 );
			const randomBank = ( Math.floor( Math.random() * 32768 ) - 16384 ) *
				( Math.PI / 65536.0 );
			physics_set_player_rot_velocity( randomPitch, rotvel.y, randomBank );

			// Play volatile wall hiss sound (throttled to 0.25s intervals)
			if ( GameTime > lastVolatileScrapeTime + 0.25 || GameTime < lastVolatileScrapeTime ) {

				lastVolatileScrapeTime = GameTime;
				// The current scrape API has no exact wall contact point; the player
				// position and segment retain D1 portal topology and side selection.
				digi_play_sample_world(
					SOUND_VOLATILE_WALL_HISS, 1.0, playerSeg, pp.x, pp.y, pp.z
				);

			}

			if ( _getPlayerShields() < 0 ) {

				if ( _startPlayerDeath !== null ) _startPlayerDeath();
				break;

			}

		}

	}

}

// ---------------------------------------------------------------
// drop_player_eggs
// Ported from: drop_player_eggs() in COLLIDE.C lines 1447-1546
// Drop powerups corresponding to player's current weapons/ammo
// ---------------------------------------------------------------
export function drop_player_eggs() {

	if ( _getPlayerPos === null || _getPlayerSegnum === null || _spawnDroppedPowerup === null ) return;

	const pp = _getPlayerPos();
	const seg = _getPlayerSegnum();

	// Drop laser level powerups (one per level above 0)
	const laserLevel = _getPlayerLaserLevel !== null ? _getPlayerLaserLevel() : 0;
	if ( laserLevel >= 1 ) {

		for ( let i = 0; i < laserLevel; i ++ ) {

			_spawnDroppedPowerup( POW_LASER, pp.x, pp.y, pp.z, seg );

		}

	}

	// Drop primary weapons (skip laser, bit 0 — player always has it)
	const primaryFlags = _getPlayerPrimaryFlags !== null ? _getPlayerPrimaryFlags() : 1;

	if ( ( primaryFlags & 2 ) !== 0 ) {

		_spawnDroppedPowerup( POW_VULCAN_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 4 ) !== 0 ) {

		_spawnDroppedPowerup( POW_SPREADFIRE_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 8 ) !== 0 ) {

		_spawnDroppedPowerup( POW_PLASMA_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 16 ) !== 0 ) {

		_spawnDroppedPowerup( POW_FUSION_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Drop secondary weapons
	const secAmmo0 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 0 ) : 0;
	const secAmmo1 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 1 ) : 0;
	const secAmmo2 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 2 ) : 0;
	const secAmmo3 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 3 ) : 0;
	const secAmmo4 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 4 ) : 0;

	// Concussion missiles: up to 4, split as packs of 4 and singles
	const numConcussion = Math.min( secAmmo0, 4 );
	if ( Math.floor( numConcussion / 4 ) > 0 ) {

		_spawnDroppedPowerup( POW_MISSILE_4, pp.x, pp.y, pp.z, seg );

	}

	for ( let i = 0; i < numConcussion % 4; i ++ ) {

		_spawnDroppedPowerup( POW_MISSILE_1, pp.x, pp.y, pp.z, seg );

	}

	// Homing missiles: up to 6, split as packs of 4 and singles
	const numHoming = Math.min( secAmmo1, 6 );
	if ( Math.floor( numHoming / 4 ) > 0 ) {

		_spawnDroppedPowerup( POW_HOMING_AMMO_4, pp.x, pp.y, pp.z, seg );

	}

	for ( let i = 0; i < numHoming % 4; i ++ ) {

		_spawnDroppedPowerup( POW_HOMING_AMMO_1, pp.x, pp.y, pp.z, seg );

	}

	// Proximity bombs: (ammo+2)/4, max 3
	const numProx = Math.min( Math.floor( ( secAmmo2 + 2 ) / 4 ), 3 );
	for ( let i = 0; i < numProx; i ++ ) {

		_spawnDroppedPowerup( POW_PROXIMITY_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Smart missiles: ammo count, max 3
	const numSmart = Math.min( secAmmo3, 3 );
	for ( let i = 0; i < numSmart; i ++ ) {

		_spawnDroppedPowerup( POW_SMARTBOMB_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Mega missiles: ammo count, max 3
	const numMega = Math.min( secAmmo4, 3 );
	for ( let i = 0; i < numMega; i ++ ) {

		_spawnDroppedPowerup( POW_MEGA_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Vulcan ammo: if player has ammo but no vulcan weapon, drop ammo packs
	const vulcanAmmo = _getPlayerVulcanAmmo !== null ? _getPlayerVulcanAmmo() : 0;
	if ( ( primaryFlags & 2 ) === 0 && vulcanAmmo > 0 ) {

		let amount = Math.min( vulcanAmmo, 200 );
		while ( amount > 0 ) {

			_spawnDroppedPowerup( POW_VULCAN_AMMO, pp.x, pp.y, pp.z, seg );
			amount -= VULCAN_AMMO_AMOUNT;

		}

	}

}

// Ported from: pick_up_energy() in POWERUP.C:344
// Adds difficulty-scaled energy (3 + 3*(NDL - Difficulty_level), NDL=5) up to ENERGY_MAX (200).
// Returns true if any energy was added (powerup consumed), false if already full.
function pick_up_energy() {

	if ( _getPlayerEnergy === null || _setPlayerEnergy === null ) return false;
	if ( _getPlayerEnergy() >= 200 ) return false;

	const diff = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	let energy = _getPlayerEnergy() + ( 3 + 3 * ( 5 - diff ) );
	if ( energy > 200 ) energy = 200;
	_setPlayerEnergy( energy );
	if ( _showMessage !== null ) _showMessage( 'Energy boosted to ' + Math.round( energy ) );
	return true;

}

function play_powerup_pickup_sound( id ) {

	if ( id < 0 || id >= N_powerup_types ) return;
	const sound = Powerup_info[ id ].hit_sound;
	if ( sound >= 0 ) digi_play_sample( sound, 1.0 );

}

// ---------------------------------------------------------------
// collide_player_and_powerup
// Ported from: collide_player_and_powerup() in COLLIDE.C lines 1739-1776
//              do_powerup() in POWERUP.C
// ---------------------------------------------------------------
export function collide_player_and_powerup( powerup ) {

	const scene = _getScene !== null ? _getScene() : null;
	if ( scene === null ) return;

	const id = powerup.obj.id;
	let used = 0;

	// Hostages are always consumed
	if ( powerup.isHostage === true ) {

		if ( _addHostageSaved !== null ) _addHostageSaved( 1 );
		if ( _addLevelHostagesSaved !== null ) _addLevelHostagesSaved( 1 );
		if ( _addPlayerScore !== null ) _addPlayerScore( HOSTAGE_SCORE );

		let hostageMessage = 'Hostage rescued!';

		if ( _getHostagesInLevel !== null && _getHostagesSavedInLevel !== null ) {

			const total = _getHostagesInLevel();
			const saved = _getHostagesSavedInLevel();

			if ( total > 0 ) {

				hostageMessage = 'Hostage rescued! (' + saved + '/' + total + ')';

			}

		}

		if ( _showMessage !== null ) _showMessage( hostageMessage );
		digi_play_sample( SOUND_HOSTAGE_RESCUED, 1.0 );
		if ( _flashDamage !== null ) _flashDamage( 'blue' );
		if ( _updateHUD !== null ) _updateHUD();
		used = 1;

	} else {

		// Ported from: do_powerup() in POWERUP.C lines 378-540
		// Returns used=0 if powerup should stay in the world (player maxed out)
		switch ( id ) {

			case POW_SHIELD_BOOST:
				if ( _getPlayerShields() < 200 ) {

					// Ported from: do_powerup() in POWERUP.C line 397
					// shields += 3*F1_0 + 3*F1_0*(NDL - Difficulty_level)
					const shieldDifficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const shieldBoostAmount = 3 + 3 * ( NDL - shieldDifficulty );
					_setPlayerShields( Math.min( _getPlayerShields() + shieldBoostAmount, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Shield Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Shields maxed out!' );

				}

				break;

			case POW_ENERGY:
				if ( _getPlayerEnergy() < 200 ) {

					// Ported from: pick_up_energy() in POWERUP.C line 349
					// energy += 3*F1_0 + 3*F1_0*(NDL - Difficulty_level)
					const energyDifficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const energyBoostAmount = 3 + 3 * ( NDL - energyDifficulty );
					_setPlayerEnergy( Math.min( _getPlayerEnergy() + energyBoostAmount, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Energy maxed out!' );

				}

				break;

			case POW_EXTRA_LIFE:
				if ( _setPlayerLives !== null ) _setPlayerLives( _getPlayerLives() + 1 );
				if ( _showMessage !== null ) _showMessage( 'Extra Life!' );
				used = 1;
				break;

			case POW_LASER:
				if ( _getPlayerLaserLevel() < 3 ) {

					_setPlayerLaserLevel( _getPlayerLaserLevel() + 1 );
					if ( _showMessage !== null ) _showMessage( 'Laser Level ' + ( _getPlayerLaserLevel() + 1 ) + '!' );
					used = 1;

				} else if ( pick_up_energy() === true ) {

					// Already own this weapon -> fall back to a difficulty-scaled energy boost
					// (POWERUP.C: used = pick_up_energy()), instead of a flat +20.
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Laser maxed out!' );

				}

				break;

			case POW_KEY_BLUE:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().blue === true ) {

					break;

				}

				play_powerup_pickup_sound( id );
				if ( _setPlayerKey !== null ) _setPlayerKey( 'blue', true );
				if ( _showMessage !== null ) _showMessage( 'Blue Access Key!' );
				used = 1;
				break;

			case POW_KEY_RED:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().red === true ) {

					break;

				}

				play_powerup_pickup_sound( id );
				if ( _setPlayerKey !== null ) _setPlayerKey( 'red', true );
				if ( _showMessage !== null ) _showMessage( 'Red Access Key!' );
				used = 1;
				break;

			case POW_KEY_GOLD:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().gold === true ) {

					break;

				}

				play_powerup_pickup_sound( id );
				if ( _setPlayerKey !== null ) _setPlayerKey( 'gold', true );
				if ( _showMessage !== null ) _showMessage( 'Gold Access Key!' );
				used = 1;
				break;

			case POW_VULCAN_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 2 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 2 );
					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_WEAPON_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Cannon!' );
					used = 1;

				} else if ( _getPlayerVulcanAmmo() < VULCAN_AMMO_MAX ) {

					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Ammo!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Vulcan ammo maxed out!' );

				}

				break;

			case POW_SPREADFIRE_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 4 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 4 );
					if ( _showMessage !== null ) _showMessage( 'Spreadfire Cannon!' );
					used = 1;

				} else if ( pick_up_energy() === true ) {

					// Already own this weapon -> fall back to a difficulty-scaled energy boost
					// (POWERUP.C: used = pick_up_energy()), instead of a flat +20.
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Spreadfire!' );

				}

				break;

			case POW_PLASMA_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 8 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 8 );
					if ( _showMessage !== null ) _showMessage( 'Plasma Cannon!' );
					used = 1;

				} else if ( pick_up_energy() === true ) {

					// Already own this weapon -> fall back to a difficulty-scaled energy boost
					// (POWERUP.C: used = pick_up_energy()), instead of a flat +20.
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Plasma!' );

				}

				break;

			case POW_FUSION_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 16 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 16 );
					if ( _showMessage !== null ) _showMessage( 'Fusion Cannon!' );
					used = 1;

				} else if ( pick_up_energy() === true ) {

					// Already own this weapon -> fall back to a difficulty-scaled energy boost
					// (POWERUP.C: used = pick_up_energy()), instead of a flat +20.
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Fusion!' );

				}

				break;

			case POW_MISSILE_1:
				if ( _getPlayerSecondaryAmmo( 0 ) < 20 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 1 );
					_setPlayerSecondaryAmmo( 0, Math.min( _getPlayerSecondaryAmmo( 0 ) + 1, 20 ) );
					if ( _showMessage !== null ) _showMessage( 'Concussion Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Concussion ammo maxed out!' );

				}

				break;

			case POW_MISSILE_4:
				if ( _getPlayerSecondaryAmmo( 0 ) < 20 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 1 );
					_setPlayerSecondaryAmmo( 0, Math.min( _getPlayerSecondaryAmmo( 0 ) + 4, 20 ) );
					if ( _showMessage !== null ) _showMessage( '4 Concussion Missiles!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Concussion ammo maxed out!' );

				}

				break;

			case POW_HOMING_AMMO_1:
				if ( _getPlayerSecondaryAmmo( 1 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 2 );
					_setPlayerSecondaryAmmo( 1, Math.min( _getPlayerSecondaryAmmo( 1 ) + 1, 10 ) );
					if ( _showMessage !== null ) _showMessage( 'Homing Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Homing ammo maxed out!' );

				}

				break;

			case POW_HOMING_AMMO_4:
				if ( _getPlayerSecondaryAmmo( 1 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 2 );
					_setPlayerSecondaryAmmo( 1, Math.min( _getPlayerSecondaryAmmo( 1 ) + 4, 10 ) );
					if ( _showMessage !== null ) _showMessage( '4 Homing Missiles!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Homing ammo maxed out!' );

				}

				break;

			case POW_PROXIMITY_WEAPON:
				if ( _getPlayerSecondaryAmmo( 2 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 4 );
					_setPlayerSecondaryAmmo( 2, Math.min( _getPlayerSecondaryAmmo( 2 ) + 4, 10 ) );
					if ( _showMessage !== null ) _showMessage( 'Proximity Bombs!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Proximity ammo maxed out!' );

				}

				break;

			case POW_SMARTBOMB_WEAPON:
				if ( _getPlayerSecondaryAmmo( 3 ) < 5 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 8 );
					_setPlayerSecondaryAmmo( 3, Math.min( _getPlayerSecondaryAmmo( 3 ) + 1, 5 ) );
					if ( _showMessage !== null ) _showMessage( 'Smart Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Smart ammo maxed out!' );

				}

				break;

			case POW_MEGA_WEAPON:
				if ( _getPlayerSecondaryAmmo( 4 ) < 5 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 16 );
					_setPlayerSecondaryAmmo( 4, Math.min( _getPlayerSecondaryAmmo( 4 ) + 1, 5 ) );
					if ( _showMessage !== null ) _showMessage( 'Mega Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Mega ammo maxed out!' );

				}

				break;

			case POW_VULCAN_AMMO:
				if ( _getPlayerVulcanAmmo() < VULCAN_AMMO_MAX ) {

					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Ammo!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Vulcan ammo maxed out!' );

				}

				break;

			case POW_QUAD_FIRE:
				// Ported from: POWERUP.C — set PLAYER_FLAGS_QUAD_LASERS
				if ( _getPlayerQuadLasers !== null && _getPlayerQuadLasers() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already have Quad Lasers!' );

				} else {

					if ( _setPlayerQuadLasers !== null ) _setPlayerQuadLasers( true );
					if ( _showMessage !== null ) _showMessage( 'Quad Lasers!' );
					used = 1;

				}

				// Already have quad -> fall back to a difficulty-scaled energy boost. POWERUP.C:477-478
				if ( used !== 1 && pick_up_energy() === true ) used = 1;

				break;

			case POW_CLOAK:
				// Ported from: do_megawow_powerup() / POWERUP.C lines 527-535
				if ( _isPlayerCloaked !== null && _isPlayerCloaked() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already cloaked!' );

				} else {

					if ( _activateCloak !== null ) _activateCloak();
					if ( _showMessage !== null ) _showMessage( 'Cloak!' );
					used = 1;

				}

				break;

			case POW_INVULNERABILITY:
				// Ported from: do_megawow_powerup() / POWERUP.C lines 543-553
				if ( _isPlayerInvulnerable !== null && _isPlayerInvulnerable() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already invulnerable!' );

				} else {

					if ( _activateInvulnerability !== null ) _activateInvulnerability();
					if ( _showMessage !== null ) _showMessage( 'Invulnerability!' );
					used = 1;

				}

				break;

			default:
				if ( _showMessage !== null ) _showMessage( 'Got Powerup!' );
				used = 1;
				break;

		}

	}

	// Only consume the powerup if it was actually used
	if ( used === 1 ) {

		// Play per-powerup-type pickup sound (hostage already plays its own)
		// Ported from: POWERUP.C line 569-574 — Powerup_info[obj->id].hit_sound
		if ( powerup.isHostage !== true ) {

			play_powerup_pickup_sound( id );

		}

		powerup.alive = false;
		if ( powerup.objnum !== undefined && powerup.objnum >= 0 ) powerup.obj.flags |= OF_SHOULD_BE_DEAD;

		if ( powerup.sprite !== null ) {

			scene.remove( powerup.sprite );

		}

		if ( _updateHUD !== null ) _updateHUD();

	}

}
