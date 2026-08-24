// Ported from: descent-master/MAIN/POWERUP.C
// Powerup placement, animation, pickup detection, sprite texture building

import * as THREE from 'three';
import { Vclips, Powerup_info, N_powerup_types } from './bm.js';
import { OBJ_POWERUP, OBJ_HOSTAGE, CT_POWERUP, MT_PHYSICS, RT_POWERUP, PF_BOUNCE,
	OF_SHOULD_BE_DEAD, Objects, obj_create, obj_delete } from './object.js';
import { object_create_explosion, VCLIP_POWERUP_DISAPPEARANCE } from './fireball.js';
import { digi_play_sample_world } from './digi.js';

// Lifetime for robot/player-dropped powerups, in seconds.
// Ported from: object_create_egg() in FIREBALL.C:796 —
//   obj->lifeleft = (rand() + F1_0*3) * 64;  // 3 to 3.5 "binary minutes" (64 s each) = 192 to 224 s
// Single-player only; C halves this in multiplayer (GM_MULTI), which we don't have.
function dropped_powerup_lifeleft() {

	return ( 3.0 + Math.random() * 0.5 ) * 64;

}

// Tracked powerups for player pickup
const livePowerups = [];

// Map of powerup ID → vclip_num (built dynamically from placed objects)
const powerupVclipMap = {};
// Map of powerup ID → size
const powerupSizeMap = {};

// Cache for vclip sprite textures (keyed by PIG bitmap index)
const spriteTextureCache = new Map();

// External references
let _pigFile = null;
let _palette = null;
let _scene = null;
let _collide_player_and_powerup = null;

export function powerup_set_externals( ext ) {

	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.collide_player_and_powerup !== undefined ) _collide_player_and_powerup = ext.collide_player_and_powerup;

}

export function powerup_get_live() { return livePowerups; }
export function powerup_get_vclip_map() { return powerupVclipMap; }
export function powerup_get_size_map() { return powerupSizeMap; }

