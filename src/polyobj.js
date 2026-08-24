// Ported from: descent-master/MAIN/POLYOBJ.C, POLYOBJ.H
// Polygon object (POF) model loading and rendering

import * as THREE from 'three';
import { config_get_texture_filtering, config_on_texture_filtering_changed } from './config.js';
import { BM_FLAG_TRANSPARENT, BM_FLAG_NO_LIGHTING } from './piggy.js';

// Constants
export const MAX_SUBMODELS = 10;
const MAX_POLYGON_MODELS = 300;

// POF file signature
const POF_SIG = 0x4F505350;	// 'PSPO' as little-endian int32
const PM_COMPATIBLE_VERSION = 6;
const PM_OBJFILE_VERSION = 8;

// Chunk IDs (4-char codes as little-endian int32)
const ID_OHDR = 0x5244484F;	// 'OHDR'
const ID_SOBJ = 0x4A424F53;	// 'SOBJ'
const ID_GUNS = 0x534E5547;	// 'GUNS'
const ID_ANIM = 0x4D494E41;	// 'ANIM'
const ID_TXTR = 0x52545854;	// 'TXTR'
const ID_IDTA = 0x41544449;	// 'IDTA'

// Model bytecode opcodes
const OP_EOF = 0;
const OP_DEFPOINTS = 1;
const OP_FLATPOLY = 2;
const OP_TMAPPOLY = 3;
const OP_SORTNORM = 4;
const OP_RODBM = 5;
const OP_SUBCALL = 6;
const OP_DEFP_START = 7;
const OP_GLOW = 8;

// Palette for flat-shaded polygons (approximate Descent palette colors)
// We'll generate this from the actual palette when available
let flatColorPalette = null;

// Global model storage
export const Polygon_models = [];
export let N_polygon_models = 0;

export function set_N_polygon_models( n ) {

	N_polygon_models = n;

}

// Polymodel class - mirrors C struct polymodel
export class Polymodel {

	constructor() {

		this.n_models = 0;		// number of submodels
		this.model_data = null;		// Uint8Array bytecode
		this.model_data_size = 0;
		this.submodel_ptrs = new Int32Array( MAX_SUBMODELS );	// byte offsets into model_data
		this.submodel_offsets = [];	// {x,y,z} per submodel
		this.submodel_norms = [];
		this.submodel_pnts = [];
		this.submodel_rads = new Float64Array( MAX_SUBMODELS );
		this.submodel_parents = new Uint8Array( MAX_SUBMODELS );
		this.submodel_mins = [];
		this.submodel_maxs = [];
		this.mins = { x: 0, y: 0, z: 0 };
		this.maxs = { x: 0, y: 0, z: 0 };
		this.rad = 0;
		this.n_textures = 0;
		this.first_texture = 0;
		this.simpler_model = 0;

		for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

			this.submodel_offsets.push( { x: 0, y: 0, z: 0 } );
			this.submodel_norms.push( { x: 0, y: 0, z: 0 } );
			this.submodel_pnts.push( { x: 0, y: 0, z: 0 } );
			this.submodel_mins.push( { x: 0, y: 0, z: 0 } );
			this.submodel_maxs.push( { x: 0, y: 0, z: 0 } );

		}

		// Texture names from TXTR chunk (model-local indices map to these)
		this.textureNames = [];
		this.textureBitmapIndices = null;	// static fallback for models without ObjBitmap indirection
		this.textureObjectBitmapSlots = null;	// live ObjBitmaps[] slots for compiled/table models

		// Gun hardpoints from GUNS chunk (used by reactor/robots)
		this.n_guns = 0;
		this.gun_points = [];	// {x,y,z} per gun (model-space)
		this.gun_dirs = [];		// {x,y,z} per gun (model-space)
		this.gun_submodels = [];	// which submodel each gun is on

		// Animation data from ANIM chunk (null = no animation)
		// anim_angs[state][submodel] = {p, b, h} in radians
		this.anim_angs = null;

		// Three.js mesh (built on first use)
		this.mesh = null;

		// Animated mesh (hierarchical submodel groups, built on first use)
		this.animatedMesh = null;

	}

}

// Read a vms_vector (3 fix values = 12 bytes) from DataView
function readVec( dv, offset ) {

	return {
		x: dv.getInt32( offset, true ) / 65536.0,
		y: dv.getInt32( offset + 4, true ) / 65536.0,
		z: dv.getInt32( offset + 8, true ) / 65536.0
	};

}

// Read a uint16 from DataView
function readU16( dv, offset ) {

	return dv.getUint16( offset, true );

}

// Read an int16 from DataView
function readI16( dv, offset ) {

	return dv.getInt16( offset, true );

}

// Read a fix (int32) from DataView, convert to float
function readFix( dv, offset ) {

	return dv.getInt32( offset, true ) / 65536.0;

}

// Rebuild the per-submodel bounds stored only in compiled polymodel headers.
// POF files carry the defining point stream instead, so D1 calls
// polyobj_find_min_max() immediately after read_model_file().
function polyobj_find_min_max( model ) {

	if ( model.model_data === null || model.n_models <= 0 || model.n_models > MAX_SUBMODELS ) return false;

	const data = model.model_data;
	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );

	for ( let m = 0; m < model.n_models; m ++ ) {

		const ptr = model.submodel_ptrs[ m ];
		if ( ptr < 0 || ptr + 4 > data.length ) return false;

		const opcode = readU16( dv, ptr );
		const nverts = readU16( dv, ptr + 2 );
		if ( ( opcode !== OP_DEFPOINTS && opcode !== OP_DEFP_START ) || nverts === 0 ) return false;

		const vertexStart = ptr + ( opcode === OP_DEFP_START ? 8 : 4 );
		if ( vertexStart + nverts * 12 > data.length ) return false;

		const first = readVec( dv, vertexStart );
		const mins = model.submodel_mins[ m ];
		const maxs = model.submodel_maxs[ m ];
		mins.x = maxs.x = first.x;
		mins.y = maxs.y = first.y;
		mins.z = maxs.z = first.z;

		if ( m === 0 ) {

			model.mins.x = model.maxs.x = first.x;
			model.mins.y = model.maxs.y = first.y;
			model.mins.z = model.maxs.z = first.z;

		}

		const offset = model.submodel_offsets[ m ];
		for ( let i = 1; i < nverts; i ++ ) {

			const vertex = readVec( dv, vertexStart + i * 12 );
			if ( vertex.x < mins.x ) mins.x = vertex.x;
			if ( vertex.y < mins.y ) mins.y = vertex.y;
			if ( vertex.z < mins.z ) mins.z = vertex.z;
			if ( vertex.x > maxs.x ) maxs.x = vertex.x;
			if ( vertex.y > maxs.y ) maxs.y = vertex.y;
			if ( vertex.z > maxs.z ) maxs.z = vertex.z;

			// Preserve D1's exact whole-model calculation, including its use of
			// only the immediate submodel offset and vertices after the first.
			const worldX = vertex.x + offset.x;
			const worldY = vertex.y + offset.y;
			const worldZ = vertex.z + offset.z;
			if ( worldX < model.mins.x ) model.mins.x = worldX;
			if ( worldY < model.mins.y ) model.mins.y = worldY;
			if ( worldZ < model.mins.z ) model.mins.z = worldZ;
			if ( worldX > model.maxs.x ) model.maxs.x = worldX;
			if ( worldY > model.maxs.y ) model.maxs.y = worldY;
			if ( worldZ > model.maxs.z ) model.maxs.z = worldZ;

		}

	}

	return true;

}

// Rod UVs are inset by half a texel in fixed-point, matching ROD.ASM uvl_list.
const ROD_UV_MIN = 0x0200 / 65536.0;
const ROD_UV_MAX = 0xFE00 / 65536.0;
const SIMPLE_MODEL_THRESHOLD_SCALE = 5.0;

const _lodCameraPosition = new THREE.Vector3();
const _lodObjectPosition = new THREE.Vector3();
const _lodForward = new THREE.Vector3();

// Parse a POF file from a CFile reader
export function load_polygon_model( fp ) {

	const model = new Polymodel();

	const fileStart = fp.tell();
	const fileSize = fp.length();

	// Read signature
	const sig = fp.readInt();
	if ( ( sig & 0xFFFFFFFF ) !== ( POF_SIG & 0xFFFFFFFF ) ) {

		console.error( 'POF: Invalid signature 0x' + ( sig >>> 0 ).toString( 16 ) );
		return null;

	}

	// Read version
	const version = fp.readShort();
	if ( version < PM_COMPATIBLE_VERSION || version > PM_OBJFILE_VERSION ) {

		console.error( 'POF: Unsupported version ' + version );
		return null;

	}

	// Read chunks
	while ( fp.tell() < fileSize ) {

		const chunkId = fp.readInt();
		const chunkLen = fp.readInt();
		const chunkStart = fp.tell();

		if ( ( chunkId & 0xFFFFFFFF ) === ( ID_OHDR & 0xFFFFFFFF ) ) {

			// Object header
			model.n_models = fp.readInt();
			model.rad = fp.readFix();
			const rmin = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
			const rmax = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
			model.mins = rmin;
			model.maxs = rmax;

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_SOBJ & 0xFFFFFFFF ) ) {

			// Subobject — subnum and parent are shorts (2 bytes), not ints
			const subnum = fp.readShort();
			if ( subnum >= 0 && subnum < MAX_SUBMODELS ) {

				model.submodel_parents[ subnum ] = fp.readShort();
				model.submodel_norms[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_pnts[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_offsets[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_rads[ subnum ] = fp.readFix();
				model.submodel_ptrs[ subnum ] = fp.readInt();

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_TXTR & 0xFFFFFFFF ) ) {

			// Texture names (model-local bitmap indices map to these)
			const nTextures = fp.readShort();
			for ( let i = 0; i < nTextures; i ++ ) {

				// Read null-terminated string
				let name = '';
				while ( true ) {

					const ch = fp.readUByte();
					if ( ch === 0 ) break;
					name += String.fromCharCode( ch );

				}

				model.textureNames.push( name );

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_ANIM & 0xFFFFFFFF ) ) {

			// Animation data chunk — per-state angles for each submodel
			// Ported from: POLYOBJ.C lines 376-399 — ID_ANIM handler
			const n_frames = fp.readShort();

			if ( n_frames > 0 && model.n_models > 0 ) {

				model.anim_angs = [];

				for ( let f = 0; f < n_frames; f ++ ) {

					const stateAngles = [];

					for ( let m = 0; m < model.n_models; m ++ ) {

						stateAngles.push( { p: 0, b: 0, h: 0 } );

					}

					model.anim_angs.push( stateAngles );

				}

				// Read order: for each submodel m, for each state f
				// Each vms_angvec = 3 * int16 (p, b, h in fixang units)
				const ANG_SCALE = 2.0 * Math.PI / 65536.0;

				for ( let m = 0; m < model.n_models; m ++ ) {

					for ( let f = 0; f < n_frames; f ++ ) {

						const p = fp.readShort();
						const b = fp.readShort();
						const h = fp.readShort();
						model.anim_angs[ f ][ m ].p = p * ANG_SCALE;
						model.anim_angs[ f ][ m ].b = b * ANG_SCALE;
						model.anim_angs[ f ][ m ].h = h * ANG_SCALE;

					}

				}

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_IDTA & 0xFFFFFFFF ) ) {

			// Interpreter data (bytecode)
			model.model_data_size = chunkLen;
			model.model_data = fp.readBytes( chunkLen );

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_GUNS & 0xFFFFFFFF ) ) {

			// Gun hardpoints — ported from polyobj.c read_model_guns() / pof_read_data() ID_GUNS handler
			// Format: int(n_guns), then per gun:
			//   short(gun_id), short(submodel), fix(px,py,pz)
			//   version 7+: fix(dx,dy,dz)
			model.n_guns = fp.readInt();

			// Pre-allocate arrays so gun_id indexing works (guns may be out of order)
			for ( let i = 0; i < model.n_guns; i ++ ) {

				model.gun_submodels.push( 0 );
				model.gun_points.push( { x: 0, y: 0, z: 0 } );
				model.gun_dirs.push( { x: 0, y: 0, z: 0 } );

			}

			for ( let i = 0; i < model.n_guns; i ++ ) {

				const gun_id = fp.readShort();
				const submodel = fp.readShort();
				const px = fp.readFix();
				const py = fp.readFix();
				const pz = fp.readFix();
				let dx = 0, dy = 0, dz = 0;
				if ( version >= 7 ) {

					dx = fp.readFix();
					dy = fp.readFix();
					dz = fp.readFix();

				}

				if ( gun_id >= 0 && gun_id < model.n_guns ) {

					model.gun_submodels[ gun_id ] = submodel;
					model.gun_points[ gun_id ] = { x: px, y: py, z: pz };
					model.gun_dirs[ gun_id ] = { x: dx, y: dy, z: dz };

				}

			}

		}

		// Skip to end of chunk
		fp.seek( chunkStart + chunkLen );

	}

	if ( model.model_data !== null && polyobj_find_min_max( model ) !== true ) {

		console.error( 'POF: Invalid submodel point data' );
		return null;

	}

	return model;

}

// Read the packed polymodel header stored in Descent 1's compiled HAM data.
// The model bytecode follows all polymodel headers and is read separately by
// bm_read_all(), matching BM.C. The four-byte model_data pointer in the DOS
// structure is meaningless on disk and must only be skipped.
export function read_compiled_polygon_model_header( fp ) {

	const model = new Polymodel();
	model.compiled = true;
	model.flatColorsArePaletteIndices = true;

	model.n_models = fp.readInt();
	model.model_data_size = fp.readInt();
	fp.skip( 4 );	// serialized DOS model_data pointer

	for ( let i = 0; i < MAX_SUBMODELS; i ++ ) model.submodel_ptrs[ i ] = fp.readInt();

	const vectorArrays = [ model.submodel_offsets, model.submodel_norms, model.submodel_pnts ];
	for ( let arrayIndex = 0; arrayIndex < vectorArrays.length; arrayIndex ++ ) {

		const vectors = vectorArrays[ arrayIndex ];
		for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

			vectors[ i ].x = fp.readFix();
			vectors[ i ].y = fp.readFix();
			vectors[ i ].z = fp.readFix();

		}

	}

	for ( let i = 0; i < MAX_SUBMODELS; i ++ ) model.submodel_rads[ i ] = fp.readFix();
	for ( let i = 0; i < MAX_SUBMODELS; i ++ ) model.submodel_parents[ i ] = fp.readUByte();

	const boundsArrays = [ model.submodel_mins, model.submodel_maxs ];
	for ( let arrayIndex = 0; arrayIndex < boundsArrays.length; arrayIndex ++ ) {

		const vectors = boundsArrays[ arrayIndex ];
		for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

			vectors[ i ].x = fp.readFix();
			vectors[ i ].y = fp.readFix();
			vectors[ i ].z = fp.readFix();

		}

	}

	model.mins.x = fp.readFix();
	model.mins.y = fp.readFix();
	model.mins.z = fp.readFix();
	model.maxs.x = fp.readFix();
	model.maxs.y = fp.readFix();
	model.maxs.z = fp.readFix();
	model.rad = fp.readFix();
	model.n_textures = fp.readUByte();
	model.first_texture = fp.readUShort();
	model.simpler_model = fp.readUByte();

	return model;

}

