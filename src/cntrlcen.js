// Ported from: descent-master/MAIN/CNTRLCEN.C and CNTRLCEN.H
// Control center (reactor) logic: firing AI, gun hardpoints, self-destruct

import { find_point_seg } from './gameseg.js';
import { find_vector_intersection, HIT_WALL } from './fvi.js';
import { Laser_create_new, PARENT_ROBOT } from './laser.js';
import { digi_play_sample, digi_play_sample_world,
	SOUND_CONTROL_CENTER_WARNING_SIREN, SOUND_MINE_BLEW_UP,
	SOUND_COUNTDOWN_0_SECS, SOUND_COUNTDOWN_13_SECS, SOUND_COUNTDOWN_29_SECS,
	SOUND_EXPLODING_WALL } from './digi.js';
import { Weapon_info } from './weapon.js';
import { object_create_explosion } from './fireball.js';
import { effects_set_reactor_destroyed } from './effects.js';
import { Segments, Vertices, Num_segments } from './mglobal.js';
import { Polygon_models } from './polyobj.js';

// Difficulty levels
const NDL = 5;
const CONTROLCEN_WEAPON_NUM = 6;

function playControlCenterWeaponSound( segnum, pos_x, pos_y, pos_z ) {

	if ( CONTROLCEN_WEAPON_NUM >= Weapon_info.length ) return;
	const sound = Weapon_info[ CONTROLCEN_WEAPON_NUM ].flash_sound;
	if ( sound < 0 ) return;
	digi_play_sample_world( sound, 1.0, segnum, pos_x, pos_y, pos_z );

}

// Reactor state
let liveReactor = null;

// Reactor firing state (ported from CNTRLCEN.C)
let reactorFireTimer = 0;
let reactorCheckTimer = 0;
let reactorPlayerSeen = false;
// Ported from: Control_center_been_hit in CNTRLCEN.C
// Reactor only fires after it has been hit at least once
let Control_center_been_hit = false;

// Self-destruct sequence state
let selfDestructTimer = 0;
let selfDestructWarningTimer = 0;
let selfDestructSirenTimer = 0;
let selfDestructTotalTime = 0;
let selfDestructReactorTimer = 0;
let selfDestructWhiteFlash = 0;
let controlCenterDestroyed = false;

// Countdown voice tracking — which second thresholds have been spoken
let countdownVoicePlayed = new Set();


// ControlCenterTriggers — doors to toggle when reactor is destroyed
let _controlCenterTriggers = null;
let _wallToggle = null;

// Externals (injected to avoid circular imports)
let _getPlayerPos = null;
let _getCamera = null;
let _getDifficultyLevel = null;
let _isPlayerDead = null;
let _isPlayerCloaked = null;
let _getBelievedPlayerPos = null;
let _showMessage = null;
let _updateHUD = null;
let _gauges_set_white_flash = null;
let _startPlayerDeath = null;
let _getPlayerShields = null;
let _setPlayerShields = null;
export function cntrlcen_set_externals( ext ) {

	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getCamera !== undefined ) _getCamera = ext.getCamera;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;
	if ( ext.isPlayerDead !== undefined ) _isPlayerDead = ext.isPlayerDead;
	if ( ext.showMessage !== undefined ) _showMessage = ext.showMessage;
	if ( ext.updateHUD !== undefined ) _updateHUD = ext.updateHUD;
	if ( ext.gauges_set_white_flash !== undefined ) _gauges_set_white_flash = ext.gauges_set_white_flash;
	if ( ext.startPlayerDeath !== undefined ) _startPlayerDeath = ext.startPlayerDeath;
	if ( ext.getPlayerShields !== undefined ) _getPlayerShields = ext.getPlayerShields;
	if ( ext.setPlayerShields !== undefined ) _setPlayerShields = ext.setPlayerShields;
	if ( ext.controlCenterTriggers !== undefined ) _controlCenterTriggers = ext.controlCenterTriggers;
	if ( ext.wallToggle !== undefined ) _wallToggle = ext.wallToggle;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;
	if ( ext.getBelievedPlayerPos !== undefined ) _getBelievedPlayerPos = ext.getBelievedPlayerPos;

}

// Get/set reactor reference
export function cntrlcen_get_reactor() {

	return liveReactor;

}

