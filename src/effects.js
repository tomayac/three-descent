// Ported from: descent-master/MAIN/EFFECTS.C
// Special effects - animated wall textures (fans, monitors, lava, warning lights)

import {
	Effects, Num_effects, MAX_EFFECTS,
	EF_CRITICAL, EF_ONE_SHOT, EF_STOPPED,
	TmapInfos, ObjBitmaps
} from './bm.js';
import { Vertices, Textures, Segments, Side_to_verts } from './mglobal.js';
import { Vclips } from './vclip.js';
import { digi_play_sample_world, digi_kill_sound_linked_to_segment } from './digi.js';
import { SIDE_IS_TRI_13 } from './segment.js';

// Externals injected at init time (avoids circular imports)
let _getFrameTime = null;
let _onTextureChanged = null;	// callback(changing_wall_texture, newBitmapIndex)
let _onObjectTextureChanged = null;	// callback(ObjBitmaps[] slot, newBitmapIndex)
let _onSideOverlayChanged = null;	// callback(segnum, sidenum) — side tmap_num2 changed
let _createExplosion = null;	// callback(x, y, z, size, vclipNum) — create explosion
let _reactorDestroyed = false;	// set when reactor is destroyed — freezes EF_CRITICAL eclips
let _pigFile = null;

// Set external dependencies
export function effects_set_externals( externals ) {

	_getFrameTime = externals.getFrameTime;
	if ( externals.createExplosion !== undefined ) _createExplosion = externals.createExplosion;
	if ( externals.onSideOverlayChanged !== undefined ) _onSideOverlayChanged = externals.onSideOverlayChanged;
	if ( externals.onObjectTextureChanged !== undefined ) {

		_onObjectTextureChanged = externals.onObjectTextureChanged;

	}
	if ( externals.pigFile !== undefined ) _pigFile = externals.pigFile;

}

// All runtime writes to ObjBitmaps[] go through this helper so the polygon
// renderer can prewarm the replacement bitmap before its next draw.
function setObjectTexture( objectBitmapSlot, bitmapIndex ) {

	ObjBitmaps[ objectBitmapSlot ] = bitmapIndex;
	if ( _onObjectTextureChanged !== null ) {

		_onObjectTextureChanged( objectBitmapSlot, bitmapIndex );

	}

}

// Set render callback for when a texture changes
export function effects_set_render_callback( callback ) {

	_onTextureChanged = callback;

}

// Initialize special effects timers
// Ported from: init_special_effects() in EFFECTS.C
export function init_special_effects() {

	for ( let i = 0; i < Num_effects; i ++ ) {

		Effects[ i ].time_left = Effects[ i ].vc_frame_time;

	}

}

// Reset special effects (clear one-shots, restart stopped effects)
// Ported from: reset_special_effects() in EFFECTS.C
export function reset_special_effects() {

	_reactorDestroyed = false;

	for ( let i = 0; i < Num_effects; i ++ ) {

		Effects[ i ].segnum = - 1;
		Effects[ i ].flags &= ~( EF_STOPPED | EF_ONE_SHOT );

		if ( Effects[ i ].changing_wall_texture !== - 1 ) {

			Textures[ Effects[ i ].changing_wall_texture ] = Effects[ i ].vc_frames[ Effects[ i ].frame_count ];

		}

		// Reset object textures to current frame
		// Ported from: EFFECTS.C reset_special_effects() lines 142-143
		if ( Effects[ i ].changing_object_texture !== - 1 ) {

			setObjectTexture(
				Effects[ i ].changing_object_texture,
				Effects[ i ].vc_frames[ Effects[ i ].frame_count ]
			);

		}

	}

}

