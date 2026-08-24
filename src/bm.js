// Ported from: descent-master/MAIN/BM.C and BM.H
// Bitmap and palette loading functions - data structures and HAM reader

import { MAX_TEXTURES } from './segment.js';
import { Textures, set_NumTextures } from './mglobal.js';
import { Vclips, set_Num_vclips, VCLIP_MAXNUM, VCLIP_MAX_FRAMES } from './vclip.js';
import { WallAnims, set_Num_wall_anims, MAX_WALL_ANIMS, MAX_CLIP_FRAMES } from './wall.js';
import {
	Robot_info, N_robot_types, set_N_robot_types, MAX_ROBOT_TYPES, MAX_ROBOT_JOINTS, MAX_GUNS,
	Robot_joints, N_robot_joints, set_N_robot_joints, N_ANIM_STATES
} from './robot.js';
import { Weapon_info, N_weapon_types, set_N_weapon_types, MAX_WEAPON_TYPES } from './weapon.js';
import {
	Polygon_models, set_N_polygon_models, MAX_SUBMODELS,
	read_compiled_polygon_model_header
} from './polyobj.js';

// Re-export from new modules for backward compatibility during transition
export { Vclip, Vclips, Num_vclips, set_Num_vclips, VCLIP_MAXNUM, VCLIP_MAX_FRAMES } from './vclip.js';
export { RobotInfo, Robot_info, N_robot_types, set_N_robot_types, MAX_ROBOT_TYPES,
	N_ANIM_STATES, AS_REST, AS_ALERT, AS_FIRE, AS_RECOIL, AS_FLINCH,
	AIS_NONE, AIS_REST, AIS_SRCH, AIS_LOCK, AIS_FLIN, AIS_FIRE, AIS_RECO, AIS_ERR_,
	Mike_to_matt_xlate, ANIM_RATE, Flinch_scale, Attack_scale } from './robot.js';
export {
	WeaponInfo, Weapon_info, N_weapon_types, set_N_weapon_types, MAX_WEAPON_TYPES,
	MAX_PRIMARY_WEAPONS, MAX_SECONDARY_WEAPONS,
	WEAPON_RENDER_NONE, WEAPON_RENDER_LASER, WEAPON_RENDER_BLOB, WEAPON_RENDER_POLYMODEL, WEAPON_RENDER_VCLIP,
	LASER_ID, CONCUSSION_ID, FLARE_ID, VULCAN_ID, SPREADFIRE_ID, PLASMA_ID, FUSION_ID,
	HOMING_ID, PROXIMITY_ID, SMART_ID, MEGA_ID,
	Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info,
	WEAPON_NAMES, SECONDARY_NAMES
} from './weapon.js';
export { bm_build_shareware_texture_table } from './bmread.js';

// tmap_info structure: filename[13], flags(ubyte), lighting(fix), damage(fix), eclip_num(int)
// Total: 13 + 1 + 4 + 4 + 4 = 26 bytes

export const TMI_VOLATILE = 1;	// this material blows up when hit

export const MAX_OBJ_BITMAPS = 210;

// Object bitmap arrays — used for polygon model textures
// Ported from: BM.C lines 105-106
// ObjBitmaps[]: actual bitmap indices (into GameBitmaps/PIG)
// ObjBitmapPtrs[]: indirection used during model rendering
//   model texture i -> ObjBitmaps[ObjBitmapPtrs[model.first_texture + i]]
export const ObjBitmaps = new Int16Array( MAX_OBJ_BITMAPS ).fill( - 1 );
export const ObjBitmapPtrs = new Uint16Array( MAX_OBJ_BITMAPS ).fill( 0 );
export let N_ObjBitmaps = 0;
export function set_N_ObjBitmaps( n ) { N_ObjBitmaps = n; }
export let N_ObjBitmapPtrs = 0;
export function set_N_ObjBitmapPtrs( n ) { N_ObjBitmapPtrs = n; }

// Descent 1's compiled properties always store 85 model variant entries,
// regardless of the larger model capacity used by some ports.
export const D1_MAX_POLYGON_MODELS = 85;
export const Dying_modelnums = new Int32Array( D1_MAX_POLYGON_MODELS ).fill( - 1 );
export const Dead_modelnums = new Int32Array( D1_MAX_POLYGON_MODELS ).fill( - 1 );

export class PlayerShip {