export function cntrlcen_set_reactor( reactor ) {

	liveReactor = reactor;

}

// Called when reactor takes damage — enables firing AI
// Ported from: Control_center_been_hit = 1 in COLLIDE.C
export function cntrlcen_notify_hit() {

	Control_center_been_hit = true;

}

// Get self-destruct timer (used by main.js frame callback)
export function cntrlcen_get_self_destruct_timer() {

	return selfDestructTimer;

}

// Check if self-destruct sequence is active (countdown or white-out)
export function cntrlcen_is_self_destruct_active() {

	return selfDestructTimer > 0 || selfDestructWhiteFlash > 0;

}

// Fuelcen_control_center_destroyed remains set after the countdown and
// white-out finish.  D1 uses that persistent state to route a mine-death to
// the end-of-level flow instead of respawning the player in the destroyed mine.
export function cntrlcen_is_destroyed() {

	return controlCenterDestroyed;

}

// STATE.C persists both Fuelcen_control_center_destroyed and the countdown
// state.  Keep the JS-specific fractional timers so a save resumes at the
// same point without replaying do_controlcen_destroyed_stuff() (which would
// toggle the exit doors a second time).
export function cntrlcen_get_save_state() {

	return {
		destroyed: controlCenterDestroyed,
		timer: selfDestructTimer,
		totalTime: selfDestructTotalTime,
		warningTimer: selfDestructWarningTimer,
		sirenTimer: selfDestructSirenTimer,
		reactorTimer: selfDestructReactorTimer,
		whiteFlash: selfDestructWhiteFlash,
		countdownVoicePlayed: Array.from( countdownVoicePlayed )
	};

}

export function cntrlcen_restore_save_state( state ) {

	if ( state === null || state === undefined || typeof state !== 'object' ||
		typeof state.destroyed !== 'boolean' ) return false;

	controlCenterDestroyed = state.destroyed === true;
	if ( controlCenterDestroyed !== true ) {

		selfDestructTimer = 0;
		selfDestructTotalTime = 0;
		selfDestructWarningTimer = 0;
		selfDestructSirenTimer = 0;
		selfDestructReactorTimer = 0;
		selfDestructWhiteFlash = 0;
		countdownVoicePlayed.clear();
		effects_set_reactor_destroyed( false );
		return true;

	}

	selfDestructTimer = Number.isFinite( state.timer ) ? Math.max( state.timer, 0 ) : 0;
	selfDestructTotalTime = Number.isFinite( state.totalTime )
		? Math.max( state.totalTime, selfDestructTimer ) : selfDestructTimer;
	selfDestructWarningTimer = Number.isFinite( state.warningTimer )
		? state.warningTimer : 0;
	selfDestructSirenTimer = Number.isFinite( state.sirenTimer ) ? state.sirenTimer : 0;
	selfDestructReactorTimer = Number.isFinite( state.reactorTimer )
		? state.reactorTimer : 0;
	selfDestructWhiteFlash = Number.isFinite( state.whiteFlash )
		? Math.max( state.whiteFlash, 0 ) : 0;
	countdownVoicePlayed.clear();
	if ( Array.isArray( state.countdownVoicePlayed ) ) {

		for ( let i = 0; i < state.countdownVoicePlayed.length; i ++ ) {

			const second = state.countdownVoicePlayed[ i ];
			if ( Number.isInteger( second ) && second >= 0 ) countdownVoicePlayed.add( second );

		}

	}

	effects_set_reactor_destroyed( controlCenterDestroyed );
	return true;

}