// Process special effects each frame
// Ported from: do_special_effects() in EFFECTS.C
export function do_special_effects() {

	if ( _getFrameTime === null ) return;

	const frameTime = _getFrameTime();

	for ( let i = 0; i < Num_effects; i ++ ) {

		const ec = Effects[ i ];

		if ( ec.changing_wall_texture === - 1 && ec.changing_object_texture === - 1 ) {

			continue;

		}

		if ( ( ec.flags & EF_STOPPED ) !== 0 ) {

			continue;

		}

		ec.time_left -= frameTime;

		let frameChanged = false;

		while ( ec.time_left < 0 ) {

			ec.time_left += ec.vc_frame_time;

			ec.frame_count ++;
			if ( ec.frame_count >= ec.vc_num_frames ) {

				if ( ( ec.flags & EF_ONE_SHOT ) !== 0 ) {

					// One-shot: switch to destroyed bitmap and stop
					// Ported from: EFFECTS.C lines 169-175
					if ( ec.segnum !== - 1 && ec.sidenum >= 0 && ec.sidenum < 6 ) {

						const side = Segments[ ec.segnum ].sides[ ec.sidenum ];
						side.tmap_num2 = ( side.tmap_num2 & 0xC000 ) | ec.dest_bm_num;

						// Notify renderer to update this side's mesh
						if ( _onSideOverlayChanged !== null ) {

							_onSideOverlayChanged( ec.segnum, ec.sidenum );

						}

					}

					ec.flags &= ~EF_ONE_SHOT;
					ec.segnum = - 1;

				}

				ec.frame_count = 0;

			}

			frameChanged = true;

		}

		if ( frameChanged !== true ) continue;

		// EF_CRITICAL eclips always skip normal texture updates
		// They are the alternate clips referenced by other eclips' crit_clip field
		// Ported from: EFFECTS.C line 182-183
		if ( ( ec.flags & EF_CRITICAL ) !== 0 ) {

			continue;

		}

		// If this eclip has a crit_clip and reactor is destroyed,
		// redirect to show frames from the alternate clip instead
		// Ported from: EFFECTS.C lines 185-195
		if ( ec.crit_clip !== - 1 && _reactorDestroyed === true ) {

			const n = ec.crit_clip;

			if ( ec.changing_wall_texture !== - 1 ) {

				const newBitmapIndex = Effects[ n ].vc_frames[ Effects[ n ].frame_count ];
				Textures[ ec.changing_wall_texture ] = newBitmapIndex;

				if ( _onTextureChanged !== null ) {

					_onTextureChanged( ec.changing_wall_texture, newBitmapIndex );

				}

			}

			// Object texture crit_clip update
			// Ported from: EFFECTS.C lines 192-193
			if ( ec.changing_object_texture !== - 1 ) {

				setObjectTexture(
					ec.changing_object_texture,
					Effects[ n ].vc_frames[ Effects[ n ].frame_count ]
				);

			}

		} else {

			// Normal frame update
			// Ported from: EFFECTS.C lines 196-203
			if ( ec.changing_wall_texture !== - 1 ) {

				const newBitmapIndex = ec.vc_frames[ ec.frame_count ];
				Textures[ ec.changing_wall_texture ] = newBitmapIndex;

				if ( _onTextureChanged !== null ) {

					_onTextureChanged( ec.changing_wall_texture, newBitmapIndex );

				}

			}

			// Object texture normal frame update
			// Ported from: EFFECTS.C lines 201-202
			if ( ec.changing_object_texture !== - 1 ) {

				setObjectTexture( ec.changing_object_texture, ec.vc_frames[ ec.frame_count ] );

			}

		}

	}

}

// Stop an effect from animating (show first frame)
// Ported from: stop_effect() in EFFECTS.C
export function stop_effect( effect_num ) {

	const ec = Effects[ effect_num ];

	ec.flags |= EF_STOPPED;
	ec.frame_count = 0;

	if ( ec.changing_wall_texture !== - 1 ) {

		Textures[ ec.changing_wall_texture ] = ec.vc_frames[ 0 ];

		if ( _onTextureChanged !== null ) {

			_onTextureChanged( ec.changing_wall_texture, ec.vc_frames[ 0 ] );

		}

	}

	// Stop object texture animation — show first frame
	// Ported from: EFFECTS.C stop_effect() lines 239-240
	if ( ec.changing_object_texture !== - 1 ) {

		setObjectTexture( ec.changing_object_texture, ec.vc_frames[ 0 ] );

	}

}

// Restart a stopped effect
// Ported from: restart_effect() in EFFECTS.C
export function restart_effect( effect_num ) {

	Effects[ effect_num ].flags &= ~EF_STOPPED;

}

// Called when reactor is destroyed — freezes EF_CRITICAL eclips
// Ported from: EFFECTS.C do_special_effects() reactor_is_dead check
export function effects_set_reactor_destroyed( destroyed ) {

	_reactorDestroyed = destroyed;

}

function cross2( ai, aj, bi, bj ) {

	return ai * bj - aj * bi;

}