	constructor() {

		this.model_num = - 1;
		this.expl_vclip_num = - 1;
		this.mass = 0;
		this.drag = 0;
		this.max_thrust = 0;
		this.reverse_thrust = 0;
		this.brakes = 0;
		this.wiggle = 0;
		this.max_rotthrust = 0;
		this.gun_points = [];
		for ( let i = 0; i < MAX_GUNS; i ++ ) {

			this.gun_points.push( { x: 0, y: 0, z: 0 } );

		}
		this.loaded = false;

	}

}

export const Player_ship = new PlayerShip();

export let First_multi_bitmap_num = - 1;
export function set_First_multi_bitmap_num( n ) { First_multi_bitmap_num = n; }
export let N_controlcen_guns = 0;
export const controlcen_gun_points = [];
export const controlcen_gun_dirs = [];
for ( let i = 0; i < 4; i ++ ) {

	controlcen_gun_points.push( { x: 0, y: 0, z: 0 } );
	controlcen_gun_dirs.push( { x: 0, y: 0, z: 0 } );

}

export let exit_modelnum = - 1;
export let destroyed_exit_modelnum = - 1;
export function set_exit_modelnums( normal, destroyed ) {

	exit_modelnum = normal;
	destroyed_exit_modelnum = destroyed;

}

// Powerup type info (from POWERUP.H)
export const MAX_POWERUP_TYPES = 29;

export class PowerupInfo {

	constructor() {

		this.vclip_num = - 1;	// which vclip to animate
		this.hit_sound = - 1;	// sound to play when picked up
		this.size = 3.0;	// 3D size (default i2f(3))
		this.light = 1.0 / 3;	// light cast (default F1_0/3)

	}

}

export const Powerup_info = [];
export const Powerup_names = [];
export let N_powerup_types = 0;
export function set_N_powerup_types( n ) { N_powerup_types = n; }

for ( let i = 0; i < MAX_POWERUP_TYPES; i ++ ) {

	Powerup_info.push( new PowerupInfo() );
	Powerup_names.push( '' );

}

// Eclip constants (from EFFECTS.H)
export const MAX_EFFECTS = 60;
export const EF_CRITICAL = 1;	// only plays when mine critical
export const EF_ONE_SHOT = 2;	// plays once then shows destroyed bitmap
export const EF_STOPPED = 4;	// has been stopped

// Eclip class - animated wall/object texture effect
export class Eclip {

	constructor() {

		// Embedded vclip data
		this.vc_play_time = 0;		// total time in seconds
		this.vc_num_frames = 0;
		this.vc_frame_time = 0;		// time per frame in seconds
		this.vc_flags = 0;
		this.vc_sound_num = - 1;
		this.vc_frames = [];		// array of PIG bitmap indices
		this.vc_light_value = 0;

		// Eclip-specific
		this.time_left = 0;			// for sequencing
		this.frame_count = 0;		// current frame index
		this.changing_wall_texture = - 1;	// Textures[] index to replace
		this.changing_object_texture = - 1;	// ObjBitmaps[] index to replace
		this.flags = 0;
		this.crit_clip = - 1;		// alternate clip when mine critical
		this.dest_bm_num = - 1;		// bitmap for destroyed state
		this.dest_vclip = - 1;
		this.dest_eclip = - 1;
		this.dest_size = 0;
		this.sound_num = - 1;
		this.segnum = - 1;
		this.sidenum = - 1;

	}

}

// Global effects array
export const Effects = [];
for ( let i = 0; i < MAX_EFFECTS; i ++ ) {

	Effects.push( new Eclip() );

}

export let Num_effects = 0;

export function set_Num_effects( n ) {

	Num_effects = n;

}

// Sound mapping: game sound ID -> PIG sound file index
export const Sounds = new Int16Array( 250 ).fill( - 1 );
export const AltSounds = new Uint8Array( 250 ).fill( 255 );
export let Num_sounds = 0;
export function set_Num_sounds( n ) { Num_sounds = n; }

// Cockpit bitmaps (from $COCKPIT in bitmaps.bin)
// Ported from: BM.C cockpit_bitmap[], N_COCKPIT_BITMAPS = 4
export const N_COCKPIT_BITMAPS = 4;
export const cockpit_bitmap = new Int16Array( N_COCKPIT_BITMAPS ).fill( - 1 ); // PIG bitmap indices
export let Num_cockpits = 0;
export function set_Num_cockpits( n ) { Num_cockpits = n; }