// Initialize reactor gun hardpoints from polygon model
// Ported from: init_controlcen_for_level() / calc_controlcen_gun_point() in CNTRLCEN.C
export function init_controlcen_for_level( obj ) {

	const pm = Polygon_models[ obj.rtype.model_num ];
	if ( pm !== null && pm !== undefined && pm.n_guns > 0 ) {

		liveReactor.n_guns = pm.n_guns;
		liveReactor.gun_pos = [];
		liveReactor.gun_dir = [];

		for ( let g = 0; g < pm.n_guns; g ++ ) {

			// Transform model-space gun point/dir by reactor orientation (transposed)
			const gp = pm.gun_points[ g ];
			const gd = pm.gun_dirs[ g ];

			// Rotate by orientation matrix (columns = rvec, uvec, fvec)
			const wpx = obj.orient_rvec_x * gp.x + obj.orient_uvec_x * gp.y + obj.orient_fvec_x * gp.z + obj.pos_x;
			const wpy = obj.orient_rvec_y * gp.x + obj.orient_uvec_y * gp.y + obj.orient_fvec_y * gp.z + obj.pos_y;
			const wpz = obj.orient_rvec_z * gp.x + obj.orient_uvec_z * gp.y + obj.orient_fvec_z * gp.z + obj.pos_z;

			const wdx = obj.orient_rvec_x * gd.x + obj.orient_uvec_x * gd.y + obj.orient_fvec_x * gd.z;
			const wdy = obj.orient_rvec_y * gd.x + obj.orient_uvec_y * gd.y + obj.orient_fvec_y * gd.z;
			const wdz = obj.orient_rvec_z * gd.x + obj.orient_uvec_z * gd.y + obj.orient_fvec_z * gd.z;

			liveReactor.gun_pos.push( { x: wpx, y: wpy, z: wpz } );
			liveReactor.gun_dir.push( { x: wdx, y: wdy, z: wdz } );

		}

		console.log( 'REACTOR: ' + pm.n_guns + ' gun hardpoints initialized' );

	} else {

		liveReactor.n_guns = 0;

	}

}

// Start the self-destruct countdown
// Ported from: do_controlcen_destroyed_stuff() in CNTRLCEN.C + controlcen_proc() in FUELCEN.C
export function startSelfDestruct() {

	controlCenterDestroyed = true;

	// Toggle exit doors via ControlCenterTriggers
	// Ported from: do_controlcen_destroyed_stuff() in CNTRLCEN.C lines 211-216
	if ( _controlCenterTriggers !== null && _wallToggle !== null ) {

		for ( let i = 0; i < _controlCenterTriggers.num_links; i ++ ) {

			_wallToggle( _controlCenterTriggers.seg[ i ], _controlCenterTriggers.side[ i ] );

		}

		console.log( 'REACTOR: Toggled ' + _controlCenterTriggers.num_links + ' exit doors' );

	}

	const Difficulty_level = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;

	// Duration: 30 + (NDL - Difficulty_level - 1) * 5 seconds (easier = more time)
	// Ported from: DIFF_CONTROL_CENTER_EXPLOSION_TIME in FUELCEN.C
	const BASE_TIME = 30.0;
	const bonusTime = ( NDL - Difficulty_level - 1 ) * 5;
	selfDestructTimer = BASE_TIME + bonusTime;
	selfDestructTotalTime = selfDestructTimer;
	selfDestructWarningTimer = 0;
	selfDestructSirenTimer = 0;
	selfDestructReactorTimer = 0;
	selfDestructWhiteFlash = 0;
	countdownVoicePlayed.clear();

	if ( _showMessage !== null ) _showMessage( 'REACTOR DESTROYED! ESCAPE NOW!' );

	// Freeze critical eclips (monitors/screens that depend on reactor power)
	effects_set_reactor_destroyed( true );

}

// Reset reactor state for new level
export function cntrlcen_reset() {

	liveReactor = null;
	controlCenterDestroyed = false;
	selfDestructTimer = 0;
	selfDestructWarningTimer = 0;
	selfDestructSirenTimer = 0;
	selfDestructTotalTime = 0;
	selfDestructReactorTimer = 0;
	selfDestructWhiteFlash = 0;
	reactorFireTimer = 0;
	reactorCheckTimer = 0;
	reactorPlayerSeen = false;
	Control_center_been_hit = false;
	countdownVoicePlayed.clear();
	_controlCenterTriggers = null;

}