// Interpret model bytecode and extract polygons for Three.js
// Returns { flatPolys, texPolys }
// startOffset: byte offset in model_data to start interpreting from
function interpretModelData( model, startOffset, offsetX, offsetY, offsetZ, subobj_flags ) {

	const data = model.model_data;
	if ( data === null ) return null;

	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const startPtr = startOffset;

	// Vertex buffer built by DEFPOINTS/DEFP_START
	const points = [];	// array of {x, y, z}

	// Collected polygons
	const flatPolys = [];	// { verts: [{x,y,z}...], color: int }
	const texPolys = [];	// { verts: [{x,y,z}...], uvs: [{u,v}...], bitmap: int }
	const rods = [];		// { top:{x,y,z}, bot:{x,y,z}, topWidth, botWidth, bitmap }

	// Track current submodel for subobj_flags filtering
	let currentSubmodel = 0;

	// Glow state: set by OP_GLOW, consumed by next OP_TMAPPOLY
	// Ported from: 3D/INTERP.ASM — glow_num variable
	let glowNum = - 1;

	// Recursive interpreter — offX/Y/Z accumulate submodel offsets
	function interpret( ptr, offX, offY, offZ ) {

		while ( ptr < data.length - 2 ) {

			const opcode = readU16( dv, ptr );

			switch ( opcode ) {

				case OP_EOF:
					return;

				case OP_DEFPOINTS: {

					const n = readU16( dv, ptr + 2 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 4 + i * 12 );
						points[ i ] = {
							x: v.x + offX,
							y: v.y + offY,
							z: v.z + offZ
						};

					}

					ptr += 4 + n * 12;
					break;

				}

				case OP_DEFP_START: {

					const n = readU16( dv, ptr + 2 );
					const start = readU16( dv, ptr + 4 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 8 + i * 12 );
						points[ start + i ] = {
							x: v.x + offX,
							y: v.y + offY,
							z: v.z + offZ
						};

					}

					ptr += 8 + n * 12;
					break;

				}

				case OP_FLATPOLY: {

					const nv = readU16( dv, ptr + 2 );

					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << currentSubmodel ) ) !== 0 ) {

					// Normal at ptr+4 (12 bytes), center at ptr+16 (12 bytes)
					const color = readU16( dv, ptr + 28 );

					const verts = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					if ( verts.length >= 3 ) {

						flatPolys.push( { verts, color } );

					}

					}

					ptr += 30 + ( nv | 1 ) * 2;
					break;

				}

				case OP_TMAPPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const uvlOffset = 30 + ( nv | 1 ) * 2;

					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << currentSubmodel ) ) !== 0 ) {

					// The bytecode stores the plane point at ptr+4 and its normal at
					// ptr+16.  The interpreter uses the latter for both facing and light.
					const normal = readVec( dv, ptr + 16 );
					const bitmap = readU16( dv, ptr + 28 );

					const verts = [];
					const uvs = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					for ( let i = 0; i < nv; i ++ ) {

						uvs.push( {
							u: readFix( dv, ptr + uvlOffset + i * 12 ),
							v: readFix( dv, ptr + uvlOffset + i * 12 + 4 )
						} );

					}

					if ( verts.length >= 3 ) {

						// Mark glow polygons — OP_GLOW sets glowNum for the next OP_TMAPPOLY
						// Ported from: 3D/INTERP.ASM — glow_num consumed by tmappoly handler
						const isGlow = ( glowNum >= 0 );
						texPolys.push( { verts, uvs, bitmap, isGlow, normal } );

					}

					}

					// OP_GLOW is consumed by the next TMAPPOLY even when subobj_flags
					// excludes that polygon.  Otherwise debris-only builds can leak a
					// skipped parent's glow state into a later included submodel.
					glowNum = - 1;

					ptr += uvlOffset + nv * 12;
					break;

				}

				case OP_SORTNORM: {

					// BSP node: interpret both children (Three.js handles depth sorting),
					// then continue the enclosing opcode stream after this 32-byte node.
					// D1's interpreter does the same after both recursive calls; valid POFs
					// can place additional, distinct geometry after the SORTNORM record.
					const backOff = readU16( dv, ptr + 28 );
					const frontOff = readU16( dv, ptr + 30 );
					interpret( ptr + backOff, offX, offY, offZ );
					interpret( ptr + frontOff, offX, offY, offZ );
					ptr += 32;
					break;

				}

					case OP_RODBM: {

						if ( subobj_flags === undefined || ( subobj_flags & ( 1 << currentSubmodel ) ) !== 0 ) {

							const bitmap = readU16( dv, ptr + 2 );
							const top = readVec( dv, ptr + 4 );
							const bot = readVec( dv, ptr + 20 );
							const botWidth = readFix( dv, ptr + 16 );
							const topWidth = readFix( dv, ptr + 32 );

							rods.push( {
								top: { x: top.x + offX, y: top.y + offY, z: top.z + offZ },
								bot: { x: bot.x + offX, y: bot.y + offY, z: bot.z + offZ },
								topWidth: topWidth,
								botWidth: botWidth,
								bitmap: bitmap
							} );

						}

						ptr += 36;
						break;

				}

				case OP_SUBCALL: {

					const subNum = readU16( dv, ptr + 2 );
					const subOffset = readVec( dv, ptr + 4 );
					const codeOffset = readU16( dv, ptr + 16 );

					// Only interpret submodel if its flag is set (or render all if no flags)
					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << subNum ) ) !== 0 ) {

						const prevSubmodel = currentSubmodel;
						currentSubmodel = subNum;
						interpret(
							ptr + codeOffset,
							offX + subOffset.x,
							offY + subOffset.y,
							offZ + subOffset.z
						);
						currentSubmodel = prevSubmodel;

					}

					ptr += 20;
					break;

				}

				case OP_GLOW: {

					// Set glow index for the next OP_TMAPPOLY polygon
					// Ported from: 3D/INTERP.ASM op_glow — reads 2-byte glow_num at offset +2
					glowNum = readU16( dv, ptr + 2 );
					ptr += 4;
					break;

				}

				default:
					// Unknown opcode, bail
					console.warn( 'POF: Unknown opcode ' + opcode + ' at offset ' + ptr );
					return;

			}

		}

	}

	interpret( startPtr, offsetX, offsetY, offsetZ );

	return { flatPolys, texPolys, rods };

}

// Convert RGB 5-5-5 packed color to float RGB when no game palette is present.
// Ported from: 3D/INTERP.ASM — OP_FLATPOLY color field is 15-bit RGB (not a palette index).
// Format: bits 10-14 = Red(0-31), bits 5-9 = Green(0-31), bits 0-4 = Blue(0-31)
function rgb15toFloat( rgb15 ) {

	const r = ( ( rgb15 >> 10 ) & 31 ) / 31;
	const g = ( ( rgb15 >> 5 ) & 31 ) / 31;
	const b = ( rgb15 & 31 ) / 31;
	return { r, g, b };

}

function flatColorToPaletteIndex( color, model, palette ) {

	if ( palette === null || palette === undefined ) return - 1;
	if ( model.flatColorsArePaletteIndices === true ) return color & 0xFF;

	let paletteIndex = color & 0xFF;

	// g3_init_polygon_model() converts each POF RGB 5-5-5 color through
	// gr_find_closest_color_15bpp() before the model is ever drawn.  The
	// lookup works in the original 6-bit DAC space and excludes the two
	// reserved transparency colors.
	const red = ( ( color >> 10 ) & 31 ) * 2;
	const green = ( ( color >> 5 ) & 31 ) * 2;
	const blue = ( color & 31 ) * 2;
	let bestDistance = Number.POSITIVE_INFINITY;

	for ( let i = 0; i < 254; i ++ ) {

		const offset = i * 3;
		const dr = red - ( palette[ offset + 0 ] >> 2 );
		const dg = green - ( palette[ offset + 1 ] >> 2 );
		const db = blue - ( palette[ offset + 2 ] >> 2 );
		const distance = dr * dr + dg * dg + db * db;
		if ( distance < bestDistance ) {

			bestDistance = distance;
			paletteIndex = i;
			if ( distance === 0 ) break;

		}

	}

	return paletteIndex;

}

function flatColorToFloat( color, model, palette ) {

	const paletteIndex = flatColorToPaletteIndex( color, model, palette );
	if ( paletteIndex >= 0 ) {

		return {
			r: palette[ paletteIndex * 3 + 0 ] / 255,
			g: palette[ paletteIndex * 3 + 1 ] / 255,
			b: palette[ paletteIndex * 3 + 2 ] / 255
		};

	}

	return rgb15toFloat( color );

}

function resolveModelTextureBitmapIndices( model, pigFile ) {

	if ( model.textureObjectBitmapSlots !== null ) {

		if ( objectBitmapTable === null ) {

			throw new Error( 'Object bitmap table is not configured' );

		}

		const indices = [];
		for ( let i = 0; i < model.textureObjectBitmapSlots.length; i ++ ) {

			const objectBitmapSlot = model.textureObjectBitmapSlots[ i ];
			if ( objectBitmapSlot < 0 || objectBitmapSlot >= objectBitmapTable.length ) {

				throw new Error( 'Invalid object bitmap slot ' + objectBitmapSlot );

			}
			indices.push( objectBitmapTable[ objectBitmapSlot ] );

		}
		return indices;

	}

	if ( model.textureBitmapIndices !== null ) return model.textureBitmapIndices;

	const indices = [];
	for ( let i = 0; i < model.textureNames.length; i ++ ) {

		indices.push( pigFile.findBitmapIndexByName( model.textureNames[ i ] ) );

	}
	return indices;

}

