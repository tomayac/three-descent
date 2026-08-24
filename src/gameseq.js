// Ported from: descent-master/MAIN/GAMESEQ.C
// Game sequencing: level flow, player state, object placement, set_externals wiring

import * as THREE from 'three';
import { load_mine_data_compiled_old, load_mine_data_compiled_new } from './gamemine.js';
import { buildMineGeometry, clearRenderCaches, updateDoorMesh, updateEclipTexture, setWallMeshVisible, rebuildSideOverlay, getVisibleSegments, updateMineVisibility, updateDynamicLighting } from './render.js';
import { game_init, game_set_mine, game_set_mine_visible, game_loop, game_set_player_start, game_set_player_dead, game_set_controls_enabled, game_reset_physics, game_sync_player_object, game_set_external_player_pose, game_set_player_pose_driven, game_set_viewer_segnum, game_update_audio_listener_from_player, game_set_transition_suspended, game_get_player_object, getScene, getCamera, getPlayerPos, getPlayerSegnum, setPlayerSegnum, game_set_frame_callback, game_set_pre_ai_frame_callback, game_set_automap, game_set_fusion_externals, game_set_quit_callback, game_set_cockpit_mode_callback, game_set_save_callback, game_set_load_callback, game_set_palette, Missile_gun } from './game.js';
import { load_game_data, get_Gamesave_num_org_robots } from './gamesave.js';
import { Polygon_models, SHAREWARE_MODEL_TABLE, buildModelMesh, buildAnimatedModelMesh,
	polyobj_set_glow, polyobj_set_object_light, compute_engine_glow,
	polyobj_clone_model_mesh, polyobj_set_anim_angles, polyobj_apply_texture_override,
	polyobj_wrap_model_lod, polyobj_update_model_lod,
	polyobj_set_cloak, polyobj_update_cloak_render,
	polyobj_set_object_bitmap_source, polyobj_prewarm_object_effects,
	polyobj_object_bitmap_changed } from './polyobj.js';
import { OBJ_NONE, OBJ_PLAYER, OBJ_ROBOT, OBJ_CNTRLCEN, OBJ_CLUTTER, OBJ_HOSTAGE, OBJ_POWERUP, OBJ_GHOST, RT_POLYOBJ, RT_POWERUP, RT_HOSTAGE,
	CT_AI, MT_PHYSICS, PF_LEVELLING,
	init_objects, obj_set_segments, obj_create, obj_delete, obj_relink,
	CT_NONE, OF_EXPLODING, OF_DESTROYED, OF_SHOULD_BE_DEAD } from './object.js';
import { vm_vector_2_matrix } from './vecmat.js';
import { wall_set_externals, wall_set_render_callback, wall_set_player_callbacks, wall_set_illusion_callback, wall_set_explosion_callback, wall_set_explode_wall_callback, wall_init_door_textures, wall_get_active_door_state, wall_restore_active_door_state, wall_reset, wall_toggle, wall_is_doorway } from './wall.js';
import { collide_set_externals, apply_damage_to_player, collide_player_and_weapon, collide_robot_and_weapon, collide_robot_collision_damage, collide_robot_and_materialization_center, collide_weapon_and_clutter, collide_weapon_and_debris, collide_weapon_and_wall, collide_badass_explosion, collide_player_and_powerup, collide_player_and_nasty_robot, collide_robot_and_player, collide_player_and_controlcen, collide_player_and_clutter, collide_start_robot_explosion, collide_process_robot_explosion, drop_player_eggs, scrape_object_on_wall, POW_EXTRA_LIFE } from './collide.js';
import { init_special_effects, effects_set_externals, effects_set_render_callback, reset_special_effects } from './effects.js';
import { switch_set_externals, Triggers, Num_triggers } from './switch.js';
import { laser_init, laser_set_externals, laser_get_homing_object_dist, laser_get_stuck_flares, laser_get_active_weapons, laser_remap_robot_index, Primary_weapon, Secondary_weapon, set_primary_weapon, set_secondary_weapon, FLARE_ID } from './laser.js';
import { fireball_init, fireball_set_badass_wall_callback, fireball_get_active, fireball_get_debris, object_create_explosion, explosion_copy_physics, explode_model, get_explosion_vclip, debris_cleanup, init_exploding_walls, explode_wall, EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION, VCLIP_PLAYER_HIT, VCLIP_PLAYER_APPEARANCE, VCLIP_MORPHING_ROBOT } from './fireball.js';
import { ai_set_externals, init_robots_for_level, ai_reset_gun_point_cache, ai_reset_anim_cache, AILocalInfo, ai_behavior_to_mode, ai_notify_player_fired_laser, ai_do_cloak_stuff, ai_get_believed_player_pos, ai_get_save_state, ai_restore_save_state, ai_restore_boss_death_save_state } from './ai.js';
import { digi_play_sample, digi_play_sample_world, digi_sync_sounds,
	digi_set_world_distance_resolver, digi_set_object_getter,
	digi_link_sound_to_pos, digi_stop_all_sounds,
	SOUND_CLOAK_OFF, SOUND_INVULNERABILITY_OFF, SOUND_PLAYER_GOT_HIT,
	SOUND_REFUEL_STATION_GIVING_FUEL, SOUND_HOMING_WARNING, SOUND_PLAYER_HIT_WALL,
	SOUND_BADASS_EXPLOSION,
	SOUND_EXPLODING_WALL } from './digi.js';
import { Sounds, Dead_modelnums, ObjBitmaps, Effects, Num_effects, TmapInfos, Vclips, Powerup_info, Player_ship } from './bm.js';
import { autoSelectPrimary as weapon_autoSelectPrimary, autoSelectSecondary as weapon_autoSelectSecondary } from './weapon.js';
import { songs_play_level_song, songs_stop, songs_play_song,
	SONG_TITLE, SONG_ENDLEVEL } from './songs.js';
import { do_briefing_screens, do_end_game, hide_title_canvas, show_title_canvas, get_title_canvas, titles_set_text_filenames } from './titles.js';
import { do_main_menu } from './menu.js';
import { pcx_read, pcx_to_canvas } from './pcx.js';
import { gr_string, gr_get_string_size } from './font.js';
import { SUBTITLE_FONT, GAME_FONT } from './gamefont.js';
import { Segments, Vertices, Num_segments, Highest_segment_index, Side_to_verts, Walls, Num_walls, FrameTime, GameTime, set_GameTime, Automap_visited, Textures, Objects } from './mglobal.js';
import { get_seg_masks, find_point_seg, find_connected_distance, compute_center_point_on_side,
	gameseg_set_connected_distance_doorway } from './gameseg.js';
import { automap_set_player_start } from './automap.js';
import { fuelcen_init, fuelcen_reset, fuelcen_set_externals, fuelcen_frame_process,
	fuelcen_get_save_state, fuelcen_restore_save_state,
	SEGMENT_IS_FUELCEN } from './fuelcen.js';
import { cntrlcen_set_externals, cntrlcen_set_reactor, init_controlcen_for_level, startSelfDestruct,
	cntrlcen_is_self_destruct_active, cntrlcen_is_destroyed,
	cntrlcen_get_self_destruct_timer, cntrlcen_get_save_state, cntrlcen_restore_save_state,
	cntrlcen_reset,
	do_controlcen_frame, do_controlcen_destroyed_frame } from './cntrlcen.js';
import { Robot_info, N_robot_types, AIS_REST, AIS_SRCH } from './robot.js';
import { do_morph_frame, start_robot_morph, finish_robot_morphs_for_save } from './morph.js';
import { create_n_segment_path, aipath_snapshot_robot_path,
	aipath_restore_robot_path } from './aipath.js';
import { gauges_init, gauges_update, gauges_flash_damage, gauges_set_white_flash, gauges_draw, gauges_set_externals, gauges_add_score_points, gauges_set_cockpit_mode, gauges_set_countdown_seconds } from './gauges.js';
import { hud_show_message } from './hud.js';
import { powerup_set_externals, powerup_place, powerup_place_hostage, powerup_do_frame, powerup_cleanup, powerup_get_live, spawnDroppedPowerup, buildSpriteTexture } from './powerup.js';
import { hostage_get_in_level, hostage_get_level_saved, hostage_get_total_saved,
	hostage_add_in_level, hostage_add_level_saved, hostage_add_total_saved,
	hostage_reset_level, hostage_reset_all } from './hostage.js';
import { physics_set_wall_hit_callback, physics_set_object_hit_callback, getPlayerVelocity, do_physics_move } from './physics.js';
import { find_vector_intersection, HIT_NONE } from './fvi.js';
import { lighting_init, lighting_frame, lighting_cleanup, set_dynamic_light, get_dynamic_light, lighting_set_externals, compute_object_light } from './lighting.js';
import { endlevel_set_externals, endlevel_is_active, endlevel_get_viewer_segnum, load_endlevel_data, prepare_endlevel_scene, start_endlevel_sequence, do_endlevel_frame, stop_endlevel_sequence } from './endlevel.js';
import { mission_init, mission_get_last_level, mission_get_level_name, mission_is_final_level, mission_compute_next_level, mission_get_briefing_filename, mission_get_ending_filename } from './mission.js';

// External references (injected from main.js)
let _hogFile = null;
let _pigFile = null;
let _palette = null;
let _setStatus = null;

export function gameseq_set_externals( ext ) {

	if ( ext.hogFile !== undefined ) _hogFile = ext.hogFile;
	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.setStatus !== undefined ) _setStatus = ext.setStatus;

	if ( _pigFile !== null && _palette !== null ) {

		polyobj_set_object_bitmap_source( ObjBitmaps, _pigFile, _palette );
		polyobj_prewarm_object_effects( Effects, Num_effects );

	}

	if ( _hogFile !== null && _pigFile !== null ) {

		mission_init( _hogFile, _pigFile.isShareware === true );
		titles_set_text_filenames( mission_get_briefing_filename(), mission_get_ending_filename() );

	}

}

function setStatus( msg ) {

	if ( _setStatus !== null ) _setStatus( msg );

}

// --- Tracked robots for collision detection by weapon system ---
const liveRobots = [];

// Polygon clutter participates in weapon collisions but never in robot AI.
const liveClutter = [];

// Every gameplay RT_POLYOBJ needs per-object light, including clutter which is
// intentionally absent from the robot collision/AI list.
const livePolygonObjects = [];

function getSoundObject( objnum ) {

	if ( Number.isInteger( objnum ) !== true || objnum < 0 || objnum >= Objects.length ) return null;
	const obj = Objects[ objnum ];
	if ( obj === undefined || obj === null || obj.type === OBJ_NONE ||
		( obj.flags & OF_SHOULD_BE_DEAD ) !== 0 ) return null;
	return obj;

}

// Go through this level and start the looping sounds attached to animated wall
// overlays.  Ported from set_sound_sources() in GAMESEQ.C lines 722-744.
export function set_sound_sources() {

	// D1 begins every level by clearing the prior level's linked sound objects.
	digi_stop_all_sounds();

	// Linking computes the initial volume and pan immediately.  Refresh from the
	// newly loaded canonical player so no source starts against a stale listener.
	if ( game_update_audio_listener_from_player() !== true ) return 0;

	let linked = 0;

	for ( let segnum = 0; segnum < Num_segments; segnum ++ ) {

		const seg = Segments[ segnum ];

		for ( let sidenum = 0; sidenum < seg.sides.length; sidenum ++ ) {

			const tm = seg.sides[ sidenum ].tmap_num2;
			if ( tm === 0 ) continue;

			const tmapIndex = tm & 0x3FFF;
			const tmapInfo = TmapInfos[ tmapIndex ];
			if ( tmapInfo === undefined ) continue;

			const effectNum = tmapInfo.eclip_num;
			if ( Number.isInteger( effectNum ) !== true || effectNum < 0 ||
				effectNum >= Num_effects ) continue;

			const soundnum = Effects[ effectNum ].sound_num;
			if ( Number.isInteger( soundnum ) !== true || soundnum < 0 ) continue;

			// compute_center_point_on_side() returns shared scratch storage.  Copy
			// its scalars before the next side can overwrite it.
			const center = compute_center_point_on_side( segnum, sidenum );
			const pos_x = center.x;
			const pos_y = center.y;
			const pos_z = center.z;

			if ( digi_link_sound_to_pos(
				soundnum, segnum, sidenum, pos_x, pos_y, pos_z, true, 0.5
			) !== - 1 ) linked ++;

		}

	}

	return linked;

}

// --- Player state ---
let playerShields = 100;
let playerEnergy = 100;

// Cloak and invulnerability timers (0 = inactive)
// Ported from: Players[].cloak_time and Players[].invulnerable_time in PLAYER.H
const CLOAK_TIME_MAX = 30.0;		// 30 seconds (F1_0*30 in original)
const INVULNERABLE_TIME_MAX = 30.0;
let playerCloakTime = 0;		// time remaining, 0 = not cloaked
let playerInvulnerableTime = 0;	// time remaining, 0 = not invulnerable

// Player death/respawn state
const DEATH_SEQUENCE_EXPLODE_TIME = 2.0;
const DEATH_CAMERA_MAX_DISTANCE = 20.0;
const DEATH_CAMERA_RETREAT_RATE = 8.0;
const FULL_TURN_RADIANS = Math.PI * 2;
let playerDead = false;
let deathElapsed = 0;
let deathExploded = false;
let deathInputArmed = false;
let deathSequenceAborted = false;
let deathPlayerEntry = null;
let deathPlayerObject = null;
let deathPlayerOriginalType = - 1;
let deathBaseModelNum = - 1;
let deathPlayerX = 0;
let deathPlayerY = 0;
let deathPlayerZ = 0;
let deathPlayerSegnum = - 1;
let deathCameraSegnum = - 1;
let deathPlayerSize = 4.0;
let deathRotPitch = 0;
let deathRotHeading = 0;
let deathRotBank = 0;
const deathPlayerQuaternion = new THREE.Quaternion();
const deathPlayerMatrix = new THREE.Matrix4();
const deathStepEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
const deathStepQuaternion = new THREE.Quaternion();
const deathRandomVector = new THREE.Vector3();
const deathLookTarget = new THREE.Vector3();
let savedPlayerStart = null;
let savedPlayerObjnum = - 1;
let _pendingSaveRestore = null;	// save data set by loadGame, applied after level loads

// Level tracking (shareware: levels 1-7)
let currentLevelNum = 1;
let currentLevelName = '';
let levelTransitioning = false;
let gameInitialized = false;
let soundInitialized = false;
let _lastLevelLoadSucceeded = false;

// Difficulty level: 0=Trainee, 1=Rookie, 2=Hotshot, 3=Ace, 4=Insane
// Ported from: GAME.H (#define NDL 5, Difficulty_level 0..NDL-1)
let Difficulty_level = 1;	// default: Rookie

// Player inventory
let playerKeys = { blue: false, red: false, gold: false };
let playerPrimaryFlags = 1;	// bit 0 = laser (always have)
let playerSecondaryFlags = 1;	// bit 0 = concussion (start with it)
const playerSecondaryAmmo = [ 3, 0, 0, 0, 0 ];	// concussion, homing, proximity, smart, mega
let playerVulcanAmmo = 0;
let playerLaserLevel = 0;	// 0-3 (4 levels)
let playerQuadLasers = false;	// Ported from: PLAYER.H PLAYER_FLAGS_QUAD_LASERS
let playerLives = 3;
let playerScore = 0;
let playerLastScore = 0;	// Score at level start (for skill points calculation)
let playerKills = 0;

// --- Getters for external access ---
export function gameseq_get_difficulty() { return Difficulty_level; }
export function gameseq_set_difficulty( d ) { Difficulty_level = d; }
export function gameseq_get_secondary_ammo() { return playerSecondaryAmmo; }
export function gameseq_get_sound_initialized() { return soundInitialized; }
export function gameseq_set_sound_initialized( v ) { soundInitialized = v; }
export function gameseq_get_current_level() { return currentLevelNum; }

// --- HUD wrappers ---
function updateHUD() {

	gauges_update( {
		shields: playerShields,
		energy: playerEnergy,
		primaryWeapon: Primary_weapon,
		secondaryWeapon: Secondary_weapon,
		missileGun: Missile_gun,
		laserLevel: playerLaserLevel,
		vulcanAmmo: playerVulcanAmmo,
		secondaryAmmo: playerSecondaryAmmo,
		quadLasers: playerQuadLasers,
		keysBlue: playerKeys.blue,
		keysRed: playerKeys.red,
		keysGold: playerKeys.gold,
		score: playerScore,
		lives: playerLives,
		homingObjectDist: laser_get_homing_object_dist(),
		gameTime: GameTime,
		playerDead: playerDead,
		playerExploded: playerDead,
		cloakTimeRemaining: playerCloakTime,
		invulnerableTimeRemaining: playerInvulnerableTime
	} );

}

function flashDamage( color ) {

	gauges_flash_damage( color );

}

function showMessage( msg ) {

	hud_show_message( msg );

}

// --- Cloak/Invulnerability helpers ---
// Ported from: PLAYER.H PLAYER_FLAGS_CLOAKED / PLAYER_FLAGS_INVULNERABLE

function isPlayerCloaked() {

	return playerCloakTime > 0;

}

function isPlayerInvulnerable() {

	return playerInvulnerableTime > 0;

}

function activateCloak() {

	playerCloakTime = CLOAK_TIME_MAX;
	showMessage( 'CLOAK ON!' );

	// Initialize AI cloak tracking to current player position
	// Ported from: ai_do_cloak_stuff() in AI.C lines 3549-3560
	ai_do_cloak_stuff();

}

function updatePlayerCloakTimer( dt ) {

	if ( playerCloakTime <= 0 ) return;
	playerCloakTime -= dt;

	if ( playerCloakTime <= 3.0 && playerCloakTime + dt > 3.0 ) {

		showMessage( 'CLOAK WEARING OFF...' );

	}

	if ( playerCloakTime <= 0 ) {

		playerCloakTime = 0;
		digi_play_sample( SOUND_CLOAK_OFF, 1.0 );
		showMessage( 'CLOAK OFF!' );

	}

}

function updatePlayerCloakRender( mesh, dt ) {

	if ( mesh === null || mesh === undefined ) return;
	if ( playerCloakTime <= 0 ) {

		polyobj_set_cloak( mesh, 0, 1, 33 );
		return;

	}

	polyobj_update_cloak_render(
		mesh,
		Math.max( 0, CLOAK_TIME_MAX - playerCloakTime ),
		CLOAK_TIME_MAX,
		2.0,
		dt
	);

}

function activateInvulnerability() {

	playerInvulnerableTime = INVULNERABLE_TIME_MAX;
	showMessage( 'INVULNERABILITY ON!' );

}

// --- High score persistence (localStorage) ---
// Ported from: SCORES.C — high score table
const HIGH_SCORE_KEY = 'descent_high_scores';
const MAX_HIGH_SCORES = 10;

function getHighScores() {

	try {

		const data = localStorage.getItem( HIGH_SCORE_KEY );
		if ( data !== null ) return JSON.parse( data );

	} catch ( e ) { /* ignore */ }

	return [];

}

function saveHighScore( score, kills, hostages, difficulty ) {

	const scores = getHighScores();

	scores.push( { score: score, kills: kills, hostages: hostages, difficulty: difficulty, date: Date.now() } );
	scores.sort( function ( a, b ) { return b.score - a.score; } );

	if ( scores.length > MAX_HIGH_SCORES ) scores.length = MAX_HIGH_SCORES;

	try {

		localStorage.setItem( HIGH_SCORE_KEY, JSON.stringify( scores ) );

	} catch ( e ) { /* ignore */ }

	return scores;

}

function getHighestScore() {

	const scores = getHighScores();
	if ( scores.length === 0 ) return 0;
	return scores[ 0 ].score;

}

// --- Save / Load game ---
// Ported from: GAMESAVE.C save/restore functionality
// Uses localStorage for checkpoint-style saves (saves player state + current level)
const SAVE_KEY = 'descent_savegame';

function snapshotJointAngles( angles ) {

	if ( Array.isArray( angles ) !== true ) return null;
	const snapshot = new Array( angles.length );

	for ( let i = 0; i < angles.length; i ++ ) {

		const angle = angles[ i ];
		snapshot[ i ] = [ angle.p, angle.b, angle.h ];

	}

	return snapshot;

}

function restoreJointAngles( angles, snapshot ) {

	if ( Array.isArray( angles ) !== true || Array.isArray( snapshot ) !== true ) return;
	const count = Math.min( angles.length, snapshot.length );

	for ( let i = 0; i < count; i ++ ) {

		const saved = snapshot[ i ];
		if ( Array.isArray( saved ) !== true || saved.length < 3 ) continue;
		if ( Number.isFinite( saved[ 0 ] ) ) angles[ i ].p = saved[ 0 ];
		if ( Number.isFinite( saved[ 1 ] ) ) angles[ i ].b = saved[ 1 ];
		if ( Number.isFinite( saved[ 2 ] ) ) angles[ i ].h = saved[ 2 ];

	}

}