// Build a billboard sprite texture from a PIG bitmap
export function buildSpriteTexture( bitmapIndex ) {

	if ( spriteTextureCache.has( bitmapIndex ) ) {

		return spriteTextureCache.get( bitmapIndex );

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

	spriteTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Build a sprite material for a vclip (uses first frame)
export function buildVclipSprite( vclipNum, size ) {

	const vc = Vclips[ vclipNum ];
	if ( vc === undefined || vc.frames.length === 0 ) {

		console.warn( 'buildVclipSprite: vclip ' + vclipNum + ' — no frames (undefined=' +
			( vc === undefined ) + ', length=' + ( vc !== undefined ? vc.frames.length : 'N/A' ) + ')' );
		return null;

	}

	// Use first frame bitmap
	const bitmapIndex = vc.frames[ 0 ];
	const texture = buildSpriteTexture( bitmapIndex );
	if ( texture === null ) {

		console.warn( 'buildVclipSprite: vclip ' + vclipNum + ' — texture build failed for bitmap ' + bitmapIndex );
		return null;

	}

	const material = new THREE.SpriteMaterial( {
		map: texture,
		transparent: true,
		depthTest: true,
		depthWrite: false
	} );

	const sprite = new THREE.Sprite( material );
	sprite.scale.set( size * 2, size * 2, 1 );

	return sprite;

}

// Place a powerup object in the scene (called from placeObjects)
// Returns true if sprite was created, false if failed
export function powerup_place( obj, scene, objnum = - 1 ) {

	const sprite = buildVclipSprite( obj.rtype.vclip_num, obj.size );
	if ( sprite === null ) {

		console.warn( 'POWERUP: Failed to place powerup id=' + obj.id + ' vclip=' + obj.rtype.vclip_num +
			' (no frames in PIG for this vclip)' );
		return false;

	}

	sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
	scene.add( sprite );

	const vc = Vclips[ obj.rtype.vclip_num ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	livePowerups.push( {
		objnum: objnum, obj: obj, sprite: sprite, alive: true,
		vclipNum: obj.rtype.vclip_num, frameNum: 0, frameTime: frameTime, frameTimer: frameTime
	} );

	// Record vclip_num and size for this powerup type (for robot drops)
	if ( powerupVclipMap[ obj.id ] === undefined ) {

		powerupVclipMap[ obj.id ] = obj.rtype.vclip_num;
		powerupSizeMap[ obj.id ] = obj.size;

	}

	return true;

}

// Place a hostage object in the scene (called from placeObjects)
// Returns 1 to increment hostagesInLevel counter
export function powerup_place_hostage( obj, scene, objnum = - 1 ) {

	const sprite = buildVclipSprite( obj.rtype.vclip_num, obj.size );
	if ( sprite === null ) return 0;

	sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
	scene.add( sprite );

	const vc = Vclips[ obj.rtype.vclip_num ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	livePowerups.push( {
		objnum: objnum, obj: obj, sprite: sprite, alive: true, isHostage: true,
		vclipNum: obj.rtype.vclip_num, frameNum: 0, frameTime: frameTime, frameTimer: frameTime
	} );

	return 1;

}

// Spawn a dropped powerup from a destroyed robot
// Ported from: object_create_egg() in COLLIDE.C
export function spawnDroppedPowerup( powerupId, pos_x, pos_y, pos_z, segnum ) {

	if ( _scene === null ) return - 1;

	// Find vclip_num for this powerup type
	// Prefer Powerup_info[] (parsed from bitmaps.bin), fall back to dynamic map
	let vclipNum;
	let size;

	if ( powerupId >= 0 && powerupId < N_powerup_types && Powerup_info[ powerupId ].vclip_num !== - 1 ) {

		vclipNum = Powerup_info[ powerupId ].vclip_num;
		size = Powerup_info[ powerupId ].size;

	} else {

		vclipNum = powerupVclipMap[ powerupId ];
		size = powerupSizeMap[ powerupId ] || 3.0;

	}

	if ( vclipNum === undefined ) {

		// No vclip known for this powerup type — give directly to player
		console.log( 'DROP: No vclip for powerup id=' + powerupId + ', auto-collecting' );

		if ( _collide_player_and_powerup !== null ) {

			_collide_player_and_powerup( {
				objnum: - 1,
				alive: true,
				obj: { id: powerupId, size: size },
				sprite: null,
				isHostage: false,
				autoPicked: true
			} );

		}

		return - 1;

	}

	// Create sprite
	const sprite = buildVclipSprite( vclipNum, size );
	if ( sprite === null ) return - 1;

	sprite.position.set( pos_x, pos_y, - pos_z );

	const objnum = obj_create(
		OBJ_POWERUP, powerupId, segnum, pos_x, pos_y, pos_z,
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
		size, CT_POWERUP, MT_PHYSICS, RT_POWERUP
	);

	if ( objnum < 0 ) {

		sprite.material.dispose();
		console.warn( 'DROP: No free object slot for powerup id=' + powerupId );
		return - 1;

	}

	const obj = Objects[ objnum ];

	const vc = Vclips[ vclipNum ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	obj.mtype.mass = 1.0;
	obj.mtype.drag = 512 / 65536;
	obj.mtype.flags = PF_BOUNCE;
	obj.rtype.vclip_num = vclipNum;
	obj.rtype.frametime = frameTime;
	obj.rtype.framenum = 0;
	obj.lifeleft = dropped_powerup_lifeleft();

	_scene.add( sprite );
	livePowerups.push( {
		objnum: objnum, obj: obj, sprite: sprite, alive: true,
		vclipNum: vclipNum, frameNum: 0, frameTime: frameTime, frameTimer: frameTime,
		dropped: true
	} );
	console.log( 'DROP: Spawned powerup id=' + powerupId + ' at seg ' + segnum );
	return objnum;

}

// Animate powerup/hostage vclips and expire runtime drops. Player collection is
// dispatched by the swept object collision in physics.js.
// Called each frame from onFrameCallback
export function powerup_do_frame( dt, playerPos ) {

	// Animate powerup/hostage vclips
	for ( let i = 0; i < livePowerups.length; i ++ ) {

		const pw = livePowerups[ i ];
		if ( pw.alive !== true || pw.sprite === null ) continue;
		if ( pw.frameTime <= 0 ) continue;	// No animation

		const vc = Vclips[ pw.vclipNum ];
		if ( vc === undefined || vc.num_frames <= 1 ) continue;

		pw.frameTimer -= dt;

		while ( pw.frameTimer < 0 ) {

			pw.frameTimer += pw.frameTime;
			pw.frameNum ++;
			if ( pw.frameNum >= vc.num_frames ) pw.frameNum = 0;

		}

		// Update sprite texture to current frame
		const bitmapIndex = vc.frames[ pw.frameNum ];
		const newTexture = buildSpriteTexture( bitmapIndex );
		if ( newTexture !== null && pw.sprite.material.map !== newTexture ) {

			pw.sprite.material.map = newTexture;
			pw.sprite.material.needsUpdate = true;

		}

	}

	// Check lifeleft on dropped powerups — remove when expired
	// Ported from: do_powerup_frame() in POWERUP.C lines 210-215
	for ( let i = livePowerups.length - 1; i >= 0; i -- ) {

		const pw = livePowerups[ i ];
		if ( pw.alive !== true ) continue;
		if ( pw.dropped !== true ) continue;	// Only dropped powerups expire

		pw.obj.lifeleft -= dt;

		if ( pw.obj.lifeleft <= 0 ) {

			// Spawn disappearance explosion at powerup position
			object_create_explosion( pw.obj.pos_x, pw.obj.pos_y, pw.obj.pos_z, 3.5, VCLIP_POWERUP_DISAPPEARANCE );

			// Play disappearance sound (ported from POWERUP.C line 213-214)
			const dispVc = Vclips[ VCLIP_POWERUP_DISAPPEARANCE ];
			if ( dispVc !== undefined && dispVc.sound_num >= 0 ) {

				digi_play_sample_world(
					dispVc.sound_num, 1.0, pw.obj.segnum,
					pw.obj.pos_x, pw.obj.pos_y, pw.obj.pos_z
				);

			}

			// Remove sprite from scene
			if ( pw.sprite !== null && _scene !== null ) {

				_scene.remove( pw.sprite );

			}

			pw.alive = false;
			if ( pw.objnum !== undefined && pw.objnum >= 0 ) pw.obj.flags |= OF_SHOULD_BE_DEAD;

		}

	}

	// Base-level wrappers keep positional save-state identity.  Dropped objects
	// are runtime-only, so reclaim their canonical slots once their callbacks are
	// finished and compact the tracking array without allocating.
	let writeIndex = 0;
	for ( let readIndex = 0; readIndex < livePowerups.length; readIndex ++ ) {

		const pw = livePowerups[ readIndex ];
		if ( pw.dropped === true && pw.alive !== true && pw.objnum >= 0 ) {

			obj_delete( pw.objnum );
			continue;

		}

		livePowerups[ writeIndex ++ ] = pw;

	}
	livePowerups.length = writeIndex;

}

// Clean up powerups for level transition
export function powerup_cleanup( scene ) {

	for ( let i = 0; i < livePowerups.length; i ++ ) {

		if ( livePowerups[ i ].sprite !== null ) {

			scene.remove( livePowerups[ i ].sprite );

		}

	}

	livePowerups.length = 0;

}