// Cache for model textures (keyed by PIG bitmap index)
const modelTextureCache = new Map();

const GR_FADE_LEVELS = 34;
const cloakLookupCache = new WeakMap();

function getCloakLookupTextures( palette ) {

	if ( palette === null || palette === undefined ) return null;
	if ( cloakLookupCache.has( palette ) ) return cloakLookupCache.get( palette );

	const fadePixels = new Uint8Array( 256 * GR_FADE_LEVELS * 4 );
	const fadeTable = palette.fadeTable;
	for ( let level = 0; level < GR_FADE_LEVELS; level ++ ) {

		for ( let color = 0; color < 256; color ++ ) {

			const value = fadeTable !== undefined && fadeTable.length >= 256 * GR_FADE_LEVELS
				? fadeTable[ level * 256 + color ] : color;
			const offset = ( level * 256 + color ) * 4;
			fadePixels[ offset + 0 ] = value;
			fadePixels[ offset + 1 ] = value;
			fadePixels[ offset + 2 ] = value;
			fadePixels[ offset + 3 ] = 255;

		}

	}

	const palettePixels = new Uint8Array( 256 * 4 );
	for ( let color = 0; color < 256; color ++ ) {

		const source = color * 3;
		const target = color * 4;
		palettePixels[ target + 0 ] = palette[ source + 0 ];
		palettePixels[ target + 1 ] = palette[ source + 1 ];
		palettePixels[ target + 2 ] = palette[ source + 2 ];
		palettePixels[ target + 3 ] = 255;

	}

	const fade = new THREE.DataTexture( fadePixels, 256, GR_FADE_LEVELS );
	fade.colorSpace = THREE.NoColorSpace;
	fade.magFilter = THREE.NearestFilter;
	fade.minFilter = THREE.NearestFilter;
	fade.wrapS = THREE.ClampToEdgeWrapping;
	fade.wrapT = THREE.ClampToEdgeWrapping;
	fade.generateMipmaps = false;
	fade.needsUpdate = true;

	const colors = new THREE.DataTexture( palettePixels, 256, 1 );
	colors.colorSpace = THREE.NoColorSpace;
	colors.magFilter = THREE.NearestFilter;
	colors.minFilter = THREE.NearestFilter;
	colors.wrapS = THREE.ClampToEdgeWrapping;
	colors.wrapT = THREE.ClampToEdgeWrapping;
	colors.generateMipmaps = false;
	colors.needsUpdate = true;

	const result = { fade, colors };
	cloakLookupCache.set( palette, result );
	return result;

}

function configureCloakMaterial( material, palette, averageColor = 0 ) {

	const lookup = getCloakLookupTextures( palette );
	if ( lookup !== null ) {

		material.cloakFadeTexture = lookup.fade;
		material.cloakPaletteTexture = lookup.colors;

	}
	material.bitmapAverageColor = averageColor;

}

// Compiled/table polygon models do not own bitmap indices.  Their local texture
// numbers resolve through ObjBitmapPtrs[] to a stable ObjBitmaps[] slot, whose
// value can be replaced by EFFECTS.C while the game is running.  Keep the table
// and texture resources injected to avoid a bm.js <-> polyobj.js module cycle.
let objectBitmapTable = null;
let objectTexturePigFile = null;
let objectTexturePalette = null;

export function polyobj_set_object_bitmap_source( table, pigFile, palette ) {

	objectBitmapTable = table;
	objectTexturePigFile = pigFile;
	objectTexturePalette = palette;

}

export function polyobj_prewarm_object_bitmap( bitmapIndex ) {

	if ( objectTexturePigFile === null || objectTexturePalette === null ) return false;
	if ( bitmapIndex < 0 || bitmapIndex >= objectTexturePigFile.bitmaps.length ) return false;
	return buildModelTexture( bitmapIndex, objectTexturePigFile, objectTexturePalette ) !== null;

}

// Pre-build every frame which can be installed in an ObjBitmaps[] slot.  This
// keeps the render callback below to an integer comparison and a cache lookup.
export function polyobj_prewarm_object_effects( effects, numEffects ) {

	function prewarmFrames( effect ) {

		const numFrames = Math.min( effect.vc_num_frames, effect.vc_frames.length );
		for ( let frame = 0; frame < numFrames; frame ++ ) {

			polyobj_prewarm_object_bitmap( effect.vc_frames[ frame ] );

		}

	}

	for ( let i = 0; i < numEffects; i ++ ) {

		const effect = effects[ i ];
		if ( effect === undefined || effect.changing_object_texture < 0 ) continue;

		prewarmFrames( effect );
		if ( effect.crit_clip >= 0 && effect.crit_clip < numEffects ) {

			prewarmFrames( effects[ effect.crit_clip ] );

		}

	}

}

// Called after every Effects[] mutation of ObjBitmaps[].  Prewarming here is a
// safety net for data installed after initialization; normal eclip frames have
// already been prepared by polyobj_prewarm_object_effects().
export function polyobj_object_bitmap_changed( objectBitmapSlot, bitmapIndex ) {

	if ( objectBitmapTable === null ) return false;
	if ( objectBitmapSlot < 0 || objectBitmapSlot >= objectBitmapTable.length ) return false;
	return polyobj_prewarm_object_bitmap( bitmapIndex );

}

function bitmapUsesNoLighting( bitmapIndex ) {

	if ( objectTexturePigFile === null ) return false;
	const bitmap = objectTexturePigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined && ( bitmap.flags & BM_FLAG_NO_LIGHTING ) !== 0;

}

function bitmapUsesTransparency( bitmapIndex ) {

	if ( objectTexturePigFile === null ) return false;
	const bitmap = objectTexturePigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined && ( bitmap.flags & BM_FLAG_TRANSPARENT ) !== 0;

}

function bitmapAverageColor( bitmapIndex ) {

	if ( objectTexturePigFile === null ) return 0;
	const bitmap = objectTexturePigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined ? bitmap.avg_color : 0;

}

function pigBitmapUsesNoLighting( pigFile, bitmapIndex ) {

	if ( pigFile === null || pigFile === undefined ) return false;
	const bitmap = pigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined && ( bitmap.flags & BM_FLAG_NO_LIGHTING ) !== 0;

}

function pigBitmapUsesTransparency( pigFile, bitmapIndex ) {

	if ( pigFile === null || pigFile === undefined ) return false;
	const bitmap = pigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined && ( bitmap.flags & BM_FLAG_TRANSPARENT ) !== 0;

}

function pigBitmapAverageColor( pigFile, bitmapIndex ) {

	if ( pigFile === null || pigFile === undefined ) return 0;
	const bitmap = pigFile.bitmaps[ bitmapIndex ];
	return bitmap !== undefined ? bitmap.avg_color : 0;

}

// Exported for focused parity tests.  In normal rendering this is called by
// PolyobjTextureMaterial.onBeforeRender().
export function polyobj_sync_object_texture_material( material ) {

	if ( objectBitmapTable === null ) return false;
	const data = material.userData;
	if ( data.tmapOverride === true ) return false;
	const objectBitmapSlot = data.objectBitmapSlot;
	if ( objectBitmapSlot === undefined ) return false;
	if ( objectBitmapSlot < 0 || objectBitmapSlot >= objectBitmapTable.length ) return false;

	const bitmapIndex = objectBitmapTable[ objectBitmapSlot ];
	if ( bitmapIndex === data.objectBitmapIndex ) return false;

	// All legal effect frames are prewarmed outside the render loop.  Do not
	// allocate pixel or texture storage from an onBeforeRender callback.
	const texture = modelTextureCache.get( bitmapIndex );
	if ( texture === undefined || texture === null ) return false;

	const hadMap = material.map !== null;
	const hadAlphaTest = material.alphaTest > 0;
	const needsAlphaTest = bitmapUsesTransparency( bitmapIndex );
	material.map = texture;
	material.alphaTest = needsAlphaTest === true ? 0.5 : 0;
	data.objectBitmapIndex = bitmapIndex;
	data.noLighting = bitmapUsesNoLighting( bitmapIndex );
	material.bitmapAverageColor = bitmapAverageColor( bitmapIndex );
	if ( hadMap !== true || hadAlphaTest !== needsAlphaTest ) material.needsUpdate = true;
	return true;

}

// OBJECT.C replaces every texture-mapped face of a polygon object when its
// per-instance tmap_override is set.  Runtime model clones own their materials,
// so the override can be installed once without mutating the cached template.
// It also takes precedence over animated ObjBitmaps for the lifetime of this
// instance, exactly like D1's alternate texture list passed to the interpreter.
export function polyobj_apply_texture_override( group, bitmapIndex, pigFile, palette ) {

	if ( group === null || group === undefined ) return false;
	if ( Number.isInteger( bitmapIndex ) !== true || bitmapIndex < 0 ) return false;
	if ( pigFile === null || pigFile === undefined ||
		bitmapIndex >= pigFile.bitmaps.length ) return false;

	const texture = buildModelTexture( bitmapIndex, pigFile, palette );
	if ( texture === null ) return false;

	const needsAlphaTest = pigBitmapUsesTransparency( pigFile, bitmapIndex );
	const noLighting = pigBitmapUsesNoLighting( pigFile, bitmapIndex );
	let changed = false;

	group.traverse( ( child ) => {

		if ( child.isMesh !== true ) return;
		const materials = Array.isArray( child.material ) ? child.material : null;
		const materialCount = materials !== null ? materials.length : 1;

		for ( let i = 0; i < materialCount; i ++ ) {

			const material = materials !== null ? materials[ i ] : child.material;
			if ( ( material instanceof PolyobjTextureMaterial ) !== true ) continue;

			const hadMap = material.map !== null;
			const hadAlphaTest = material.alphaTest > 0;
			material.map = texture;
			material.alphaTest = needsAlphaTest === true ? 0.5 : 0;
			material.userData.tmapOverride = true;
			material.userData.noLighting = noLighting;
			material.bitmapAverageColor = pigBitmapAverageColor( pigFile, bitmapIndex );
			if ( hadMap !== true || hadAlphaTest !== needsAlphaTest ) material.needsUpdate = true;
			changed = true;

		}

	} );

	return changed;

}

// A material callback survives both Object3D.clone() (which shares materials)
// and explicit material.clone() calls.  Three.js constructs cloned materials
// with the same subclass and copies primitive userData fields.
class PolyobjTextureMaterial extends THREE.MeshBasicMaterial {

	constructor( parameters ) {

		super( parameters );
		this.isPolyobjTextureMaterial = true;
		this.objectLightR = 1;
		this.objectLightG = 1;
		this.objectLightB = 1;
		this.glowLight = 1;
		this.useObjectLight = false;
		this.cloakMode = 0;
		this.cloakLightScale = 1;
		this.cloakLevel = GR_FADE_LEVELS - 1;
		this.bitmapAverageColor = 0;
		this.cloakFadeTexture = null;
		this.cloakPaletteTexture = null;
		this._cloakModeUniform = null;
		this._cloakLightScaleUniform = null;
		this._cloakLevelUniform = null;
		this._cloakAverageColorUniform = null;
		this._cloakObjectLightUniform = null;
		this._cloakGlowLightUniform = null;
		this._cloakUseObjectLightUniform = null;

	}