function snapshotRobotAnimation( robot ) {

	const ailp = robot.aiLocal;
	if ( ailp === undefined || ailp === null ) return null;

	return {
		currentState: ailp.current_state,
		goalState: ailp.goal_state,
		goalAngles: snapshotJointAngles( ailp.goal_angles ),
		deltaAngles: snapshotJointAngles( ailp.delta_angles ),
		achievedStates: Array.from( ailp.anim_achieved_state ),
		goalStates: Array.from( ailp.anim_goal_state )
	};

}

function restoreRobotAnimation( robot, snapshot ) {

	const ailp = robot.aiLocal;
	if ( ailp === undefined || ailp === null || snapshot === null ||
		typeof snapshot !== 'object' ) return;

	// AIS_* values occupy 0..7.  Reject malformed localStorage values rather
	// than letting typed-array coercion or invalid transition-table indices leak.
	if ( Number.isInteger( snapshot.currentState ) && snapshot.currentState >= 0 &&
		snapshot.currentState <= 7 ) ailp.current_state = snapshot.currentState;
	if ( Number.isInteger( snapshot.goalState ) && snapshot.goalState >= 0 &&
		snapshot.goalState <= 7 ) ailp.goal_state = snapshot.goalState;

	restoreJointAngles( ailp.goal_angles, snapshot.goalAngles );
	restoreJointAngles( ailp.delta_angles, snapshot.deltaAngles );

	if ( Array.isArray( snapshot.achievedStates ) ) {

		const count = Math.min( ailp.anim_achieved_state.length, snapshot.achievedStates.length );
		for ( let i = 0; i < count; i ++ ) {

			const state = snapshot.achievedStates[ i ];
			if ( Number.isInteger( state ) && state >= 0 && state <= 7 ) {

				ailp.anim_achieved_state[ i ] = state;

			}

		}

	}

	if ( Array.isArray( snapshot.goalStates ) ) {

		const count = Math.min( ailp.anim_goal_state.length, snapshot.goalStates.length );
		for ( let i = 0; i < count; i ++ ) {

			const state = snapshot.goalStates[ i ];
			if ( Number.isInteger( state ) && state >= 0 && state <= 7 ) {

				ailp.anim_goal_state[ i ] = state;

			}

		}

	}

	if ( robot.obj.ctype !== null && robot.obj.ctype !== undefined &&
		robot.obj.ctype.flags !== undefined ) {

		robot.obj.ctype.flags[ 1 ] = ailp.current_state;
		robot.obj.ctype.flags[ 2 ] = ailp.goal_state;

	}

}

function snapshotRobotAIState( robot ) {

	const ailp = robot.aiLocal;
	if ( ailp === undefined || ailp === null ) return null;

	return {
		mode: ailp.mode,
		playerAwarenessType: ailp.player_awareness_type,
		playerAwarenessTime: ailp.player_awareness_time,
		previousVisibility: ailp.previous_visibility,
		nextFire: ailp.next_fire,
		rapidfireCount: ailp.rapidfire_count,
		timePlayerSeen: ailp.time_player_seen,
		timePlayerSoundAttacked: ailp.time_player_sound_attacked,
		nextMiscSoundTime: ailp.next_misc_sound_time,
		skipAICount: ailp.skip_ai_count,
		goalSegment: ailp.goal_segment,
		pathRegenTimer: ailp.path_regen_timer,
		bumpCooldown: ailp.bump_cooldown,
		currentGun: ailp.current_gun,
		hideSegment: ailp.hide_segment,
		behavior: ailp.behavior,
		modeIsRunFrom: ailp.mode_is_run_from,
		submode: ailp.submode,
		needsNewPath: ailp.needs_new_path,
		rotvelX: ailp.rotvel_x,
		rotvelY: ailp.rotvel_y,
		rotvelZ: ailp.rotvel_z,
		goalSide: ailp.goal_side,
		prevMode: ailp.prev_mode,
		consecutiveRetries: ailp.consecutive_retries,
		bombDropTimer: ailp.bomb_drop_timer,
		path: aipath_snapshot_robot_path( ailp )
	};

}

function restoreRobotAIInteger( ailp, snapshot, savedName, fieldName, min, max ) {

	const value = snapshot[ savedName ];
	if ( Number.isInteger( value ) === true && value >= min && value <= max ) {

		ailp[ fieldName ] = value;

	}

}

function restoreRobotAIFinite( ailp, snapshot, savedName, fieldName ) {

	const value = snapshot[ savedName ];
	if ( Number.isFinite( value ) === true ) ailp[ fieldName ] = value;

}

function restoreRobotAIState( robot, snapshot ) {

	const ailp = robot.aiLocal;
	if ( ailp === undefined || ailp === null || snapshot === null ||
		typeof snapshot !== 'object' ) return;

	restoreRobotAIInteger( ailp, snapshot, 'mode', 'mode', 0, 7 );
	restoreRobotAIInteger( ailp, snapshot, 'playerAwarenessType', 'player_awareness_type', 0, 4 );
	restoreRobotAIInteger( ailp, snapshot, 'previousVisibility', 'previous_visibility', 0, 2 );
	restoreRobotAIInteger( ailp, snapshot, 'rapidfireCount', 'rapidfire_count', 0, 255 );
	restoreRobotAIInteger( ailp, snapshot, 'skipAICount', 'skip_ai_count', 0, 255 );
	restoreRobotAIInteger( ailp, snapshot, 'currentGun', 'current_gun', 0, 255 );
	restoreRobotAIInteger( ailp, snapshot, 'behavior', 'behavior', 0x80, 0x85 );
	restoreRobotAIInteger( ailp, snapshot, 'submode', 'submode', 0, 1 );
	restoreRobotAIInteger( ailp, snapshot, 'goalSide', 'goal_side', - 1, 5 );
	restoreRobotAIInteger( ailp, snapshot, 'prevMode', 'prev_mode', 0, 7 );
	restoreRobotAIInteger( ailp, snapshot, 'consecutiveRetries', 'consecutive_retries', 0, 0x7fff );
	restoreRobotAIInteger( ailp, snapshot, 'goalSegment', 'goal_segment', - 1, Highest_segment_index );
	restoreRobotAIInteger( ailp, snapshot, 'hideSegment', 'hide_segment', - 1, Highest_segment_index );

	restoreRobotAIFinite( ailp, snapshot, 'playerAwarenessTime', 'player_awareness_time' );
	restoreRobotAIFinite( ailp, snapshot, 'nextFire', 'next_fire' );
	restoreRobotAIFinite( ailp, snapshot, 'timePlayerSeen', 'time_player_seen' );
	restoreRobotAIFinite( ailp, snapshot, 'timePlayerSoundAttacked', 'time_player_sound_attacked' );
	restoreRobotAIFinite( ailp, snapshot, 'nextMiscSoundTime', 'next_misc_sound_time' );
	restoreRobotAIFinite( ailp, snapshot, 'pathRegenTimer', 'path_regen_timer' );
	restoreRobotAIFinite( ailp, snapshot, 'bumpCooldown', 'bump_cooldown' );
	restoreRobotAIFinite( ailp, snapshot, 'rotvelX', 'rotvel_x' );
	restoreRobotAIFinite( ailp, snapshot, 'rotvelY', 'rotvel_y' );
	restoreRobotAIFinite( ailp, snapshot, 'rotvelZ', 'rotvel_z' );
	restoreRobotAIFinite( ailp, snapshot, 'bombDropTimer', 'bomb_drop_timer' );

	if ( typeof snapshot.modeIsRunFrom === 'boolean' ) {

		ailp.mode_is_run_from = snapshot.modeIsRunFrom;

	}
	if ( typeof snapshot.needsNewPath === 'boolean' ) {

		ailp.needs_new_path = snapshot.needsNewPath;

	}

	if ( Object.prototype.hasOwnProperty.call( snapshot, 'path' ) ) {

		aipath_restore_robot_path( ailp, snapshot.path );

	}

	// Active weapon objects are not currently serialized by this port.  Never
	// restore D1's raw danger_laser slot/signature into the rebuilt weapon pool.
	ailp.danger_laser_idx = - 1;
	ailp.danger_laser_id = - 1;

	if ( robot.obj.ctype !== null && robot.obj.ctype !== undefined ) {

		robot.obj.ctype.behavior = ailp.behavior;

	}

}

const _robotRestoreMatrix = new THREE.Matrix4();

function syncRobotMeshOrientation( robot ) {

	if ( robot.mesh === null || robot.mesh === undefined ) return;
	const obj = robot.obj;
	_robotRestoreMatrix.set(
		obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
		obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
		- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
		0, 0, 0, 1
	);
	robot.mesh.quaternion.setFromRotationMatrix( _robotRestoreMatrix ).normalize();

}

function saveGame() {

	const pp = getPlayerPos();
	if ( pp === null ) return false;
	finish_robot_morphs_for_save( liveRobots );

	const cam = getCamera();
	const levelPowerups = powerup_get_live();
	const levelRobotState = [];
	const levelClutterState = [];
	const levelPowerupState = [];
	const droppedPowerups = [];
	const levelWallState = [];
	const levelTriggerState = [];

	for ( let i = 0; i < liveRobots.length; i ++ ) {

		const robot = liveRobots[ i ];
		const phys = robot.obj.mtype;
		const velocity = robot.aiLocal !== undefined && robot.aiLocal !== null
			? robot.aiLocal : phys;
		levelRobotState.push( {
			objnum: robot.objnum,
			runtimeSpawned: robot.runtimeSpawned === true,
			robotType: robot.obj.id,
			matcenCreator: robot.obj.matcen_creator,
			alive: robot.alive === true,
			shields: robot.obj.shields,
			flags: robot.obj.flags,
			model_num: robot.obj.rtype !== null && robot.obj.rtype !== undefined
				? robot.obj.rtype.model_num : - 1,
			pos_x: robot.obj.pos_x,
			pos_y: robot.obj.pos_y,
			pos_z: robot.obj.pos_z,
			segnum: robot.obj.segnum,
			orientation: {
				rvec_x: robot.obj.orient_rvec_x,
				rvec_y: robot.obj.orient_rvec_y,
				rvec_z: robot.obj.orient_rvec_z,
				uvec_x: robot.obj.orient_uvec_x,
				uvec_y: robot.obj.orient_uvec_y,
				uvec_z: robot.obj.orient_uvec_z,
				fvec_x: robot.obj.orient_fvec_x,
				fvec_y: robot.obj.orient_fvec_y,
				fvec_z: robot.obj.orient_fvec_z
			},
			physics: phys !== null && phys !== undefined ? {
				velocity_x: velocity !== null && velocity !== undefined ? velocity.vel_x ?? velocity.velocity_x : 0,
				velocity_y: velocity !== null && velocity !== undefined ? velocity.vel_y ?? velocity.velocity_y : 0,
				velocity_z: velocity !== null && velocity !== undefined ? velocity.vel_z ?? velocity.velocity_z : 0,
				thrust_x: phys.thrust_x,
				thrust_y: phys.thrust_y,
				thrust_z: phys.thrust_z,
				rotvel_x: phys.rotvel_x,
				rotvel_y: phys.rotvel_y,
				rotvel_z: phys.rotvel_z,
				rotthrust_x: phys.rotthrust_x,
				rotthrust_y: phys.rotthrust_y,
				rotthrust_z: phys.rotthrust_z,
				turnroll: phys.turnroll,
				flags: phys.flags
			} : null,
			explosionDelay: robot.explosionDelay,
			explosionDeleteDelay: robot.explosionDeleteDelay,
			animAngles: robot.obj.rtype !== null && robot.obj.rtype !== undefined
				? snapshotJointAngles( robot.obj.rtype.anim_angles ) : null,
			aiLocal: snapshotRobotAIState( robot ),
			aiAnimation: snapshotRobotAnimation( robot )
		} );

	}

	for ( let i = 0; i < liveClutter.length; i ++ ) {

		const clutter = liveClutter[ i ];
		levelClutterState.push( {
			objnum: clutter.objnum,
			alive: clutter.alive === true,
			shields: clutter.obj.shields,
			flags: clutter.obj.flags,
			model_num: clutter.obj.rtype !== null ? clutter.obj.rtype.model_num : - 1,
			explosionDelay: clutter.explosionDelay,
			deleteDelay: clutter.deleteDelay
		} );

	}

	for ( let i = 0; i < levelPowerups.length; i ++ ) {

		const pw = levelPowerups[ i ];

		// Dropped powerups are not part of the base level object list; persist full spawn data.
		if ( pw.dropped === true ) {

			if ( pw.alive === true ) {

				droppedPowerups.push( {
					id: pw.obj.id,
					pos_x: pw.obj.pos_x,
					pos_y: pw.obj.pos_y,
					pos_z: pw.obj.pos_z,
					segnum: pw.obj.segnum,
					lifeleft: pw.obj.lifeleft
				} );

			}

			continue;

		}

		levelPowerupState.push( pw.alive === true );

	}

	for ( let i = 0; i < Num_walls; i ++ ) {

		const w = Walls[ i ];
		if ( w === undefined || w === null ) continue;

		levelWallState.push( {
			index: i,
			hps: w.hps,
			flags: w.flags,
			state: w.state,
			tmap_num: Segments[ w.segnum ].sides[ w.sidenum ].tmap_num,
			tmap_num2: Segments[ w.segnum ].sides[ w.sidenum ].tmap_num2
		} );

	}

	for ( let i = 0; i < Num_triggers; i ++ ) {

		const t = Triggers[ i ];
		if ( t === undefined || t === null ) continue;

		levelTriggerState.push( {
			index: i,
			flags: t.flags,
			time: t.time
		} );

	}

	const saveData = {
		version: 2,
		level: currentLevelNum,
		// D1 STATE.C persists GameTime because AI, weapon, lighting, and sound
		// cooldowns store absolute timestamps in this clock.
		gameTime: GameTime,
		shields: playerShields,
		energy: playerEnergy,
		primaryFlags: playerPrimaryFlags,
		secondaryFlags: playerSecondaryFlags,
		secondaryAmmo: [ playerSecondaryAmmo[ 0 ], playerSecondaryAmmo[ 1 ], playerSecondaryAmmo[ 2 ], playerSecondaryAmmo[ 3 ], playerSecondaryAmmo[ 4 ] ],
		vulcanAmmo: playerVulcanAmmo,
		laserLevel: playerLaserLevel,
		quadLasers: playerQuadLasers,
		lives: playerLives,
		score: playerScore,
		kills: playerKills,
		primaryWeapon: Primary_weapon,
		secondaryWeapon: Secondary_weapon,
		keys: { blue: playerKeys.blue, red: playerKeys.red, gold: playerKeys.gold },
		cloakTime: playerCloakTime,
		invulnerableTime: playerInvulnerableTime,
		pos: { x: pp.x, y: pp.y, z: pp.z },
		playerSegnum: getPlayerSegnum(),
		quat: cam !== null ? { x: cam.quaternion.x, y: cam.quaternion.y, z: cam.quaternion.z, w: cam.quaternion.w } : null,
		difficulty: Difficulty_level,
		hostagesSaved: hostage_get_total_saved(),
		hostagesLevelSaved: hostage_get_level_saved(),
		levelState: {
			automapVisited: Array.from( Automap_visited.subarray( 0, Num_segments ) ),
			fuelCenters: fuelcen_get_save_state(),
			robots: levelRobotState,
			clutter: levelClutterState,
			powerups: levelPowerupState,
			droppedPowerups: droppedPowerups,
			walls: levelWallState,
			activeDoors: wall_get_active_door_state(),
			triggers: levelTriggerState,
			controlCenter: cntrlcen_get_save_state(),
			ai: ai_get_save_state()
		}
	};

	try {

		localStorage.setItem( SAVE_KEY, JSON.stringify( saveData ) );
		console.log( 'SAVE: Game saved at level ' + currentLevelNum );
		return true;

	} catch ( e ) {

		console.error( 'SAVE: Failed to save game:', e );
		return false;

	}

}

function loadGame() {

	try {

		const json = localStorage.getItem( SAVE_KEY );
		if ( json === null ) return false;

		const saveData = JSON.parse( json );
		if ( saveData.version !== 1 && saveData.version !== 2 ) return false;

		console.log( 'LOAD: Loading saved game from level ' + saveData.level );

		// Set difficulty before level load (affects robot spawns, etc.)
		Difficulty_level = saveData.difficulty !== undefined ? saveData.difficulty : 1;

		// Store full save data for deferred restoration after advanceLevel() resets
		// (advanceLevel() overwrites shields/energy/keys during its init phase)
		_pendingSaveRestore = saveData;

		// Restore the saved clock before rebuilding the level.  Constructors for
		// AI and other timed systems seed absolute timestamps from GameTime, so
		// applying it later would leave them based on the abandoned session clock.
		// Older v1/v2 saves omit this optional field and retain the previous port
		// behavior.
		if ( Number.isFinite( saveData.gameTime ) === true && saveData.gameTime >= 0 ) {

			set_GameTime( saveData.gameTime );

		}

		// Navigate to saved level
		currentLevelNum = saveData.level;
		beginGameplayTeardown();
		_lastLevelLoadSucceeded = false;
		const advancePromise = advanceLevel();
		advancePromise.catch( e => console.error( 'LOAD: Failed to load game:', e ) );

		// Save loads skip briefing awaits, so advanceLevel reaches loadLevelData
		// synchronously.  Only dismiss the pause UI after that final boundary.
		if ( _lastLevelLoadSucceeded !== true ) {

			// Do not let a later restart treat a failed payload as a pending restore.
			_pendingSaveRestore = null;
			return false;

		}

		return true;

	} catch ( e ) {

		_pendingSaveRestore = null;
		console.error( 'LOAD: Failed to load game:', e );
		return false;

	}

}

// --- Score / extra lives ---
// Ported from: add_points_to_score() in GAUGES.C lines 1179-1219
const EXTRA_SHIP_SCORE = 50000;

function playExtraLifeSound() {

	const extraLife = Powerup_info[ POW_EXTRA_LIFE ];
	if ( extraLife !== undefined && extraLife.hit_sound >= 0 ) {

		digi_play_sample( extraLife.hit_sound, 1.0 );

	}

}

function addPlayerScore( points ) {

	const prevScore = playerScore;
	playerScore += points;
	gauges_add_score_points( points );

	// Award extra lives every 50,000 points
	const prevShips = Math.floor( prevScore / EXTRA_SHIP_SCORE );
	const newShips = Math.floor( playerScore / EXTRA_SHIP_SCORE );

	if ( newShips > prevShips ) {

		playerLives += ( newShips - prevShips );
		showMessage( 'EXTRA LIFE!' );
		playExtraLifeSound();

	}

	updateHUD();

}

// Ported from: add_bonus_points_to_score() in GAUGES.C:1221 — add end-of-level bonus points
// and grant an extra ship for each EXTRA_SHIP_SCORE (50,000) boundary crossed. Unlike
// add_points_to_score() there is no on-screen score popup for bonus points.
function addBonusPointsToScore( points ) {

	if ( points === 0 ) return;

	const prevScore = playerScore;
	playerScore += points;

	if ( Math.floor( playerScore / EXTRA_SHIP_SCORE ) !== Math.floor( prevScore / EXTRA_SHIP_SCORE ) ) {

		playerLives += Math.floor( playerScore / EXTRA_SHIP_SCORE ) - Math.floor( prevScore / EXTRA_SHIP_SCORE );
		showMessage( 'EXTRA LIFE!' );
		playExtraLifeSound();

	}

}

// --- Auto-select wrappers ---
function setPrimaryWeaponWithFeedback( weapon ) {

	return set_primary_weapon( weapon, true );

}

function setSecondaryWeaponWithFeedback( weapon ) {

	return set_secondary_weapon( weapon, true );

}

function autoSelectPrimary() {

	weapon_autoSelectPrimary( playerPrimaryFlags, playerVulcanAmmo, playerEnergy,
		setPrimaryWeaponWithFeedback, showMessage, updateHUD );

}

function autoSelectSecondary() {

	weapon_autoSelectSecondary( Secondary_weapon, playerSecondaryAmmo,
		setSecondaryWeaponWithFeedback, showMessage, updateHUD );

}

// --- Player death sequence ---
// Ported from: start_player_death_sequence(), dead_player_frame(), and
// set_camera_pos() in OBJECT.C.
function deathQuickMagnitude( x, y, z ) {

	let largest = Math.abs( x );
	let middle = Math.abs( y );
	let smallest = Math.abs( z );
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	if ( middle < smallest ) { const t = middle; middle = smallest; smallest = t; }
	if ( largest < middle ) { const t = largest; largest = middle; middle = t; }
	return largest + middle * 3 / 8 + smallest * 3 / 16;

}