// Gauge bitmaps (from $GAUGES in bitmaps.bin)
// Ported from: GAUGES.H MAX_GAUGE_BMS = 80, Gauges[]
export const MAX_GAUGE_BMS = 80;
export const Gauges = new Int16Array( MAX_GAUGE_BMS ).fill( - 1 ); // PIG bitmap indices

// Gauge bitmap index constants (from GAUGES.C)
export const GAUGE_SHIELDS = 0;			// 10 frames (100%..0%)
export const GAUGE_INVULNERABLE = 10;	// 10 frames
export const GAUGE_SPEED = 20;			// unused
export const GAUGE_ENERGY_LEFT = 21;
export const GAUGE_ENERGY_RIGHT = 22;
export const GAUGE_NUMERICAL = 23;
export const GAUGE_BLUE_KEY = 24;
export const GAUGE_GOLD_KEY = 25;
export const GAUGE_RED_KEY = 26;
export const GAUGE_BLUE_KEY_OFF = 27;
export const GAUGE_GOLD_KEY_OFF = 28;
export const GAUGE_RED_KEY_OFF = 29;
export const SB_GAUGE_BLUE_KEY = 30;
export const SB_GAUGE_GOLD_KEY = 31;
export const SB_GAUGE_RED_KEY = 32;
export const SB_GAUGE_BLUE_KEY_OFF = 33;
export const SB_GAUGE_GOLD_KEY_OFF = 34;
export const SB_GAUGE_RED_KEY_OFF = 35;
export const SB_GAUGE_ENERGY = 36;
export const GAUGE_LIVES = 37;
export const GAUGE_SHIPS = 38;			// 8 player ships (38-45)
export const RETICLE_CROSS = 46;		// 2 frames
export const RETICLE_PRIMARY = 48;		// 3 frames
export const RETICLE_SECONDARY = 51;	// 5 frames
export const GAUGE_HOMING_WARNING_ON = 56;
export const GAUGE_HOMING_WARNING_OFF = 57;
export const SML_RETICLE_CROSS = 58;	// 2 frames
export const SML_RETICLE_PRIMARY = 60;	// 3 frames
export const SML_RETICLE_SECONDARY = 63; // 5 frames
export const KEY_ICON_BLUE = 68;
export const KEY_ICON_YELLOW = 69;
export const KEY_ICON_RED = 70;

// Object type classification constants (from BM.H)
// Ported from: descent-master/MAIN/BM.H lines 267-273
export const OL_ROBOT = 1;
export const OL_CONTROL_CENTER = 4;
export const OL_PLAYER = 5;
export const OL_CLUTTER = 6;
export const OL_EXIT = 7;

// Object type tables — populated from $ROBOT/$OBJECT/$POWERUP/$HOSTAGE in bitmaps.bin
// Ported from: descent-master/MAIN/BM.H lines 278-280
export const MAX_OBJTYPE = 100;
export const ObjType = new Uint8Array( MAX_OBJTYPE );	// OL_ROBOT, OL_CONTROL_CENTER, etc.
export const ObjId = new Uint8Array( MAX_OBJTYPE );		// model_num for polyobj types
export const ObjStrength = new Float32Array( MAX_OBJTYPE );	// strength (fixed-point converted to float)
export let Num_total_object_types = 0;
export function set_Num_total_object_types( n ) { Num_total_object_types = n; }

export class TmapInfo {

	constructor() {

		this.filename = '';
		this.flags = 0;
		this.lighting = 0;	// 0 to 1 (float, converted from fix)
		this.damage = 0;	// how much damage being against this does
		this.eclip_num = - 1;	// if not -1, the eclip that changes this

	}

}

// Global tmap info array
export const TmapInfos = [];
for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

	TmapInfos.push( new TmapInfo() );

}

const HAM_MAX_SOUNDS = 250;
const HAM_MAX_GAUGES = 80;
const HAM_MAX_OBJ_TYPES = 100;
const HAM_MAX_CONTROLCEN_GUNS = 4;
const HAM_FIXED_PREFIX_SIZE = 61750;
const HAM_POLYMODEL_HEADER_SIZE = 734;
const HAM_FIXED_TAIL_SIZE = 3040;
const HAM_MIN_SIZE = 64790;
const HAM_ANGLE_SCALE = 2.0 * Math.PI / 65536.0;