// Process reactor firing AI (called each frame)
// Ported from: do_controlcen_frame() in CNTRLCEN.C
export function do_controlcen_frame( dt ) {

	if ( liveReactor === null || liveReactor.alive !== true ) return;
	if ( _isPlayerDead !== null && _isPlayerDead() === true ) return;
	if ( selfDestructTimer > 0 ) return;

	const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
	if ( pp === null ) return;

	// Ported from: CNTRLCEN.C do_controlcen_frame() lines 249-284
	// Reactor starts firing after either being hit OR seeing the player.
	// While neither is true, periodically probe visibility within 200 units.
	if ( Control_center_been_hit !== true && reactorPlayerSeen !== true ) {

		reactorCheckTimer -= dt;

		if ( reactorCheckTimer <= 0 ) {

			reactorCheckTimer = 0.133; // every ~8 frames at 60fps

			const qx = pp.x - liveReactor.obj.pos_x;
			const qy = pp.y - liveReactor.obj.pos_y;
			const qz = pp.z - liveReactor.obj.pos_z;
			const qdist = Math.sqrt( qx * qx + qy * qy + qz * qz );

			if ( qdist < 200.0 ) {

				const losResult = find_vector_intersection(
					liveReactor.obj.pos_x, liveReactor.obj.pos_y, liveReactor.obj.pos_z,
					pp.x, pp.y, pp.z,
					liveReactor.obj.segnum, 0.0,
					- 1, 0
				);

				if ( losResult.hit_type !== HIT_WALL ) {

					reactorPlayerSeen = true;
					reactorFireTimer = 0;

				}

			}

		}

		return;

	}

	// Cloaked player: reactor fires at inaccurate "believed" position
	// Ported from: CNTRLCEN.C lines 287-303 — uses Believed_player_pos when cloaked
	const isCloaked = ( _isPlayerCloaked !== null && _isPlayerCloaked() === true );
	let target_x = pp.x;
	let target_y = pp.y;
	let target_z = pp.z;

	if ( isCloaked === true ) {

		const bp = _getBelievedPlayerPos !== null ? _getBelievedPlayerPos() : null;
		if ( bp !== null ) {

			target_x = bp.x;
			target_y = bp.y;
			target_z = bp.z;

		} else {

			// Fallback when AI believed-position provider is unavailable
			target_x += ( Math.random() - 0.5 ) * 60.0;
			target_y += ( Math.random() - 0.5 ) * 60.0;
			target_z += ( Math.random() - 0.5 ) * 60.0;

		}

	}

	reactorFireTimer -= dt;
	if ( reactorFireTimer > 0 ) return;

	// Select best gun to fire from (ported from calc_best_gun in CNTRLCEN.C)
	let fire_x = liveReactor.obj.pos_x;
	let fire_y = liveReactor.obj.pos_y;
	let fire_z = liveReactor.obj.pos_z;

	if ( liveReactor.n_guns > 0 ) {

		let bestDot = - 2.0;
		let bestGun = - 1;

		for ( let g = 0; g < liveReactor.n_guns; g ++ ) {

			const gp = liveReactor.gun_pos[ g ];
			const gd = liveReactor.gun_dir[ g ];
			let gvx = target_x - gp.x;
			let gvy = target_y - gp.y;
			let gvz = target_z - gp.z;
			const gvmag = Math.sqrt( gvx * gvx + gvy * gvy + gvz * gvz );

			if ( gvmag > 0.001 ) {

				gvx /= gvmag;
				gvy /= gvmag;
				gvz /= gvmag;
				const d = gd.x * gvx + gd.y * gvy + gd.z * gvz;

				if ( d > bestDot ) {

					bestDot = d;
					bestGun = g;

				}

			}

		}

		if ( bestGun !== - 1 && bestDot >= 0 ) {

			fire_x = liveReactor.gun_pos[ bestGun ].x;
			fire_y = liveReactor.gun_pos[ bestGun ].y;
			fire_z = liveReactor.gun_pos[ bestGun ].z;

		}

	}

	let dx = target_x - fire_x;
	let dy = target_y - fire_y;
	let dz = target_z - fire_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist > 300.0 ) {

		Control_center_been_hit = false;
		reactorPlayerSeen = false;
		return;

	}

	if ( dist > 0.001 ) {

		dx /= dist;
		dy /= dist;
		dz /= dist;

		const fireSeg = find_point_seg( fire_x, fire_y, fire_z, liveReactor.obj.segnum );
		const seg = fireSeg !== - 1 ? fireSeg : liveReactor.obj.segnum;

		// LOS check: don't fire through walls
		// Ported from: CNTRLCEN.C do_controlcen_frame() visibility check
		const losResult = find_vector_intersection(
			fire_x, fire_y, fire_z,
			target_x, target_y, target_z,
			seg, 0.0,
			- 1, 0
		);

		if ( losResult.hit_type === HIT_WALL ) return;

		// Fire at player
		const firstShot = Laser_create_new(
			dx, dy, dz, fire_x, fire_y, fire_z, seg, PARENT_ROBOT, CONTROLCEN_WEAPON_NUM,
			1.0, undefined, false, undefined, liveReactor.objnum, liveReactor.obj.signature
		);
		if ( firstShot !== - 1 ) playControlCenterWeaponSound( seg, fire_x, fire_y, fire_z );

		// 25% chance of additional random-aimed shot
		if ( Math.random() < 0.25 ) {

			let rx = dx + ( Math.random() - 0.5 ) * 0.5;
			let ry = dy + ( Math.random() - 0.5 ) * 0.5;
			let rz = dz + ( Math.random() - 0.5 ) * 0.5;
			const rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );
			if ( rmag > 0.001 ) {

				const secondShot = Laser_create_new( rx / rmag, ry / rmag, rz / rmag,
					fire_x, fire_y, fire_z, seg, PARENT_ROBOT, CONTROLCEN_WEAPON_NUM,
					1.0, undefined, false, undefined, liveReactor.objnum, liveReactor.obj.signature );
				if ( secondShot !== - 1 ) {

					playControlCenterWeaponSound( seg, fire_x, fire_y, fire_z );

				}

			}

		}

		// Fire rate: (NDL - Difficulty_level) * 0.25 seconds
		const Difficulty_level = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
		reactorFireTimer = ( NDL - Difficulty_level ) * 0.25;

	}

}