function cleanupPlayerDeathVisual() {

	document.removeEventListener( 'keydown', abortPlayerDeathSequence );
	document.removeEventListener( 'mousedown', abortPlayerDeathSequence );
	document.removeEventListener( 'touchstart', abortPlayerDeathSequence );

	if ( deathPlayerEntry !== null ) {

		const liveIndex = livePolygonObjects.indexOf( deathPlayerEntry );
		if ( liveIndex >= 0 ) livePolygonObjects.splice( liveIndex, 1 );
		if ( deathPlayerEntry.mesh !== null && deathPlayerEntry.mesh.parent !== null ) {

			deathPlayerEntry.mesh.parent.remove( deathPlayerEntry.mesh );

		}

	}
	if ( deathPlayerObject !== null && deathPlayerObject.rtype !== null ) {

		if ( deathBaseModelNum >= 0 ) deathPlayerObject.rtype.model_num = deathBaseModelNum;
		deathPlayerObject.rtype.subobj_flags = 0;

	}
	if ( deathPlayerObject !== null && deathPlayerOriginalType >= 0 ) {

		deathPlayerObject.type = deathPlayerOriginalType;

	}
	deathPlayerEntry = null;
	deathPlayerObject = null;
	deathPlayerOriginalType = - 1;
	deathBaseModelNum = - 1;
	deathExploded = false;
	deathInputArmed = false;
	deathSequenceAborted = false;
	game_set_player_pose_driven( false );
	game_set_viewer_segnum( - 1 );

}

function abortPlayerDeathSequence() {

	if ( deathInputArmed === true ) deathSequenceAborted = true;

}

function buildPlayerDeathVisual() {

	let modelNum = Player_ship.loaded === true ? Player_ship.model_num : - 1;
	if ( modelNum < 0 && deathPlayerObject !== null && deathPlayerObject.rtype !== null ) {

		modelNum = deathPlayerObject.rtype.model_num;

	}
	if ( modelNum < 0 || modelNum >= Polygon_models.length ) return;
	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return;
	if ( model.mesh === null ) model.mesh = buildModelMesh( model, _pigFile, _palette );
	if ( model.mesh === null ) return;

	let mesh = polyobj_clone_model_mesh( model.mesh );
	mesh = polyobj_wrap_model_lod( mesh, model, _pigFile, _palette );
	mesh.name = 'player-death-ship';
	mesh.userData.playerDeathShip = true;
	mesh.position.set( deathPlayerX, deathPlayerY, - deathPlayerZ );
	mesh.quaternion.copy( deathPlayerQuaternion );
	polyobj_set_object_light( mesh, 1, 1, 1 );
	polyobj_set_glow( mesh, 0.2 );
	updatePlayerCloakRender( mesh, 0 );
	getScene().add( mesh );

	deathBaseModelNum = modelNum;
	if ( deathPlayerObject !== null && deathPlayerObject.rtype !== null ) {

		deathPlayerObject.rtype.model_num = modelNum;
		deathPlayerObject.rtype.subobj_flags = 0;

	}
	deathPlayerEntry = {
		obj: deathPlayerObject,
		mesh: mesh,
		submodelGroups: null,
		signature: deathPlayerObject !== null ? deathPlayerObject.signature : 0,
		morphing: false,
		reclaimed: false
	};
	if ( deathPlayerObject !== null ) livePolygonObjects.push( deathPlayerEntry );

}

function setPlayerDeathCamera( camera ) {

	let cameraX = camera.position.x;
	let cameraY = camera.position.y;
	let cameraZ = - camera.position.z;
	let deltaX = cameraX - deathPlayerX;
	let deltaY = cameraY - deathPlayerY;
	let deltaZ = cameraZ - deathPlayerZ;
	const distanceGoal = Math.min(
		deathElapsed * DEATH_CAMERA_RETREAT_RATE,
		DEATH_CAMERA_MAX_DISTANCE
	) + deathPlayerSize;

	if ( deathQuickMagnitude( deltaX, deltaY, deltaZ ) < distanceGoal ) {

		if ( deltaX === 0 && deltaY === 0 && deltaZ === 0 ) deltaX = 1 / 16;
		let farScale = 1;
		for ( let attempt = 0; attempt < 6; attempt ++ ) {

			let magnitude = deathQuickMagnitude( deltaX, deltaY, deltaZ );
			if ( magnitude <= 0 ) magnitude = 1;
			deltaX = deltaX / magnitude * distanceGoal;
			deltaY = deltaY / magnitude * distanceGoal;
			deltaZ = deltaZ / magnitude * distanceGoal;
			const closerX = deathPlayerX + deltaX;
			const closerY = deathPlayerY + deltaY;
			const closerZ = deathPlayerZ + deltaZ;
			const hit = find_vector_intersection(
				deathPlayerX, deathPlayerY, deathPlayerZ,
				deathPlayerX + deltaX * farScale,
				deathPlayerY + deltaY * farScale,
				deathPlayerZ + deltaZ * farScale,
				deathPlayerSegnum, 0, - 1, 0
			);
			if ( hit.hit_type === HIT_NONE ) {

				cameraX = closerX;
				cameraY = closerY;
				cameraZ = closerZ;
				break;

			}

			deathRandomVector.set(
				Math.random() - 0.5,
				Math.random() - 0.5,
				Math.random() - 0.5
			);
			deltaX = deathRandomVector.x;
			deltaY = deathRandomVector.y;
			deltaZ = deathRandomVector.z;
			farScale = 1.5;

		}

	}

	camera.position.set( cameraX, cameraY, - cameraZ );
	deathLookTarget.set( deathPlayerX, deathPlayerY, - deathPlayerZ );
	camera.up.set( 0, 1, 0 );
	camera.lookAt( deathLookTarget );
	const cameraSeg = find_point_seg( cameraX, cameraY, cameraZ, deathCameraSegnum );
	if ( cameraSeg >= 0 ) deathCameraSegnum = cameraSeg;
	game_set_viewer_segnum( deathCameraSegnum );
	if ( deathCameraSegnum >= 0 ) updateMineVisibility( deathCameraSegnum, camera );

}

function advancePlayerDeathPose( dt ) {

	if ( deathRotPitch !== 0 || deathRotHeading !== 0 || deathRotBank !== 0 ) {

		deathStepEuler.set(
			- deathRotPitch * dt,
			- deathRotHeading * dt,
			deathRotBank * dt,
			'YXZ'
		);
		deathStepQuaternion.setFromEuler( deathStepEuler );
		deathPlayerQuaternion.multiply( deathStepQuaternion ).normalize();

	}

	const velocity = getPlayerVelocity();
	const drag = Player_ship.drag > 0 ? Player_ship.drag : 0.033;
	let dragSteps = Math.floor( dt * 64 );
	const dragRemainder = dt * 64 - dragSteps;
	let dragScale = 1;
	while ( dragSteps -- > 0 ) dragScale *= 1 - drag;
	dragScale *= 1 - dragRemainder * drag;
	velocity.x *= dragScale;
	velocity.y *= dragScale;
	velocity.z *= dragScale;

	const moved = do_physics_move(
		deathPlayerX, deathPlayerY, deathPlayerZ,
		velocity.x * dt, velocity.y * dt, velocity.z * dt,
		deathPlayerSegnum, dt, savedPlayerObjnum
	);
	deathPlayerX = moved.x;
	deathPlayerY = moved.y;
	deathPlayerZ = moved.z;
	deathPlayerSegnum = moved.segnum;
	game_set_external_player_pose(
		deathPlayerX, deathPlayerY, deathPlayerZ,
		deathPlayerQuaternion, deathPlayerSegnum
	);
	if ( deathPlayerEntry !== null && deathPlayerEntry.mesh !== null ) {

		deathPlayerEntry.mesh.position.set( deathPlayerX, deathPlayerY, - deathPlayerZ );
		deathPlayerEntry.mesh.quaternion.copy( deathPlayerQuaternion );

	}

}

function createPlayerDeathFireball() {

	deathRandomVector.set(
		Math.random() - 0.5,
		Math.random() - 0.5,
		Math.random() - 0.5
	);
	let magnitude = deathQuickMagnitude(
		deathRandomVector.x, deathRandomVector.y, deathRandomVector.z
	);
	if ( magnitude <= 0 ) {

		deathRandomVector.set( 1, 0, 0 );
		magnitude = 1;

	}
	deathRandomVector.multiplyScalar( deathPlayerSize / ( 2 * magnitude ) );
	const x = deathPlayerX + deathRandomVector.x;
	const y = deathPlayerY + deathRandomVector.y;
	const z = deathPlayerZ + deathRandomVector.z;
	const segnum = find_point_seg( x, y, z, deathPlayerSegnum );
	if ( segnum < 0 ) return;
	const explosion = object_create_explosion(
		x, y, z, 1 + Math.random() * 2, VCLIP_SMALL_EXPLOSION
	);
	if ( explosion !== null && Math.random() < 0.25 ) {

		digi_play_sample_world( SOUND_EXPLODING_WALL, 0.5, segnum, x, y, z );

	}

}

function explodePlayerDeathShip() {

	if ( deathExploded === true ) return;
	deathExploded = true;
	drop_player_eggs();
	const playerId = deathPlayerObject !== null ? deathPlayerObject.id : 0;
	const deathVclip = get_explosion_vclip( OBJ_PLAYER, playerId, 0 );
	const deathExplosion = collide_badass_explosion(
		deathPlayerX, deathPlayerY, deathPlayerZ, 50.0, 40.0, 150.0,
		deathPlayerSize, deathVclip, true, OBJ_PLAYER, playerId
	);
	object_create_explosion(
		deathPlayerX, deathPlayerY, deathPlayerZ,
		deathPlayerSize * EXPLOSION_SCALE, deathVclip
	);
	if ( deathExplosion !== null ) {

		digi_play_sample_world(
			SOUND_BADASS_EXPLOSION, 1.0, deathPlayerSegnum,
			deathPlayerX, deathPlayerY, deathPlayerZ
		);

	}
	if ( deathPlayerEntry !== null && deathPlayerObject !== null && deathBaseModelNum >= 0 ) {

		const velocity = getPlayerVelocity();
		explode_model(
			deathBaseModelNum,
			deathPlayerX, deathPlayerY, deathPlayerZ,
			velocity.x, velocity.y, velocity.z,
			deathPlayerEntry
		);
		if ( deathPlayerEntry.mesh !== null ) {

			deathPlayerEntry.mesh.name = 'player-death-ship';
			deathPlayerEntry.mesh.userData.playerDeathShip = true;
			deathPlayerEntry.mesh.visible = false;

		}

	}
	if ( deathPlayerObject !== null ) deathPlayerObject.type = OBJ_GHOST;
	showMessage( 'YOU WERE DESTROYED!' );

}

function updatePlayerDeathSequence( dt ) {

	advancePlayerDeathPose( dt );
	if ( deathPlayerEntry !== null ) updatePlayerCloakRender( deathPlayerEntry.mesh, dt );
	deathElapsed += dt;
	const spinRemaining = Math.max( 0, DEATH_SEQUENCE_EXPLODE_TIME - deathElapsed );
	deathRotPitch = spinRemaining * FULL_TURN_RADIANS / 4;
	deathRotHeading = spinRemaining * FULL_TURN_RADIANS / 2;
	deathRotBank = spinRemaining * FULL_TURN_RADIANS / 3;
	setPlayerDeathCamera( getCamera() );
	if ( deathElapsed > DEATH_SEQUENCE_EXPLODE_TIME ) {

		explodePlayerDeathShip();
		// D1 flushes the input state on the first exploded frame, then accepts
		// the next key or button as the respawn request.
		deathInputArmed = true;

	} else if ( Math.random() < dt * 4 ) {

		createPlayerDeathFireball();

	}
	return deathSequenceAborted;

}

function startPlayerDeath() {

	if ( playerDead === true ) return;

	cleanupPlayerDeathVisual();
	playerDead = true;
	deathElapsed = 0;
	deathExploded = false;
	deathInputArmed = false;
	deathSequenceAborted = false;
	deathRotPitch = 0;
	deathRotHeading = 0;
	deathRotBank = 0;
	game_set_player_dead( true );
	const pp = getPlayerPos();
	deathPlayerX = pp.x;
	deathPlayerY = pp.y;
	deathPlayerZ = pp.z;
	deathPlayerSegnum = getPlayerSegnum();
	deathCameraSegnum = deathPlayerSegnum;
	deathPlayerObject = savedPlayerObjnum >= 0 ? Objects[ savedPlayerObjnum ] : null;
	deathPlayerOriginalType = deathPlayerObject !== null ? deathPlayerObject.type : - 1;
	if ( deathPlayerObject !== null ) {

		deathPlayerMatrix.set(
			deathPlayerObject.orient_rvec_x, deathPlayerObject.orient_uvec_x, - deathPlayerObject.orient_fvec_x, 0,
			deathPlayerObject.orient_rvec_y, deathPlayerObject.orient_uvec_y, - deathPlayerObject.orient_fvec_y, 0,
			- deathPlayerObject.orient_rvec_z, - deathPlayerObject.orient_uvec_z, deathPlayerObject.orient_fvec_z, 0,
			0, 0, 0, 1
		);
		deathPlayerQuaternion.setFromRotationMatrix( deathPlayerMatrix ).normalize();

	} else {

		deathPlayerQuaternion.copy( getCamera().quaternion );

	}
	deathPlayerSize = deathPlayerObject !== null && deathPlayerObject.size > 0
		? deathPlayerObject.size : 4.0;
	game_set_player_pose_driven( true );
	game_set_viewer_segnum( deathCameraSegnum );
	game_set_external_player_pose(
		deathPlayerX, deathPlayerY, deathPlayerZ,
		deathPlayerQuaternion, deathPlayerSegnum
	);
	buildPlayerDeathVisual();
	document.addEventListener( 'keydown', abortPlayerDeathSequence );
	document.addEventListener( 'mousedown', abortPlayerDeathSequence );
	document.addEventListener( 'touchstart', abortPlayerDeathSequence );

	console.log( 'Player destroyed! Lives remaining: ' + ( playerLives - 1 ) );

}

function resetPlayerLoadoutForNewShip() {

	playerPrimaryFlags = 1;		// HAS_LASER_FLAG only
	playerSecondaryFlags = 1;	// HAS_CONCUSSION_FLAG
	playerQuadLasers = false;
	playerSecondaryAmmo[ 0 ] = 2 + 5 - Difficulty_level;
	playerSecondaryAmmo[ 1 ] = 0;
	playerSecondaryAmmo[ 2 ] = 0;
	playerSecondaryAmmo[ 3 ] = 0;
	playerSecondaryAmmo[ 4 ] = 0;
	playerVulcanAmmo = 0;
	playerLaserLevel = 0;
	set_primary_weapon( 0 );
	set_secondary_weapon( 0 );

}

function respawnPlayer() {

	cleanupPlayerDeathVisual();
	playerLives --;

	if ( playerLives <= 0 ) {

		console.log( 'GAME OVER — no lives remaining' );
		showGameOver();
		return;

	}

	// Reset player state
	// Ported from: init_player_stats_new_ship() in GAMESEQ.C lines 580-617
	playerDead = false;
	playerShields = 100;
	playerEnergy = 100;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;
	// Keys belong to the current level, not the current ship. D1 keeps them on
	// same-level respawn and clears them only when starting another level.
	resetPlayerLoadoutForNewShip();

	// Reset physics (zero velocity/rotation)
	game_reset_physics();

	// Teleport to start position
	if ( savedPlayerStart !== null ) {

		game_set_player_start( savedPlayerStart );

	}

	game_set_player_dead( false );
	updateHUD();
	showMessage( 'RESPAWNING... Lives: ' + playerLives );

	// Create the materialization effect slightly in front of the local player.
	// Ported from: create_player_appearance_effect() in GAMESEQ.C lines 752-778
	const respawnPos = getPlayerPos();
	let effect_x = respawnPos.x;
	let effect_y = respawnPos.y;
	let effect_z = respawnPos.z;
	let effectSize = 5.0;

	if ( savedPlayerStart !== null ) {

		effectSize = savedPlayerStart.size;
		const forwardOffset = effectSize * 0.9;
		effect_x += savedPlayerStart.orient_fvec_x * forwardOffset;
		effect_y += savedPlayerStart.orient_fvec_y * forwardOffset;
		effect_z += savedPlayerStart.orient_fvec_z * forwardOffset;

	}

	const appearance = object_create_explosion(
		effect_x, effect_y, effect_z, effectSize, VCLIP_PLAYER_APPEARANCE
	);
	const appearanceClip = Vclips[ VCLIP_PLAYER_APPEARANCE ];
	if ( appearance !== null && appearanceClip !== undefined && appearanceClip.sound_num >= 0 ) {

		digi_play_sample_world(
			appearanceClip.sound_num, 1.0, getPlayerSegnum(), effect_x, effect_y, effect_z
		);

	}

}

function computeAdvanceLevelTarget( secretFlag ) {

	// Ported from: AdvanceLevel(secret_flag) in GAMESEQ.C via mission routing tables.
	return mission_compute_next_level( currentLevelNum, secretFlag === true );

}

function beginGameplayTeardown() {

	game_set_transition_suspended( true );
	digi_stop_all_sounds();

}

async function finishLevelExit( isSecret ) {

	// D1's score/ending screens block the old mine.  Freeze it only after any
	// endlevel flythrough has completed, then silence every gameplay SFX owner.
	beginGameplayTeardown();

	const isFinalLevel = mission_is_final_level( currentLevelNum );
	if ( isFinalLevel === true ) {

		// D1 plays the narrative ending before awarding the final-level bonuses.
		showMessage( 'CONGRATULATIONS! You completed all levels!' );
		console.log( 'GAME COMPLETE! All ' + mission_get_last_level() + ' levels finished.' );
		await do_end_game( _hogFile, _pigFile, _palette );
		showBonusScreen( true, () => {

			showGameOver( true );

		} );
		return;

	}

	// Non-final levels award bonuses before advancing, matching PlayerFinishedLevel.
	showBonusScreen( false, async () => {

		// Advance to next level (normal/secret routing handled in advanceLevel)
		await advanceLevel( isSecret );

	} );

}

function startEndlevelSequence() {

	const started = start_endlevel_sequence( getCamera(), getPlayerSegnum() );
	game_set_controls_enabled( false );
	showMessage( 'EXIT SEQUENCE' );

	if ( started !== true ) {

		// If we can't build an exit tunnel path, fall back to immediate level completion.
		// Mirrors ENDLEVEL.C behavior where invalid data exits the level without flythrough.
		console.warn( 'ENDLEVEL: Could not start flythrough path; finishing level directly' );
		game_set_controls_enabled( true );
		finishLevelExit( false );
		return;

	}

	// The normal tunnel flythrough owns the optional end-level track.  The
	// shareware song table has no file in this slot, and songs_play_song()
	// deliberately preserves the current level song in that case.
	// Ported from: ENDLEVEL.C line 492.
	songs_play_song( SONG_ENDLEVEL, false );

	console.log( 'ENDLEVEL: Starting tunnel flythrough sequence' );

}

// --- Handle level exit trigger ---
function handleLevelExit( isSecret ) {

	if ( levelTransitioning === true ) return;
	levelTransitioning = true;

	console.log( 'LEVEL EXIT: ' + ( isSecret === true ? 'Secret' : 'Normal' ) + ' exit from level ' + currentLevelNum );

	// Secret exits skip the endlevel flythrough and immediately finish level.
	// Ported from: SWITCH.C TRIGGER_SECRET_EXIT path to PlayerFinishedLevel(1)
	if ( isSecret === true ) {

		finishLevelExit( true );
		return;

	}

	// Normal exits start endlevel sequence first.
	// Ported from: SWITCH.C TRIGGER_EXIT -> start_endlevel_sequence()
	startEndlevelSequence();

}

// --- End-of-level score bonus screen ---
// Ported from: DoEndLevelScoreGlitz() in GAMESEQ.C lines 1042-1133

// Find closest palette color to target RGB values
function findClosestColor( palette, r, g, b ) {

	let bestIdx = 0;
	let bestDist = Infinity;

	for ( let i = 0; i < 256; i ++ ) {

		const dr = palette[ i * 3 ] - r;
		const dg = palette[ i * 3 + 1 ] - g;
		const db = palette[ i * 3 + 2 ] - b;
		const dist = dr * dr + dg * dg + db * db;

		if ( dist < bestDist ) {

			bestDist = dist;
			bestIdx = i;

		}

	}

	return bestIdx;

}

// Right-aligned text rendering helper
function gr_string_right( imageData, font, rightX, y, text, gamePalette, fgColorIndex ) {

	const size = gr_get_string_size( font, text );
	gr_string( imageData, font, rightX - size.width, y, text, gamePalette, fgColorIndex );

}