	onBeforeCompile( shader ) {

		shader.uniforms.d1CloakMode = { value: this.cloakMode };
		shader.uniforms.d1CloakLightScale = { value: this.cloakLightScale };
		shader.uniforms.d1CloakLevel = { value: this.cloakLevel };
		shader.uniforms.d1CloakAverageColor = { value: this.bitmapAverageColor };
		shader.uniforms.d1CloakObjectLight = { value: new THREE.Vector3(
			this.objectLightR, this.objectLightG, this.objectLightB
		) };
		shader.uniforms.d1CloakGlowLight = { value: this.glowLight };
		shader.uniforms.d1CloakUseObjectLight = { value: this.useObjectLight === true ? 1 : 0 };
		shader.uniforms.d1CloakFade = { value: this.cloakFadeTexture };
		shader.uniforms.d1CloakPalette = { value: this.cloakPaletteTexture };

		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				'#include <common>\nvarying float vD1CloakFaceLight;'
			)
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n\tvD1CloakFaceLight = 1.0;'
			);

		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				'#include <common>\n' +
				'uniform float d1CloakMode;\n' +
				'uniform float d1CloakLightScale;\n' +
				'uniform float d1CloakLevel;\n' +
				'uniform float d1CloakAverageColor;\n' +
				'uniform vec3 d1CloakObjectLight;\n' +
				'uniform float d1CloakGlowLight;\n' +
				'uniform float d1CloakUseObjectLight;\n' +
				'uniform sampler2D d1CloakFade;\n' +
				'uniform sampler2D d1CloakPalette;\n' +
				'varying float vD1CloakFaceLight;\n' +
				'vec3 d1CloakSrgbToLinear( vec3 value ) {\n' +
				'\tvec3 low = value / 12.92;\n' +
				'\tvec3 high = pow( ( value + 0.055 ) / 1.055, vec3( 2.4 ) );\n' +
				'\treturn mix( low, high, step( vec3( 0.04045 ), value ) );\n' +
				'}\n' +
				'float d1CloakFadeIndex( float level, float color ) {\n' +
				'\tvec2 uv = vec2( ( color + 0.5 ) / 256.0, ( level + 0.5 ) / 34.0 );\n' +
				'\treturn floor( texture2D( d1CloakFade, uv ).r * 255.0 + 0.5 );\n' +
				'}'
			)
			.replace(
				'#include <alphatest_fragment>',
				'if ( d1CloakMode < 0.5 ) {\n\t#include <alphatest_fragment>\n}'
			)
			.replace(
				'#include <opaque_fragment>',
				'outgoingLight *= d1CloakLightScale;\n' +
				'if ( d1CloakMode > 0.5 ) {\n' +
				'\tfloat d1ObjectScalar = dot( d1CloakObjectLight, vec3( 0.3333333333 ) );\n' +
				'\tfloat d1SourceLight = mix( d1CloakGlowLight,\n' +
				'\t\td1ObjectScalar * vD1CloakFaceLight, d1CloakUseObjectLight );\n' +
				'\tfloat d1LightLevel = floor( clamp( d1SourceLight * 32.0, 0.0, 31.0 ) );\n' +
				'\tfloat d1LitColor = d1CloakFadeIndex( d1LightLevel, d1CloakAverageColor );\n' +
				'\tfloat d1FinalColor = d1CloakFadeIndex( clamp( d1CloakLevel, 0.0, 33.0 ), d1LitColor );\n' +
				'\tvec3 d1PaletteColor = texture2D( d1CloakPalette,\n' +
				'\t\tvec2( ( d1FinalColor + 0.5 ) / 256.0, 0.5 ) ).rgb;\n' +
				'\toutgoingLight = d1CloakSrgbToLinear( d1PaletteColor );\n' +
				'\tdiffuseColor.a = 1.0;\n' +
				'}\n' +
				'#include <opaque_fragment>'
			);

		this._cloakModeUniform = shader.uniforms.d1CloakMode;
		this._cloakLightScaleUniform = shader.uniforms.d1CloakLightScale;
		this._cloakLevelUniform = shader.uniforms.d1CloakLevel;
		this._cloakAverageColorUniform = shader.uniforms.d1CloakAverageColor;
		this._cloakObjectLightUniform = shader.uniforms.d1CloakObjectLight;
		this._cloakGlowLightUniform = shader.uniforms.d1CloakGlowLight;
		this._cloakUseObjectLightUniform = shader.uniforms.d1CloakUseObjectLight;

	}

	onBeforeRender() {

		polyobj_sync_object_texture_material( this );
		if ( this._cloakModeUniform !== null ) {

			this._cloakModeUniform.value = this.cloakMode;
			this._cloakLightScaleUniform.value = this.cloakLightScale;
			this._cloakLevelUniform.value = this.cloakLevel;
			this._cloakAverageColorUniform.value = this.bitmapAverageColor;
			const objectLight = this._cloakObjectLightUniform.value;
			objectLight.x = this.objectLightR;
			objectLight.y = this.objectLightG;
			objectLight.z = this.objectLightB;
			this._cloakGlowLightUniform.value = this.glowLight;
			this._cloakUseObjectLightUniform.value = this.useObjectLight === true ? 1 : 0;

		}

	}

	copy( source ) {

		super.copy( source );
		this.objectLightR = source.objectLightR;
		this.objectLightG = source.objectLightG;
		this.objectLightB = source.objectLightB;
		this.glowLight = source.glowLight;
		this.useObjectLight = source.useObjectLight;
		this.cloakMode = source.cloakMode;
		this.cloakLightScale = source.cloakLightScale;
		this.cloakLevel = source.cloakLevel;
		this.bitmapAverageColor = source.bitmapAverageColor;
		this.cloakFadeTexture = source.cloakFadeTexture;
		this.cloakPaletteTexture = source.cloakPaletteTexture;
		this._cloakModeUniform = null;
		this._cloakLightScaleUniform = null;
		this._cloakLevelUniform = null;
		this._cloakAverageColorUniform = null;
		this._cloakObjectLightUniform = null;
		this._cloakGlowLightUniform = null;
		this._cloakUseObjectLightUniform = null;
		return this;

	}

}

// OP_FLATPOLY faces normally retain their palette color and ignore object
// lighting.  During the fully cloaked phase D1 applies one fade-table lookup
// to that palette index, so keep the original index as a vertex attribute.
class PolyobjFlatMaterial extends THREE.MeshBasicMaterial {

	constructor( parameters ) {

		super( parameters );
		this.isPolyobjFlatMaterial = true;
		this.cloakMode = 0;
		this.cloakLevel = GR_FADE_LEVELS - 1;
		this.cloakFadeTexture = null;
		this.cloakPaletteTexture = null;
		this._cloakModeUniform = null;
		this._cloakLevelUniform = null;

	}

	onBeforeCompile( shader ) {

		shader.uniforms.d1CloakMode = { value: this.cloakMode };
		shader.uniforms.d1CloakLevel = { value: this.cloakLevel };
		shader.uniforms.d1CloakFade = { value: this.cloakFadeTexture };
		shader.uniforms.d1CloakPalette = { value: this.cloakPaletteTexture };

		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				'#include <common>\n' +
				'attribute float d1PaletteIndex;\n' +
				'varying float vD1PaletteIndex;'
			)
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n\tvD1PaletteIndex = d1PaletteIndex;'
			);

		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				'#include <common>\n' +
				'uniform float d1CloakMode;\n' +
				'uniform float d1CloakLevel;\n' +
				'uniform sampler2D d1CloakFade;\n' +
				'uniform sampler2D d1CloakPalette;\n' +
				'varying float vD1PaletteIndex;\n' +
				'vec3 d1FlatCloakSrgbToLinear( vec3 value ) {\n' +
				'\tvec3 low = value / 12.92;\n' +
				'\tvec3 high = pow( ( value + 0.055 ) / 1.055, vec3( 2.4 ) );\n' +
				'\treturn mix( low, high, step( vec3( 0.04045 ), value ) );\n' +
				'}'
			)
			.replace(
				'#include <opaque_fragment>',
				'if ( d1CloakMode > 0.5 ) {\n' +
				'\tvec2 d1FadeUv = vec2(\n' +
				'\t\t( floor( vD1PaletteIndex + 0.5 ) + 0.5 ) / 256.0,\n' +
				'\t\t( clamp( d1CloakLevel, 0.0, 33.0 ) + 0.5 ) / 34.0\n' +
				'\t);\n' +
				'\tfloat d1FinalColor = floor( texture2D( d1CloakFade, d1FadeUv ).r * 255.0 + 0.5 );\n' +
				'\tvec3 d1PaletteColor = texture2D( d1CloakPalette,\n' +
				'\t\tvec2( ( d1FinalColor + 0.5 ) / 256.0, 0.5 ) ).rgb;\n' +
				'\toutgoingLight = d1FlatCloakSrgbToLinear( d1PaletteColor );\n' +
				'}\n' +
				'#include <opaque_fragment>'
			);

		this._cloakModeUniform = shader.uniforms.d1CloakMode;
		this._cloakLevelUniform = shader.uniforms.d1CloakLevel;

	}

	onBeforeRender() {

		if ( this._cloakModeUniform === null ) return;
		this._cloakModeUniform.value = this.cloakMode;
		this._cloakLevelUniform.value = this.cloakLevel;

	}

	customProgramCacheKey() {

		return 'polyobj-d1-flat-cloak-v1';

	}

	copy( source ) {

		super.copy( source );
		this.cloakMode = source.cloakMode;
		this.cloakLevel = source.cloakLevel;
		this.cloakFadeTexture = source.cloakFadeTexture;
		this.cloakPaletteTexture = source.cloakPaletteTexture;
		this._cloakModeUniform = null;
		this._cloakLevelUniform = null;
		return this;

	}

}

// OP_RODBM vertices are generated in view space just before projection.  Keep
// the rod definition on the material so Object3D.clone() retains the callback
// and shared geometry remains immutable; modelViewMatrix still gives every
// draw (including a plain shared-material clone) its own billboard pose.
class PolyobjRodTextureMaterial extends PolyobjTextureMaterial {

	constructor( parameters ) {

		super( parameters );
		this.isPolyobjRodTextureMaterial = true;
		this.rodTopX = 0;
		this.rodTopY = 0;
		this.rodTopZ = 0;
		this.rodBottomX = 0;
		this.rodBottomY = 0;
		this.rodBottomZ = 0;
		this.rodTopWidth = 0;
		this.rodBottomWidth = 0;

	}

	onBeforeCompile( shader ) {

		shader.uniforms.d1RodTop = { value: new THREE.Vector3(
			this.rodTopX, this.rodTopY, this.rodTopZ
		) };
		shader.uniforms.d1RodBottom = { value: new THREE.Vector3(
			this.rodBottomX, this.rodBottomY, this.rodBottomZ
		) };
		shader.uniforms.d1RodTopWidth = { value: this.rodTopWidth };
		shader.uniforms.d1RodBottomWidth = { value: this.rodBottomWidth };

		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				'#include <common>\n' +
				'attribute float d1RodCorner;\n' +
				'uniform vec3 d1RodTop;\n' +
				'uniform vec3 d1RodBottom;\n' +
				'uniform float d1RodTopWidth;\n' +
				'uniform float d1RodBottomWidth;'
			)
			.replace(
				'#include <project_vertex>',
				'vec3 d1RodTopView = ( modelViewMatrix * vec4( d1RodTop, 1.0 ) ).xyz;\n' +
				'vec3 d1RodBottomView = ( modelViewMatrix * vec4( d1RodBottom, 1.0 ) ).xyz;\n' +
				'float d1RodScaleX = max( abs( projectionMatrix[ 0 ][ 0 ] ), 0.000001 );\n' +
				'float d1RodScaleY = max( abs( projectionMatrix[ 1 ][ 1 ] ), 0.000001 );\n' +
				'vec3 d1RodDelta = d1RodBottomView - d1RodTopView;\n' +
				'float d1RodDeltaLength = length( d1RodDelta );\n' +
				'vec3 d1RodTopScaled = vec3(\n' +
				'\td1RodTopView.x * d1RodScaleX, d1RodTopView.y * d1RodScaleY, d1RodTopView.z\n' +
				');\n' +
				'float d1RodTopLength = length( d1RodTopScaled );\n' +
				'vec3 d1RodDeltaDirection = d1RodDelta / max( d1RodDeltaLength, 0.000001 );\n' +
				'vec3 d1RodTopDirection = d1RodTopScaled / max( d1RodTopLength, 0.000001 );\n' +
				'vec3 d1RodNormal = cross( d1RodTopDirection, d1RodDeltaDirection );\n' +
				'float d1RodNormalLength = length( d1RodNormal );\n' +
				'd1RodNormal /= max( d1RodNormalLength, 0.000001 );\n' +
				'd1RodNormal.z = 0.0;\n' +
				'vec3 d1RodTopOffset = d1RodNormal * d1RodTopWidth;\n' +
				'vec3 d1RodBottomOffset = d1RodNormal * d1RodBottomWidth;\n' +
				'vec3 d1RodPosition;\n' +
				'if ( d1RodCorner < 0.5 ) {\n' +
				'\td1RodPosition = d1RodTopView + d1RodTopOffset;\n' +
				'} else if ( d1RodCorner < 1.5 ) {\n' +
				'\td1RodPosition = d1RodTopView - d1RodTopOffset;\n' +
				'} else if ( d1RodCorner < 2.5 ) {\n' +
				'\td1RodPosition = d1RodBottomView - d1RodBottomOffset;\n' +
				'} else {\n' +
				'\td1RodPosition = d1RodBottomView + d1RodBottomOffset;\n' +
				'}\n' +
				'vec4 mvPosition = vec4( d1RodPosition, 1.0 );\n' +
				'bool d1RodVisible = ( d1RodTopView.z < - 0.001 || d1RodBottomView.z < - 0.001 ) &&\n' +
				'\td1RodDeltaLength > 0.000001 && d1RodTopLength > 0.000001 &&\n' +
				'\td1RodNormalLength > 0.000001;\n' +
				'if ( d1RodVisible ) {\n' +
				'\tgl_Position = projectionMatrix * mvPosition;\n' +
				'} else {\n' +
				'\tgl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );\n' +
				'}'
			);