function wrap_floor_mod( value, mod ) {

	let x = Math.floor( value );
	x %= mod;
	if ( x < 0 ) x += mod;
	return x;

}

// Compute hit UV on side face 0 (mirrors find_hitpoint_uv(..., facenum=0) usage in COLLIDE.C)
function compute_hitpoint_uv_face0( seg, sidenum, pos_x, pos_y, pos_z ) {

	const side = seg.sides[ sidenum ];
	const sv = Side_to_verts[ sidenum ];

	let v0, v1, v2;
	let uv0, uv1, uv2;

	if ( side.type === SIDE_IS_TRI_13 ) {

		v0 = seg.verts[ sv[ 3 ] ];
		v1 = seg.verts[ sv[ 0 ] ];
		v2 = seg.verts[ sv[ 1 ] ];
		uv0 = side.uvls[ 3 ];
		uv1 = side.uvls[ 0 ];
		uv2 = side.uvls[ 1 ];

	} else {

		// SIDE_IS_QUAD and SIDE_IS_TRI_02 both use (0,1,2) for facenum=0.
		v0 = seg.verts[ sv[ 0 ] ];
		v1 = seg.verts[ sv[ 1 ] ];
		v2 = seg.verts[ sv[ 2 ] ];
		uv0 = side.uvls[ 0 ];
		uv1 = side.uvls[ 1 ];
		uv2 = side.uvls[ 2 ];

	}

	const normal = side.normals[ 0 ];
	const ax = Math.abs( normal.x );
	const ay = Math.abs( normal.y );
	const az = Math.abs( normal.z );

	let biggest = 0;
	if ( ay > ax ) biggest = 1;
	if ( az > ( biggest === 1 ? ay : ax ) ) biggest = 2;

	const ii = ( biggest === 0 ) ? 1 : 0;
	const jj = ( biggest === 2 ) ? 1 : 2;

	const vx0_i = Vertices[ v0 * 3 + ii ];
	const vx0_j = Vertices[ v0 * 3 + jj ];
	const vx1_i = Vertices[ v1 * 3 + ii ];
	const vx1_j = Vertices[ v1 * 3 + jj ];
	const vx2_i = Vertices[ v2 * 3 + ii ];
	const vx2_j = Vertices[ v2 * 3 + jj ];

	const p1_i = vx1_i;
	const p1_j = vx1_j;
	const vec0_i = vx0_i - p1_i; // 1 -> 0
	const vec0_j = vx0_j - p1_j;
	const vec1_i = vx2_i - p1_i; // 1 -> 2
	const vec1_j = vx2_j - p1_j;
	const checkp_i = ( ii === 0 ) ? pos_x : ( ii === 1 ) ? pos_y : pos_z;
	const checkp_j = ( jj === 0 ) ? pos_x : ( jj === 1 ) ? pos_y : pos_z;

	const denom = cross2( vec0_i, vec0_j, vec1_i, vec1_j );
	if ( Math.abs( denom ) < 1e-8 ) return null;

	const k1 = - ( cross2( checkp_i, checkp_j, vec0_i, vec0_j ) + cross2( vec0_i, vec0_j, p1_i, p1_j ) ) / denom;
	let k0;

	if ( Math.abs( vec0_i ) > 1e-8 ) {

		k0 = ( - k1 * vec1_i + checkp_i - p1_i ) / vec0_i;

	} else if ( Math.abs( vec0_j ) > 1e-8 ) {

		k0 = ( - k1 * vec1_j + checkp_j - p1_j ) / vec0_j;

	} else {

		return null;

	}

	const u = uv1.u + k0 * ( uv0.u - uv1.u ) + k1 * ( uv2.u - uv1.u );
	const v = uv1.v + k0 * ( uv0.v - uv1.v ) + k1 * ( uv2.v - uv1.v );

	return { u, v };

}