function showBonusScreen( isFinalLevel, onContinue ) {

	// Calculate bonuses — multiplied by (Difficulty_level + 1)
	// Ported from GAMESEQ.C: shield_points = f2i(shields) * 10 * (Difficulty_level+1)
	const diffMultiplier = Difficulty_level + 1;
	const shieldBonus = Math.floor( playerShields ) * 10 * diffMultiplier;
	const energyBonus = Math.floor( playerEnergy ) * 5 * diffMultiplier;
	const hostageBonus = hostage_get_level_saved() * 500 * diffMultiplier;

	// Full rescue bonus: all hostages in level rescued
	let allHostageBonus = 0;
	if ( hostage_get_in_level() > 0 && hostage_get_level_saved() === hostage_get_in_level() ) {

		allHostageBonus = hostage_get_level_saved() * 1000 * diffMultiplier;

	}

	// Skill points bonus: extra points for playing on higher difficulty
	// Ported from: GAMESEQ.C lines 1059-1066
	let skillBonus = 0;
	if ( Difficulty_level > 1 ) {

		const levelPoints = playerScore - playerLastScore;
		skillBonus = Math.floor( levelPoints * ( Difficulty_level - 1 ) / 2 );
		skillBonus -= skillBonus % 100;	// Round down to nearest 100
		if ( skillBonus < 0 ) skillBonus = 0;

	}

	// Endgame bonus: lives remaining on final level
	let endgameBonus = 0;
	if ( isFinalLevel === true && playerLives > 0 ) {

		endgameBonus = playerLives * 10000;

	}

	const totalBonus = shieldBonus + energyBonus + hostageBonus + allHostageBonus + skillBonus + endgameBonus;

	// Route the bonus through the extra-ship logic instead of a raw add. Ported from:
	// DoEndLevelScoreGlitz() -> add_bonus_points_to_score() (GAMESEQ.C:1094, GAUGES.C:1221)
	addBonusPointsToScore( totalBonus );

	console.log( 'BONUS: Shield=' + shieldBonus + ' Energy=' + energyBonus + ' Hostage=' + hostageBonus +
		' AllHostage=' + allHostageBonus + ' Skill=' + skillBonus + ' Endgame=' + endgameBonus + ' Total=' + totalBonus );

	// Build bonus line items for animated count-up
	const bonusLines = [
		{ label: 'Shield Bonus', value: shieldBonus },
		{ label: 'Energy Bonus', value: energyBonus },
		{ label: 'Hostage Bonus', value: hostageBonus },
		{ label: 'Skill Bonus', value: skillBonus }
	];

	if ( allHostageBonus > 0 ) {

		bonusLines.push( { label: 'Full Rescue Bonus', value: allHostageBonus } );

	}

	if ( endgameBonus > 0 ) {

		bonusLines.push( { label: 'Ship Bonus', value: endgameBonus } );

	}

	// Canvas-based rendering using MENU.PCX background + bitmap fonts
	// Ported from: newmenu_do2(NULL, title, c, m, ..., "MENU.PCX") in GAMESEQ.C line 1132
	const { canvas: titleCanvas, ctx: titleCtx, inner: titleInner } = get_title_canvas();
	show_title_canvas();

	// Load MENU.PCX background
	const pcxData = pcx_read( _hogFile, 'menu.pcx' );
	let bgCanvas = null;

	if ( pcxData !== null ) {

		bgCanvas = pcx_to_canvas( pcxData );

	}

	if ( bgCanvas !== null ) {

		titleCanvas.width = bgCanvas.width;
		titleCanvas.height = bgCanvas.height;

	} else {

		titleCanvas.width = 320;
		titleCanvas.height = 200;

	}

	const titleFont = SUBTITLE_FONT();
	const dataFont = GAME_FONT();

	if ( titleFont === null || dataFont === null ) {

		console.warn( 'BONUS: Fonts not loaded, falling back' );
		hide_title_canvas();
		updateHUD();
		if ( onContinue !== null ) onContinue();
		return;

	}

	// Palette color indices
	// BM_XRGB(31,26,5) → golden labels (VGA 6-bit scaled: 124,104,20)
	// BM_XRGB(28,28,28) → bright white for values (224,224,224)
	const goldenIdx = findClosestColor( _palette, 124, 104, 20 );
	const brightIdx = findClosestColor( _palette, 224, 224, 224 );

	// Layout constants — positioned below the DESCENT logo in MENU.PCX (~70px tall)
	const LABEL_X = 48;		// left edge of label text
	const VALUE_RIGHT_X = 272;	// right edge of value text
	const TITLE_Y = 62;		// title line Y (below logo)
	const SUBTITLE_Y = 78;		// subtitle line Y (level name)
	const FIRST_LINE_Y = 100;	// first bonus line Y
	const LINE_SPACING = 12;	// vertical spacing between lines

	// Count-up animation state
	let currentLine = 0;			// which line is currently counting
	const displayValues = [];		// current displayed value per line
	let countUpDone = false;
	let showContinue = false;
	let dismissed = false;

	for ( let i = 0; i < bonusLines.length; i ++ ) {

		displayValues.push( 0 );

	}

	// Count-up speed: ~40,000 points per second, minimum step of 1
	const COUNT_SPEED = 40000;

	// Draw a complete frame
	function drawFrame() {

		// Draw background
		if ( bgCanvas !== null ) {

			titleCtx.drawImage( bgCanvas, 0, 0 );

		} else {

			titleCtx.fillStyle = '#0a0a2a';
			titleCtx.fillRect( 0, 0, titleCanvas.width, titleCanvas.height );

		}

		const imageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );

		// Title: "LEVEL X COMPLETE" — centered, SUBTITLE_FONT (color font, no fgColorIndex)
		// Ported from: GAMESEQ.C line 1119
		gr_string( imageData, titleFont, 0x8000, TITLE_Y, 'LEVEL ' + currentLevelNum + ' COMPLETE', _palette );

		// Subtitle: "<level_name> DESTROYED" — centered, GAME_FONT
		if ( currentLevelName !== '' ) {

			gr_string( imageData, dataFont, 0x8000, SUBTITLE_Y, currentLevelName + ' DESTROYED', _palette, goldenIdx );

		}

		// Bonus lines (label left, value right)
		for ( let i = 0; i < bonusLines.length; i ++ ) {

			const y = FIRST_LINE_Y + i * LINE_SPACING;

			// Only show lines up to and including the current counting line
			if ( i > currentLine && countUpDone !== true ) continue;

			gr_string( imageData, dataFont, LABEL_X, y, bonusLines[ i ].label, _palette, goldenIdx );

			const val = ( countUpDone === true ) ? bonusLines[ i ].value : displayValues[ i ];
			gr_string_right( imageData, dataFont, VALUE_RIGHT_X, y, String( val ), _palette, brightIdx );

		}

		// Totals — shown after count-up completes
		if ( countUpDone === true ) {

			const totalY = FIRST_LINE_Y + bonusLines.length * LINE_SPACING + LINE_SPACING;

			gr_string( imageData, dataFont, LABEL_X, totalY, 'Total Bonus', _palette, goldenIdx );
			gr_string_right( imageData, dataFont, VALUE_RIGHT_X, totalY, String( totalBonus ), _palette, brightIdx );

			gr_string( imageData, dataFont, LABEL_X, totalY + LINE_SPACING, 'Total Score', _palette, goldenIdx );
			gr_string_right( imageData, dataFont, VALUE_RIGHT_X, totalY + LINE_SPACING, String( playerScore ), _palette, brightIdx );

		}

		// "CLICK TO CONTINUE" — bottom, centered
		if ( showContinue === true ) {

			gr_string( imageData, dataFont, 0x8000, 185, 'CLICK TO CONTINUE', _palette, goldenIdx );

		}

		titleCtx.putImageData( imageData, 0, 0 );

	}

	// Animation loop
	let lastTime = 0;

	function animate( timestamp ) {

		if ( dismissed === true ) return;

		if ( lastTime === 0 ) lastTime = timestamp;
		const dt = ( timestamp - lastTime ) / 1000;
		lastTime = timestamp;

		if ( countUpDone !== true ) {

			// Count up current line
			if ( currentLine < bonusLines.length ) {

				const target = bonusLines[ currentLine ].value;

				if ( target === 0 ) {

					// Skip zero-value lines immediately
					displayValues[ currentLine ] = 0;
					currentLine ++;

				} else {

					const increment = Math.max( 1, Math.floor( COUNT_SPEED * dt ) );
					displayValues[ currentLine ] += increment;

					if ( displayValues[ currentLine ] >= target ) {

						displayValues[ currentLine ] = target;
						currentLine ++;

					}

				}

			}

			if ( currentLine >= bonusLines.length ) {

				countUpDone = true;
				showContinue = true;

			}

		}

		drawFrame();
		requestAnimationFrame( animate );

	}

	// Draw initial frame and start animation
	drawFrame();
	requestAnimationFrame( animate );

	// Wait for input to dismiss
	const finish = () => {

		if ( dismissed === true ) return;
		dismissed = true;

		document.removeEventListener( 'keydown', onKey );
		titleInner.removeEventListener( 'click', onClick );

		hide_title_canvas();
		updateHUD();

		if ( onContinue !== null ) {

			onContinue();

		}

	};

	const onKey = ( e ) => {

		// If count-up still running, skip to end
		if ( countUpDone !== true ) {

			e.preventDefault();
			countUpDone = true;
			showContinue = true;

			for ( let i = 0; i < bonusLines.length; i ++ ) {

				displayValues[ i ] = bonusLines[ i ].value;

			}

			return;

		}

		e.preventDefault();
		finish();

	};

	const onClick = () => {

		// If count-up still running, skip to end
		if ( countUpDone !== true ) {

			countUpDone = true;
			showContinue = true;

			for ( let i = 0; i < bonusLines.length; i ++ ) {

				displayValues[ i ] = bonusLines[ i ].value;

			}

			return;

		}

		finish();

	};

	document.addEventListener( 'keydown', onKey );
	titleInner.addEventListener( 'click', onClick );

}

// --- Clean up current level and load next ---
async function advanceLevel( secretFlag, skipBriefing = false ) {

	if ( typeof secretFlag === 'boolean' ) {

		const nextLevelNum = computeAdvanceLevelTarget( secretFlag );
		console.log( 'ADVANCE LEVEL: ' + currentLevelNum + ' -> ' + nextLevelNum +
			' (secret=' + ( secretFlag === true ) + ')' );
		currentLevelNum = nextLevelNum;

	}

	const scene = getScene();

	// Leave endlevel/cutscene mode before level teardown.
	stop_endlevel_sequence();
	cleanupPlayerDeathVisual();
	game_set_controls_enabled( true );

	// Remove all tracked objects from scene
	for ( let i = 0; i < livePolygonObjects.length; i ++ ) {

		if ( livePolygonObjects[ i ].mesh !== null ) {

			scene.remove( livePolygonObjects[ i ].mesh );

		}

	}

	powerup_cleanup( scene );

	// Clear tracked arrays
	liveRobots.length = 0;
	liveClutter.length = 0;
	livePolygonObjects.length = 0;

	// Clean up debris from previous level
	debris_cleanup();

	// Reset dynamic object lights
	lighting_cleanup();

	// Reset wall/door state
	wall_reset();

	// Reset automap visited segments for new level
	Automap_visited.fill( 0 );

	// Reset player state (keep weapons between levels)
	// Ported from: init_ammo_and_energy() in GAMESEQ.C lines 514-530
	// Ensure shields and energy are at least starting values
	if ( playerShields < 100 ) playerShields = 100;
	if ( playerEnergy < 100 ) playerEnergy = 100;
	// Ensure minimum concussion missiles for new level
	const minConcussion = 2 + 5 - Difficulty_level;
	if ( playerSecondaryAmmo[ 0 ] < minConcussion ) playerSecondaryAmmo[ 0 ] = minConcussion;
	// Keys are level-specific — clear for new level
	playerKeys = { blue: false, red: false, gold: false };
	playerDead = false;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;
	game_set_player_dead( false );
	game_reset_physics();
	cntrlcen_reset();
	fuelcen_reset();
	reset_special_effects();
	gauges_set_white_flash( 0 );
	levelTransitioning = false;

	// Show briefing screens for the next level (skip on save game load)
	if ( _pendingSaveRestore === null && skipBriefing !== true ) {

		show_title_canvas();
		await do_briefing_screens( _hogFile, currentLevelNum, _pigFile, _palette );
		hide_title_canvas();

	}

	let levelName = mission_get_level_name( currentLevelNum );
	if ( levelName.length <= 0 ) {

		// Fallback for malformed mission data.
		const levelAbsNum = Math.abs( currentLevelNum );
		const num = levelAbsNum < 10 ? '0' + levelAbsNum : '' + levelAbsNum;
		const ext = ( _pigFile !== null && _pigFile.isShareware === true ) ? 'sdl' : 'rdl';
		levelName = 'level' + num + '.' + ext;
		console.warn( 'ADVANCE LEVEL: Missing mission filename for level ' + currentLevelNum +
			', using fallback "' + levelName + '"' );

	}

	console.log( 'Loading level: ' + levelName );
	// Pass the signed level number through; songs_play_level_song handles the
	// secret-level (negative) case itself, matching SONGS.C.
	songs_play_level_song( currentLevelNum );
	loadLevel( levelName );

}

// Developer quick-starts can be requested repeatedly from the browser console.
// Route them through the same level teardown as normal progression, but retain
// the helper's defining behavior of skipping briefing screens.
export async function quickStartLevel( levelNum ) {

	if ( Number.isInteger( levelNum ) !== true || levelNum === 0 ) return false;
	beginGameplayTeardown();
	currentLevelNum = levelNum;
	_lastLevelLoadSucceeded = false;
	await advanceLevel( undefined, true );
	return _lastLevelLoadSucceeded;

}

// --- Level loading ---
export function loadLevel( levelName, missionLevelNum ) {

	if ( missionLevelNum !== undefined &&
		( Number.isInteger( missionLevelNum ) !== true || missionLevelNum === 0 ) ) {

		console.warn( 'LOAD LEVEL: Invalid mission level number ' + missionLevelNum );
		return false;

	}

	// Find the level file in the HOG
	let levelFile = _hogFile.findFile( levelName );

	if ( levelFile === null ) {

		// Try uppercase
		levelFile = _hogFile.findFile( levelName.toUpperCase() );

	}

	if ( levelFile === null ) {

		// List available level files (.sdl and .rdl) for debugging
		const files = _hogFile.listFiles();
		const levelFiles = files.filter( f => {

			const upper = f.toUpperCase();
			return upper.endsWith( '.SDL' ) || upper.endsWith( '.RDL' );

		} );

		console.log( 'Available level files:', levelFiles );

		if ( levelFiles.length > 0 ) {

			setStatus( 'Level "' + levelName + '" not found, trying ' + levelFiles[ 0 ] + '...' );
			levelFile = _hogFile.findFile( levelFiles[ 0 ] );

		}

	}

	if ( levelFile === null ) {

		setStatus( 'Error: Could not find any level files in HOG' );
		return false;

	}

	if ( missionLevelNum !== undefined ) currentLevelNum = missionLevelNum;

	// Track score at level start for skill points calculation
	// Ported from: GAMESEQ.C init_player_stats_level() — Players[Player_num].last_score
	playerLastScore = playerScore;

	loadLevelData( levelFile, levelName );
	return true;

}

// Ported from: check_poke() in WALL.C lines 641-652
function check_poke( objnum, segnum, side ) {

	const obj = Objects[ objnum ];
	if ( obj === undefined ) return false;
	if ( obj.size <= 0 ) return false; // note: don't let objects with zero size block door

	const masks = get_seg_masks( obj.pos_x, obj.pos_y, obj.pos_z, segnum, obj.size );
	return ( masks.sidemask & ( 1 << side ) ) !== 0;

}

function applyPolygonObjectTextureOverride( mesh, obj ) {

	if ( mesh === null || mesh === undefined || obj === null || obj === undefined ||
		obj.rtype === null || obj.rtype === undefined ) return false;
	const tmapOverride = obj.rtype.tmap_override;
	if ( Number.isInteger( tmapOverride ) !== true || tmapOverride < 0 ||
		tmapOverride >= Textures.length ) return false;
	return polyobj_apply_texture_override(
		mesh, Textures[ tmapOverride ], _pigFile, _palette
	);

}

function replaceReactorWithDestroyedModel( reactor ) {

	if ( reactor === null || reactor === undefined ) return false;
	if ( reactor.obj === null || reactor.obj === undefined ) return false;
	if ( reactor.obj.rtype === null || reactor.obj.rtype === undefined ) return false;
	if ( reactor.mesh === null || reactor.mesh === undefined ) return false;

	const oldModelNum = reactor.obj.rtype.model_num;
	let deadModelNum = - 1;

	if ( oldModelNum >= 0 && oldModelNum < Dead_modelnums.length ) {

		deadModelNum = Dead_modelnums[ oldModelNum ];

	}

	// Ported behavior: reactor.pof -> reactor2.pof when a destroyed model exists.
	if ( deadModelNum < 0 && oldModelNum >= 0 && oldModelNum + 1 < SHAREWARE_MODEL_TABLE.length ) {

		const liveName = SHAREWARE_MODEL_TABLE[ oldModelNum ];
		const deadName = SHAREWARE_MODEL_TABLE[ oldModelNum + 1 ];
		if ( liveName === 'reactor.pof' && deadName === 'reactor2.pof' ) {

			deadModelNum = oldModelNum + 1;

		}

	}

	if ( deadModelNum < 0 || deadModelNum >= Polygon_models.length ) return false;
	const deadModel = Polygon_models[ deadModelNum ];
	if ( deadModel === null || deadModel === undefined ) return false;

	if ( deadModel.mesh === null ) {

		deadModel.mesh = buildModelMesh( deadModel, _pigFile, _palette );

	}

	if ( deadModel.mesh === null ) return false;

	const scene = getScene();
	if ( scene === null ) return false;

	let deadMesh = polyobj_clone_model_mesh( deadModel.mesh );
	if ( reactor.obj.rtype.subobj_flags === 0 ) {

		deadMesh = polyobj_wrap_model_lod( deadMesh, deadModel, _pigFile, _palette );

	}
	applyPolygonObjectTextureOverride( deadMesh, reactor.obj );
	deadMesh.position.copy( reactor.mesh.position );
	deadMesh.quaternion.copy( reactor.mesh.quaternion );
	deadMesh.scale.copy( reactor.mesh.scale );

	scene.remove( reactor.mesh );
	scene.add( deadMesh );

	reactor.mesh = deadMesh;
	reactor.obj.rtype.model_num = deadModelNum;
	reactor.obj.flags |= OF_DESTROYED;
	reactor.obj.flags &= ~ OF_SHOULD_BE_DEAD;
	return true;

}

function replaceClutterModel( clutter, modelNum ) {

	if ( clutter === null || clutter === undefined ) return false;
	const obj = clutter.obj;
	if ( obj === null || obj === undefined || obj.rtype === null || obj.rtype === undefined ) return false;
	if ( clutter.mesh === null || clutter.mesh === undefined ) return false;
	if ( modelNum < 0 || modelNum >= Polygon_models.length ) return false;

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return false;
	if ( model.mesh === null ) model.mesh = buildModelMesh( model, _pigFile, _palette );
	if ( model.mesh === null ) return false;

	const scene = getScene();
	if ( scene === null ) return false;

	let deadMesh = polyobj_clone_model_mesh( model.mesh );
	if ( obj.rtype.subobj_flags === 0 ) {

		deadMesh = polyobj_wrap_model_lod( deadMesh, model, _pigFile, _palette );

	}
	applyPolygonObjectTextureOverride( deadMesh, obj );
	deadMesh.position.copy( clutter.mesh.position );
	deadMesh.quaternion.copy( clutter.mesh.quaternion );
	deadMesh.scale.copy( clutter.mesh.scale );

	scene.remove( clutter.mesh );
	scene.add( deadMesh );
	clutter.mesh = deadMesh;
	obj.rtype.model_num = modelNum;
	return true;

}

function replaceClutterWithDestroyedModel( clutter ) {

	if ( clutter === null || clutter === undefined || clutter.obj === null ||
		clutter.obj === undefined || clutter.obj.rtype === null || clutter.obj.rtype === undefined ) return false;

	const oldModelNum = clutter.obj.rtype.model_num;
	if ( oldModelNum < 0 || oldModelNum >= Dead_modelnums.length ) return false;
	const deadModelNum = Dead_modelnums[ oldModelNum ];
	if ( replaceClutterModel( clutter, deadModelNum ) !== true ) return false;
	clutter.obj.flags |= OF_DESTROYED;
	return true;

}