function hamReadCount( fp, name, maximum ) {

	const count = fp.readInt();
	if ( count < 0 || count > maximum ) {

		throw new Error( 'Invalid HAM ' + name + ' count: ' + count );

	}
	return count;

}

function hamReadVector( fp, target ) {

	target.x = fp.readFix();
	target.y = fp.readFix();
	target.z = fp.readFix();

}

function hamReadVclip( fp, target, embedded ) {

	const playTime = fp.readFix();
	const numFrames = fp.readInt();
	const frameTime = fp.readFix();
	const flags = fp.readInt();
	const soundNum = fp.readShort();
	const frames = [];

	for ( let i = 0; i < VCLIP_MAX_FRAMES; i ++ ) frames.push( fp.readUShort() );
	const lightValue = fp.readFix();

	if ( embedded === true ) {

		target.vc_play_time = playTime;
		target.vc_num_frames = numFrames;
		target.vc_frame_time = frameTime;
		target.vc_flags = flags;
		target.vc_sound_num = soundNum;
		target.vc_frames = frames;
		target.vc_light_value = lightValue;

	} else {

		target.play_time = playTime;
		target.num_frames = numFrames;
		target.frame_time = frameTime;
		target.flags = flags;
		target.sound_num = soundNum;
		target.frames = frames;
		target.light_value = lightValue;

	}

}

function hamReadRobotInfo( fp, robot ) {

	robot.compiled = true;
	robot.model_num = fp.readInt();
	robot.n_guns = fp.readInt();
	for ( let i = 0; i < MAX_GUNS; i ++ ) hamReadVector( fp, robot.gun_points[ i ] );
	for ( let i = 0; i < MAX_GUNS; i ++ ) robot.gun_submodels[ i ] = fp.readUByte();

	robot.exp1_vclip_num = fp.readShort();
	robot.exp1_sound_num = fp.readShort();
	robot.exp2_vclip_num = fp.readShort();
	robot.exp2_sound_num = fp.readShort();
	robot.weapon_type = fp.readShort();
	robot.contains_id = fp.readByte();
	robot.contains_count = fp.readByte();
	robot.contains_prob = fp.readByte();
	robot.contains_type = fp.readByte();
	robot.score_value = fp.readInt();
	robot.lighting = fp.readFix();
	robot.strength = fp.readFix();
	robot.mass = fp.readFix();
	robot.drag = fp.readFix();

	const fixArrays = [
		robot.field_of_view, robot.firing_wait, robot.turn_time,
		robot.fire_power, robot.shield, robot.max_speed, robot.circle_distance
	];
	for ( let arrayIndex = 0; arrayIndex < fixArrays.length; arrayIndex ++ ) {

		for ( let difficulty = 0; difficulty < 5; difficulty ++ ) {

			fixArrays[ arrayIndex ][ difficulty ] = fp.readFix();

		}

	}

	for ( let i = 0; i < 5; i ++ ) robot.rapidfire_count[ i ] = fp.readByte();
	for ( let i = 0; i < 5; i ++ ) robot.evade_speed[ i ] = fp.readByte();
	robot.cloak_type = fp.readByte();
	robot.attack_type = fp.readByte();
	robot.boss_flag = fp.readByte();
	robot.see_sound = fp.readUByte();
	robot.attack_sound = fp.readUByte();
	robot.claw_sound = fp.readUByte();

	for ( let gun = 0; gun <= MAX_GUNS; gun ++ ) {

		for ( let state = 0; state < N_ANIM_STATES; state ++ ) {

			const list = robot.anim_states[ gun ][ state ];
			list.n_joints = fp.readShort();
			list.offset = fp.readShort();
			if ( list.n_joints === 0 ) list.offset = 0;

		}

	}

	robot.always_0xabcd = fp.readInt();

}