// Check if a weapon hit can blow up an effect (destructible monitor) on a wall side
// If so, creates an explosion and replaces the texture with the destroyed version
// Returns 1 if the effect blew up, 0 if not
// Ported from: check_effect_blowup() in COLLIDE.C lines 766-852
export function check_effect_blowup( segnum, sidenum, pos_x, pos_y, pos_z ) {

	if ( segnum < 0 ) return 0;

	const seg = Segments[ segnum ];
	if ( seg === undefined ) return 0;

	const side = seg.sides[ sidenum ];
	const tm = side.tmap_num2;

	// Must have an overlay texture
	if ( tm === 0 ) return 0;

	// Look up eclip for this overlay texture
	const tmapIndex = tm & 0x3FFF;
	if ( tmapIndex < 0 || TmapInfos[ tmapIndex ] === undefined ) return 0;

	const ec_num = TmapInfos[ tmapIndex ].eclip_num;
	if ( ec_num === - 1 ) return 0;

	const ec = Effects[ ec_num ];

	// Check if this eclip can be destroyed
	const db = ec.dest_bm_num;
	if ( db === - 1 ) return 0;

	// Don't destroy if already playing one-shot destruction
	if ( ( ec.flags & EF_ONE_SHOT ) !== 0 ) return 0;

	// Match original transparency test: only blow up if the hit pixel is non-transparent.
	if ( _pigFile === null ) return 0;

	const bmIndex = Textures[ tmapIndex ];
	if ( bmIndex === undefined || bmIndex < 0 ) return 0;
	if ( bmIndex >= _pigFile.bitmaps.length ) return 0;

	const bm = _pigFile.bitmaps[ bmIndex ];
	if ( bm === undefined || bm.width <= 0 || bm.height <= 0 ) return 0;

	const uv = compute_hitpoint_uv_face0( seg, sidenum, pos_x, pos_y, pos_z );
	if ( uv === null ) return 0;

	let x = wrap_floor_mod( uv.u * bm.width, bm.width );
	let y = wrap_floor_mod( uv.v * bm.height, bm.height );

	switch ( tm & 0xC000 ) {

		case 0x4000: {

			const t = y;
			y = x;
			x = bm.width - t - 1;
			break;

		}

		case 0x8000:
			y = bm.height - y - 1;
			x = bm.width - x - 1;
			break;

		case 0xC000: {

			const t = x;
			x = y;
			y = bm.height - t - 1;
			break;

		}

		default:
			break;

	}

	if ( x < 0 || x >= bm.width || y < 0 || y >= bm.height ) return 0;

	const pixels = _pigFile.getBitmapPixels( bmIndex );
	if ( pixels === null ) return 0;

	if ( pixels[ y * bm.width + x ] === 255 ) return 0;

	// Create explosion at impact point
	// Ported from: COLLIDE.C line 810-811
	const vc = ec.dest_vclip;
	if ( _createExplosion !== null && vc >= 0 ) {

		_createExplosion( pos_x, pos_y, pos_z, ec.dest_size > 0 ? ec.dest_size : 2.0, vc );

	}

	// Play destruction vclip sound
	// Ported from: COLLIDE.C lines 813-814
	if ( vc >= 0 && Vclips[ vc ] !== undefined && Vclips[ vc ].sound_num !== - 1 ) {

		digi_play_sample_world( Vclips[ vc ].sound_num, 1.0, segnum, pos_x, pos_y, pos_z );

	}

	// The looping ambient source belongs to this exact segment side.  Stop it
	// before replacing the destroyed eclip texture.
	// Ported from: COLLIDE.C lines 816-817.
	if ( ec.sound_num !== - 1 ) {

		digi_kill_sound_linked_to_segment( segnum, sidenum, ec.sound_num );

	}

	// Handle texture replacement
	if ( ec.dest_eclip !== - 1 && Effects[ ec.dest_eclip ].segnum === - 1 ) {

		// Start one-shot destruction animation
		// Ported from: COLLIDE.C lines 823-837
		const new_ec = Effects[ ec.dest_eclip ];
		const bm_num = new_ec.changing_wall_texture;

		new_ec.time_left = new_ec.vc_frame_time;
		new_ec.frame_count = 0;
		new_ec.segnum = segnum;
		new_ec.sidenum = sidenum;
		new_ec.flags |= EF_ONE_SHOT;
		new_ec.dest_bm_num = ec.dest_bm_num;

		side.tmap_num2 = bm_num | ( tm & 0xC000 );

	} else {

		// Immediate replacement with destroyed bitmap
		// Ported from: COLLIDE.C lines 839-840
		side.tmap_num2 = db | ( tm & 0xC000 );

	}

	// Notify renderer to rebuild this side's mesh with the new texture
	if ( _onSideOverlayChanged !== null ) {

		_onSideOverlayChanged( segnum, sidenum );

	}

	return 1;

}