export function process_clutter_explosion( clutter, dt ) {

	if ( clutter === null || clutter === undefined || clutter.alive !== true ) return;
	const obj = clutter.obj;
	if ( obj === null || obj === undefined ) return;

	if ( clutter.explosionDelay >= 0 ) {

		clutter.explosionDelay -= dt;
		if ( clutter.explosionDelay > 0 ) return;
		clutter.explosionDelay = - 1;

		// do_explosion_sequence(): create the secondary blast, then break the
		// polygon model into debris before deleting/replacing the center body.
		const deathExplosion = object_create_explosion(
			obj.pos_x, obj.pos_y, obj.pos_z,
			obj.size * EXPLOSION_SCALE, VCLIP_SMALL_EXPLOSION
		);
		if ( deathExplosion !== null && obj.movement_type === MT_PHYSICS &&
			obj.mtype !== null && obj.mtype !== undefined ) {

			explosion_copy_physics(
				deathExplosion, obj.segnum, obj.mtype,
				obj.mtype.velocity_x, obj.mtype.velocity_y, obj.mtype.velocity_z
			);

		}

		// FIREBALL.C uses the destroyed object's id as a Robot_info index even
		// for OBJ_CLUTTER, so preserve that original secondary sound quirk.
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

			let vel_x = 0;
			let vel_y = 0;
			let vel_z = 0;
			if ( obj.mtype !== null && obj.mtype !== undefined ) {

				vel_x = obj.mtype.velocity_x;
				vel_y = obj.mtype.velocity_y;
				vel_z = obj.mtype.velocity_z;

			}
			explode_model(
				obj.rtype.model_num,
				obj.pos_x, obj.pos_y, obj.pos_z,
				vel_x, vel_y, vel_z,
				clutter
			);

		}

		const clip = Vclips[ VCLIP_SMALL_EXPLOSION ];
		clutter.deleteDelay = ( clip !== undefined && clip.play_time > 0 )
			? clip.play_time / 2 : 0.25;
		return;

	}

	if ( clutter.deleteDelay >= 0 ) {

		clutter.deleteDelay -= dt;
		if ( clutter.deleteDelay > 0 ) return;
		clutter.deleteDelay = - 1;

		if ( replaceClutterWithDestroyedModel( clutter ) !== true ) {

			clutter.alive = false;
			obj.flags |= OF_SHOULD_BE_DEAD;
			if ( clutter.mesh !== null && clutter.mesh.parent !== null ) {

				clutter.mesh.parent.remove( clutter.mesh );

			}

		}

	}

}

function processExplodingClutter( dt ) {

	for ( let i = 0; i < liveClutter.length; i ++ ) {

		process_clutter_explosion( liveClutter[ i ], dt );

	}

}

function any_object_pokes_side( segnum, side ) {

	if ( segnum < 0 || segnum >= Num_segments ) return false;

	let objnum = Segments[ segnum ].objects;
	let guard = 0;

	while ( objnum !== - 1 ) {

		if ( objnum < 0 || objnum >= Objects.length ) break;

		const obj = Objects[ objnum ];
		const nextObj = obj.next;

		if ( ( obj.flags & OF_SHOULD_BE_DEAD ) === 0 && check_poke( objnum, segnum, side ) === true ) {

			return true;

		}

		objnum = nextObj;
		guard ++;

		// Broken object list guard
		if ( guard > Objects.length ) break;

	}

	return false;

}

// Check if any objects are blocking a door side
// Ported from: do_door_close() + check_poke() in WALL.C lines 670-694, 641-652
function checkObjectsInDoorway( segnum, sidenum, csegnum, csidenum ) {

	if ( any_object_pokes_side( segnum, sidenum ) === true ) return true;
	if ( any_object_pokes_side( csegnum, csidenum ) === true ) return true;
	return false;

}