function hamReadWeaponInfo( fp, weapon ) {

	weapon.render_type = fp.readByte();
	weapon.model_num = fp.readByte();
	weapon.model_num_inner = fp.readByte();
	weapon.persistent = fp.readByte();
	weapon.flash_vclip = fp.readByte();
	weapon.flash_sound = fp.readShort();
	weapon.robot_hit_vclip = fp.readByte();
	weapon.robot_hit_sound = fp.readShort();
	weapon.wall_hit_vclip = fp.readByte();
	weapon.wall_hit_sound = fp.readShort();
	weapon.fire_count = fp.readByte();
	weapon.ammo_usage = fp.readByte();
	weapon.weapon_vclip = fp.readByte();
	weapon.destroyable = fp.readByte();
	weapon.matter = fp.readByte();
	weapon.bounce = fp.readByte();
	weapon.homing_flag = fp.readByte();
	fp.skip( 3 );
	weapon.energy_usage = fp.readFix();
	weapon.fire_wait = fp.readFix();
	const bitmap = fp.readUShort();
	weapon.bitmap = bitmap === 0xFFFF ? - 1 : bitmap;
	weapon.blob_size = fp.readFix();
	weapon.flash_size = fp.readFix();
	weapon.impact_size = fp.readFix();
	for ( let i = 0; i < 5; i ++ ) weapon.strength[ i ] = fp.readFix();
	for ( let i = 0; i < 5; i ++ ) weapon.speed[ i ] = fp.readFix();
	weapon.mass = fp.readFix();
	weapon.drag = fp.readFix();
	weapon.thrust = fp.readFix();
	weapon.po_len_to_width_ratio = fp.readFix();
	weapon.light = fp.readFix();
	weapon.lifetime = fp.readFix();
	weapon.damage_radius = fp.readFix();
	const picture = fp.readUShort();
	weapon.picture = picture === 0xFFFF ? - 1 : picture;

}

function hamBuildCompiledModelMetadata( pigFile, nModels ) {

	for ( let modelNum = 0; modelNum < nModels; modelNum ++ ) {

		const model = Polygon_models[ modelNum ];
		model.textureNames.length = 0;
		model.textureBitmapIndices = null;
		model.textureObjectBitmapSlots = [];

		for ( let texture = 0; texture < model.n_textures; texture ++ ) {

			const ptrIndex = model.first_texture + texture;
			const bitmapSlot = ObjBitmapPtrs[ ptrIndex ];
			if ( bitmapSlot >= MAX_OBJ_BITMAPS ) {

				throw new Error( 'Invalid HAM object bitmap pointer for model ' + modelNum );

			}
			const bitmapIndex = ObjBitmaps[ bitmapSlot ];
			let name = '';
			model.textureObjectBitmapSlots.push( bitmapSlot );

			if ( pigFile !== undefined && pigFile !== null ) {

				const bitmap = pigFile.bitmaps[ bitmapIndex ];
				if ( bitmap === undefined ) {

					throw new Error( 'Invalid HAM bitmap index for model ' + modelNum + ': ' + bitmapIndex );

				}
				name = bitmap.name;

			}

			model.textureNames.push( name );

		}

	}

	for ( let robotNum = 0; robotNum < N_robot_types; robotNum ++ ) {

		const robot = Robot_info[ robotNum ];
		const model = Polygon_models[ robot.model_num ];
		if ( model === undefined ) throw new Error( 'Invalid HAM robot model: ' + robot.model_num );
		if ( robot.n_guns < 0 || robot.n_guns > MAX_GUNS ) {

			throw new Error( 'Invalid HAM robot gun count: ' + robot.n_guns );

		}

		const populateModelGuns = model.registeredRobotInfo === undefined;
		if ( populateModelGuns === true ) {

			model.registeredRobotInfo = robotNum;
			model.n_guns = robot.n_guns;
			model.gun_points.length = 0;
			model.gun_dirs.length = 0;
			model.gun_submodels.length = 0;

		}
		for ( let gun = 0; gun < robot.n_guns; gun ++ ) {

			let submodel = robot.gun_submodels[ gun ];
			let parentDepth = 0;
			while ( submodel !== 0 ) {

				if ( submodel >= model.n_models || parentDepth ++ >= MAX_SUBMODELS ) {

					throw new Error( 'Invalid HAM robot gun submodel' );

				}
				submodel = model.submodel_parents[ submodel ];

			}

			if ( populateModelGuns === true ) {

				model.gun_points.push( robot.gun_points[ gun ] );
				model.gun_dirs.push( { x: 0, y: 0, z: 1 } );
				model.gun_submodels.push( robot.gun_submodels[ gun ] );

			}

		}

		robot.anim_angs = [];
		for ( let state = 0; state < N_ANIM_STATES; state ++ ) {

			const angles = [];
			for ( let submodel = 0; submodel < model.n_models; submodel ++ ) {

				angles.push( { p: 0, b: 0, h: 0 } );

			}
			robot.anim_angs.push( angles );

		}

		for ( let gun = 0; gun <= robot.n_guns; gun ++ ) {

			for ( let state = 0; state < N_ANIM_STATES; state ++ ) {

				const list = robot.anim_states[ gun ][ state ];
				if ( list.n_joints < 0 || list.offset < 0 || list.offset + list.n_joints > N_robot_joints ) {

					throw new Error( 'Invalid HAM robot animation joint list' );

				}

				for ( let i = 0; i < list.n_joints; i ++ ) {

					const joint = Robot_joints[ list.offset + i ];
					if ( joint.jointnum >= 0 && joint.jointnum < model.n_models ) {

						const angle = robot.anim_angs[ state ][ joint.jointnum ];
						angle.p = joint.angles.p;
						angle.b = joint.angles.b;
						angle.h = joint.angles.h;

					}

				}

			}

		}
		if ( model.anim_angs === null ) model.anim_angs = robot.anim_angs;

	}

	const playerModel = Polygon_models[ Player_ship.model_num ];
	if ( playerModel === undefined ) {

		throw new Error( 'Invalid HAM player model: ' + Player_ship.model_num );

	} else {

		playerModel.n_guns = MAX_GUNS;
		playerModel.gun_points.length = 0;
		playerModel.gun_dirs.length = 0;
		playerModel.gun_submodels.length = 0;
		for ( let gun = 0; gun < MAX_GUNS; gun ++ ) {

			playerModel.gun_points.push( Player_ship.gun_points[ gun ] );
			playerModel.gun_dirs.push( { x: 0, y: 0, z: 1 } );
			playerModel.gun_submodels.push( 0 );

		}

	}

	for ( let i = 0; i < Num_total_object_types; i ++ ) {

		if ( ObjType[ i ] !== OL_CONTROL_CENTER ) continue;
		const reactorModel = Polygon_models[ ObjId[ i ] ];
		if ( reactorModel === undefined ) throw new Error( 'Invalid HAM reactor model: ' + ObjId[ i ] );

		reactorModel.n_guns = N_controlcen_guns;
		reactorModel.gun_points.length = 0;
		reactorModel.gun_dirs.length = 0;
		reactorModel.gun_submodels.length = 0;
		for ( let gun = 0; gun < N_controlcen_guns; gun ++ ) {

			reactorModel.gun_points.push( controlcen_gun_points[ gun ] );
			reactorModel.gun_dirs.push( controlcen_gun_dirs[ gun ] );
			reactorModel.gun_submodels.push( 0 );

		}

	}

}