		super.onBeforeCompile( shader );

	}

	customProgramCacheKey() {

		return 'polyobj-d1-rod-v3-cloak';

	}

	copy( source ) {

		super.copy( source );
		this.rodTopX = source.rodTopX;
		this.rodTopY = source.rodTopY;
		this.rodTopZ = source.rodTopZ;
		this.rodBottomX = source.rodBottomX;
		this.rodBottomY = source.rodBottomY;
		this.rodBottomZ = source.rodBottomZ;
		this.rodTopWidth = source.rodTopWidth;
		this.rodBottomWidth = source.rodBottomWidth;
		return this;

	}

}

// D1 applies object lighting itself before handing a texture-mapped polygon to
// the rasterizer.  Keep MeshBasicMaterial's texture/alpha behavior and inject
// only that modulation.  Primitive fields are copied explicitly so every
// runtime model instance can own its light and glow state independently.
class PolyobjLitTextureMaterial extends PolyobjTextureMaterial {

	constructor( parameters ) {

		super( parameters );
		this.isPolyobjLitTextureMaterial = true;
		this.objectLightR = 1;
		this.objectLightG = 1;
		this.objectLightB = 1;
		this.glowLight = 1;
		this.useObjectLight = true;
		this._objectLightUniform = null;
		this._glowLightUniform = null;
		this._useObjectLightUniform = null;
		this._noLightingUniform = null;

	}

	onBeforeCompile( shader ) {

		shader.uniforms.d1ObjectLight = { value: new THREE.Vector3(
			this.objectLightR, this.objectLightG, this.objectLightB
		) };
		shader.uniforms.d1GlowLight = { value: this.glowLight };
		shader.uniforms.d1UseObjectLight = { value: this.useObjectLight === true ? 1 : 0 };
		shader.uniforms.d1NoLighting = { value:
			this.userData.noLighting === true || this.userData.forceNoLighting === true ? 1 : 0
		};

		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				'#include <common>\nvarying float vD1FaceLight;'
			)
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n' +
				'\tvec3 d1ViewNormal = normalize( normalMatrix * normal );\n' +
				'\tvD1FaceLight = 0.25 + 0.75 * max( d1ViewNormal.z, 0.0 );\n' +
				'\tvD1CloakFaceLight = vD1FaceLight;'
			);

		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				'#include <common>\n' +
				'uniform vec3 d1ObjectLight;\n' +
				'uniform float d1GlowLight;\n' +
				'uniform float d1UseObjectLight;\n' +
				'uniform float d1NoLighting;\n' +
				'varying float vD1FaceLight;'
			)
			.replace(
				'#include <opaque_fragment>',
				'vec3 d1ObjectModulation = d1ObjectLight * vD1FaceLight;\n' +
				'vec3 d1GlowModulation = vec3( d1GlowLight );\n' +
				'vec3 d1Modulation = mix( d1GlowModulation, d1ObjectModulation, d1UseObjectLight );\n' +
				'd1Modulation = mix( d1Modulation, vec3( 1.0 ), d1NoLighting );\n' +
				'outgoingLight *= d1Modulation;\n' +
				'#include <opaque_fragment>'
			);

		super.onBeforeCompile( shader );

		this._objectLightUniform = shader.uniforms.d1ObjectLight;
		this._glowLightUniform = shader.uniforms.d1GlowLight;
		this._useObjectLightUniform = shader.uniforms.d1UseObjectLight;
		this._noLightingUniform = shader.uniforms.d1NoLighting;

	}

	onBeforeRender() {

		super.onBeforeRender();

		if ( this._objectLightUniform !== null ) {

			const value = this._objectLightUniform.value;
			value.x = this.objectLightR;
			value.y = this.objectLightG;
			value.z = this.objectLightB;
			this._glowLightUniform.value = this.glowLight;
			this._useObjectLightUniform.value = this.useObjectLight === true ? 1 : 0;
			this._noLightingUniform.value =
				this.userData.noLighting === true || this.userData.forceNoLighting === true ? 1 : 0;

		}

	}

	customProgramCacheKey() {

		return 'polyobj-d1-object-light-v2-cloak';

	}

	copy( source ) {

		super.copy( source );
		this.objectLightR = source.objectLightR;
		this.objectLightG = source.objectLightG;
		this.objectLightB = source.objectLightB;
		this.glowLight = source.glowLight;
		this.useObjectLight = source.useObjectLight;
		this._objectLightUniform = null;
		this._glowLightUniform = null;
		this._useObjectLightUniform = null;
		this._noLightingUniform = null;
		return this;

	}

}

// Build a Three.js DataTexture from PIG bitmap data
function buildModelTexture( bitmapIndex, pigFile, palette ) {

	if ( modelTextureCache.has( bitmapIndex ) ) {

		return modelTextureCache.get( bitmapIndex );

	}

	const pixels = pigFile.getBitmapPixels( bitmapIndex );
	if ( pixels === null ) return null;

	const bm = pigFile.bitmaps[ bitmapIndex ];
	const w = bm.width;
	const h = bm.height;
	const usesTransparency = ( bm.flags & BM_FLAG_TRANSPARENT ) !== 0;
	const rgba = new Uint8Array( w * h * 4 );

	for ( let i = 0; i < w * h; i ++ ) {

		const palIdx = pixels[ i ];

		if ( usesTransparency === true && palIdx === 255 ) {

			// Transparent pixel
			rgba[ i * 4 + 0 ] = 0;
			rgba[ i * 4 + 1 ] = 0;
			rgba[ i * 4 + 2 ] = 0;
			rgba[ i * 4 + 3 ] = 0;

		} else {

			rgba[ i * 4 + 0 ] = palette[ palIdx * 3 + 0 ];
			rgba[ i * 4 + 1 ] = palette[ palIdx * 3 + 1 ];
			rgba[ i * 4 + 2 ] = palette[ palIdx * 3 + 2 ];
			rgba[ i * 4 + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( rgba, w, h );
	texture.colorSpace = THREE.SRGBColorSpace;

	if ( config_get_texture_filtering() === 'linear' ) {

		texture.magFilter = THREE.LinearFilter;
		texture.minFilter = THREE.LinearMipmapLinearFilter;

	} else {

		texture.magFilter = THREE.NearestFilter;
		texture.minFilter = THREE.NearestMipmapLinearFilter;

	}

	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;

	modelTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Update all model textures when filtering setting changes
config_on_texture_filtering_changed( function () {

	for ( const [ , tex ] of modelTextureCache ) {

		if ( config_get_texture_filtering() === 'linear' ) {

			tex.magFilter = THREE.LinearFilter;
			tex.minFilter = THREE.LinearMipmapLinearFilter;

		} else {

			tex.magFilter = THREE.NearestFilter;
			tex.minFilter = THREE.NearestMipmapLinearFilter;

		}

		tex.needsUpdate = true;

	}

} );

// Build a Three.js Mesh for a group of texture-mapped polys sharing the same bitmap slot
// isGlow: if true, create emissive material for engine glow polygons
// Ported from: 3D/INTERP.ASM — glow polygons use glow_values[] intensity instead of normal lighting
function buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, textureObjectBitmapSlots,
	pigFile, palette, isGlow ) {

	const positions = [];
	const uvs = [];
	const normals = [];

	for ( let i = 0; i < polys.length; i ++ ) {

		const poly = polys[ i ];

		for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

			const v0 = poly.verts[ 0 ];
			const v1 = poly.verts[ j ];
			const v2 = poly.verts[ j + 1 ];

			positions.push( v0.x, v0.y, - v0.z );
			positions.push( v1.x, v1.y, - v1.z );
			positions.push( v2.x, v2.y, - v2.z );

			// A POF polygon carries one stored plane normal.  Repeat it for each
			// generated triangle vertex so interpolation remains face-constant.
			const normal = poly.normal;
			normals.push( normal.x, normal.y, - normal.z );
			normals.push( normal.x, normal.y, - normal.z );
			normals.push( normal.x, normal.y, - normal.z );

			const uv0 = poly.uvs[ 0 ];
			const uv1 = poly.uvs[ j ];
			const uv2 = poly.uvs[ j + 1 ];

			uvs.push( uv0.u, uv0.v );
			uvs.push( uv1.u, uv1.v );
			uvs.push( uv2.u, uv2.v );

		}

	}

	if ( positions.length === 0 ) return null;

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );

	// Look up actual texture for this bitmap slot
	const pigBitmapIndex = textureBitmapIndices[ bitmapSlot ];
	const objectBitmapSlot = textureObjectBitmapSlots !== null &&
		textureObjectBitmapSlots[ bitmapSlot ] !== undefined
		? textureObjectBitmapSlots[ bitmapSlot ] : - 1;
	let mat;
	const usesTransparency = pigBitmapUsesTransparency( pigFile, pigBitmapIndex );

	if ( pigBitmapIndex !== undefined && pigBitmapIndex >= 0 ) {

		const texture = buildModelTexture( pigBitmapIndex, pigFile, palette );
		if ( texture !== null ) {

			mat = new PolyobjLitTextureMaterial( {
				map: texture,
				side: THREE.DoubleSide,
				alphaTest: usesTransparency === true ? 0.5 : 0
			} );

		} else {

			mat = new PolyobjLitTextureMaterial( {
				color: 0x808080,
				side: THREE.DoubleSide
			} );

		}

	} else {

		mat = new PolyobjLitTextureMaterial( {
			color: 0x808080,
			side: THREE.DoubleSide
		} );

	}
	mat.useObjectLight = isGlow !== true;
	configureCloakMaterial( mat, palette, pigBitmapAverageColor( pigFile, pigBitmapIndex ) );
	mat.userData.noLighting = pigBitmapUsesNoLighting( pigFile, pigBitmapIndex );
	if ( objectBitmapSlot >= 0 ) {

		mat.userData.objectBitmapSlot = objectBitmapSlot;
		mat.userData.objectBitmapIndex = pigBitmapIndex;
	}

	const mesh = new THREE.Mesh( geo, mat );
	if ( isGlow ) mesh.userData.isGlowMesh = true;
	return mesh;

}

// Build a camera-facing rod mesh for OP_RODBM.
// Ported from: 3D/ROD.ASM calc_rod_corners() + g3_draw_rod_tmap().
function buildRodMesh( rod, textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette ) {

	const pigBitmapIndex = textureBitmapIndices[ rod.bitmap ];
	const objectBitmapSlot = textureObjectBitmapSlots !== null &&
		textureObjectBitmapSlots[ rod.bitmap ] !== undefined
		? textureObjectBitmapSlots[ rod.bitmap ] : - 1;

	let mat;
	const usesTransparency = pigBitmapUsesTransparency( pigFile, pigBitmapIndex );

	if ( pigBitmapIndex !== undefined && pigBitmapIndex >= 0 ) {

		const texture = buildModelTexture( pigBitmapIndex, pigFile, palette );

		if ( texture !== null ) {

			mat = new PolyobjRodTextureMaterial( {
				map: texture,
				side: THREE.DoubleSide,
				alphaTest: usesTransparency === true ? 0.5 : 0
			} );

		} else {

			mat = new PolyobjRodTextureMaterial( {
				color: 0x808080,
				side: THREE.DoubleSide
			} );

		}

	} else {

		mat = new PolyobjRodTextureMaterial( {
			color: 0x808080,
			side: THREE.DoubleSide
		} );

	}
	configureCloakMaterial( mat, palette, pigBitmapAverageColor( pigFile, pigBitmapIndex ) );
	mat.userData.noLighting = pigBitmapUsesNoLighting( pigFile, pigBitmapIndex );
	if ( objectBitmapSlot >= 0 ) {

		mat.userData.objectBitmapSlot = objectBitmapSlot;
		mat.userData.objectBitmapIndex = pigBitmapIndex;
	}
	mat.rodTopX = rod.top.x;
	mat.rodTopY = rod.top.y;
	mat.rodTopZ = - rod.top.z;
	mat.rodBottomX = rod.bot.x;
	mat.rodBottomY = rod.bot.y;
	mat.rodBottomZ = - rod.bot.z;
	mat.rodTopWidth = rod.topWidth;
	mat.rodBottomWidth = rod.botWidth;

	const positions = new Float32Array( 12 );
	const corners = new Float32Array( [ 0, 1, 2, 3 ] );
	const uvs = new Float32Array( [
		ROD_UV_MIN, ROD_UV_MIN,
		ROD_UV_MAX, ROD_UV_MIN,
		ROD_UV_MAX, ROD_UV_MAX,
		ROD_UV_MIN, ROD_UV_MAX
	] );

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geo.setAttribute( 'd1RodCorner', new THREE.Float32BufferAttribute( corners, 1 ) );
	geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geo.setIndex( [ 0, 1, 2, 0, 2, 3 ] );

	const mesh = new THREE.Mesh( geo, mat );
	mesh.frustumCulled = false;

	return mesh;

}

function buildRodMeshes( rods, textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette, group ) {

	for ( let i = 0; i < rods.length; i ++ ) {

		const rodMesh = buildRodMesh(
			rods[ i ], textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette
		);
		if ( rodMesh !== null ) group.add( rodMesh );

	}

}

// Rebuild root-local material lists after construction or cloning.  Object3D
// clones share materials by default, so these lists must always point into the
// new tree rather than back into a cached template.
export function polyobj_rebuild_glow_refs( group ) {

	if ( group === null ) return;

	const glowMeshes = [];
	const glowMaterials = [];
	const objectLightMaterials = [];
	const cloakMaterials = [];
	const lodMeshes = [];
	let visibleLodLevel = 0;

	group.traverse( ( child ) => {

		const lodLevel = child.userData.polyobjLodLevel;
		if ( Number.isInteger( lodLevel ) === true && lodLevel >= 0 ) {

			lodMeshes[ lodLevel ] = child;
			if ( child.visible === true ) visibleLodLevel = lodLevel;

		}
		if ( child.isMesh !== true ) return;

		const materials = Array.isArray( child.material ) ? child.material : null;
		const materialCount = materials !== null ? materials.length : 1;

		for ( let i = 0; i < materialCount; i ++ ) {

			const material = materials !== null ? materials[ i ] : child.material;
			if ( material === null || material === undefined ) continue;
			if ( material.isPolyobjLitTextureMaterial === true ) {

				objectLightMaterials.push( material );
				if ( child.userData.isGlowMesh === true ) glowMaterials.push( material );

			}
			if ( material.isPolyobjTextureMaterial === true || material.isPolyobjFlatMaterial === true ) {

				cloakMaterials.push( material );

			}

		}

		if ( child.userData.isGlowMesh === true ) {

			glowMeshes.push( child );

		}

	} );

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	} else {

		delete group.userData.glowMeshes;

	}

	group._polyobjGlowMaterials = glowMaterials;
	group._polyobjObjectLightMaterials = objectLightMaterials;
	group._polyobjCloakMaterials = cloakMaterials;
	group._polyobjLodMeshes = lodMeshes.length > 1 ? lodMeshes : null;
	group._polyobjLodLevel = visibleLodLevel;

}