function loadLevelData( levelFile, levelName ) {

	// PLVL format (used by both shareware .sdl and registered .rdl):
	// sig (int) = 'PLVL' (0x504c564c as little-endian int32)
	// version (int)
	// minedata_offset (int)
	// gamedata_offset (int)
	// hostagetext_offset (int)

	const sig = levelFile.readInt();
	const version = levelFile.readInt();
	const minedata_offset = levelFile.readInt();
	const gamedata_offset = levelFile.readInt();
	const hostagetext_offset = levelFile.readInt();

	console.log( 'Level: sig=0x' + ( sig >>> 0 ).toString( 16 ) +
		', version=' + version +
		', minedata_offset=' + minedata_offset +
		', gamedata_offset=' + gamedata_offset );

	// 'PLVL' = 0x504c564c when read as big-endian multi-char constant
	// But stored in file as little-endian, so readInt() gives 0x4c564c50
	// Actually in C, 'PLVL' = 0x504c564c, written via write_int as little-endian bytes:
	// 0x4c, 0x56, 0x4c, 0x50, then read back via read_int as 0x504c564c
	const PLVL_SIG = 0x504c564c;

	if ( sig !== PLVL_SIG ) {

		console.error( 'Level: Invalid signature 0x' + ( sig >>> 0 ).toString( 16 ) + ' (expected PLVL=0x504c564c)' );
		setStatus( 'Error: Invalid level file signature' );
		return;

	}

	// Seek to mine data and load it
	levelFile.seek( minedata_offset );

	setStatus( 'Parsing mine data...' );

	let result;

	if ( _pigFile.isShareware === true ) {

		// Shareware uses the old compiled mine format (no bitmasks, int sizes)
		result = load_mine_data_compiled_old( levelFile );

	} else {

		// Registered uses the new compressed mine format (bitmasks, ushort sizes)
		result = load_mine_data_compiled_new( levelFile );

	}

	if ( result !== 0 ) {

		setStatus( 'Error loading mine data' );
		return;

	}

	// Initialize object pool before loading game data
	// Wire up Segments reference for per-segment linked lists
	obj_set_segments( Segments, () => Highest_segment_index );
	init_objects();

	// Load game data (objects, walls, triggers, etc.)
	setStatus( 'Loading game data...' );

	levelFile.seek( gamedata_offset );
	const gameData = load_game_data( levelFile );

	// Store level name for bonus screen
	// Ported from: Current_level_name in GAMESEQ.C line 336
	if ( gameData !== null && gameData.levelName !== '' ) {

		currentLevelName = gameData.levelName;

	} else {

		currentLevelName = '';

	}

	// Wire up wall system before building geometry
	wall_set_externals( {
		Segments: Segments,
		Walls: Walls,
		Num_walls: Num_walls,
		Vertices: Vertices,
		Side_to_verts: Side_to_verts,
		Textures: Textures,
		pigFile: _pigFile,
		getFrameTime: () => FrameTime,
		checkObjectsInDoorway: checkObjectsInDoorway
	} );
	gameseg_set_connected_distance_doorway( wall_is_doorway );
	digi_set_world_distance_resolver( find_connected_distance );
	digi_set_object_getter( getSoundObject );
	wall_set_render_callback( updateDoorMesh );
	wall_set_player_callbacks(
		() => playerKeys,
		showMessage
	);
	wall_set_illusion_callback( ( segnum, sidenum, visible ) => {

		setWallMeshVisible( segnum, sidenum, visible );

	} );
	wall_set_explosion_callback( ( pos_x, pos_y, pos_z, size ) => {

		// Create explosion at the blasted wall face
		// Ported from: explode_wall() in FIREBALL.C
		object_create_explosion( pos_x, pos_y, pos_z, size );

	} );
	wall_set_explode_wall_callback( explode_wall );

	// Build Three.js geometry
	setStatus( 'Building geometry...' );
	clearRenderCaches();
	const mineGeometry = buildMineGeometry( _pigFile, _palette );

	// Initialize door textures to their wall clip's frame 0
	// Must be done after buildMineGeometry so door meshes exist
	wall_init_door_textures();

	// Wire up trigger system
	switch_set_externals( {
		getFrameTime: () => FrameTime,
		onLevelExit: handleLevelExit,
		onPlayerShieldDamage: ( amount ) => {

			playerShields -= amount;
			updateHUD();
			flashDamage();

			if ( playerShields < 0 && playerDead !== true ) {

				startPlayerDeath();

			}

		},
		onPlayerEnergyDrain: ( amount ) => {

			playerEnergy -= amount;
			if ( playerEnergy < 0 ) playerEnergy = 0;
			updateHUD();

		}
	} );

	// Wire up effects system (animated textures)
	effects_set_externals( {
		getFrameTime: () => FrameTime,
		createExplosion: object_create_explosion,
		onSideOverlayChanged: rebuildSideOverlay,
		onObjectTextureChanged: polyobj_object_bitmap_changed,
		pigFile: _pigFile
	} );
	effects_set_render_callback( updateEclipTexture );
	init_special_effects();

	// Initialize the game engine (only once)
	if ( gameInitialized !== true ) {

		setStatus( 'Starting game...' );
		game_init();

	}

	game_set_mine( mineGeometry );

	// Reset automap for new level
	game_set_automap();

	// Wire up powerup system BEFORE placing objects (powerup_place needs pigFile/palette)
	powerup_set_externals( {
		pigFile: _pigFile,
		palette: _palette,
		scene: getScene(),
		collide_player_and_powerup: collide_player_and_powerup
	} );

	// Place objects in the scene
	if ( gameData !== null ) {

		setStatus( 'Placing objects...' );
		placeObjects( gameData );

		// Set player start position from level data
		if ( gameData.playerObj !== null ) {

			// The live player now uses the canonical Objects[] slot, so retain a
			// value snapshot for same-level respawns rather than an alias that moves.
			savedPlayerStart = { ...gameData.playerObj };
			savedPlayerObjnum = gameData.playerObjnum;
			game_set_player_start( gameData.playerObj, gameData.playerObjnum );

			// Mark starting segment as visited for automap, and remember it so the
			// automap can highlight the start room in magenta (AUTOMAP.C:1071).
			if ( gameData.playerObj.segnum >= 0 ) {

				Automap_visited[ gameData.playerObj.segnum ] = 1;
				automap_set_player_start( gameData.playerObj.segnum );

			}

		}

	}

	// Initialize weapon system (pool created once, externals re-wired per level)
	if ( gameInitialized !== true ) {

		laser_init();

	}

	laser_set_externals( {
		pigFile: _pigFile,
		palette: _palette,
		scene: getScene(),
		robots: liveRobots,
		clutter: liveClutter,
		debris: fireball_get_debris(),
		onRobotHit: collide_robot_and_weapon,
		onClutterHit: collide_weapon_and_clutter,
		onDebrisHit: collide_weapon_and_debris,
		onPlayerHit: collide_player_and_weapon,
		onWallHit: collide_weapon_and_wall,
		getPlayerPos: getPlayerPos,
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; updateHUD(); },
		getVulcanAmmo: () => playerVulcanAmmo,
		setVulcanAmmo: ( a ) => { playerVulcanAmmo = a; },
		getSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		setSecondaryAmmo: ( slot, a ) => { playerSecondaryAmmo[ slot ] = a; },
		onBadassExplosion: (
			pos_x, pos_y, pos_z, segnum, maxDamage, maxDistance, maxForce,
			visualSize, visualVclip, parentType, parentId
		) => {

			digi_play_sample_world(
				SOUND_BADASS_EXPLOSION, 1.0, segnum, pos_x, pos_y, pos_z
			);
			collide_badass_explosion(
				pos_x, pos_y, pos_z, maxDamage, maxDistance, maxForce,
				visualSize, visualVclip, true, parentType, parentId
			);

		},
		onAutoSelectPrimary: autoSelectPrimary,
		onAutoSelectSecondary: autoSelectSecondary,
		getPlayerPrimaryFlags: () => playerPrimaryFlags,
		getPlayerSecondaryFlags: () => playerSecondaryFlags,
		getPlayerSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		getPlayerLaserLevel: () => playerLaserLevel,
		onPlayerFiredLaser: ai_notify_player_fired_laser,
		isPlayerCloaked: isPlayerCloaked,
		getDifficultyLevel: () => Difficulty_level,
		getPlayerVelocity: getPlayerVelocity,
		getPlayerObject: game_get_player_object
	} );

	// Initialize collision system (COLLIDE.C)
	collide_set_externals( {
		getPlayerShields: () => playerShields,
		setPlayerShields: ( s ) => { playerShields = s; },
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; },
		getPlayerLaserLevel: () => playerLaserLevel,
		setPlayerLaserLevel: ( l ) => { playerLaserLevel = l; },
		getPlayerPrimaryFlags: () => playerPrimaryFlags,
		setPlayerPrimaryFlags: ( f ) => { playerPrimaryFlags = f; },
		getPlayerQuadLasers: () => playerQuadLasers,
		setPlayerQuadLasers: ( v ) => { playerQuadLasers = v; },
		getPlayerSecondaryFlags: () => playerSecondaryFlags,
		setPlayerSecondaryFlags: ( f ) => { playerSecondaryFlags = f; },
		getPlayerSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		setPlayerSecondaryAmmo: ( slot, a ) => { playerSecondaryAmmo[ slot ] = a; },
		getPlayerVulcanAmmo: () => playerVulcanAmmo,
		setPlayerVulcanAmmo: ( a ) => { playerVulcanAmmo = a; },
		getPlayerKeys: () => playerKeys,
		setPlayerKey: ( key, val ) => { playerKeys[ key ] = val; },
		getPlayerLives: () => playerLives,
		setPlayerLives: ( l ) => { playerLives = l; },
		addPlayerScore: ( s ) => { addPlayerScore( s ); },
		addPlayerKills: ( k ) => { playerKills += k; },
		addHostageSaved: ( n ) => { hostage_add_total_saved( n ); },
		addLevelHostagesSaved: ( n ) => { hostage_add_level_saved( n ); },
		getHostagesInLevel: hostage_get_in_level,
		getHostagesSavedInLevel: hostage_get_level_saved,
		getPlayerPos: getPlayerPos,
		getPlayerSegnum: getPlayerSegnum,
		getScene: getScene,
		updateHUD: updateHUD,
		showMessage: showMessage,
		flashDamage: flashDamage,
		startPlayerDeath: startPlayerDeath,
		startSelfDestruct: startSelfDestruct,
		spawnDroppedPowerup: spawnDroppedPowerup,
		spawnDroppedRobot: spawnRobotEgg,
		liveRobots: liveRobots,
		isPlayerInvulnerable: isPlayerInvulnerable,
		isPlayerCloaked: isPlayerCloaked,
		activateCloak: activateCloak,
		activateInvulnerability: activateInvulnerability,
		getDifficultyLevel: () => Difficulty_level,
		onReactorDestroyedVisual: replaceReactorWithDestroyedModel
	} );

	// Wire up reactor / self-destruct system
	cntrlcen_set_externals( {
		getPlayerPos: getPlayerPos,
		getCamera: getCamera,
		getDifficultyLevel: () => Difficulty_level,
		isPlayerDead: () => playerDead,
		showMessage: showMessage,
		updateHUD: updateHUD,
		gauges_set_white_flash: gauges_set_white_flash,
		startPlayerDeath: startPlayerDeath,
		getPlayerShields: () => playerShields,
		setPlayerShields: ( s ) => { playerShields = s; },
		controlCenterTriggers: gameData.controlCenterTriggers,
		wallToggle: wall_toggle,
		isPlayerCloaked: isPlayerCloaked,
		getBelievedPlayerPos: ai_get_believed_player_pos
	} );

	// Initialize exploding wall slots for this level
	// Ported from: init_exploding_walls() in FIREBALL.C line 1149
	init_exploding_walls();

	// Initialize explosion effects (pass texture builder callback)
	if ( gameInitialized !== true ) {

		fireball_init( getScene(), buildSpriteTexture, _pigFile, _palette );

		// Wire badass wall explosion callback (area damage from exploding walls)
		// Ported from: object_create_badass_explosion() calls in do_exploding_wall_frame()
		fireball_set_badass_wall_callback( ( pos_x, pos_y, pos_z, damage, distance, force ) => {

			// explode_wall() already created the correctly sized visual fireball.
			collide_badass_explosion(
				pos_x, pos_y, pos_z, damage, distance, force,
				undefined, undefined, false
			);

		} );

		lighting_init( getScene() );

		lighting_set_externals( {
			getActiveExplosions: fireball_get_active,
			getActiveWeapons: laser_get_active_weapons,
			FLARE_ID: FLARE_ID
		} );

		// Sound/music already initialized in startGame() before title sequence
		if ( soundInitialized !== true ) {

			// This path should not be reached normally since sound is initialized in main.js startGame()
			soundInitialized = true;

		}

	}

	// Wire up fusion cannon externals (energy access for charge mechanic)
	game_set_fusion_externals( {
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; },
		flashDamage: flashDamage,
		updateHUD: updateHUD,
		applyPlayerDamage: ( damage ) => { apply_damage_to_player( damage ); },
		getPlayerQuadLasers: () => playerQuadLasers
	} );

	// Initialize robot AI
	ai_set_externals( {
		getPlayerPos: getPlayerPos,
		getPlayerVelocity: getPlayerVelocity,
		getPlayerSeg: getPlayerSegnum,
		robots: liveRobots,
		getDifficultyLevel: () => Difficulty_level,
		getPlayerDead: () => playerDead,
		onMeleeAttack: ( damage, claw_sound, pos_x, pos_y, pos_z ) =>
			collide_player_and_nasty_robot( damage, claw_sound, pos_x, pos_y, pos_z ),
		onBumpPlayer: ( robot, vel_x, vel_y, vel_z, mass ) =>
			collide_robot_and_player( robot, vel_x, vel_y, vel_z, mass ),
		onRobotCollisionDamage: collide_robot_collision_damage,
		isPlayerCloaked: isPlayerCloaked,
		onSpawnGatedRobot: spawnGatedRobot,
		onBossDeath: ( robot ) => {

			// Boss death sequence complete — queue the ordinary 1/4-second
			// explode_object stage, while the long-range detonation and reactor
			// countdown begin immediately.
			// Ported from: do_boss_dying_frame() completion in AI.C lines 2433-2437
			collide_start_robot_explosion( robot, 0.25 );

			// Trigger self-destruct (do_controlcen_destroyed_stuff in C)
			console.log( 'BOSS DESTROYED! Self-destruct initiated!' );
			digi_play_sample_world(
				SOUND_BADASS_EXPLOSION, 2.0, robot.obj.segnum,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				undefined, 512.0
			);
			startSelfDestruct();

		},
		onCreateExplosion: object_create_explosion
	} );
	ai_reset_gun_point_cache();
	ai_reset_anim_cache();
	init_robots_for_level();

	// Initialize matcen (robot generator) system
	if ( gameData.matcens.length > 0 ) {

		fuelcen_init( gameData.matcens );
		fuelcen_set_externals( {
			getPlayerPos: getPlayerPos,
			spawnRobot: spawnMatcenRobot,
			createExplosion: object_create_explosion,
			getFrameTime: () => FrameTime,
			getDifficultyLevel: () => Difficulty_level,
			countRobotsFromMatcen: ( matcenNum ) => {

				// Count alive robots spawned by a specific matcen
				// Ported from: FUELCEN.C lines 673-676 — matcen_creator check
				let count = 0;
				for ( let r = 0; r < liveRobots.length; r ++ ) {

					const creator = liveRobots[ r ].obj.matcen_creator;
					if ( liveRobots[ r ].alive === true && creator >= 0x80 &&
						( creator ^ 0x80 ) === matcenNum ) count ++;

				}

				return count;

			},
			countLiveRobots: () => {

				let count = 0;
				for ( let r = 0; r < liveRobots.length; r ++ ) {

					if ( liveRobots[ r ].alive === true ) count ++;

				}

				return count;

			},
			getOrgRobotCount: () => get_Gamesave_num_org_robots(),
		getPlayerSegnum: getPlayerSegnum,
		damagePlayerMatcen: ( damage ) => {

			if ( playerDead === true ) return;

			const pp = getPlayerPos();
			digi_play_sample_world(
				SOUND_PLAYER_GOT_HIT, 1.0, getPlayerSegnum(), pp.x, pp.y, pp.z
			);
			object_create_explosion( pp.x, pp.y, pp.z, 5.0, VCLIP_PLAYER_HIT );
			apply_damage_to_player( damage );

		},
		damageRobotInSegment: ( segnum ) => {

			for ( let r = 0; r < liveRobots.length; r ++ ) {

				const robot = liveRobots[ r ];
				const obj = robot.obj;
				if ( obj.type === OBJ_ROBOT && obj.segnum === segnum &&
					( obj.flags & OF_SHOULD_BE_DEAD ) === 0 ) {

					return collide_robot_and_materialization_center( r );

				}

			}

			return false;

		}
		} );

	}

	if ( gameInitialized !== true ) {

		// Create HUD (Canvas 2D overlay)
		gauges_init( getCamera(), _pigFile, _palette );
		gauges_set_externals( {
			digi_play_sample: digi_play_sample,
			SOUND_HOMING_WARNING: SOUND_HOMING_WARNING
		} );
		endlevel_set_externals( {
			setPlayerSegnum: setPlayerSegnum,
			setPlayerPose: game_set_external_player_pose,
			setPlayerPoseDriven: game_set_player_pose_driven,
			setViewerSegnum: game_set_viewer_segnum,
			setMineVisible: game_set_mine_visible,
			createExplosion: object_create_explosion,
			setWhiteFlash: gauges_set_white_flash,
			playWorldSound: digi_play_sample_world,
			updatePlayerShipRender: updatePlayerCloakRender,
			scene: getScene(),
			pigFile: _pigFile,
			palette: _palette
		} );

		// Set up wall-hit damage callback
		// Ported from: collide_player_and_wall() in COLLIDE.C lines 654-693
		physics_set_wall_hit_callback( function ( damage, volume, hit_x, hit_y, hit_z, hitseg, hitside ) {

			if ( playerDead === true ) return;
			const hitSegment = Segments[ hitseg ];
			if ( hitSegment !== undefined && hitside >= 0 && hitside < 6 ) {

				const hitTmapInfo = TmapInfos[ hitSegment.sides[ hitside ].tmap_num ];
				// Damaging textures own their scrape/hiss feedback; D1 suppresses the
				// ordinary wall-impact cue and bump damage for this contact.
				if ( hitTmapInfo !== undefined && hitTmapInfo.damage > 0 ) return;

			}

			// Invulnerability suppresses only damage; D1 still plays the positional
			// wall-impact cue. Only damage if the player has more than 10 shields.
			if ( playerInvulnerableTime <= 0 && playerShields > 10 ) {

				playerShields -= damage;
				updateHUD();
				flashDamage();

				if ( playerShields < 0 && playerDead !== true ) {

					startPlayerDeath();

				}

			}

			// Play wall hit sound with volume proportional to impact
			if ( volume > 0 ) {

				digi_play_sample_world(
					SOUND_PLAYER_HIT_WALL, volume, hitseg, hit_x, hit_y, hit_z
				);

			}

		} );

		// Set up player-object collision callback.
		// Ported from: collide_two_objects() dispatch in COLLIDE.C.
		physics_set_object_hit_callback( function (
			hitObjectNum, hit_x, hit_y, hit_z,
			player_x, player_y, player_z, player_segnum
		) {

			// The dead player uses a separate viewer.  Object contacts may update
			// its canonical pose, but must never drag that camera back to the ship.
			if ( playerDead === true ) return false;

			// Physics dispatches synchronously before updateCamera applies its final
			// result. Mirror the accepted contact pose so gameplay callbacks observe
			// the same player position that the canonical C object already has.
			const cam = getCamera();
			if ( cam !== null ) cam.position.set( player_x, player_y, - player_z );
			if ( player_segnum >= 0 && player_segnum <= Highest_segment_index ) {

				setPlayerSegnum( player_segnum );

			}
			game_sync_player_object();

			const obj = Objects[ hitObjectNum ];
			if ( obj === undefined || obj === null ) return true;

			if ( obj.type === OBJ_ROBOT ) {

				for ( let i = 0; i < liveRobots.length; i ++ ) {

					const robot = liveRobots[ i ];
					if ( robot.alive !== true || robot.objnum !== hitObjectNum ) continue;

					const ailp = robot.aiLocal;
					const vel_x = ailp !== undefined ? ailp.vel_x : 0;
					const vel_y = ailp !== undefined ? ailp.vel_y : 0;
					const vel_z = ailp !== undefined ? ailp.vel_z : 0;
					const mass = obj.mtype !== null && obj.mtype.mass > 0 ? obj.mtype.mass : 4.0;
					collide_robot_and_player(
						robot, vel_x, vel_y, vel_z, mass, i,
						hit_x, hit_y, hit_z, player_segnum
					);

					// AI still has a temporary endpoint fallback for robots that move into a
					// stationary player. Suppress a duplicate event later in this frame.
					if ( ailp !== undefined ) ailp.bump_cooldown = 0.5;
					return playerDead !== true;

				}

				return true;

			}

			if ( obj.type === OBJ_POWERUP || obj.type === OBJ_HOSTAGE ) {

				const powerups = powerup_get_live();
				for ( let i = 0; i < powerups.length; i ++ ) {

					const powerup = powerups[ i ];
					if ( powerup.alive === true && powerup.objnum === hitObjectNum ) {

						collide_player_and_powerup( powerup );
						break;

					}

				}

				return true;

			}

			if ( obj.type === OBJ_CNTRLCEN ) {

				collide_player_and_controlcen( obj, hit_x, hit_y, hit_z );
				return playerDead !== true;

			}

			if ( obj.type === OBJ_CLUTTER ) {

				collide_player_and_clutter( obj, hit_x, hit_y, hit_z );

			}

			return playerDead !== true;

		} );

		// D1 advances existing CT_MORPH shells before their AI/physics step.
		game_set_pre_ai_frame_callback( function ( dt ) {

			do_morph_frame( liveRobots, dt );

		} );

		// Register frame callback for powerup collection and reactor
		game_set_frame_callback( onFrameCallback );

		// Register quit-to-menu callback for pause menu
		game_set_quit_callback( function () { restartGame(); } );

		// Register cockpit mode change callback (F3/H keys)
		game_set_cockpit_mode_callback( function ( mode ) { gauges_set_cockpit_mode( mode ); } );

		// Register save/load callbacks for pause menu
		game_set_save_callback( saveGame );
		game_set_load_callback( loadGame );

		// Pass palette to game.js for bitmap font rendering in pause menu
		game_set_palette( _palette );

		// Start the render loop
		requestAnimationFrame( game_loop );

		gameInitialized = true;

	}

	setStatus( '' );
	updateHUD();

	// Restore saved game state if loading a save
	if ( _pendingSaveRestore !== null ) {

		const sd = _pendingSaveRestore;

		// Restore full player state (overrides advanceLevel() resets)
		playerShields = sd.shields;
		playerEnergy = sd.energy;
		playerPrimaryFlags = sd.primaryFlags;
		playerSecondaryFlags = sd.secondaryFlags;
		for ( let i = 0; i < 5; i ++ ) playerSecondaryAmmo[ i ] = sd.secondaryAmmo[ i ];
		playerVulcanAmmo = sd.vulcanAmmo;
		playerLaserLevel = sd.laserLevel;
		playerQuadLasers = sd.quadLasers === true;
		playerLives = sd.lives;
		playerScore = sd.score;
		playerKills = sd.kills;
		playerKeys.blue = sd.keys.blue === true;
		playerKeys.red = sd.keys.red === true;
		playerKeys.gold = sd.keys.gold === true;
		playerCloakTime = ( sd.cloakTime !== undefined ) ? sd.cloakTime : 0;
		playerInvulnerableTime = ( sd.invulnerableTime !== undefined ) ? sd.invulnerableTime : 0;
		playerDead = false;

		// Restore hostage tracking totals.
		const inLevelHostages = hostage_get_in_level();
		hostage_reset_all();
		hostage_add_in_level( inLevelHostages );
		if ( sd.hostagesSaved !== undefined ) hostage_add_total_saved( sd.hostagesSaved );
		if ( sd.hostagesLevelSaved !== undefined ) hostage_add_level_saved( sd.hostagesLevelSaved );

		// Restore selected weapons (fallback to auto-select for older v1 saves)
		if ( sd.primaryWeapon !== undefined ) set_primary_weapon( sd.primaryWeapon );
		else if ( sd.primaryFlags > 1 ) weapon_autoSelectPrimary(
			playerPrimaryFlags, playerVulcanAmmo, playerEnergy,
			set_primary_weapon, showMessage, updateHUD
		);
		if ( sd.secondaryWeapon !== undefined ) set_secondary_weapon( sd.secondaryWeapon );
		else if ( sd.secondaryFlags > 1 || sd.secondaryAmmo[ 0 ] > 0 ) weapon_autoSelectSecondary(
			Secondary_weapon, playerSecondaryAmmo,
			set_secondary_weapon, showMessage, updateHUD
		);

		// Restore camera position/orientation
		const cam = getCamera();
		if ( cam !== null && sd.pos !== null && sd.pos !== undefined ) {

			// pos was saved from getPlayerPos() which returns Descent coords
			// Convert back to Three.js: negate Z
			cam.position.set( sd.pos.x, sd.pos.y, - sd.pos.z );

			if ( sd.quat !== null && sd.quat !== undefined ) {

				cam.quaternion.set( sd.quat.x, sd.quat.y, sd.quat.z, sd.quat.w );

			}

			// Save v2 originally omitted the player segment.  Prefer the saved hint
			// when present, but locate the actual containing segment so old saves and
			// boundary positions restore coherently.
			let segmentHint = getPlayerSegnum();
			if ( Number.isInteger( sd.playerSegnum ) && sd.playerSegnum >= 0 &&
				sd.playerSegnum <= Highest_segment_index ) {

				segmentHint = sd.playerSegnum;

			}

			let restoredSegnum = find_point_seg( sd.pos.x, sd.pos.y, sd.pos.z, segmentHint );
			if ( restoredSegnum < 0 ) restoredSegnum = segmentHint;
			setPlayerSegnum( restoredSegnum );
			game_sync_player_object( true );

		}

		// Restore level object state for parity with original save/restore behavior.
		if ( sd.levelState !== undefined && sd.levelState !== null ) {

			// D1 persists the complete Automap_visited array.  Store only the live
			// level prefix in JSON, but require an exact, binary snapshot before
			// replacing the new level's starting-room baseline.
			const automapState = sd.levelState.automapVisited;
			if ( Array.isArray( automapState ) && automapState.length === Num_segments &&
				automapState.every( value => value === 0 || value === 1 ) ) {

				Automap_visited.fill( 0 );
				for ( let i = 0; i < automapState.length; i ++ ) {

					Automap_visited[ i ] = automapState[ i ];

				}

			}

			const hasSavedControlCenter = sd.levelState.controlCenter !== null &&
				typeof sd.levelState.controlCenter === 'object' &&
				typeof sd.levelState.controlCenter.destroyed === 'boolean';

			// Robots/reactor state
			const robotState = sd.levelState.robots;
			if ( Array.isArray( robotState ) ) {

				let reactorDeadFromSave = false;
				for ( let i = 0; i < robotState.length; i ++ ) {

					const rs = robotState[ i ];
					let robot = null;

					if ( rs !== null && rs !== undefined && rs.runtimeSpawned === true ) {

						robot = restoreRuntimeRobotRecord( rs );

					} else if ( rs !== null && rs !== undefined && Number.isInteger( rs.objnum ) ) {

						for ( let r = 0; r < liveRobots.length; r ++ ) {

							if ( liveRobots[ r ].objnum === rs.objnum ) {

								robot = liveRobots[ r ];
								break;

							}

						}

					} else if ( i < liveRobots.length ) {

						// Legacy v1/v2 saves used positional robot records.
						robot = liveRobots[ i ];

					}

					if ( rs === null || rs === undefined || robot === null || robot === undefined ) continue;

					robot.alive = rs.alive === true;
					if ( rs.shields !== undefined ) robot.obj.shields = rs.shields;
					if ( Number.isInteger( rs.flags ) === true && rs.flags >= 0 && rs.flags <= 0xffff ) {

						robot.obj.flags = rs.flags;

					}
					if ( rs.segnum !== undefined && rs.segnum >= 0 && rs.segnum <= Highest_segment_index &&
						rs.segnum !== robot.obj.segnum ) {

						if ( robot.objnum !== undefined && robot.objnum >= 0 ) obj_relink( robot.objnum, rs.segnum );
						else robot.obj.segnum = rs.segnum;

					}

					robot.explosionDelay = Number.isFinite( rs.explosionDelay ) && rs.explosionDelay >= 0
						? rs.explosionDelay : - 1;
					robot.explosionDeleteDelay = Number.isFinite( rs.explosionDeleteDelay ) &&
						rs.explosionDeleteDelay >= 0 ? rs.explosionDeleteDelay : - 1;
					if ( robot.alive === true ) {

						robot.explosionDelay = - 1;
						robot.explosionDeleteDelay = - 1;
						robot.obj.flags &= ~ ( OF_EXPLODING | OF_DESTROYED | OF_SHOULD_BE_DEAD );

					} else if ( robot.isReactor !== true &&
						( robot.explosionDelay >= 0 || robot.explosionDeleteDelay >= 0 ) ) {

						robot.obj.flags |= OF_EXPLODING;
						robot.obj.flags &= ~ ( OF_DESTROYED | OF_SHOULD_BE_DEAD );
						robot.obj.control_type = CT_NONE;

					} else if ( robot.isReactor === true ) {

						// STATE.C restores the complete object, including the destroyed
						// reactor model and flags.  Level loading rebuilt the live model,
						// so recreate its persistent wreck before applying the saved pose.
						// Older JSON saves omit flags/model_num; a dead reactor still
						// unambiguously means that the destroyed visual must be present.
						if ( replaceReactorWithDestroyedModel( robot ) === true ) {

							robot.obj.flags |= OF_EXPLODING | OF_DESTROYED;
							robot.obj.flags &= ~ OF_SHOULD_BE_DEAD;
							robot.obj.control_type = CT_NONE;

						} else {

							robot.obj.flags &= ~ ( OF_EXPLODING | OF_DESTROYED );
							robot.obj.flags |= OF_SHOULD_BE_DEAD;

						}

					} else {

						robot.obj.flags &= ~ ( OF_EXPLODING | OF_DESTROYED );
						robot.obj.flags |= OF_SHOULD_BE_DEAD;

					}

					if ( rs.pos_x !== undefined && rs.pos_y !== undefined && rs.pos_z !== undefined ) {

						robot.obj.pos_x = rs.pos_x;
						robot.obj.pos_y = rs.pos_y;
						robot.obj.pos_z = rs.pos_z;
						robot.obj.last_pos_x = rs.pos_x;
						robot.obj.last_pos_y = rs.pos_y;
						robot.obj.last_pos_z = rs.pos_z;

						if ( robot.mesh !== null ) {

							robot.mesh.position.set( rs.pos_x, rs.pos_y, - rs.pos_z );

						}

					}

					const orientation = rs.orientation;
					if ( orientation !== null && typeof orientation === 'object' ) {

						const values = [
							orientation.rvec_x, orientation.rvec_y, orientation.rvec_z,
							orientation.uvec_x, orientation.uvec_y, orientation.uvec_z,
							orientation.fvec_x, orientation.fvec_y, orientation.fvec_z
						];
						if ( values.every( Number.isFinite ) ) {

							robot.obj.orient_rvec_x = values[ 0 ];
							robot.obj.orient_rvec_y = values[ 1 ];
							robot.obj.orient_rvec_z = values[ 2 ];
							robot.obj.orient_uvec_x = values[ 3 ];
							robot.obj.orient_uvec_y = values[ 4 ];
							robot.obj.orient_uvec_z = values[ 5 ];
							robot.obj.orient_fvec_x = values[ 6 ];
							robot.obj.orient_fvec_y = values[ 7 ];
							robot.obj.orient_fvec_z = values[ 8 ];
							syncRobotMeshOrientation( robot );

						}

					}

					const physics = rs.physics;
					const phys = robot.obj.mtype;
					if ( physics !== null && typeof physics === 'object' &&
						phys !== null && phys !== undefined ) {

						if ( Number.isFinite( physics.velocity_x ) &&
							Number.isFinite( physics.velocity_y ) &&
							Number.isFinite( physics.velocity_z ) ) {

							phys.velocity_x = physics.velocity_x;
							phys.velocity_y = physics.velocity_y;
							phys.velocity_z = physics.velocity_z;
							if ( robot.aiLocal !== null && robot.aiLocal !== undefined ) {

								robot.aiLocal.vel_x = physics.velocity_x;
								robot.aiLocal.vel_y = physics.velocity_y;
								robot.aiLocal.vel_z = physics.velocity_z;

							}

						}
						if ( Number.isFinite( physics.thrust_x ) ) phys.thrust_x = physics.thrust_x;
						if ( Number.isFinite( physics.thrust_y ) ) phys.thrust_y = physics.thrust_y;
						if ( Number.isFinite( physics.thrust_z ) ) phys.thrust_z = physics.thrust_z;
						if ( Number.isFinite( physics.rotvel_x ) ) phys.rotvel_x = physics.rotvel_x;
						if ( Number.isFinite( physics.rotvel_y ) ) phys.rotvel_y = physics.rotvel_y;
						if ( Number.isFinite( physics.rotvel_z ) ) phys.rotvel_z = physics.rotvel_z;
						if ( Number.isFinite( physics.rotthrust_x ) ) phys.rotthrust_x = physics.rotthrust_x;
						if ( Number.isFinite( physics.rotthrust_y ) ) phys.rotthrust_y = physics.rotthrust_y;
						if ( Number.isFinite( physics.rotthrust_z ) ) phys.rotthrust_z = physics.rotthrust_z;
						if ( Number.isFinite( physics.turnroll ) ) phys.turnroll = physics.turnroll;
						if ( Number.isInteger( physics.flags ) && physics.flags >= 0 &&
							physics.flags <= 0xffff ) phys.flags = physics.flags;

					}

					if ( robot.obj.rtype !== null && robot.obj.rtype !== undefined ) {

						restoreJointAngles( robot.obj.rtype.anim_angles, rs.animAngles );
						polyobj_set_anim_angles( robot.submodelGroups, robot.obj.rtype.anim_angles );

					}
					restoreRobotAIState( robot, rs.aiLocal );
					restoreRobotAnimation( robot, rs.aiAnimation );

					if ( robot.mesh !== null ) {

						robot.mesh.visible = ( robot.alive === true || robot.explosionDelay >= 0 ||
							robot.explosionDeleteDelay >= 0 || ( robot.isReactor === true &&
								( robot.obj.flags & OF_DESTROYED ) !== 0 ) );

					}

					if ( robot.isReactor === true && robot.alive !== true ) {

						reactorDeadFromSave = true;

					}

				}

				if ( reactorDeadFromSave === true && hasSavedControlCenter !== true &&
					cntrlcen_is_self_destruct_active() !== true ) {

					startSelfDestruct();

				}

			}

			if ( sd.levelState.ai !== null && typeof sd.levelState.ai === 'object' ) {

				ai_restore_save_state( sd.levelState.ai );

			} else if ( sd.levelState.bossDeath !== null &&
				typeof sd.levelState.bossDeath === 'object' ) {

				ai_restore_boss_death_save_state( sd.levelState.bossDeath );

			}

			if ( sd.levelState.fuelCenters !== null &&
				typeof sd.levelState.fuelCenters === 'object' ) {

				fuelcen_restore_save_state( sd.levelState.fuelCenters );

			}

			// Polygon clutter state, including an in-progress delayed explosion or
			// a persistent destroyed-model replacement.
			const clutterState = sd.levelState.clutter;
			if ( Array.isArray( clutterState ) ) {

				for ( let i = 0; i < clutterState.length; i ++ ) {

					const cs = clutterState[ i ];
					if ( cs === null || cs === undefined || Number.isInteger( cs.objnum ) !== true ) continue;

					let clutter = null;
					for ( let c = 0; c < liveClutter.length; c ++ ) {

						if ( liveClutter[ c ].objnum === cs.objnum ) {

							clutter = liveClutter[ c ];
							break;

						}

					}
					if ( clutter === null ) continue;

					const obj = clutter.obj;
					if ( Number.isFinite( cs.shields ) === true ) obj.shields = cs.shields;
					if ( Number.isInteger( cs.model_num ) === true && obj.rtype !== null &&
						cs.model_num !== obj.rtype.model_num ) {

						replaceClutterModel( clutter, cs.model_num );

					}
					if ( Number.isInteger( cs.flags ) === true ) obj.flags = cs.flags;

					clutter.alive = cs.alive === true;
					clutter.explosionDelay = Number.isFinite( cs.explosionDelay )
						? cs.explosionDelay : - 1;
					clutter.deleteDelay = Number.isFinite( cs.deleteDelay )
						? cs.deleteDelay : - 1;

					if ( clutter.alive !== true || ( obj.flags & OF_SHOULD_BE_DEAD ) !== 0 ) {

						clutter.alive = false;
						obj.flags |= OF_SHOULD_BE_DEAD;
						if ( clutter.mesh !== null && clutter.mesh.parent !== null ) {

							clutter.mesh.parent.remove( clutter.mesh );

						}

					} else if ( clutter.mesh !== null ) {

						clutter.mesh.visible = true;

					}

				}

			}

			// Base level powerups/hostages alive state
			const powerupState = sd.levelState.powerups;
			if ( Array.isArray( powerupState ) ) {

				const pws = powerup_get_live();
				const scene = getScene();
				let stateIdx = 0;

				for ( let i = 0; i < pws.length && stateIdx < powerupState.length; i ++ ) {

					const pw = pws[ i ];
					if ( pw.dropped === true ) continue;

					const alive = powerupState[ stateIdx ] === true;
					stateIdx ++;

					if ( alive !== true && pw.alive === true ) {

						if ( pw.sprite !== null && scene !== null ) {

							scene.remove( pw.sprite );

						}

						pw.alive = false;
						if ( pw.objnum !== undefined && pw.objnum >= 0 ) pw.obj.flags |= OF_SHOULD_BE_DEAD;

					}

				}

			}

			// Dropped powerups spawned by destroyed robots
			const droppedState = sd.levelState.droppedPowerups;
			if ( Array.isArray( droppedState ) ) {

				for ( let i = 0; i < droppedState.length; i ++ ) {

					const dp = droppedState[ i ];
					if ( dp === null || dp === undefined ) continue;

					const beforeCount = powerup_get_live().length;
					spawnDroppedPowerup( dp.id, dp.pos_x, dp.pos_y, dp.pos_z, dp.segnum );
					const after = powerup_get_live();
					if ( after.length > beforeCount ) {

						const spawned = after[ after.length - 1 ];
						if ( spawned.dropped === true && dp.lifeleft !== undefined ) spawned.obj.lifeleft = dp.lifeleft;

					}

				}

			}

			// Wall state (blast damage, open/closed flags, etc.)
			const wallState = sd.levelState.walls;
			if ( Array.isArray( wallState ) ) {

				for ( let i = 0; i < wallState.length; i ++ ) {

					const ws = wallState[ i ];
					if ( ws === null || ws === undefined ) continue;
					if ( Number.isInteger( ws.index ) !== true || ws.index < 0 || ws.index >= Num_walls ) continue;

					const w = Walls[ ws.index ];
					if ( w === undefined || w === null ) continue;

					if ( ws.hps !== undefined ) w.hps = ws.hps;
					if ( ws.flags !== undefined ) w.flags = ws.flags;
					if ( ws.state !== undefined ) w.state = ws.state;

					const side = Segments[ w.segnum ].sides[ w.sidenum ];
					const hasTmap1 = Number.isInteger( ws.tmap_num );
					const hasTmap2 = Number.isInteger( ws.tmap_num2 );
					if ( hasTmap1 === true ) side.tmap_num = ws.tmap_num;
					if ( hasTmap2 === true ) side.tmap_num2 = ws.tmap_num2;
					if ( hasTmap1 === true || hasTmap2 === true ) {

						updateDoorMesh( w.segnum, w.sidenum );

					}

				}

			}

			if ( Array.isArray( sd.levelState.activeDoors ) ) {

				wall_restore_active_door_state( sd.levelState.activeDoors );

			}

			if ( hasSavedControlCenter === true ) {

				cntrlcen_restore_save_state( sd.levelState.controlCenter );

			}

			// Trigger state (one-shot disabled flags + timers)
			const triggerState = sd.levelState.triggers;
			if ( Array.isArray( triggerState ) ) {

				for ( let i = 0; i < triggerState.length; i ++ ) {

					const ts = triggerState[ i ];
					if ( ts === null || ts === undefined ) continue;
					if ( ts.index === undefined || ts.index < 0 || ts.index >= Num_triggers ) continue;

					const trig = Triggers[ ts.index ];
					if ( trig === undefined || trig === null ) continue;

					if ( ts.flags !== undefined ) trig.flags = ts.flags;
					if ( ts.time !== undefined ) trig.time = ts.time;

				}

			}

		}

		_pendingSaveRestore = null;
		updateHUD();
		showMessage( 'GAME LOADED' );

	}

	// Load the external-scene description only after the mine and any saved
	// state are final, matching GAMESEQ.C's level-load ordering.
	let fallbackLevelName = mission_get_level_name( 1 );
	if ( fallbackLevelName.length <= 0 ) {

		fallbackLevelName = ( _pigFile !== null && _pigFile.isShareware === true )
			? 'level01.sdl' : 'level01.rdl';

	}
	if ( load_endlevel_data( _hogFile, levelName, fallbackLevelName ) === true ) {

		prepare_endlevel_scene( _hogFile );

	}

	// Load-time permanent sounds must reflect the final level state, including
	// any destroyed overlays restored from a save game.
	set_sound_sources();
	game_set_transition_suspended( false );
	_lastLevelLoadSucceeded = true;

}