// Read all compiled Descent 1 properties embedded in a registered PIG file.
// Mirrors the fixed-capacity bm_read_all() layout in MAIN/BM.C exactly.
export function bm_read_all( fp, pigFile ) {

	if ( fp.length() < HAM_MIN_SIZE ) {

		throw new Error( 'Registered HAM block is too short: ' + fp.length() + ' bytes' );

	}

	const numTextures = hamReadCount( fp, 'texture', MAX_TEXTURES );
	set_NumTextures( numTextures );
	for ( let i = 0; i < MAX_TEXTURES; i ++ ) Textures[ i ] = fp.readUShort();

	for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

		const info = TmapInfos[ i ];
		info.filename = fp.readString( 13 );
		info.flags = fp.readUByte();
		info.lighting = fp.readFix();
		info.damage = fp.readFix();
		info.eclip_num = fp.readInt();

	}

	for ( let i = 0; i < HAM_MAX_SOUNDS; i ++ ) Sounds[ i ] = fp.readUByte();
	for ( let i = 0; i < HAM_MAX_SOUNDS; i ++ ) AltSounds[ i ] = fp.readUByte();

	set_Num_vclips( hamReadCount( fp, 'vclip', VCLIP_MAXNUM ) );
	for ( let i = 0; i < VCLIP_MAXNUM; i ++ ) hamReadVclip( fp, Vclips[ i ], false );

	set_Num_effects( hamReadCount( fp, 'effect', MAX_EFFECTS ) );
	for ( let i = 0; i < MAX_EFFECTS; i ++ ) {

		const effect = Effects[ i ];
		hamReadVclip( fp, effect, true );
		effect.time_left = fp.readFix();
		effect.frame_count = fp.readInt();
		effect.changing_wall_texture = fp.readShort();
		effect.changing_object_texture = fp.readShort();
		effect.flags = fp.readInt();
		effect.crit_clip = fp.readInt();
		effect.dest_bm_num = fp.readInt();
		effect.dest_vclip = fp.readInt();
		effect.dest_eclip = fp.readInt();
		effect.dest_size = fp.readFix();
		effect.sound_num = fp.readInt();
		effect.segnum = fp.readInt();
		effect.sidenum = fp.readInt();

	}

	set_Num_wall_anims( hamReadCount( fp, 'wall animation', MAX_WALL_ANIMS ) );
	for ( let i = 0; i < MAX_WALL_ANIMS; i ++ ) {

		const clip = WallAnims[ i ];
		clip.play_time = fp.readFix();
		clip.num_frames = fp.readShort();
		clip.frames = [];
		for ( let frame = 0; frame < MAX_CLIP_FRAMES; frame ++ ) clip.frames.push( fp.readShort() );
		clip.open_sound = fp.readShort();
		clip.close_sound = fp.readShort();
		clip.flags = fp.readShort();
		clip.filename = fp.readString( 13 );
		fp.skip( 1 );

	}

	set_N_robot_types( hamReadCount( fp, 'robot', MAX_ROBOT_TYPES ) );
	for ( let i = 0; i < MAX_ROBOT_TYPES; i ++ ) hamReadRobotInfo( fp, Robot_info[ i ] );

	set_N_robot_joints( hamReadCount( fp, 'robot joint', MAX_ROBOT_JOINTS ) );
	for ( let i = 0; i < MAX_ROBOT_JOINTS; i ++ ) {

		const joint = Robot_joints[ i ];
		joint.jointnum = fp.readShort();
		joint.angles.p = fp.readShort() * HAM_ANGLE_SCALE;
		joint.angles.b = fp.readShort() * HAM_ANGLE_SCALE;
		joint.angles.h = fp.readShort() * HAM_ANGLE_SCALE;

	}

	set_N_weapon_types( hamReadCount( fp, 'weapon', MAX_WEAPON_TYPES ) );
	for ( let i = 0; i < MAX_WEAPON_TYPES; i ++ ) hamReadWeaponInfo( fp, Weapon_info[ i ] );

	set_N_powerup_types( hamReadCount( fp, 'powerup', MAX_POWERUP_TYPES ) );
	for ( let i = 0; i < MAX_POWERUP_TYPES; i ++ ) {

		const powerup = Powerup_info[ i ];
		powerup.vclip_num = fp.readInt();
		powerup.hit_sound = fp.readInt();
		powerup.size = fp.readFix();
		powerup.light = fp.readFix();

	}

	const nModels = hamReadCount( fp, 'polygon model', D1_MAX_POLYGON_MODELS );
	if ( fp.tell() !== HAM_FIXED_PREFIX_SIZE ) {

		throw new Error( 'Registered HAM packed-record offset mismatch: ' + fp.tell() );

	}
	if ( fp.length() - fp.tell() < nModels * HAM_POLYMODEL_HEADER_SIZE + HAM_FIXED_TAIL_SIZE ) {

		throw new Error( 'Registered HAM polygon model table is truncated' );

	}
	Polygon_models.length = nModels;
	let modelDataSize = 0;
	for ( let i = 0; i < nModels; i ++ ) {

		const headerStart = fp.tell();
		const model = read_compiled_polygon_model_header( fp );
		if ( fp.tell() - headerStart !== HAM_POLYMODEL_HEADER_SIZE ) {

			throw new Error( 'Invalid HAM polygon model header size' );

		}
		if ( model.n_models < 1 || model.n_models > MAX_SUBMODELS ) {

			throw new Error( 'Invalid HAM submodel count for model ' + i + ': ' + model.n_models );

		}
		if ( model.model_data_size < 2 ) {

			throw new Error( 'Invalid HAM bytecode size for model ' + i + ': ' + model.model_data_size );

		}
		if ( model.first_texture + model.n_textures > MAX_OBJ_BITMAPS ) {

			throw new Error( 'Invalid HAM texture range for model ' + i );

		}
		modelDataSize += model.model_data_size;
		Polygon_models[ i ] = model;

	}

	const remainingAfterHeaders = fp.length() - fp.tell();
	if ( remainingAfterHeaders !== modelDataSize + HAM_FIXED_TAIL_SIZE ) {

		throw new Error(
			'Registered HAM size mismatch after model headers: expected ' +
			( modelDataSize + HAM_FIXED_TAIL_SIZE ) + ', found ' + remainingAfterHeaders
		);

	}

	for ( let i = 0; i < nModels; i ++ ) {

		Polygon_models[ i ].model_data = fp.readBytes( Polygon_models[ i ].model_data_size );

	}
	set_N_polygon_models( nModels );

	for ( let i = 0; i < HAM_MAX_GAUGES; i ++ ) Gauges[ i ] = fp.readUShort();
	for ( let i = 0; i < D1_MAX_POLYGON_MODELS; i ++ ) Dying_modelnums[ i ] = fp.readInt();
	for ( let i = 0; i < D1_MAX_POLYGON_MODELS; i ++ ) Dead_modelnums[ i ] = fp.readInt();
	for ( let i = 0; i < MAX_OBJ_BITMAPS; i ++ ) ObjBitmaps[ i ] = fp.readUShort();
	for ( let i = 0; i < MAX_OBJ_BITMAPS; i ++ ) ObjBitmapPtrs[ i ] = fp.readUShort();
	// D1 serializes the complete tables without their construction-time count.
	// Expose the readable capacity; consumers must use each model's texture range.
	set_N_ObjBitmaps( MAX_OBJ_BITMAPS );
	set_N_ObjBitmapPtrs( MAX_OBJ_BITMAPS );

	Player_ship.model_num = fp.readInt();
	Player_ship.expl_vclip_num = fp.readInt();
	Player_ship.mass = fp.readFix();
	Player_ship.drag = fp.readFix();
	Player_ship.max_thrust = fp.readFix();
	Player_ship.reverse_thrust = fp.readFix();
	Player_ship.brakes = fp.readFix();
	Player_ship.wiggle = fp.readFix();
	Player_ship.max_rotthrust = fp.readFix();
	for ( let i = 0; i < MAX_GUNS; i ++ ) hamReadVector( fp, Player_ship.gun_points[ i ] );
	Player_ship.loaded = true;

	set_Num_cockpits( hamReadCount( fp, 'cockpit', N_COCKPIT_BITMAPS ) );
	for ( let i = 0; i < N_COCKPIT_BITMAPS; i ++ ) cockpit_bitmap[ i ] = fp.readUShort();

	// BM.C intentionally stores this table twice; the later copy wins.
	for ( let i = 0; i < HAM_MAX_SOUNDS; i ++ ) Sounds[ i ] = fp.readUByte();
	for ( let i = 0; i < HAM_MAX_SOUNDS; i ++ ) AltSounds[ i ] = fp.readUByte();
	set_Num_sounds( HAM_MAX_SOUNDS );

	set_Num_total_object_types( hamReadCount( fp, 'object type', HAM_MAX_OBJ_TYPES ) );
	for ( let i = 0; i < HAM_MAX_OBJ_TYPES; i ++ ) ObjType[ i ] = fp.readUByte();
	for ( let i = 0; i < HAM_MAX_OBJ_TYPES; i ++ ) ObjId[ i ] = fp.readUByte();
	for ( let i = 0; i < HAM_MAX_OBJ_TYPES; i ++ ) ObjStrength[ i ] = fp.readFix();

	First_multi_bitmap_num = fp.readInt();
	N_controlcen_guns = hamReadCount( fp, 'control-center gun', HAM_MAX_CONTROLCEN_GUNS );
	for ( let i = 0; i < HAM_MAX_CONTROLCEN_GUNS; i ++ ) hamReadVector( fp, controlcen_gun_points[ i ] );
	for ( let i = 0; i < HAM_MAX_CONTROLCEN_GUNS; i ++ ) hamReadVector( fp, controlcen_gun_dirs[ i ] );
	exit_modelnum = fp.readInt();
	destroyed_exit_modelnum = fp.readInt();

	if ( fp.tell() !== fp.length() ) {

		throw new Error( 'Registered HAM parser stopped at ' + fp.tell() + ' of ' + fp.length() + ' bytes' );

	}

	hamBuildCompiledModelMetadata( pigFile, nModels );
	console.log(
		'HAM: Read ' + numTextures + ' textures, ' + N_robot_types + ' robots, ' +
		N_weapon_types + ' weapons, and ' + nModels + ' polygon models'
	);

}