// Process self-destruct countdown (called each frame)
// Ported from: controlcen_proc() in FUELCEN.C lines 791-854
// and do_controlcen_dead_frame() in CNTRLCEN.C
export function do_controlcen_destroyed_frame( dt, playerPos ) {

	// --- Self-destruct countdown ---
	if ( selfDestructTimer > 0 ) {

		const oldTimer = selfDestructTimer;
		selfDestructTimer -= dt;
		selfDestructWarningTimer -= dt;

		const elapsed = selfDestructTotalTime - selfDestructTimer;
		const oldElapsed = selfDestructTotalTime - oldTimer;

		// Ship rocking — random camera rotation during countdown
		// Ported from: FUELCEN.C lines 801-805
		const camera = _getCamera !== null ? _getCamera() : null;
		if ( camera !== null ) {

			const fc = Math.min( selfDestructTimer, 16 );
			const rockScale = ( 3.0 / 16 + ( 16 - fc ) / 32 ) * 0.02;
			camera.rotation.x += ( Math.random() - 0.5 ) * rockScale;
			camera.rotation.z += ( Math.random() - 0.5 ) * rockScale;

		}

		// Random fireballs on reactor object (do_controlcen_dead_frame)
		// Ported from: CNTRLCEN.C lines 196-204
		if ( liveReactor !== null && selfDestructTimer > 0 ) {

			selfDestructReactorTimer -= dt;

			if ( selfDestructReactorTimer <= 0 ) {

				selfDestructReactorTimer = 0.3 + Math.random() * 0.5;

				const rx = liveReactor.obj.pos_x + ( Math.random() - 0.5 ) * 8;
				const ry = liveReactor.obj.pos_y + ( Math.random() - 0.5 ) * 8;
				const rz = liveReactor.obj.pos_z + ( Math.random() - 0.5 ) * 8;
				const explosion = object_create_explosion(
					rx, ry, rz, 2.0 + Math.random() * 2.0
				);

				// create_small_fireball_on_object() gives non-robot destruction
				// fireballs a one-in-four, half-volume crackle at the owning object.
				// Ported from: OBJECT.C lines 783-793.
				if ( explosion !== null && Math.random() < 0.25 ) {

					digi_play_sample_world(
						SOUND_EXPLODING_WALL, 0.5, liveReactor.obj.segnum,
						liveReactor.obj.pos_x,
						liveReactor.obj.pos_y,
						liveReactor.obj.pos_z
					);

				}

			}

		}

		// Escalating explosions at control-center segment center + siren.
		// Ported from: FUELCEN.C lines 821-832
		if ( elapsed > 5.0 && liveReactor !== null ) {

			const size = elapsed / 0.65;
			const oldSize = oldElapsed / 0.65;
			if ( Math.floor( size ) !== Math.floor( oldSize ) ) {

				const segnum = liveReactor.obj.segnum;
				if ( segnum >= 0 && segnum < Num_segments ) {

					const s = Segments[ segnum ];
					let cx = 0, cy = 0, cz = 0;
					for ( let v = 0; v < 8; v ++ ) {

						const vi = s.verts[ v ];
						cx += Vertices[ vi * 3 + 0 ];
						cy += Vertices[ vi * 3 + 1 ];
						cz += Vertices[ vi * 3 + 2 ];

					}

					object_create_explosion( cx / 8, cy / 8, cz / 8, size * 10.0 );

				}

				digi_play_sample( SOUND_CONTROL_CENTER_WARNING_SIREN, 3.0 );

			}

		}

		// Flash warning text every 1 second
		if ( selfDestructWarningTimer <= 0 ) {

			const secs = Math.max( 0, Math.ceil( selfDestructTimer ) );
			if ( _showMessage !== null ) _showMessage( 'SELF DESTRUCT IN ' + secs + 's — ESCAPE!' );
			selfDestructWarningTimer = 1.0;

		}

		// Countdown voice sounds
		// Ported from: FUELCEN.C lines 811-819
		const countdown13At = selfDestructTotalTime - 12.75;
		if ( oldElapsed < countdown13At && elapsed >= countdown13At ) {

			digi_play_sample( SOUND_COUNTDOWN_13_SECS, 3.0 );

		}

		if ( Math.floor( oldElapsed ) !== Math.floor( elapsed ) ) {

			const totalSecs = Math.floor( selfDestructTotalTime );
			// D1 derives this from the integer part of elapsed time.  Flooring
			// the fractional time remaining instead skips the first spoken
			// second (29 on Insane) as soon as the timer crosses 1.0.
			const secsLeft = totalSecs - Math.floor( elapsed );
			if ( secsLeft >= 0 && secsLeft < 10 ) {

				digi_play_sample( SOUND_COUNTDOWN_0_SECS + secsLeft, 3.0 );

			}

			if ( secsLeft === totalSecs - 1 ) {

				digi_play_sample( SOUND_COUNTDOWN_29_SECS, 3.0 );

			}

		}

		if ( selfDestructTimer <= 0 ) {

			// Start white-out phase
			// Ported from: FUELCEN.C lines 833-852
			selfDestructTimer = 0;
			selfDestructWhiteFlash = 4.0;
			digi_play_sample( SOUND_MINE_BLEW_UP, 1.0 );
			if ( _showMessage !== null ) _showMessage( 'MINE DESTROYED!' );

			// Multiple explosions at player and reactor positions
			if ( playerPos !== null ) {

				object_create_explosion( playerPos.x, playerPos.y, playerPos.z, 20.0 );

			}

			if ( liveReactor !== null ) {

				object_create_explosion(
					liveReactor.obj.pos_x, liveReactor.obj.pos_y, liveReactor.obj.pos_z, 30.0
				);

			}

		}

	}

	// White-out flash phase — screen fades to white, then player dies
	// Ported from: FUELCEN.C lines 833-852
	if ( selfDestructWhiteFlash > 0 ) {

		selfDestructWhiteFlash -= dt;

		const flashAlpha = 1.0 - ( selfDestructWhiteFlash / 4.0 );
		if ( _gauges_set_white_flash !== null ) _gauges_set_white_flash( flashAlpha );

		// Continue ship rocking during white-out
		const camera = _getCamera !== null ? _getCamera() : null;
		if ( camera !== null ) {

			camera.rotation.x += ( Math.random() - 0.5 ) * 0.03;
			camera.rotation.z += ( Math.random() - 0.5 ) * 0.03;

		}

		if ( selfDestructWhiteFlash <= 0 ) {

			selfDestructWhiteFlash = 0;
			if ( _gauges_set_white_flash !== null ) _gauges_set_white_flash( 0 );
			if ( _setPlayerShields !== null ) _setPlayerShields( 0 );
			if ( _updateHUD !== null ) _updateHUD();

			if ( _isPlayerDead !== null && _isPlayerDead() !== true ) {

				if ( _startPlayerDeath !== null ) _startPlayerDeath();

			}

		}

	}

}