function reclaimDeadRuntimeRobots() {

	let writeIndex = 0;
	for ( let readIndex = 0; readIndex < liveRobots.length; readIndex ++ ) {

		const robot = liveRobots[ readIndex ];
		const explosionPending = ( Number.isFinite( robot.explosionDelay ) === true &&
			robot.explosionDelay >= 0 ) ||
			( Number.isFinite( robot.explosionDeleteDelay ) === true &&
				robot.explosionDeleteDelay >= 0 );
		if ( robot.runtimeSpawned === true && robot.alive !== true && explosionPending !== true &&
			robot.objnum >= 0 ) {

			laser_remap_robot_index( readIndex, - 1 );
			if ( robot.mesh !== null && robot.mesh.parent !== null ) robot.mesh.parent.remove( robot.mesh );
			robot.reclaimed = true;
			obj_delete( robot.objnum );
			continue;

		}

		if ( writeIndex !== readIndex ) laser_remap_robot_index( readIndex, writeIndex );
		liveRobots[ writeIndex ++ ] = robot;

	}
	liveRobots.length = writeIndex;

	writeIndex = 0;
	for ( let readIndex = 0; readIndex < livePolygonObjects.length; readIndex ++ ) {

		const entry = livePolygonObjects[ readIndex ];
		if ( entry.reclaimed === true ) continue;
		livePolygonObjects[ writeIndex ++ ] = entry;

	}
	livePolygonObjects.length = writeIndex;

}

function processExplodingRobots( dt ) {

	for ( let i = 0; i < liveRobots.length; i ++ ) {

		collide_process_robot_explosion( liveRobots[ i ], dt );

	}

}

// --- Frame callback: check powerup collection + reactor status ---
function onFrameCallback( dt ) {

	processExplodingRobots( dt );

	// Runtime robot wrappers are not part of positional base-level save state,
	// so they can safely release their object slots after their delayed second
	// explosion stage has run.
	reclaimDeadRuntimeRobots();
	processExplodingClutter( dt );

	// Update reactor self-destruct countdown gauge ("T-%d s") before drawing HUD.
	// Ported from: render_countdown_gauge() in GAME.C lines 1395-1407
	gauges_set_countdown_seconds(
		( cntrlcen_is_self_destruct_active() === true && endlevel_is_active() !== true && cntrlcen_get_self_destruct_timer() > 0 )
			? Math.ceil( cntrlcen_get_self_destruct_timer() ) : - 1
	);

	// Draw Canvas 2D HUD overlay (handles damage flash + message timers internally)
	gauges_draw( dt, endlevel_is_active() );

	// Endlevel escape sequence (normal exits only).
	// Ported from: ENDLEVEL.C start_endlevel_sequence() + do_endlevel_frame().
	if ( endlevel_is_active() === true ) {

		updatePlayerCloakTimer( dt );
		const finished = do_endlevel_frame( dt, getCamera() );
		const viewerSegnum = endlevel_get_viewer_segnum();
		if ( viewerSegnum >= 0 ) updateMineVisibility( viewerSegnum, getCamera() );
		if ( finished === true ) {

			game_set_controls_enabled( true );
			finishLevelExit( false );

		}

		return;

	}

	// Process player death sequence
	if ( playerDead === true ) {

		if ( updatePlayerDeathSequence( dt ) === true ) {

			// If self-destruct killed the player, advance to next level (no respawn).
			if ( cntrlcen_is_destroyed() === true ) {

				// Player died while the mine was self-destructing. Ported from DoPlayerDead()
				// in GAMESEQ.C:1337-1378: consume the lost ship first, then clear
				// shields/energy/hostages so there is no survival bonus and skip the
				// escape flythrough.
				if ( levelTransitioning !== true ) {

					cleanupPlayerDeathVisual();
					playerLives --;
					updateHUD();
					if ( playerLives <= 0 ) {

						console.log( 'GAME OVER — no lives remaining' );
						showGameOver();
						return;

					}
					resetPlayerLoadoutForNewShip();
					levelTransitioning = true;
					game_set_controls_enabled( false );
					playerShields = 0;
					playerEnergy = 0;
					hostage_add_level_saved( - hostage_get_level_saved() );
					showMessage( 'Killed in the mine!' );
					finishLevelExit( false );
					return;

				}

			} else {

				respawnPlayer();
				if ( playerLives <= 0 ) return;

			}

		}

	}

	// Process cloak/invulnerability timers
	// Ported from: do_cloak_stuff() and do_invulnerable_stuff() in GAME.C
	updatePlayerCloakTimer( dt );

	if ( playerInvulnerableTime > 0 ) {

		playerInvulnerableTime -= dt;

		if ( playerInvulnerableTime <= 3.0 && playerInvulnerableTime + dt > 3.0 ) {

			showMessage( 'INVULNERABILITY WEARING OFF...' );

		}

		if ( playerInvulnerableTime <= 0 ) {

			playerInvulnerableTime = 0;
			digi_play_sample( SOUND_INVULNERABILITY_OFF, 1.0 );
			showMessage( 'INVULNERABILITY OFF!' );

		}

	}

	// Process matcen (robot generator) timers
	fuelcen_frame_process();

	// Sync sound objects (update positions of linked sounds each frame)
	digi_sync_sounds();

	// --- Reactor fires at player ---
	do_controlcen_frame( dt );

	// Skip pickup checks if player is dead
	if ( playerDead === true || playerShields < 0 ) return;

	// --- Fuel center refueling ---
	// Ported from: fuelcen_give_fuel() in FUELCEN.C
	const playerSeg = getPlayerSegnum();
	if ( playerSeg >= 0 && playerSeg < Num_segments ) {

		const seg = Segments[ playerSeg ];
		if ( seg.special === SEGMENT_IS_FUELCEN ) {

			if ( playerEnergy < 200 ) {

				playerEnergy = Math.min( playerEnergy + 25.0 * dt, 200 );
				updateHUD();
				digi_play_sample( SOUND_REFUEL_STATION_GIVING_FUEL, 0.5 );

			}

		}

	}

	// --- Volatile wall (lava) damage ---
	// Ported from: scrape_object_on_wall() in COLLIDE.C
	scrape_object_on_wall( playerSeg, dt );

	// Animate powerup/hostage vclips and check pickup
	powerup_do_frame( dt, getPlayerPos() );

	set_dynamic_light( getVisibleSegments(), liveRobots, powerup_get_live(), laser_get_stuck_flares() );
	updateDynamicLighting( get_dynamic_light() );

	// D1 computes one light value per polygon object, then applies its stored
	// face normal in the model interpreter.  Keep RGB dynamic light from this
	// port while smoothing only the monochrome segment-static component.
	const viewer = getPlayerPos();
	const viewerToken = getCamera();
	for ( let i = 0; i < livePolygonObjects.length; i ++ ) {

		const entry = livePolygonObjects[ i ];
		if ( entry.mesh === null || entry.mesh.parent === null ) continue;
		const obj = entry.obj;
		if ( obj === null || obj === undefined ) continue;

		polyobj_update_model_lod( entry.mesh, viewerToken, entry.morphing === true );
		entry.signature = obj.signature;
		compute_object_light(
			entry, obj.segnum, obj.pos_x, obj.pos_y, obj.pos_z,
			viewer.x, viewer.y, viewer.z, dt, viewerToken
		);
		polyobj_set_object_light(
			entry.mesh, entry.objectLightR, entry.objectLightG, entry.objectLightB
		);

		let velocity_x = 0;
		let velocity_y = 0;
		let velocity_z = 0;
		const ailp = entry.aiLocal;
		if ( ailp !== undefined && ailp !== null ) {

			velocity_x = ailp.vel_x;
			velocity_y = ailp.vel_y;
			velocity_z = ailp.vel_z;

		} else if ( obj.mtype !== null && obj.mtype !== undefined ) {

			velocity_x = obj.mtype.velocity_x;
			velocity_y = obj.mtype.velocity_y;
			velocity_z = obj.mtype.velocity_z;

		}
		polyobj_set_glow( entry.mesh, compute_engine_glow( velocity_x, velocity_y, velocity_z ) );

	}

	const activeWeapons = laser_get_active_weapons();
	for ( let i = 0; i < activeWeapons.length; i ++ ) {

		const weapon = activeWeapons[ i ];
		if ( weapon.active !== true || weapon.modelMesh === null ) continue;
		polyobj_update_model_lod( weapon.modelMesh, viewerToken );
		compute_object_light(
			weapon, weapon.segnum, weapon.pos_x, weapon.pos_y, weapon.pos_z,
			viewer.x, viewer.y, viewer.z, dt, viewerToken
		);
		polyobj_set_object_light(
			weapon.modelMesh, weapon.objectLightR, weapon.objectLightG, weapon.objectLightB
		);
		polyobj_set_glow(
			weapon.modelMesh, compute_engine_glow( weapon.vel_x, weapon.vel_y, weapon.vel_z )
		);

	}

	const activeDebris = fireball_get_debris();
	for ( let i = 0; i < activeDebris.length; i ++ ) {

		const debris = activeDebris[ i ];
		if ( debris.active !== true || debris.mesh === null ) continue;
		compute_object_light(
			debris, debris.segnum, debris.pos_x, debris.pos_y, debris.pos_z,
			viewer.x, viewer.y, viewer.z, dt, viewerToken
		);
		polyobj_set_object_light(
			debris.mesh, debris.objectLightR, debris.objectLightG, debris.objectLightB
		);
		polyobj_set_glow(
			debris.mesh, compute_engine_glow( debris.vel_x, debris.vel_y, debris.vel_z )
		);

	}

	// Self-destruct countdown + white-out flash
	const pp = getPlayerPos();
	if ( cntrlcen_is_self_destruct_active() === true ) {

		do_controlcen_destroyed_frame( dt, pp );

	}

}

// Build a fully materialized robot mesh for runtime objects that do not use the
// matcen/boss morph effect.  Robot eggs are created as RT_POLYOBJ immediately in
// FIREBALL.C, so their model must be collision/AI-ready in the same call.
function buildRobotEggMesh( model ) {

	let mesh = null;
	let submodelGroups = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = polyobj_clone_model_mesh( model.animatedMesh );
			submodelGroups = [];
			mesh.traverse( function ( child ) {

				if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

					submodelGroups[ child.userData.submodelIndex ] = child;

				}

			} );

		}

	} else {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _pigFile, _palette );

		}

		if ( model.mesh !== null ) mesh = polyobj_clone_model_mesh( model.mesh );

	}

	// Match the existing runtime-spawn fallback if hierarchical construction
	// failed for a model that normally has animation metadata.
	if ( mesh === null ) {

		if ( model.mesh === null ) model.mesh = buildModelMesh( model, _pigFile, _palette );
		if ( model.mesh !== null ) mesh = polyobj_clone_model_mesh( model.mesh );

	}

	if ( mesh === null ) return null;
	mesh = polyobj_wrap_model_lod( mesh, model, _pigFile, _palette, submodelGroups );
	return { mesh: mesh, submodelGroups: submodelGroups };

}

function attachRobotSubmodelGroups( robot, submodelGroups ) {

	if ( submodelGroups === null ) return;

	robot.submodelGroups = submodelGroups;
	if ( robot.obj.rtype !== null ) {

		polyobj_set_anim_angles( submodelGroups, robot.obj.rtype.anim_angles );

	}

}

function restoreRuntimeRobotRecord( saved ) {

	if ( saved === null || saved === undefined || saved.runtimeSpawned !== true ) return null;
	if ( Number.isInteger( saved.robotType ) !== true || saved.robotType < 0 ||
		saved.robotType >= N_robot_types ) return null;
	if ( Number.isInteger( saved.segnum ) !== true || saved.segnum < 0 ||
		saved.segnum > Highest_segment_index || Number.isFinite( saved.pos_x ) !== true ||
		Number.isFinite( saved.pos_y ) !== true || Number.isFinite( saved.pos_z ) !== true ) return null;

	const scene = getScene();
	if ( scene === null ) return null;
	const robotInfo = Robot_info[ saved.robotType ];
	const modelNum = robotInfo.model_num;
	if ( Number.isInteger( modelNum ) !== true || modelNum < 0 ||
		modelNum >= Polygon_models.length ) return null;
	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined || Number.isFinite( model.rad ) !== true ||
		model.rad <= 0 ) return null;

	// STATE.C completes morphs before saving, so every restored runtime robot is
	// created directly as its fully materialized RT_POLYOBJ without a spawn cue.
	const built = buildRobotEggMesh( model );
	if ( built === null ) return null;
	const objnum = obj_create(
		OBJ_ROBOT, saved.robotType, saved.segnum, saved.pos_x, saved.pos_y, saved.pos_z,
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
		model.rad, CT_AI, MT_PHYSICS, RT_POLYOBJ
	);
	if ( objnum < 0 ) return null;

	const obj = Objects[ objnum ];
	obj.shields = robotInfo.strength;
	obj.ctype.behavior = 0x81;
	obj.ctype.flags[ 1 ] = AIS_REST;
	obj.ctype.flags[ 2 ] = AIS_SRCH;
	obj.ctype.flags[ 8 ] = - 1;
	obj.rtype.model_num = modelNum;
	obj.rtype.subobj_flags = 0;
	obj.mtype.mass = robotInfo.mass;
	obj.mtype.drag = robotInfo.drag;
	obj.mtype.flags |= PF_LEVELLING;
	if ( Number.isInteger( saved.matcenCreator ) === true &&
		saved.matcenCreator >= - 1 && saved.matcenCreator <= 0xff ) {

		obj.matcen_creator = saved.matcenCreator;

	}

	const mesh = built.mesh;
	mesh.position.set( saved.pos_x, saved.pos_y, - saved.pos_z );
	mesh.quaternion.identity();
	scene.add( mesh );

	const robot = {
		objnum: objnum, obj: obj, mesh: mesh, alive: true,
		runtimeSpawned: true, explosionDelay: - 1, explosionDeleteDelay: - 1
	};
	attachRobotSubmodelGroups( robot, built.submodelGroups );
	robot.aiLocal = new AILocalInfo();
	liveRobots.push( robot );
	livePolygonObjects.push( robot );
	return robot;

}

function robotEggRandComponent() {

	// d_rand() is 0..32767.  FIREBALL.C adds (d_rand()-16384)*2 to a
	// normalized fixed-point vector, which is exactly this range in floats.
	return ( Math.floor( Math.random() * 32768 ) - 16384 ) / 32768;

}

// Spawn a robot contained by a destroyed robot.  Unlike matcen/gated robots,
// eggs appear immediately (no morph), inherit a perturbed ejection direction,
// and begin in the normal fully-aware locked AI state from FIREBALL.C:808-876.
function spawnRobotEgg( robotType, pos_x, pos_y, pos_z, segnum,
	sourceVel_x = 0, sourceVel_y = 0, sourceVel_z = 0 ) {

	const scene = getScene();
	if ( scene === null ) return - 1;
	if ( robotType < 0 || robotType >= N_robot_types ) {

		console.warn( 'ROBOT EGG: Invalid robot type ' + robotType );
		return - 1;

	}

	const robotInfo = Robot_info[ robotType ];
	const modelNum = robotInfo.model_num;
	if ( modelNum < 0 || modelNum >= Polygon_models.length ) {

		console.warn( 'ROBOT EGG: Invalid model for robot type ' + robotType );
		return - 1;

	}

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return - 1;
	if ( Number.isFinite( model.rad ) !== true || model.rad <= 0 ) {

		console.warn( 'ROBOT EGG: Invalid radius for robot type ' + robotType );
		return - 1;

	}

	const built = buildRobotEggMesh( model );
	if ( built === null ) return - 1;

	const robotSize = model.rad;
	const objnum = obj_create(
		OBJ_ROBOT, robotType, segnum, pos_x, pos_y, pos_z,
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
		robotSize, CT_AI, MT_PHYSICS, RT_POLYOBJ
	);

	if ( objnum < 0 ) {

		console.warn( 'ROBOT EGG: No free object slot for robot type ' + robotType );
		return - 1;

	}

	const obj = Objects[ objnum ];
	obj.shields = robotInfo.strength;
	obj.ctype.behavior = 0x81;	// AIB_NORMAL
	obj.ctype.flags[ 1 ] = 3;	// CURRENT_STATE = AIS_LOCK
	obj.ctype.flags[ 2 ] = 3;	// GOAL_STATE = AIS_LOCK
	obj.ctype.flags[ 8 ] = - 1;	// REMOTE_OWNER
	obj.rtype.model_num = modelNum;
	obj.rtype.subobj_flags = 0;
	obj.mtype.mass = robotInfo.mass;
	obj.mtype.drag = robotInfo.drag;
	obj.mtype.flags |= PF_LEVELLING;

	const sourceSpeed = Math.sqrt(
		sourceVel_x * sourceVel_x + sourceVel_y * sourceVel_y + sourceVel_z * sourceVel_z
	);
	let eject_x = sourceSpeed > 0 ? sourceVel_x / sourceSpeed : 0;
	let eject_y = sourceSpeed > 0 ? sourceVel_y / sourceSpeed : 0;
	let eject_z = sourceSpeed > 0 ? sourceVel_z / sourceSpeed : 0;
	eject_x += robotEggRandComponent();
	eject_y += robotEggRandComponent();
	eject_z += robotEggRandComponent();

	const ejectLength = Math.sqrt( eject_x * eject_x + eject_y * eject_y + eject_z * eject_z );
	if ( ejectLength > 0 ) {

		const ejectSpeed = ( 32 + sourceSpeed ) * 2;
		eject_x = eject_x / ejectLength * ejectSpeed;
		eject_y = eject_y / ejectLength * ejectSpeed;
		eject_z = eject_z / ejectLength * ejectSpeed;

	} else {

		eject_x = 0;
		eject_y = 0;
		eject_z = 0;

	}

	obj.mtype.velocity_x = eject_x;
	obj.mtype.velocity_y = eject_y;
	obj.mtype.velocity_z = eject_z;

	const mesh = built.mesh;
	mesh.position.set( pos_x, pos_y, - pos_z );
	mesh.quaternion.identity();
	scene.add( mesh );

	const robot = {
		objnum: objnum, obj: obj, mesh: mesh, alive: true,
		runtimeSpawned: true, explosionDelay: - 1, explosionDeleteDelay: - 1
	};
	attachRobotSubmodelGroups( robot, built.submodelGroups );

	robot.aiLocal = new AILocalInfo();
	robot.aiLocal.behavior = 0x81;	// AIB_NORMAL
	robot.aiLocal.mode = 3;	// AIM_CHASE_OBJECT
	robot.aiLocal.player_awareness_type = 4;	// PA_WEAPON_ROBOT_COLLISION
	robot.aiLocal.player_awareness_time = 3.0;
	robot.aiLocal.current_state = 3;	// AIS_LOCK
	robot.aiLocal.goal_state = 3;	// AIS_LOCK
	robot.aiLocal.vel_x = eject_x;
	robot.aiLocal.vel_y = eject_y;
	robot.aiLocal.vel_z = eject_z;

	liveRobots.push( robot );
	livePolygonObjects.push( robot );
	console.log( 'ROBOT EGG: Spawned robot type ' + robotType + ' in seg ' + segnum );
	return objnum;

}