// Clone a cached model template while retaining shared immutable geometry and
// giving every runtime instance its own material/light/glow state.
export function polyobj_clone_model_mesh( source, recursive = true ) {

	if ( source === null || source === undefined ) return null;

	const clone = source.clone( recursive );
	clone.traverse( ( child ) => {

		if ( child.isMesh !== true ) return;

		if ( Array.isArray( child.material ) ) {

			const materials = new Array( child.material.length );
			for ( let i = 0; i < child.material.length; i ++ ) {

				materials[ i ] = child.material[ i ].clone();

			}
			child.material = materials;

		} else if ( child.material !== null && child.material !== undefined ) {

			child.material = child.material.clone();

		}

	} );

	polyobj_rebuild_glow_refs( clone );
	return clone;

}

// Apply the canonical per-object joint pose to an animated model hierarchy.
// Descent instances child submodels with heading, pitch, and bank angles while
// recursively drawing the model; submodel 0 is the unrotated object root.
export function polyobj_set_anim_angles( submodelGroups, animAngles ) {

	if ( submodelGroups === null || submodelGroups === undefined ) return;
	if ( animAngles === null || animAngles === undefined ) return;
	const groupSets = submodelGroups._polyobjLodGroupSets;
	if ( Array.isArray( groupSets ) === true ) {

		for ( let setIndex = 0; setIndex < groupSets.length; setIndex ++ ) {

			apply_anim_angles_to_groups( groupSets[ setIndex ], animAngles );

		}
		return;

	}

	apply_anim_angles_to_groups( submodelGroups, animAngles );

}

function apply_anim_angles_to_groups( submodelGroups, animAngles ) {

	for ( let i = 1; i < submodelGroups.length; i ++ ) {

		const group = submodelGroups[ i ];
		const angle = animAngles[ i ];
		if ( group === null || group === undefined || angle === undefined ) continue;

		// The renderer reflects Descent's Z axis.  With the hierarchy's YXZ
		// Euler order, pitch and heading reverse while bank retains its sign.
		group.rotation.x = - angle.p;
		group.rotation.y = - angle.h;
		group.rotation.z = angle.b;

	}

}

function collect_lod_submodel_groups( mesh ) {

	const groups = [];
	mesh.traverse( ( child ) => {

		const index = child.userData.submodelIndex;
		if ( Number.isInteger( index ) === true && index >= 0 ) groups[ index ] = child;

	} );
	return groups;

}

// D1 selects progressively simpler polygon models from camera-space depth.
// Keep every variant under one per-object transform so switching never loses
// joint, light, glow, texture-override, or ownership state.
export function polyobj_wrap_model_lod(
	detailedMesh, model, pigFile, palette, detailedSubmodelGroups = null
) {

	if ( detailedMesh === null || detailedMesh === undefined ||
		model === null || model === undefined || model.simpler_model === 0 ) return detailedMesh;

	const root = new THREE.Group();
	const groupSets = [];
	detailedMesh.userData.polyobjLodLevel = 0;
	detailedMesh.userData.polyobjLodThreshold = 0;
	root.add( detailedMesh );
	if ( detailedSubmodelGroups !== null ) groupSets.push( detailedSubmodelGroups );

	const visited = new Set();
	let currentModel = model;
	let level = 1;
	visited.add( Polygon_models.indexOf( model ) );

	while ( currentModel.simpler_model !== 0 && level < Polygon_models.length ) {

		const modelIndex = currentModel.simpler_model - 1;
		if ( modelIndex < 0 || modelIndex >= Polygon_models.length || visited.has( modelIndex ) ) break;
		const simpleModel = Polygon_models[ modelIndex ];
		if ( simpleModel === null || simpleModel === undefined ) break;
		if ( Number.isFinite( currentModel.rad ) !== true || currentModel.rad <= 0 ) break;

		let source = null;
		let simpleGroups = null;
		if ( simpleModel.n_models > 1 ) {

			if ( simpleModel.animatedMesh === null ) {

				simpleModel.animatedMesh = buildAnimatedModelMesh( simpleModel, pigFile, palette );

			}
			if ( simpleModel.animatedMesh !== null ) {

				source = simpleModel.animatedMesh;

			}

		} else {

			if ( simpleModel.mesh === null ) simpleModel.mesh = buildModelMesh( simpleModel, pigFile, palette );
			source = simpleModel.mesh;

		}
		if ( source === null ) break;

		const variant = polyobj_clone_model_mesh( source );
		if ( simpleModel.n_models > 1 ) simpleGroups = collect_lod_submodel_groups( variant );
		variant.userData.polyobjLodLevel = level;
		variant.userData.polyobjLodThreshold =
			level * SIMPLE_MODEL_THRESHOLD_SCALE * currentModel.rad;
		variant.visible = false;
		root.add( variant );
		if ( simpleGroups !== null ) groupSets.push( simpleGroups );

		visited.add( modelIndex );
		currentModel = simpleModel;
		level ++;

	}

	if ( root.children.length === 1 ) {

		delete detailedMesh.userData.polyobjLodLevel;
		delete detailedMesh.userData.polyobjLodThreshold;
		return detailedMesh;

	}

	if ( detailedSubmodelGroups !== null && groupSets.length > 0 ) {

		detailedSubmodelGroups._polyobjLodGroupSets = groupSets;

	}
	polyobj_rebuild_glow_refs( root );
	return root;

}

export function polyobj_update_model_lod( group, camera, forceDetailed = false ) {

	if ( group === null || group === undefined || camera === null || camera === undefined ) return 0;
	const lodMeshes = group._polyobjLodMeshes;
	if ( lodMeshes === null || lodMeshes === undefined ) return 0;

	let selected = 0;
	if ( forceDetailed !== true ) {

		camera.getWorldPosition( _lodCameraPosition );
		camera.getWorldDirection( _lodForward );
		group.getWorldPosition( _lodObjectPosition );
		const depth =
			( _lodObjectPosition.x - _lodCameraPosition.x ) * _lodForward.x +
			( _lodObjectPosition.y - _lodCameraPosition.y ) * _lodForward.y +
			( _lodObjectPosition.z - _lodCameraPosition.z ) * _lodForward.z;

		for ( let level = 1; level < lodMeshes.length; level ++ ) {

			const variant = lodMeshes[ level ];
			if ( variant === undefined || depth <= variant.userData.polyobjLodThreshold ) break;
			selected = level;

		}

	}

	if ( selected !== group._polyobjLodLevel ) {

		for ( let level = 0; level < lodMeshes.length; level ++ ) {

			if ( lodMeshes[ level ] !== undefined ) lodMeshes[ level ].visible = level === selected;

		}
		group._polyobjLodLevel = selected;

	}
	return selected;

}

export function polyobj_set_object_light( group, red, green, blue ) {

	if ( group === null || group === undefined ) return;
	const materials = group._polyobjObjectLightMaterials;
	if ( materials === undefined ) return;

	for ( let i = 0; i < materials.length; i ++ ) {

		const material = materials[ i ];
		material.objectLightR = red;
		material.objectLightG = green;
		material.objectLightB = blue;

	}

}

// ENDLEVEL.C temporarily disables texture lighting while drawing the player
// outside the mine.  Keep this separate from a bitmap's persistent
// BM_FLAG_NO_LIGHTING so animated object-texture rebinding cannot clear it.
export function polyobj_set_fullbright( group, fullbright ) {

	if ( group === null || group === undefined ) return;
	const materials = group._polyobjObjectLightMaterials;
	if ( materials === undefined ) return;

	for ( let i = 0; i < materials.length; i ++ ) {

		materials[ i ].userData.forceNoLighting = ( fullbright === true );

	}

}

// Configure OBJECT.C's cloaked polygon render path.  mode 0 keeps the normal
// texture/flat polygon shaders and applies only the fade-phase light scale;
// mode 1 replaces texture maps with their palette average and runs both the
// lighting and cloak rows through D1's original palette fade table.
export function polyobj_set_cloak( group, mode = 0, lightScale = 1, cloakLevel = GR_FADE_LEVELS - 1 ) {

	if ( group === null || group === undefined ) return;
	const materials = group._polyobjCloakMaterials;
	if ( materials === undefined ) return;

	const fullCloak = mode === 1 ? 1 : 0;
	const scale = Number.isFinite( lightScale ) === true ? Math.max( lightScale, 0 ) : 1;
	const level = Number.isFinite( cloakLevel ) === true
		? Math.max( 0, Math.min( GR_FADE_LEVELS - 1, Math.floor( cloakLevel ) ) )
		: GR_FADE_LEVELS - 1;

	for ( let i = 0; i < materials.length; i ++ ) {

		const material = materials[ i ];
		material.cloakMode = fullCloak;
		material.cloakLevel = level;
		if ( material.isPolyobjTextureMaterial === true ) material.cloakLightScale = scale;

	}

}

// OBJECT.C keeps one set of pulse state inside draw_cloaked_object().  It is
// intentionally shared by every visible cloaked player and robot; the original
// even notes that drawing several cloaked objects makes the pulse run faster.
let Polyobj_cloak_delta = 0;
let Polyobj_cloak_dir = 1;
let Polyobj_cloak_timer = 0;