// --- Spawn a robot from a matcen (robot generator) ---
// Called by fuelcen.js when a matcen timer fires
function spawnMatcenRobot( segnum, robotType, pos_x, pos_y, pos_z, matcenNum ) {

	const scene = getScene();
	if ( scene === null ) return;

	// Get model number for this robot type
	let modelNum = - 1;

	if ( robotType < N_robot_types ) {

		modelNum = Robot_info[ robotType ].model_num;

	}

	if ( modelNum === - 1 || modelNum >= Polygon_models.length ) {

		console.warn( 'MATCEN: Invalid model for robot type ' + robotType );
		return;

	}

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return;

	let mesh;
	let submodelGroups = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = polyobj_clone_model_mesh( model.animatedMesh );
			submodelGroups = [];
			mesh.traverse( function ( child ) {

				if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

					submodelGroups[ child.userData.submodelIndex ] = child;

				}

			} );

		} else {

			if ( model.mesh === null ) {

				model.mesh = buildModelMesh( model, _pigFile, _palette );

			}

			if ( model.mesh === null ) return;
			mesh = polyobj_clone_model_mesh( model.mesh );

		}

	} else {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _pigFile, _palette );

		}

		if ( model.mesh === null ) return;
		mesh = polyobj_clone_model_mesh( model.mesh );

	}

	mesh = polyobj_wrap_model_lod( mesh, model, _pigFile, _palette, submodelGroups );
	mesh.position.set( pos_x, pos_y, - pos_z );

	// robotmaker_proc() turns a newly-created morph robot toward the player
	// before morph_start(), using the identity up vector as its roll reference.
	const pp = getPlayerPos();
	const dx = pp.x - pos_x;
	const dy = pp.y - pos_y;
	const dz = pp.z - pos_z;

	const robotSize = model.rad || 4.84;
	const objnum = obj_create(
		OBJ_ROBOT, robotType, segnum, pos_x, pos_y, pos_z,
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
		robotSize, CT_AI, MT_PHYSICS, RT_POLYOBJ
	);

	if ( objnum < 0 ) {

		console.warn( 'MATCEN: No free object slot for robot type ' + robotType );
		return false;

	}

	const obj = Objects[ objnum ];
	const robotInfo = Robot_info[ robotType ];
	obj.shields = robotInfo.strength;
	const defaultBehavior = robotType === 10 ? 0x83 : 0x81;
	obj.ctype.behavior = defaultBehavior;	// AIB_RUN_FROM for toaster, otherwise AIB_NORMAL
	obj.ctype.flags[ 1 ] = AIS_REST;
	obj.ctype.flags[ 2 ] = AIS_SRCH;
	obj.rtype.model_num = modelNum;
	obj.rtype.subobj_flags = 0;
	obj.mtype.mass = robotInfo.mass;
	obj.mtype.drag = robotInfo.drag;
	obj.mtype.flags |= PF_LEVELLING;
	obj.matcen_creator = matcenNum | 0x80;

	vm_vector_2_matrix( obj, dx, dy, dz, 0, 1, 0 );

	const m = new THREE.Matrix4();
	m.set(
		obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
		obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
		- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
		0, 0, 0, 1
	);
	mesh.quaternion.setFromRotationMatrix( m );

	scene.add( mesh );

	// Add to liveRobots for weapon collision + AI
	const robot = {
		objnum: objnum, obj: obj, mesh: mesh, alive: true,
		runtimeSpawned: true, explosionDelay: - 1, explosionDeleteDelay: - 1
	};

	attachRobotSubmodelGroups( robot, submodelGroups );

	liveRobots.push( robot );
	livePolygonObjects.push( robot );

	// create_morph_robot() initializes AI, then gives every matcen robot a random
	// six-segment path before morph_start().  The toaster keeps run-from mode
	// because create_n_segment_path() otherwise changes it to follow-path.
	robot.aiLocal = new AILocalInfo();
	robot.aiLocal.behavior = defaultBehavior;
	robot.aiLocal.current_state = AIS_REST;
	robot.aiLocal.goal_state = AIS_SRCH;
	create_n_segment_path(
		robot, 6, - 1, robotType === 7 || defaultBehavior === 0x83
	);
	robot.aiLocal.mode = defaultBehavior === 0x83
		? ai_behavior_to_mode( defaultBehavior )
		: ai_behavior_to_mode( 0x84 );
	robot.aiLocal.mode_is_run_from = defaultBehavior === 0x83;

	// Start MORPH.C-style staged per-vertex morph.
	start_robot_morph( robot );

	console.log( 'MATCEN: Spawned robot type ' + robotType + ' in seg ' + segnum +
		' (' + liveRobots.filter( r => r.alive === true ).length + ' total alive)' );

	return true;

}

// --- Spawn a robot gated in by the boss ---
// Ported from: create_gated_robot() in AI.C lines 2115-2194
// Same as spawnMatcenRobot but tags robot with matcen_creator = -1 (BOSS_GATE_MATCEN_NUM)
function spawnGatedRobot( segnum, robotType, pos_x, pos_y, pos_z ) {

	const scene = getScene();
	if ( scene === null ) return;

	// Get model number for this robot type
	let modelNum = - 1;

	if ( robotType < N_robot_types ) {

		modelNum = Robot_info[ robotType ].model_num;

	}

	if ( modelNum === - 1 || modelNum >= Polygon_models.length ) {

		console.warn( 'BOSS GATE: Invalid model for robot type ' + robotType );
		return;

	}

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return;

	let mesh;
	let submodelGroups = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = polyobj_clone_model_mesh( model.animatedMesh );
			submodelGroups = [];
			mesh.traverse( function ( child ) {

				if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

					submodelGroups[ child.userData.submodelIndex ] = child;

				}

			} );

		} else {

			if ( model.mesh === null ) {

				model.mesh = buildModelMesh( model, _pigFile, _palette );

			}

			if ( model.mesh === null ) return;
			mesh = polyobj_clone_model_mesh( model.mesh );

		}

	} else {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _pigFile, _palette );

		}

		if ( model.mesh === null ) return;
		mesh = polyobj_clone_model_mesh( model.mesh );

	}

	mesh = polyobj_wrap_model_lod( mesh, model, _pigFile, _palette, submodelGroups );
	mesh.position.set( pos_x, pos_y, - pos_z );
	mesh.quaternion.identity();

	const robotSize = model.rad || 4.84;
	const objnum = obj_create(
		OBJ_ROBOT, robotType, segnum, pos_x, pos_y, pos_z,
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
		robotSize, CT_AI, MT_PHYSICS, RT_POLYOBJ
	);

	if ( objnum < 0 ) {

		console.warn( 'BOSS GATE: No free object slot for robot type ' + robotType );
		return false;

	}

	const obj = Objects[ objnum ];
	const robotInfo = Robot_info[ robotType ];
	obj.shields = robotInfo.strength;
	const defaultBehavior = robotType === 10 ? 0x83 : 0x81;
	obj.ctype.behavior = defaultBehavior;	// AIB_RUN_FROM for toaster, otherwise AIB_NORMAL
	obj.ctype.flags[ 1 ] = AIS_REST;
	obj.ctype.flags[ 2 ] = AIS_SRCH;
	obj.rtype.model_num = modelNum;
	obj.rtype.subobj_flags = 0;
	obj.mtype.mass = robotInfo.mass;
	obj.mtype.drag = robotInfo.drag;
	obj.mtype.flags |= PF_LEVELLING;
	obj.matcen_creator = - 1;	// BOSS_GATE_MATCEN_NUM

	scene.add( mesh );

	// Add to liveRobots for weapon collision + AI
	const robot = {
		objnum: objnum, obj: obj, mesh: mesh, alive: true,
		runtimeSpawned: true, explosionDelay: - 1, explosionDeleteDelay: - 1
	};
	attachRobotSubmodelGroups( robot, submodelGroups );

	liveRobots.push( robot );
	livePolygonObjects.push( robot );

	// init_ai_object() derives the initial mode from the default behavior before
	// morph_start().  Robot 10 (the toaster) is the one D1 gated exception.
	robot.aiLocal = new AILocalInfo();
	robot.aiLocal.behavior = defaultBehavior;
	robot.aiLocal.current_state = AIS_REST;
	robot.aiLocal.goal_state = AIS_SRCH;
	robot.aiLocal.mode = ai_behavior_to_mode( defaultBehavior );
	robot.aiLocal.mode_is_run_from = defaultBehavior === 0x83;
	robot.aiLocal.player_awareness_type = 4;
	robot.aiLocal.player_awareness_time = 6.0;
	robot.aiLocal.next_fire = Math.random() * 1.5;

	// A boss-gated robot appears inside the same morph fireball and positional
	// cue as a matcen robot before its polygon morph begins.
	// Ported from: AI.C create_gated_robot() lines 2184-2186.
	object_create_explosion(
		pos_x, pos_y, pos_z, 10.0, VCLIP_MORPHING_ROBOT
	);
	const morphClip = Vclips[ VCLIP_MORPHING_ROBOT ];
	if ( morphClip !== undefined && morphClip.sound_num >= 0 ) {

		digi_play_sample_world(
			morphClip.sound_num, 1.0, segnum, pos_x, pos_y, pos_z
		);

	}
	start_robot_morph( robot );

	console.log( 'BOSS GATE: Spawned robot type ' + robotType + ' in seg ' + segnum +
		' (' + liveRobots.filter( r => r.alive === true ).length + ' total alive)' );

	return true;

}

// --- Place game objects (robots, reactor, etc.) as meshes in the scene ---
function placeObjects( gameData ) {

	const scene = getScene();
	if ( scene === null ) return;

	let placedModels = 0;
	let placedSprites = 0;
	hostage_reset_level();

	for ( let i = 0; i < gameData.objects.length; i ++ ) {

		const obj = gameData.objects[ i ];
		if ( obj.type === OBJ_NONE ) continue;

		// Skip player objects
		if ( obj.type === OBJ_PLAYER ) continue;

		// Polygon model objects (robots, reactor)
		if ( obj.render_type === RT_POLYOBJ ) {

			if ( obj.rtype === null ) continue;

			const modelNum = obj.rtype.model_num;
			const model = Polygon_models[ modelNum ];
			if ( model === null || model === undefined ) continue;

			// D1 passes every polygon object's stored joint angles to the model
			// interpreter.  Use a hierarchy for every multipart model, not only
			// robots that also have table-driven animation states.
			let mesh;
			let submodelGroups = null;
			const subobjFlags = Number.isInteger( obj.rtype.subobj_flags ) === true
				? obj.rtype.subobj_flags >>> 0 : 0;

			if ( subobjFlags !== 0 ) {

				const flaggedMesh = buildModelMesh( model, _pigFile, _palette, subobjFlags );
				if ( flaggedMesh === null ) continue;
				mesh = polyobj_clone_model_mesh( flaggedMesh );

			} else if ( model.n_models > 1 ) {

				if ( model.animatedMesh === null ) {

					model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

				}

				if ( model.animatedMesh !== null ) {

					mesh = polyobj_clone_model_mesh( model.animatedMesh );

					// Extract submodel group references from cloned hierarchy
					submodelGroups = [];
					mesh.traverse( function ( child ) {

						if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

							submodelGroups[ child.userData.submodelIndex ] = child;

						}

					} );

				} else {

					// Fallback to flat mesh
					if ( model.mesh === null ) {

						model.mesh = buildModelMesh( model, _pigFile, _palette );

					}

					if ( model.mesh === null ) continue;
					mesh = polyobj_clone_model_mesh( model.mesh );

				}

			} else {

				if ( model.mesh === null ) {

					model.mesh = buildModelMesh( model, _pigFile, _palette );

				}

				if ( model.mesh === null ) continue;
				mesh = polyobj_clone_model_mesh( model.mesh );

			}

			if ( subobjFlags === 0 ) {

				mesh = polyobj_wrap_model_lod(
					mesh, model, _pigFile, _palette, submodelGroups
				);

			}
			if ( submodelGroups !== null ) {

				polyobj_set_anim_angles( submodelGroups, obj.rtype.anim_angles );

			}
			applyPolygonObjectTextureOverride( mesh, obj );
			mesh.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );

			const m = new THREE.Matrix4();
			m.set(
				obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
				obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
				- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
				0, 0, 0, 1
			);

			mesh.quaternion.setFromRotationMatrix( m );
			scene.add( mesh );
			placedModels ++;
			let polygonEntry = null;

			// Track robots for weapon collision
			if ( obj.type === OBJ_ROBOT ) {

				const robotEntry = {
					objnum: i, obj: obj, mesh: mesh, alive: true,
					explosionDelay: - 1, explosionDeleteDelay: - 1
				};
				attachRobotSubmodelGroups( robotEntry, submodelGroups );

				liveRobots.push( robotEntry );
				polygonEntry = robotEntry;

			}

			// Track reactor for destruction (add to liveRobots so lasers can hit it)
			if ( obj.type === OBJ_CNTRLCEN ) {

				// Boost reactor shields based on level number
				// Ported from: init_controlcen_for_level() in CNTRLCEN.C lines 392-396
				// shields = 200 + 50 * level_num (positive levels)
				if ( currentLevelNum >= 0 ) {

					obj.shields = 200 + 50 * currentLevelNum;

				} else {

					obj.shields = 200 + Math.abs( currentLevelNum ) * 100;

				}

				const reactor = {
					objnum: i, obj: obj, mesh: mesh, alive: true,
					isReactor: true, explosionDelay: - 1, explosionDeleteDelay: - 1
				};
				cntrlcen_set_reactor( reactor );
				liveRobots.push( reactor );
				polygonEntry = reactor;

				// Compute world-space gun positions from model hardpoints
				init_controlcen_for_level( obj );

			}

			if ( polygonEntry === null ) {

				polygonEntry = { objnum: i, obj: obj, mesh: mesh, alive: true };

			}
			if ( obj.type === OBJ_CLUTTER ) {

				polygonEntry.explosionDelay = - 1;
				polygonEntry.deleteDelay = - 1;
				liveClutter.push( polygonEntry );

			}
			livePolygonObjects.push( polygonEntry );

		}

		// Vclip sprite objects (powerups, hostages)
		if ( obj.render_type === RT_POWERUP || obj.render_type === RT_HOSTAGE ) {

			if ( obj.rtype === null ) continue;

			if ( obj.type === OBJ_POWERUP ) {

				if ( powerup_place( obj, scene, i ) === true ) {

					placedSprites ++;

				}

			}

			if ( obj.type === OBJ_HOSTAGE ) {

				hostage_add_in_level( powerup_place_hostage( obj, scene, i ) );
				placedSprites ++;

			}

		}

	}

	console.log( 'OBJECTS: Placed ' + placedModels + ' models, ' + placedSprites + ' sprites in scene' );

}

// --- Game Over screen ---
let gameOverOverlay = null;

function showGameOver( isVictory = false ) {

	beginGameplayTeardown();

	// Stop level music
	songs_stop();

	// Save high score
	const savedScores = saveHighScore( playerScore, playerKills, hostage_get_total_saved(), Difficulty_level );
	const isNewHighScore = ( savedScores.length > 0 && savedScores[ 0 ].score === playerScore && playerScore > 0 );

	if ( gameOverOverlay !== null ) {

		// Update stats and show
		const titleEl = gameOverOverlay.querySelector( '.go-title' );
		if ( titleEl !== null ) {

			const color = isVictory === true ? '#fc0' : '#f00';
			titleEl.textContent = isVictory === true ? 'MISSION COMPLETE' : 'GAME OVER';
			titleEl.style.color = color;
			titleEl.style.textShadow = '0 0 20px ' + color;

		}
		const statsEl = gameOverOverlay.querySelector( '.go-stats' );
		if ( statsEl !== null ) {

			let statsText = 'Score: ' + playerScore + '  |  Kills: ' + playerKills + '  |  Hostages: ' + hostage_get_total_saved();
			if ( isNewHighScore === true ) statsText += '\nNEW HIGH SCORE!';
			statsEl.textContent = statsText;

		}

		const hsEl = gameOverOverlay.querySelector( '.go-highscore' );
		if ( hsEl !== null ) {

			hsEl.textContent = 'High Score: ' + savedScores[ 0 ].score;

		}

		gameOverOverlay.style.display = 'flex';
		return;

	}

	gameOverOverlay = document.createElement( 'div' );
	gameOverOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;font-family:monospace;';

	const title = document.createElement( 'div' );
	const titleColor = isVictory === true ? '#fc0' : '#f00';
	title.className = 'go-title';
	title.style.cssText = 'color:' + titleColor + ';font-size:48px;font-weight:bold;text-shadow:0 0 20px ' + titleColor + ';';
	title.textContent = isVictory === true ? 'MISSION COMPLETE' : 'GAME OVER';
	gameOverOverlay.appendChild( title );

	const stats = document.createElement( 'div' );
	stats.className = 'go-stats';
	stats.style.cssText = 'color:#0f0;font-size:14px;margin-top:20px;white-space:pre-line;text-align:center;';
	let statsText = 'Score: ' + playerScore + '  |  Kills: ' + playerKills + '  |  Hostages: ' + hostage_get_total_saved();
	if ( isNewHighScore === true ) statsText += '\nNEW HIGH SCORE!';
	stats.textContent = statsText;
	gameOverOverlay.appendChild( stats );

	if ( savedScores.length > 0 ) {

		const hs = document.createElement( 'div' );
		hs.className = 'go-highscore';
		hs.style.cssText = 'color:#ff0;font-size:14px;margin-top:10px;';
		hs.textContent = 'High Score: ' + savedScores[ 0 ].score;
		gameOverOverlay.appendChild( hs );

	}

	const prompt = document.createElement( 'div' );
	prompt.style.cssText = 'color:#0f0;font-size:16px;margin-top:30px;animation:blink 1.5s infinite;';
	prompt.textContent = 'CLICK TO RESTART';
	gameOverOverlay.appendChild( prompt );

	gameOverOverlay.addEventListener( 'click', () => {

		gameOverOverlay.style.display = 'none';
		restartGame();

	} );

	document.body.appendChild( gameOverOverlay );

}

// --- Restart game ---
export async function restartGame() {

	// Keep the old mine frozen through the asynchronous title menu and briefing.
	beginGameplayTeardown();

	// Show menu again (skip logos on restart)
	songs_play_song( SONG_TITLE, true );
	show_title_canvas();

	const menuResult = await do_main_menu( _hogFile, Difficulty_level, _palette );
	Difficulty_level = menuResult.difficulty;

	// Reset all player state
	playerScore = 0;
	playerLastScore = 0;
	playerKills = 0;
	playerLives = 3;
	hostage_reset_all();
	playerShields = 100;
	playerEnergy = 100;
	playerKeys = { blue: false, red: false, gold: false };
	playerPrimaryFlags = 1;		// HAS_LASER_FLAG
	playerSecondaryFlags = 1;	// HAS_CONCUSSION_FLAG
	playerQuadLasers = false;

	// Starting concussion missiles: 2 + NDL - Difficulty_level
	playerSecondaryAmmo[ 0 ] = 2 + 5 - Difficulty_level;
	for ( let i = 1; i < 5; i ++ ) playerSecondaryAmmo[ i ] = 0;

	playerVulcanAmmo = 0;
	playerLaserLevel = 0;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;

	set_primary_weapon( 0 );
	set_secondary_weapon( 0 );

	// Reset to level 1
	currentLevelNum = 1;
	Automap_visited.fill( 0 );
	cntrlcen_reset();
	gauges_set_white_flash( 0 );
	levelTransitioning = false;
	stop_endlevel_sequence();
	cleanupPlayerDeathVisual();
	playerDead = false;
	game_set_player_dead( false );
	game_set_controls_enabled( true );
	game_reset_physics();

	await advanceLevel();
	updateHUD();

}