// Apply the five phases of OBJECT.C draw_cloaked_object().  elapsed and total
// are seconds since cloak activation and the full cloak lifetime; players pass
// a two-second fade duration and robots pass one second.
export function polyobj_update_cloak_render( group, elapsed, total, fadeDuration, dt ) {

	if ( group === null || group === undefined ) return;
	if ( Number.isFinite( elapsed ) !== true || Number.isFinite( total ) !== true ||
		Number.isFinite( fadeDuration ) !== true || total <= 0 || fadeDuration <= 0 ||
		elapsed < 0 || elapsed >= total ) {

		polyobj_set_cloak( group, 0, 1, GR_FADE_LEVELS - 1 );
		return;

	}

	const halfFade = fadeDuration / 2;

	if ( elapsed < halfFade ) {

		polyobj_set_cloak( group, 0, halfFade - elapsed, GR_FADE_LEVELS - 1 );

	} else if ( elapsed < fadeDuration ) {

		polyobj_set_cloak(
			group, 1, 1,
			Math.floor( ( elapsed - halfFade ) * 28 )
		);

	} else if ( elapsed < total - fadeDuration ) {

		Polyobj_cloak_timer -= Number.isFinite( dt ) === true && dt > 0 ? dt : 0;
		while ( Polyobj_cloak_timer < 0 ) {

			Polyobj_cloak_timer += fadeDuration / 12;
			Polyobj_cloak_delta += Polyobj_cloak_dir;
			if ( Polyobj_cloak_delta === 0 || Polyobj_cloak_delta === 4 ) {

				Polyobj_cloak_dir = - Polyobj_cloak_dir;

			}

		}
		polyobj_set_cloak( group, 1, 1, 28 - Polyobj_cloak_delta );

	} else if ( elapsed < total - halfFade ) {

		polyobj_set_cloak(
			group, 1, 1,
			Math.floor( ( total - halfFade - elapsed ) * 28 )
		);

	} else {

		polyobj_set_cloak(
			group, 0,
			halfFade - ( total - elapsed ), GR_FADE_LEVELS - 1
		);

	}

}

// MORPH.C uses a separate interpreter which ignores OP_GLOW.  Ordinary
// textured faces remain object-lit; only tagged glow materials change mode.
export function polyobj_set_morphing( group, morphing ) {

	if ( group === null || group === undefined ) return;
	const materials = group._polyobjGlowMaterials;
	if ( materials === undefined ) return;

	for ( let i = 0; i < materials.length; i ++ ) {

		materials[ i ].useObjectLight = morphing === true;

	}

}

// Build a Three.js mesh from a polymodel
// pigFile: PigFile instance for texture lookup
// palette: Uint8Array(768) VGA palette scaled to 0-255
export function buildModelMesh( model, pigFile, palette, subobj_flags ) {

	if ( model === null || model.model_data === null ) return null;

	// A zero mask means the whole model.  A nonzero mask is the special
	// draw_polygon_model() path used by debris/editor objects: each selected
	// submodel is drawn directly from its own bytecode pointer and centered on
	// its own bounds, rather than left at its normal hierarchy offset.
	if ( Number.isInteger( subobj_flags ) === true && subobj_flags !== 0 ) {

		const flags = subobj_flags >>> 0;
		const group = new THREE.Group();
		let selected = 0;

		for ( let i = 0; i < model.n_models && i < 32; i ++ ) {

			if ( ( flags & ( 1 << i ) ) === 0 ) continue;
			const source = buildSubmodelMesh( model, i, pigFile, palette );
			if ( source === null ) continue;
			group.add( polyobj_clone_model_mesh( source ) );
			selected ++;

		}

		if ( selected === 0 ) return null;
		polyobj_rebuild_glow_refs( group );
		return group;

	}

	// Interpret the master bytecode starting at offset 0 (contains BSP tree + SUBCALLs)
	const result = interpretModelData( model, 0, 0, 0, 0 );
	if ( result === null ) return null;

	const { flatPolys, texPolys, rods } = result;

	if ( flatPolys.length === 0 && texPolys.length === 0 && rods.length === 0 ) return null;

	// Resolve model texture names to PIG bitmap indices
	const textureBitmapIndices = resolveModelTextureBitmapIndices( model, pigFile );
	const textureObjectBitmapSlots = model.textureObjectBitmapSlots;

	// Group to hold all sub-meshes
	const group = new THREE.Group();

	// --- Build flat-shaded polygons mesh (vertex colors) ---
	if ( flatPolys.length > 0 ) {

		const positions = [];
		const colors = [];
		const paletteIndices = [];

		for ( let i = 0; i < flatPolys.length; i ++ ) {

			const poly = flatPolys[ i ];
			const rgb = flatColorToFloat( poly.color, model, palette );
			const paletteIndex = flatColorToPaletteIndex( poly.color, model, palette );

			for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

				const v0 = poly.verts[ 0 ];
				const v1 = poly.verts[ j ];
				const v2 = poly.verts[ j + 1 ];

				positions.push( v0.x, v0.y, - v0.z );
				positions.push( v1.x, v1.y, - v1.z );
				positions.push( v2.x, v2.y, - v2.z );

				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );

				paletteIndices.push( paletteIndex, paletteIndex, paletteIndex );

			}

		}

		if ( positions.length > 0 ) {

			const geo = new THREE.BufferGeometry();
			geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
			geo.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );
			geo.setAttribute( 'd1PaletteIndex', new THREE.Float32BufferAttribute( paletteIndices, 1 ) );

			const mat = new PolyobjFlatMaterial( {
				vertexColors: true,
				side: THREE.DoubleSide
			} );
			configureCloakMaterial( mat, palette );

			group.add( new THREE.Mesh( geo, mat ) );

		}

	}

	// --- Build texture-mapped polygons (grouped by bitmap index) ---
	// Separate glow polys from normal polys — glow polys get emissive materials
	// Ported from: 3D/INTERP.ASM — OP_GLOW sets glow_num, consumed by next tmappoly
	const texGroupsNormal = new Map();
	const texGroupsGlow = new Map();

	for ( let i = 0; i < texPolys.length; i ++ ) {

		const poly = texPolys[ i ];
		const bitmapSlot = poly.bitmap;
		const targetMap = ( poly.isGlow === true ) ? texGroupsGlow : texGroupsNormal;

		if ( targetMap.has( bitmapSlot ) !== true ) {

			targetMap.set( bitmapSlot, [] );

		}

		targetMap.get( bitmapSlot ).push( poly );

	}

	// Build normal texture meshes
	for ( const [ bitmapSlot, polys ] of texGroupsNormal ) {

		const mesh = buildTexGroupMesh(
			bitmapSlot, polys, textureBitmapIndices, textureObjectBitmapSlots,
			pigFile, palette, false
		);
		if ( mesh !== null ) group.add( mesh );

	}

	// Build glow texture meshes (emissive materials for engine glow)
	const glowMeshes = [];

	for ( const [ bitmapSlot, polys ] of texGroupsGlow ) {

		const mesh = buildTexGroupMesh(
			bitmapSlot, polys, textureBitmapIndices, textureObjectBitmapSlots,
			pigFile, palette, true
		);
		if ( mesh !== null ) {

			glowMeshes.push( mesh );
			group.add( mesh );

		}

	}

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	}

	// Build camera-facing rod meshes (OP_RODBM)
	if ( rods.length > 0 ) {

		buildRodMeshes( rods, textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette, group );

	}

	if ( group.children.length === 0 ) return null;

	polyobj_rebuild_glow_refs( group );
	return group;

}

// Shareware BITMAPS.BIN constructs this table while it reads model declarations.
// Keep the exported arrays live: robot and save-game modules import the filename
// table before BITMAPS.BIN has been decoded.
export const SHAREWARE_MODEL_TABLE = [];
export const SHAREWARE_MODEL_DESCRIPTORS = [];

export function polyobj_set_shareware_model_descriptors( descriptors ) {

	SHAREWARE_MODEL_TABLE.length = 0;
	SHAREWARE_MODEL_DESCRIPTORS.length = 0;

	for ( let i = 0; i < descriptors.length; i ++ ) {

		const source = descriptors[ i ];
		if ( source.filename === undefined || source.n_textures < 0 || source.first_texture < 0 ||
			source.textureObjectBitmapSlots.length !== source.n_textures ) {

			throw new Error( 'Invalid shareware polygon model descriptor ' + i );

		}

		const descriptor = {
			filename: source.filename.toLowerCase(),
			first_texture: source.first_texture,
			n_textures: source.n_textures,
			simpler_model: source.simpler_model,
			textureObjectBitmapSlots: source.textureObjectBitmapSlots.slice()
		};

		SHAREWARE_MODEL_TABLE.push( descriptor.filename );
		SHAREWARE_MODEL_DESCRIPTORS.push( descriptor );

	}

}

// Load all polygon models from HOG file for shareware
export function loadSharewareModels( hogFile ) {

	Polygon_models.length = 0;
	const uniqueNames = new Set();

	for ( let i = 0; i < SHAREWARE_MODEL_DESCRIPTORS.length; i ++ ) {

		const descriptor = SHAREWARE_MODEL_DESCRIPTORS[ i ];
		const filename = descriptor.filename;
		uniqueNames.add( filename );

		const pofFile = hogFile.findFile( filename );
		if ( pofFile !== null ) {

			const model = load_polygon_model( pofFile );
			if ( model !== null ) {

				model.first_texture = descriptor.first_texture;
				model.n_textures = descriptor.n_textures;
				model.simpler_model = descriptor.simpler_model;
				model.textureNames.length = 0;
				model.textureBitmapIndices = null;
				model.textureObjectBitmapSlots = descriptor.textureObjectBitmapSlots.slice();
				Polygon_models[ i ] = model;

			} else {

				console.warn( 'POF: Failed to parse ' + filename );
				Polygon_models[ i ] = null;

			}

		} else {

			console.warn( 'POF: ' + filename + ' not found in HOG' );
			Polygon_models[ i ] = null;

		}

	}

	N_polygon_models = SHAREWARE_MODEL_DESCRIPTORS.length;

	console.log( 'POF: Loaded ' + N_polygon_models + ' model entries from ' + uniqueNames.size + ' unique files' );

}

// Calculate gun points in model-local coordinates by accumulating submodel offsets
// Ported from: BMREAD.C lines 1485-1498 (player ship gun point setup)
// Returns array of {x,y,z} gun points transformed from submodel-local to model-local space
export function polyobj_calc_gun_points( model ) {

	const result = [];

	for ( let gun_num = 0; gun_num < model.n_guns; gun_num ++ ) {

		// Start with gun point relative to its submodel
		let px = model.gun_points[ gun_num ].x;
		let py = model.gun_points[ gun_num ].y;
		let pz = model.gun_points[ gun_num ].z;

		// Instance up the tree for this gun — accumulate submodel offsets
		let mn = model.gun_submodels[ gun_num ];

		while ( mn !== 0 ) {

			px += model.submodel_offsets[ mn ].x;
			py += model.submodel_offsets[ mn ].y;
			pz += model.submodel_offsets[ mn ].z;
			mn = model.submodel_parents[ mn ];

		}

		result.push( { x: px, y: py, z: pz } );

	}

	return result;

}

// Build a Three.js mesh for a single submodel of a polymodel
// Caches result on the model object for reuse
// Ported from: object_create_debris() in FIREBALL.C (renders with subobj_flags = 1<<subobj_num)
export function buildSubmodelMesh( model, submodelNum, pigFile, palette ) {

	if ( model === null || model.model_data === null ) return null;
	if ( Number.isInteger( submodelNum ) !== true ||
		submodelNum < 0 || submodelNum >= model.n_models ) return null;

	// Check cache
	if ( model._submodelMeshes === undefined ) {

		model._submodelMeshes = {};

	}

	if ( model._submodelMeshes[ submodelNum ] !== undefined ) {

		return model._submodelMeshes[ submodelNum ];

	}

	// D1 draws debris directly from submodel_ptrs[submodelNum].  Walking the
	// root with a visibility bit cannot reach a nested submodel when its parent
	// bit is clear, and incorrectly accumulates the model hierarchy offsets.
	const result = interpretSingleSubmodel( model, submodelNum );
	if ( result === null ||
		( result.flatPolys.length === 0 && result.texPolys.length === 0 && result.rods.length === 0 ) ) {

		model._submodelMeshes[ submodelNum ] = null;
		return null;

	}

	const textureBitmapIndices = resolveModelTextureBitmapIndices( model, pigFile );
	const geometryGroup = buildGroupFromPolys(
		model,
		result.flatPolys, result.texPolys, result.rods,
		textureBitmapIndices, model.textureObjectBitmapSlots, pigFile, palette
	);

	// draw_polygon_model() centers flagged submodels around their own bounds
	// before rendering them as independent debris objects.  Keep that local
	// offset below a transform root: object_create_debris() owns the root's
	// world position/orientation and must not overwrite the center correction.
	const mins = model.submodel_mins[ submodelNum ];
	const maxs = model.submodel_maxs[ submodelNum ];
	geometryGroup.position.set(
		- ( mins.x + maxs.x ) * 0.5,
		- ( mins.y + maxs.y ) * 0.5,
		( mins.z + maxs.z ) * 0.5
	);
	const mesh = new THREE.Group();
	mesh.add( geometryGroup );
	polyobj_rebuild_glow_refs( mesh );
	model._submodelMeshes[ submodelNum ] = mesh;
	return mesh;

}

// Interpret bytecode for a single submodel, extracting only that submodel's geometry
// Does NOT follow OP_SUBCALL — each submodel is built independently
// Points are in submodel-local coordinates (no parent offset accumulation)
function interpretSingleSubmodel( model, submodelNum ) {

	const data = model.model_data;
	if ( data === null ) return null;

	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const startPtr = model.submodel_ptrs[ submodelNum ];

	const points = [];
	const flatPolys = [];
	const texPolys = [];
	const rods = [];

	// Glow state for OP_GLOW tracking (same as interpretModelData)
	let glowNum = - 1;

	function interpret( ptr ) {

		while ( ptr < data.length - 2 ) {

			const opcode = readU16( dv, ptr );

			switch ( opcode ) {

				case OP_EOF:
					return;

				case OP_DEFPOINTS: {

					const n = readU16( dv, ptr + 2 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 4 + i * 12 );
						points[ i ] = { x: v.x, y: v.y, z: v.z };

					}

					ptr += 4 + n * 12;
					break;

				}

				case OP_DEFP_START: {

					const n = readU16( dv, ptr + 2 );
					const start = readU16( dv, ptr + 4 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 8 + i * 12 );
						points[ start + i ] = { x: v.x, y: v.y, z: v.z };

					}

					ptr += 8 + n * 12;
					break;

				}

				case OP_FLATPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const color = readU16( dv, ptr + 28 );
					const verts = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					if ( verts.length >= 3 ) {

						flatPolys.push( { verts, color } );

					}

					ptr += 30 + ( nv | 1 ) * 2;
					break;

				}

				case OP_TMAPPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const uvlOffset = 30 + ( nv | 1 ) * 2;
					const normal = readVec( dv, ptr + 16 );
					const bitmap = readU16( dv, ptr + 28 );
					const verts = [];
					const uvs = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					for ( let i = 0; i < nv; i ++ ) {

						uvs.push( {
							u: readFix( dv, ptr + uvlOffset + i * 12 ),
							v: readFix( dv, ptr + uvlOffset + i * 12 + 4 )
						} );

					}

					if ( verts.length >= 3 ) {

						const isGlow = ( glowNum >= 0 );
						texPolys.push( { verts, uvs, bitmap, isGlow, normal } );

					}

					glowNum = - 1;

					ptr += uvlOffset + nv * 12;
					break;

				}

				case OP_SORTNORM: {

					const backOff = readU16( dv, ptr + 28 );
					const frontOff = readU16( dv, ptr + 30 );
					interpret( ptr + backOff );
					interpret( ptr + frontOff );
					ptr += 32;
					break;

				}

					case OP_RODBM: {

						const bitmap = readU16( dv, ptr + 2 );
						const top = readVec( dv, ptr + 4 );
						const bot = readVec( dv, ptr + 20 );
						const botWidth = readFix( dv, ptr + 16 );
						const topWidth = readFix( dv, ptr + 32 );

						rods.push( {
							top: top,
							bot: bot,
							topWidth: topWidth,
							botWidth: botWidth,
							bitmap: bitmap
						} );

						ptr += 36;
						break;

				}

				case OP_SUBCALL: {

					// Skip child submodel calls — build each submodel independently
					ptr += 20;
					break;

				}

				case OP_GLOW: {

					// Set glow index for next OP_TMAPPOLY
					glowNum = readU16( dv, ptr + 2 );
					ptr += 4;
					break;

				}

				default:
					return;

			}

		}

	}

	interpret( startPtr );
	return { flatPolys, texPolys, rods };

}

// Build a Three.js Group from flat/tex polys (shared helper for mesh building)
function buildGroupFromPolys( model, flatPolys, texPolys, rods, textureBitmapIndices,
	textureObjectBitmapSlots, pigFile, palette ) {

	const group = new THREE.Group();

	// Build flat-shaded polygons mesh (vertex colors)
	if ( flatPolys.length > 0 ) {

		const positions = [];
		const colors = [];
		const paletteIndices = [];

		for ( let i = 0; i < flatPolys.length; i ++ ) {

			const poly = flatPolys[ i ];
			const rgb = flatColorToFloat( poly.color, model, palette );
			const paletteIndex = flatColorToPaletteIndex( poly.color, model, palette );

			for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

				const v0 = poly.verts[ 0 ];
				const v1 = poly.verts[ j ];
				const v2 = poly.verts[ j + 1 ];

				positions.push( v0.x, v0.y, - v0.z );
				positions.push( v1.x, v1.y, - v1.z );
				positions.push( v2.x, v2.y, - v2.z );

				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );
				paletteIndices.push( paletteIndex, paletteIndex, paletteIndex );

			}

		}

		if ( positions.length > 0 ) {

			const geo = new THREE.BufferGeometry();
			geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
			geo.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );
			geo.setAttribute( 'd1PaletteIndex', new THREE.Float32BufferAttribute( paletteIndices, 1 ) );

			const mat = new PolyobjFlatMaterial( {
				vertexColors: true,
				side: THREE.DoubleSide
			} );
			configureCloakMaterial( mat, palette );

			group.add( new THREE.Mesh( geo, mat ) );

		}

	}

	// Build texture-mapped polygons — separate glow polys from normal polys
	const texGroupsNormal = new Map();
	const texGroupsGlow = new Map();

	for ( let i = 0; i < texPolys.length; i ++ ) {

		const poly = texPolys[ i ];
		const bitmapSlot = poly.bitmap;
		const targetMap = ( poly.isGlow === true ) ? texGroupsGlow : texGroupsNormal;

		if ( targetMap.has( bitmapSlot ) !== true ) {

			targetMap.set( bitmapSlot, [] );

		}

		targetMap.get( bitmapSlot ).push( poly );

	}

	// Build normal texture meshes
	for ( const [ bitmapSlot, polys ] of texGroupsNormal ) {

		const mesh = buildTexGroupMesh(
			bitmapSlot, polys, textureBitmapIndices, textureObjectBitmapSlots,
			pigFile, palette, false
		);
		if ( mesh !== null ) group.add( mesh );

	}

	// Build glow texture meshes (emissive materials)
	const glowMeshes = [];

	for ( const [ bitmapSlot, polys ] of texGroupsGlow ) {

		const mesh = buildTexGroupMesh(
			bitmapSlot, polys, textureBitmapIndices, textureObjectBitmapSlots,
			pigFile, palette, true
		);
		if ( mesh !== null ) {

			glowMeshes.push( mesh );
			group.add( mesh );

		}

	}

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	}

	if ( rods.length > 0 ) {

		buildRodMeshes( rods, textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette, group );

	}

	return group;

}

// Build a hierarchical Three.js mesh with per-submodel groups for joint animation
// Returns a root THREE.Group with submodel groups arranged in parent-child tree
// Each submodel group tagged with userData.submodelIndex for extraction after cloning
// Ported from: g3_draw_polygon_model() + draw_polygon_model() — renders submodels hierarchically
export function buildAnimatedModelMesh( model, pigFile, palette ) {

	if ( model === null || model.model_data === null ) return null;
	if ( model.n_models <= 0 ) return null;

	// Resolve model texture names to PIG bitmap indices
	const textureBitmapIndices = resolveModelTextureBitmapIndices( model, pigFile );
	const textureObjectBitmapSlots = model.textureObjectBitmapSlots;

	// Build per-submodel geometry and create groups
	const submodelGroups = new Array( model.n_models );

	for ( let s = 0; s < model.n_models; s ++ ) {

		const result = interpretSingleSubmodel( model, s );

		// Create the submodel's pivot group (rotations applied here)
		const pivotGroup = new THREE.Group();
		pivotGroup.userData.submodelIndex = s;
		pivotGroup.rotation.order = 'YXZ';

		if ( result !== null &&
			( result.flatPolys.length > 0 || result.texPolys.length > 0 || result.rods.length > 0 ) ) {

			const geoGroup = buildGroupFromPolys(
				model,
				result.flatPolys, result.texPolys, result.rods,
				textureBitmapIndices, textureObjectBitmapSlots, pigFile, palette
			);

			// Transfer children from geoGroup to pivotGroup
			// (geoGroup.children mutates during add, so always take index 0)
			while ( geoGroup.children.length > 0 ) {

				pivotGroup.add( geoGroup.children[ 0 ] );

			}

			// Transfer glow mesh references from geoGroup to pivotGroup
			if ( geoGroup.userData.glowMeshes !== undefined ) {

				pivotGroup.userData.glowMeshes = geoGroup.userData.glowMeshes;

			}

		}

		// Position relative to parent (converted to Three.js coords: negate Z)
		if ( s > 0 ) {

			const off = model.submodel_offsets[ s ];
			pivotGroup.position.set( off.x, off.y, - off.z );

		}

		submodelGroups[ s ] = pivotGroup;

	}

	// Build parent-child hierarchy
	for ( let s = 1; s < model.n_models; s ++ ) {

		const parentIdx = model.submodel_parents[ s ];
		if ( parentIdx < model.n_models && submodelGroups[ parentIdx ] !== undefined ) {

			submodelGroups[ parentIdx ].add( submodelGroups[ s ] );

		}

	}

	// Collect glow meshes from all submodel groups into the root
	// This allows polyobj_set_glow() to update all glow meshes from the root group
	const allGlowMeshes = [];

	for ( let s = 0; s < model.n_models; s ++ ) {

		const sg = submodelGroups[ s ];
		if ( sg.userData.glowMeshes !== undefined ) {

			for ( let g = 0; g < sg.userData.glowMeshes.length; g ++ ) {

				allGlowMeshes.push( sg.userData.glowMeshes[ g ] );

			}

		}

	}

	if ( allGlowMeshes.length > 0 ) {

		submodelGroups[ 0 ].userData.glowMeshes = allGlowMeshes;

	}

	// Root is submodel 0
	polyobj_rebuild_glow_refs( submodelGroups[ 0 ] );
	return submodelGroups[ 0 ];

}

// Update engine glow intensity on a model mesh's glow polygons
// Ported from: OBJECT.C lines 618-638 — engine_glow_value computation
// glowValue: 0.0 to 1.0 (0.2 base + up to 0.8 from velocity/thrust)
export function polyobj_set_glow( group, glowValue ) {

	if ( group === null ) return;

	const glowMaterials = group._polyobjGlowMaterials;
	if ( glowMaterials === undefined ) return;

	for ( let i = 0; i < glowMaterials.length; i ++ ) {

		glowMaterials[ i ].glowLight = glowValue;

	}

}

// Compute engine glow value for an object based on its velocity
// Ported from: OBJECT.C lines 618-638 — engine_glow_value = F1_0/5 + speed/max * 4/5
// D1 does not clamp unusually fast objects at 1.0.
const MAX_VELOCITY = 50.0;	// i2f(50) from OBJECT.C

export function compute_engine_glow( vx, vy, vz ) {

	if ( Number.isFinite( vx ) !== true ) vx = 0;
	if ( Number.isFinite( vy ) !== true ) vy = 0;
	if ( Number.isFinite( vz ) !== true ) vz = 0;
	const speed = Math.sqrt( vx * vx + vy * vy + vz * vz );
	const ratio = speed / MAX_VELOCITY;
	return 0.2 + ratio * 0.8;

}
