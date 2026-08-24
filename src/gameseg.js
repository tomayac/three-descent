// Ported from: descent-master/MAIN/GAMESEG.C
// Functions moved from segment.c to make editor separable from game

import {
	SIDE_IS_QUAD, SIDE_IS_TRI_02, SIDE_IS_TRI_13,
	MAX_SIDES_PER_SEGMENT, MAX_SEGMENTS, IS_CHILD
} from './segment.js';
import {
	Vertices, Segments, Num_segments, Side_to_verts
} from './mglobal.js';
import { wall_is_doorway, wall_hit_process, WID_FLY_FLAG, WALL_DOOR } from './wall.js';
import { check_trigger } from './switch.js';

// Tolerance for considering a side as a flat quad vs triangulated
// From GAMESEG.C: #define PLANE_DIST_TOLERANCE 250
const PLANE_DIST_TOLERANCE = 250 / 65536.0;

// find_connected_distance() is used by positional sound updates, so all BFS
// and reconstructed-path storage is shared rather than allocated per call.
const FCD_MAX_DEPTH = 62;
const _fcdVisited = new Uint32Array( MAX_SEGMENTS );
const _fcdParent = new Int16Array( MAX_SEGMENTS );
const _fcdDepth = new Int16Array( MAX_SEGMENTS );
const _fcdQueue = new Int16Array( MAX_SEGMENTS );
const _fcdPath = new Int16Array( MAX_SEGMENTS );
const _fcdCenterX = new Float64Array( MAX_SEGMENTS );
const _fcdCenterY = new Float64Array( MAX_SEGMENTS );
const _fcdCenterZ = new Float64Array( MAX_SEGMENTS );
let _fcdVisitGeneration = 0;
let _fcdDoorwayCallback = wall_is_doorway;

// Kept injectable so users that cannot import wall.js without a cycle can
// still supply the source-equivalent WALL_IS_DOORWAY query.
export function gameseg_set_connected_distance_doorway( callback ) {

	_fcdDoorwayCallback = callback;

}

// Fixed-point Descent's vm_vec_mag_quick approximation, expressed in world
// units.  Keep scalar arguments so positional audio never creates vectors.
function vm_vec_mag_quick_components( x, y, z ) {

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

// ---- Vector math helpers (inline, replaces vecmat.asm) ----

function vm_vec_sub( dest, src0, src1 ) {

	dest.x = src0.x - src1.x;
	dest.y = src0.y - src1.y;
	dest.z = src0.z - src1.z;

}

function vm_vec_cross( dest, src0, src1 ) {

	dest.x = src0.y * src1.z - src0.z * src1.y;
	dest.y = src0.z * src1.x - src0.x * src1.z;
	dest.z = src0.x * src1.y - src0.y * src1.x;

}

function vm_vec_dot( src0, src1 ) {

	return src0.x * src1.x + src0.y * src1.y + src0.z * src1.z;

}

function vm_vec_mag( v ) {

	return Math.sqrt( v.x * v.x + v.y * v.y + v.z * v.z );

}

function vm_vec_normalize( v ) {

	const mag = vm_vec_mag( v );
	if ( mag > 0.000001 ) {

		v.x /= mag;
		v.y /= mag;
		v.z /= mag;

	}

	return mag;

}

// Compute normal from three vertices (as indices into Vertices array)
function vm_vec_normal( dest, v0, v1, v2 ) {

	const t0 = { x: 0, y: 0, z: 0 };
	const t1 = { x: 0, y: 0, z: 0 };

	vm_vec_sub( t0, v1, v0 );
	vm_vec_sub( t1, v2, v1 );
	vm_vec_cross( dest, t0, t1 );
	vm_vec_normalize( dest );

}

// Compute distance from a point to a plane defined by a normal and a point on the plane
function vm_dist_to_plane( point, normal, planePoint ) {

	const d = {
		x: point.x - planePoint.x,
		y: point.y - planePoint.y,
		z: point.z - planePoint.z
	};
	return vm_vec_dot( d, normal );

}

// Get vertex position from Vertices array as {x, y, z}
function getVertex( index ) {

	return {
		x: Vertices[ index * 3 + 0 ],
		y: Vertices[ index * 3 + 1 ],
		z: Vertices[ index * 3 + 2 ]
	};

}

// ---- get_verts_for_normal ----
// From GAMESEG.C: Determine the best ordering of 4 vertices for computing a normal
// The idea: sort the 4 vertex indices, use the sorted order to determine
// which 3 to use for the normal, and whether to negate it.
function get_verts_for_normal( v0, v1, v2, v3 ) {

	// Exact port of get_verts_for_normal() from GAMESEG.C
	// Sort 4 vertices ascending, track permutation to determine if normal needs negating
	const v = [ v0, v1, v2, v3 ];
	const w = [ 0, 1, 2, 3 ]; // tracks how indices got scrambled

	// Insertion sort (matches original C bubble sort)
	for ( let i = 1; i < 4; i ++ ) {

		for ( let j = 0; j < i; j ++ ) {

			if ( v[ j ] > v[ i ] ) {

				let t;
				t = v[ j ]; v[ j ] = v[ i ]; v[ i ] = t;
				t = w[ j ]; w[ j ] = w[ i ]; w[ i ] = t;

			}

		}

	}

	// If for any w[i] & w[i+1]: w[i+1] == (w[i]+3)%4, then must negate
	let negate_flag = false;
	if ( ( ( w[ 0 ] + 3 ) % 4 ) === w[ 1 ] || ( ( w[ 1 ] + 3 ) % 4 ) === w[ 2 ] ) {

		negate_flag = true;

	}

	return { vm0: v[ 0 ], vm1: v[ 1 ], vm2: v[ 2 ], vm3: v[ 3 ], negate_flag };

}

// ---- Side classification ----

function sign( v ) {

	if ( v > PLANE_DIST_TOLERANCE ) return 1;
	if ( v < - ( PLANE_DIST_TOLERANCE + 1 / 65536.0 ) ) return - 1;
	return 0;

}

// Add a side as a quad (flat)
// Mirrors add_side_as_quad() in GAMESEG.C
function add_side_as_quad( sp, sidenum, normal ) {

	const sidep = sp.sides[ sidenum ];
	sidep.type = SIDE_IS_QUAD;
	sidep.normals[ 0 ] = { x: normal.x, y: normal.y, z: normal.z };
	sidep.normals[ 1 ] = { x: normal.x, y: normal.y, z: normal.z };

}

// Add a side as 2 triangles
// Mirrors add_side_as_2_triangles() in GAMESEG.C
function add_side_as_2_triangles( sp, sidenum ) {

	const vs = Side_to_verts[ sidenum ];
	const sidep = sp.sides[ sidenum ];

	// Choose how to triangulate
	if ( IS_CHILD( sp.children[ sidenum ] ) === false ) {

		// Wall side: use Matt's formula Na . AD > 0
		const v0 = getVertex( sp.verts[ vs[ 0 ] ] );
		const v1 = getVertex( sp.verts[ vs[ 1 ] ] );
		const v2 = getVertex( sp.verts[ vs[ 2 ] ] );
		const v3 = getVertex( sp.verts[ vs[ 3 ] ] );

		const norm = { x: 0, y: 0, z: 0 };
		vm_vec_normal( norm, v0, v1, v2 );

		const vec_13 = { x: 0, y: 0, z: 0 };
		vm_vec_sub( vec_13, v3, v1 );

		const dot = vm_vec_dot( norm, vec_13 );

		if ( dot >= 0 ) {

			sidep.type = SIDE_IS_TRI_02;

		} else {

			sidep.type = SIDE_IS_TRI_13;

		}

		// Compute normals for each triangle
		if ( sidep.type === SIDE_IS_TRI_02 ) {

			vm_vec_normal( sidep.normals[ 0 ], v0, v1, v2 );
			vm_vec_normal( sidep.normals[ 1 ], v0, v2, v3 );

		} else {

			vm_vec_normal( sidep.normals[ 0 ], v0, v1, v3 );
			vm_vec_normal( sidep.normals[ 1 ], v1, v2, v3 );

		}

	} else {

		// Internal side: triangulate consistently with the other side
		const v = [];
		for ( let i = 0; i < 4; i ++ ) {

			v.push( sp.verts[ vs[ i ] ] );

		}

		const result = get_verts_for_normal( v[ 0 ], v[ 1 ], v[ 2 ], v[ 3 ] );

		if ( result.vm0 === v[ 0 ] || result.vm0 === v[ 2 ] ) {

			sidep.type = SIDE_IS_TRI_02;

		} else {

			sidep.type = SIDE_IS_TRI_13;

		}

		// Compute normals
		const sv0 = getVertex( sp.verts[ vs[ 0 ] ] );
		const sv1 = getVertex( sp.verts[ vs[ 1 ] ] );
		const sv2 = getVertex( sp.verts[ vs[ 2 ] ] );
		const sv3 = getVertex( sp.verts[ vs[ 3 ] ] );

		if ( sidep.type === SIDE_IS_TRI_02 ) {

			vm_vec_normal( sidep.normals[ 0 ], sv0, sv1, sv2 );
			vm_vec_normal( sidep.normals[ 1 ], sv0, sv2, sv3 );

		} else {

			vm_vec_normal( sidep.normals[ 0 ], sv0, sv1, sv3 );
			vm_vec_normal( sidep.normals[ 1 ], sv1, sv2, sv3 );

		}

	}

}

// Create walls on a side (determine if quad or triangulated)
// Mirrors create_walls_on_side() in GAMESEG.C
function create_walls_on_side( sp, sidenum ) {

	const vs = Side_to_verts[ sidenum ];

	const v0 = sp.verts[ vs[ 0 ] ];
	const v1 = sp.verts[ vs[ 1 ] ];
	const v2 = sp.verts[ vs[ 2 ] ];
	const v3 = sp.verts[ vs[ 3 ] ];

	const result = get_verts_for_normal( v0, v1, v2, v3 );

	const pv0 = getVertex( result.vm0 );
	const pv1 = getVertex( result.vm1 );
	const pv2 = getVertex( result.vm2 );
	const pv3 = getVertex( result.vm3 );

	const vn = { x: 0, y: 0, z: 0 };
	vm_vec_normal( vn, pv0, pv1, pv2 );

	const dist_to_plane = Math.abs( vm_dist_to_plane( pv3, vn, pv0 ) );

	if ( result.negate_flag ) {

		vn.x = - vn.x;
		vn.y = - vn.y;
		vn.z = - vn.z;

	}

	if ( dist_to_plane <= PLANE_DIST_TOLERANCE ) {

		add_side_as_quad( sp, sidenum, vn );

	} else {

		add_side_as_2_triangles( sp, sidenum );

		// De-triangulation check (from GAMESEG.C)
		// If both halves of the triangulated side are on the same side of each other's plane,
		// we can safely de-triangulate back to a quad
		const sidep = sp.sides[ sidenum ];
		if ( sidep.type === SIDE_IS_TRI_02 || sidep.type === SIDE_IS_TRI_13 ) {

			const vl_len = create_abs_vertex_lists_arr( sp, sidenum );

			if ( vl_len === 6 ) {

				const vertnum = Math.min( _vertex_list[ 0 ], _vertex_list[ 2 ] );
				const pVn = getVertex( vertnum );

				const dist0 = vm_dist_to_plane(
					getVertex( _vertex_list[ 1 ] ),
					sidep.normals[ 1 ],
					pVn
				);
				const dist1 = vm_dist_to_plane(
					getVertex( _vertex_list[ 4 ] ),
					sidep.normals[ 0 ],
					pVn
				);

				const s0 = sign( dist0 );
				const s1 = sign( dist1 );

				if ( s0 === 0 || s1 === 0 || s0 !== s1 ) {

					// De-triangulate
					sidep.type = SIDE_IS_QUAD;
					sidep.normals[ 0 ] = { x: vn.x, y: vn.y, z: vn.z };
					sidep.normals[ 1 ] = { x: vn.x, y: vn.y, z: vn.z };

				}

			}

		}

	}

}

// Validate a single segment side
// Mirrors validate_segment_side() in GAMESEG.C
function validate_segment_side( sp, sidenum ) {

	create_walls_on_side( sp, sidenum );

}

// Validate a single segment
// Mirrors validate_segment() in GAMESEG.C
function validate_segment( sp ) {

	for ( let side = 0; side < MAX_SIDES_PER_SEGMENT; side ++ ) {

		validate_segment_side( sp, side );

	}

}

// Validate all segments
// Mirrors validate_segment_all() in GAMESEG.C
export function validate_segment_all() {

	for ( let s = 0; s < Num_segments; s ++ ) {

		validate_segment( Segments[ s ] );

	}

}

// Helper: get absolute vertex lists for a side (fills pre-allocated array)
// Mirrors create_abs_vertex_lists() in GAMESEG.C
// Returns length: 4 for quad, 6 for triangulated (two faces of 3 verts each)
// Pre-allocated result array (Golden Rule #5)
const _vertex_list = new Int32Array( 6 );

function create_abs_vertex_lists_arr( sp, sidenum ) {

	const vp = sp.verts;
	const sidep = sp.sides[ sidenum ];
	const sv = Side_to_verts[ sidenum ];

	switch ( sidep.type ) {

		case SIDE_IS_QUAD:
			_vertex_list[ 0 ] = vp[ sv[ 0 ] ];
			_vertex_list[ 1 ] = vp[ sv[ 1 ] ];
			_vertex_list[ 2 ] = vp[ sv[ 2 ] ];
			_vertex_list[ 3 ] = vp[ sv[ 3 ] ];
			return 4;

		case SIDE_IS_TRI_02:
			_vertex_list[ 0 ] = vp[ sv[ 0 ] ];
			_vertex_list[ 1 ] = vp[ sv[ 1 ] ];
			_vertex_list[ 2 ] = vp[ sv[ 2 ] ];
			_vertex_list[ 3 ] = vp[ sv[ 2 ] ];
			_vertex_list[ 4 ] = vp[ sv[ 3 ] ];
			_vertex_list[ 5 ] = vp[ sv[ 0 ] ];
			return 6;

		case SIDE_IS_TRI_13:
			_vertex_list[ 0 ] = vp[ sv[ 3 ] ];
			_vertex_list[ 1 ] = vp[ sv[ 0 ] ];
			_vertex_list[ 2 ] = vp[ sv[ 1 ] ];
			_vertex_list[ 3 ] = vp[ sv[ 1 ] ];
			_vertex_list[ 4 ] = vp[ sv[ 2 ] ];
			_vertex_list[ 5 ] = vp[ sv[ 3 ] ];
			return 6;

		default:
			_vertex_list[ 0 ] = vp[ sv[ 0 ] ];
			_vertex_list[ 1 ] = vp[ sv[ 1 ] ];
			_vertex_list[ 2 ] = vp[ sv[ 2 ] ];
			_vertex_list[ 3 ] = vp[ sv[ 3 ] ];
			return 4;

	}

}

// Public version of create_abs_vertex_lists
// Returns the pre-allocated _vertex_list array (caller must use before next call)
export function create_abs_vertex_lists( segnum, sidenum ) {

	create_abs_vertex_lists_arr( Segments[ segnum ], sidenum );
	return _vertex_list;

}

// ---- Collision detection functions ----
// Ported from: descent-master/MAIN/GAMESEG.C get_seg_masks(), trace_segs(), find_point_seg()

// Tolerance for collision plane tests (from original source)
const COLLISION_PLANE_DIST_TOLERANCE = 250 / 65536.0;

// Get signed clearance from a point to a side.
// Positive = inside, negative = outside.  A non-planar side is the intersection
// or union of its two face half-spaces, depending on whether it pokes out or in.
// point_x/y/z are in Descent coordinates.
export function get_side_dist( point_x, point_y, point_z, seg, sidenum ) {

	const side = seg.sides[ sidenum ];
	const vertexCount = create_abs_vertex_lists_arr( seg, sidenum );

	if ( vertexCount === 4 ) {

		// Match GAMESEG.C: anchor a planar side at its lowest-numbered vertex.
		let vertnum = _vertex_list[ 0 ];
		for ( let i = 1; i < 4; i ++ ) {

			if ( _vertex_list[ i ] < vertnum ) vertnum = _vertex_list[ i ];

		}

		const n = side.normals[ 0 ];
		return ( point_x - Vertices[ vertnum * 3 ] ) * n.x +
			( point_y - Vertices[ vertnum * 3 + 1 ] ) * n.y +
			( point_z - Vertices[ vertnum * 3 + 2 ] ) * n.z;

	}

	// Both triangles share vertex_list[0] and vertex_list[2].  Using the side's
	// first relative vertex is wrong for TRI_13, where it is not on face 1.
	const vertnum = Math.min( _vertex_list[ 0 ], _vertex_list[ 2 ] );
	const ref_x = Vertices[ vertnum * 3 ];
	const ref_y = Vertices[ vertnum * 3 + 1 ];
	const ref_z = Vertices[ vertnum * 3 + 2 ];
	const n0 = side.normals[ 0 ];
	const n1 = side.normals[ 1 ];

	let poke_dist;
	if ( _vertex_list[ 4 ] < _vertex_list[ 1 ] ) {

		const testVertex = _vertex_list[ 4 ];
		poke_dist = ( Vertices[ testVertex * 3 ] - ref_x ) * n0.x +
			( Vertices[ testVertex * 3 + 1 ] - ref_y ) * n0.y +
			( Vertices[ testVertex * 3 + 2 ] - ref_z ) * n0.z;

	} else {

		const testVertex = _vertex_list[ 1 ];
		poke_dist = ( Vertices[ testVertex * 3 ] - ref_x ) * n1.x +
			( Vertices[ testVertex * 3 + 1 ] - ref_y ) * n1.y +
			( Vertices[ testVertex * 3 + 2 ] - ref_z ) * n1.z;

	}

	const d0 = ( point_x - ref_x ) * n0.x +
		( point_y - ref_y ) * n0.y +
		( point_z - ref_z ) * n0.z;
	const d1 = ( point_x - ref_x ) * n1.x +
		( point_y - ref_y ) * n1.y +
		( point_z - ref_z ) * n1.z;

	// Pokes out: the segment is inside both half-spaces.  Pokes in: being in
	// either half-space is sufficient.  min/max preserves that signed boundary.
	return poke_dist > PLANE_DIST_TOLERANCE ? Math.min( d0, d1 ) : Math.max( d0, d1 );

}

// Fill per-side distances behind a segment and return its center mask.
// Ported from GAMESEG.C get_side_dists() lines 626-762.  As in DXX-Rebirth,
// non-selected sides stay zero so trace ordering only sees masked boundaries.
// side_dists is optional.
export function get_side_dists( point_x, point_y, point_z, segnum, side_dists ) {

	const seg = Segments[ segnum ];
	let centermask = 0;
	let sidebit = 1;

	for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++, sidebit <<= 1 ) {

		if ( side_dists !== undefined ) side_dists[ sidenum ] = 0;

		const side = seg.sides[ sidenum ];
		const vertexCount = create_abs_vertex_lists_arr( seg, sidenum );

		if ( vertexCount === 6 ) {

			const vertnum = Math.min( _vertex_list[ 0 ], _vertex_list[ 2 ] );
			const ref_x = Vertices[ vertnum * 3 ];
			const ref_y = Vertices[ vertnum * 3 + 1 ];
			const ref_z = Vertices[ vertnum * 3 + 2 ];
			const n0 = side.normals[ 0 ];
			const n1 = side.normals[ 1 ];

			let poke_dist;
			if ( _vertex_list[ 4 ] < _vertex_list[ 1 ] ) {

				const testVertex = _vertex_list[ 4 ];
				poke_dist = ( Vertices[ testVertex * 3 ] - ref_x ) * n0.x +
					( Vertices[ testVertex * 3 + 1 ] - ref_y ) * n0.y +
					( Vertices[ testVertex * 3 + 2 ] - ref_z ) * n0.z;

			} else {

				const testVertex = _vertex_list[ 1 ];
				poke_dist = ( Vertices[ testVertex * 3 ] - ref_x ) * n1.x +
					( Vertices[ testVertex * 3 + 1 ] - ref_y ) * n1.y +
					( Vertices[ testVertex * 3 + 2 ] - ref_z ) * n1.z;

			}

			const d0 = ( point_x - ref_x ) * n0.x +
				( point_y - ref_y ) * n0.y +
				( point_z - ref_z ) * n0.z;
			const d1 = ( point_x - ref_x ) * n1.x +
				( point_y - ref_y ) * n1.y +
				( point_z - ref_z ) * n1.z;

			let center_count = 0;
			let dist = 0;
			if ( d0 < - COLLISION_PLANE_DIST_TOLERANCE ) {

				center_count ++;
				dist += d0;

			}
			if ( d1 < - COLLISION_PLANE_DIST_TOLERANCE ) {

				center_count ++;
				dist += d1;

			}

			const side_pokes_out = poke_dist > PLANE_DIST_TOLERANCE;
			if ( side_pokes_out !== true ) {

				if ( center_count !== 2 ) continue;

			} else if ( center_count === 0 ) {

				continue;

			}

			centermask |= sidebit;
			if ( center_count === 2 ) dist /= 2;
			if ( side_dists !== undefined ) side_dists[ sidenum ] = dist;

		} else {

			let vertnum = _vertex_list[ 0 ];
			for ( let i = 1; i < 4; i ++ ) {

				if ( _vertex_list[ i ] < vertnum ) vertnum = _vertex_list[ i ];

			}

			const n = side.normals[ 0 ];
			const dist = ( point_x - Vertices[ vertnum * 3 ] ) * n.x +
				( point_y - Vertices[ vertnum * 3 + 1 ] ) * n.y +
				( point_z - Vertices[ vertnum * 3 + 2 ] ) * n.z;

			if ( dist < - COLLISION_PLANE_DIST_TOLERANCE ) {

				centermask |= sidebit;
				if ( side_dists !== undefined ) side_dists[ sidenum ] = dist;

			}

		}

	}

	return centermask;

}

// Get centermask for a point in a segment (simple version, no facemask/sidemask)
// Returns a 6-bit mask: bit i set = point is behind side i
// centermask === 0 means point is inside segment
export function get_seg_masks_point( point_x, point_y, point_z, segnum, side_dists ) {

	return get_side_dists( point_x, point_y, point_z, segnum, side_dists );

}

// ---- Full get_seg_masks() for FVI ----
// Ported from: GAMESEG.C lines 483-621
// Returns { facemask, sidemask, centermask } with proper per-face bit masks
// facemask: 12-bit (2 faces per side × 6 sides), accounts for radius
// sidemask: 6-bit, accounts for radius
// centermask: 6-bit, zero radius (point only)
// Pre-allocated result (Golden Rule #5)
const _segmasks = { facemask: 0, sidemask: 0, centermask: 0 };

export function get_seg_masks( checkp_x, checkp_y, checkp_z, segnum, rad ) {

	const seg = Segments[ segnum ];

	_segmasks.facemask = 0;
	_segmasks.sidemask = 0;
	_segmasks.centermask = 0;

	let facebit = 1;
	let sidebit = 1;

	for ( let sn = 0; sn < 6; sn ++, sidebit <<= 1 ) {

		const sidep = seg.sides[ sn ];
		create_abs_vertex_lists_arr( seg, sn );
		const num_faces = ( sidep.type === SIDE_IS_QUAD ) ? 1 : 2;

		if ( num_faces === 2 ) {

			// Triangulated side: determine if it pokes out (convex) or in (concave)
			// Use lowest vertex index as reference point (matching original C code)
			const vertnum = Math.min( _vertex_list[ 0 ], _vertex_list[ 2 ] );
			const ref_x = Vertices[ vertnum * 3 + 0 ];
			const ref_y = Vertices[ vertnum * 3 + 1 ];
			const ref_z = Vertices[ vertnum * 3 + 2 ];

			// Determine which vertex to test against which normal
			// Ported from GAMESEG.C: if _vertex_list[4] < _vertex_list[1],
			// test _vertex_list[4] against normal[0], else _vertex_list[1] against normal[1]
			let poke_dist;

			if ( _vertex_list[ 4 ] < _vertex_list[ 1 ] ) {

				const tv = _vertex_list[ 4 ];
				const n = sidep.normals[ 0 ];
				poke_dist = ( Vertices[ tv * 3 ] - ref_x ) * n.x +
					( Vertices[ tv * 3 + 1 ] - ref_y ) * n.y +
					( Vertices[ tv * 3 + 2 ] - ref_z ) * n.z;

			} else {

				const tv = _vertex_list[ 1 ];
				const n = sidep.normals[ 1 ];
				poke_dist = ( Vertices[ tv * 3 ] - ref_x ) * n.x +
					( Vertices[ tv * 3 + 1 ] - ref_y ) * n.y +
					( Vertices[ tv * 3 + 2 ] - ref_z ) * n.z;

			}

			const side_pokes_out = ( poke_dist > PLANE_DIST_TOLERANCE );

			let side_count = 0;
			let center_count = 0;

			for ( let fn = 0; fn < 2; fn ++, facebit <<= 1 ) {

				const n = sidep.normals[ fn ];

				// Distance from check point to face plane (using reference vertex)
				const dist = ( checkp_x - ref_x ) * n.x +
					( checkp_y - ref_y ) * n.y +
					( checkp_z - ref_z ) * n.z;

				if ( dist < - COLLISION_PLANE_DIST_TOLERANCE ) {

					center_count ++;

				}

				if ( dist - rad < - COLLISION_PLANE_DIST_TOLERANCE ) {

					_segmasks.facemask |= facebit;
					side_count ++;

				}

			}

			if ( side_pokes_out !== true ) {

				// Concave: must be behind BOTH faces
				if ( side_count === 2 ) _segmasks.sidemask |= sidebit;
				if ( center_count === 2 ) _segmasks.centermask |= sidebit;

			} else {

				// Convex: behind at least ONE face
				if ( side_count > 0 ) _segmasks.sidemask |= sidebit;
				if ( center_count > 0 ) _segmasks.centermask |= sidebit;

			}

		} else {

			// Single face (quad)
			// Use lowest vertex index as reference
			let vertnum = _vertex_list[ 0 ];

			for ( let i = 1; i < 4; i ++ ) {

				if ( _vertex_list[ i ] < vertnum ) vertnum = _vertex_list[ i ];

			}

			const ref_x = Vertices[ vertnum * 3 + 0 ];
			const ref_y = Vertices[ vertnum * 3 + 1 ];
			const ref_z = Vertices[ vertnum * 3 + 2 ];

			const n = sidep.normals[ 0 ];
			const dist = ( checkp_x - ref_x ) * n.x +
				( checkp_y - ref_y ) * n.y +
				( checkp_z - ref_z ) * n.z;

			if ( dist < - COLLISION_PLANE_DIST_TOLERANCE ) {

				_segmasks.centermask |= sidebit;

			}

			if ( dist - rad < - COLLISION_PLANE_DIST_TOLERANCE ) {

				_segmasks.facemask |= facebit;
				_segmasks.sidemask |= sidebit;

			}

			facebit <<= 2; // Skip 2 bits for quad (matches C: each side uses 2 face bits)

		}

	}

	return _segmasks;

}

// Compute center point on a side as average of 4 vertices
// Ported from: compute_center_point_on_side() in GAMESEG.C
// Pre-allocated result (Golden Rule #5)
const _side_center = { x: 0, y: 0, z: 0 };

export function compute_center_point_on_side( segnum, sidenum ) {

	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sidenum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 4; v ++ ) {

		const vi = seg.verts[ sv[ v ] ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	_side_center.x = cx / 4;
	_side_center.y = cy / 4;
	_side_center.z = cz / 4;

	return _side_center;

}

// Compute segment center as average of 8 vertices
// Pre-allocated result (Golden Rule #5)
const _seg_center = { x: 0, y: 0, z: 0 };

export function compute_segment_center( segnum ) {

	const seg = Segments[ segnum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 8; v ++ ) {

		const vi = seg.verts[ v ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	_seg_center.x = cx / 8;
	_seg_center.y = cy / 8;
	_seg_center.z = cz / 8;

	return _seg_center;

}

// Find which side of con_seg connects back to base_seg
// Ported from: find_connect_side() in GAMESEG.C
export function find_connect_side( base_segnum, con_segnum ) {

	const con_seg = Segments[ con_segnum ];

	for ( let s = 0; s < MAX_SIDES_PER_SEGMENT; s ++ ) {

		if ( con_seg.children[ s ] === base_segnum ) {

			return s;

		}

	}

	return - 1;

}

// Determine the route distance between points through render-past portals.
// Ported from GAMESEG.C find_connected_distance().  Point arguments are kept
// primitive so sound-object frame updates do not need temporary vectors.
export function find_connected_distance(
	p0_x, p0_y, p0_z, seg0,
	p1_x, p1_y, p1_z, seg1,
	max_depth, wid_flag
) {

	if ( Number.isInteger( seg0 ) !== true || Number.isInteger( seg1 ) !== true ||
		seg0 < 0 || seg0 >= Num_segments || seg1 < 0 || seg1 >= Num_segments ) return - 1;
	if ( Number.isFinite( p0_x ) !== true || Number.isFinite( p0_y ) !== true ||
		Number.isFinite( p0_z ) !== true || Number.isFinite( p1_x ) !== true ||
		Number.isFinite( p1_y ) !== true || Number.isFinite( p1_z ) !== true ) return - 1;

	const direct_x = p1_x - p0_x;
	const direct_y = p1_y - p0_y;
	const direct_z = p1_z - p0_z;
	const direct_distance = vm_vec_mag_quick_components(
		direct_x, direct_y, direct_z
	);

	// D1 deliberately takes the direct distance for the same or an immediately
	// connected segment before consulting WALL_IS_DOORWAY.
	if ( seg0 === seg1 || find_connect_side( seg0, seg1 ) !== - 1 ) return direct_distance;
	if ( typeof _fcdDoorwayCallback !== 'function' ) return - 1;

	let depth_limit = Number.isInteger( max_depth ) === true ? max_depth : - 1;
	if ( depth_limit > FCD_MAX_DEPTH ) depth_limit = FCD_MAX_DEPTH;

	_fcdVisitGeneration = ( _fcdVisitGeneration + 1 ) >>> 0;
	if ( _fcdVisitGeneration === 0 ) {

		_fcdVisited.fill( 0 );
		_fcdVisitGeneration = 1;

	}

	let queue_head = 0;
	let queue_tail = 0;
	_fcdQueue[ queue_tail ++ ] = seg0;
	_fcdVisited[ seg0 ] = _fcdVisitGeneration;
	_fcdParent[ seg0 ] = - 1;
	_fcdDepth[ seg0 ] = 0;

	let found = false;

	while ( queue_head < queue_tail ) {

		const current = _fcdQueue[ queue_head ++ ];
		if ( current === seg1 ) {

			found = true;
			break;

		}

		const seg = Segments[ current ];
		const child_depth = _fcdDepth[ current ] + 1;

		for ( let side = 0; side < MAX_SIDES_PER_SEGMENT; side ++ ) {

			const child = seg.children[ side ];
			if ( child < 0 || child >= Num_segments ) continue;
			if ( _fcdVisited[ child ] === _fcdVisitGeneration ) continue;
			if ( ( _fcdDoorwayCallback( current, side ) & wid_flag ) === 0 ) continue;

			_fcdVisited[ child ] = _fcdVisitGeneration;
			_fcdParent[ child ] = current;
			_fcdDepth[ child ] = child_depth;
			_fcdQueue[ queue_tail ++ ] = child;

			// Preserve D1's exclusive finite-depth limit and early abort.
			if ( depth_limit !== - 1 && child_depth === depth_limit ) return - 1;

		}

	}

	if ( found !== true ) return - 1;

	let path_length = 0;
	let path_segment = seg1;

	while ( path_segment !== - 1 && path_length < MAX_SEGMENTS ) {

		_fcdPath[ path_length ++ ] = path_segment;
		if ( path_segment === seg0 ) break;
		path_segment = _fcdParent[ path_segment ];

	}

	if ( path_length < 2 || _fcdPath[ path_length - 1 ] !== seg0 ) return - 1;

	for ( let i = 0; i < path_length; i ++ ) {

		const path_seg = Segments[ _fcdPath[ i ] ];
		let cx = 0;
		let cy = 0;
		let cz = 0;

		for ( let vertex = 0; vertex < 8; vertex ++ ) {

			const vertex_offset = path_seg.verts[ vertex ] * 3;
			cx += Vertices[ vertex_offset ];
			cy += Vertices[ vertex_offset + 1 ];
			cz += Vertices[ vertex_offset + 2 ];

		}

		_fcdCenterX[ i ] = cx / 8;
		_fcdCenterY[ i ] = cy / 8;
		_fcdCenterZ[ i ] = cz / 8;

	}

	let dx = p1_x - _fcdCenterX[ 1 ];
	let dy = p1_y - _fcdCenterY[ 1 ];
	let dz = p1_z - _fcdCenterZ[ 1 ];
	let distance = vm_vec_mag_quick_components( dx, dy, dz );

	const first_path_center = path_length - 2;
	dx = p0_x - _fcdCenterX[ first_path_center ];
	dy = p0_y - _fcdCenterY[ first_path_center ];
	dz = p0_z - _fcdCenterZ[ first_path_center ];
	distance += vm_vec_mag_quick_components( dx, dy, dz );

	for ( let i = 1; i < path_length - 2; i ++ ) {

		dx = _fcdCenterX[ i ] - _fcdCenterX[ i + 1 ];
		dy = _fcdCenterY[ i ] - _fcdCenterY[ i + 1 ];
		dz = _fcdCenterZ[ i ] - _fcdCenterZ[ i + 1 ];
		distance += vm_vec_mag_quick_components( dx, dy, dz );

	}

	return distance;

}

// Get number of faces for a side (1 for quad, 2 for triangulated)
export function get_num_faces( sidep ) {

	if ( sidep.type === SIDE_IS_QUAD ) return 1;
	if ( sidep.type === SIDE_IS_TRI_02 || sidep.type === SIDE_IS_TRI_13 ) return 2;
	return 1;

}

// Follow segment connectivity to find which segment contains the point
// Ported from: trace_segs() in GAMESEG.C
// Returns segment number, or -1 if not found
// Pre-allocated per-depth side_dists arrays to avoid per-frame allocation
// Each recursion depth needs its own array since the parent's distances
// must survive across recursive calls for the retry loop.
const MAX_TRACE_DEPTH = 20;
const _trace_side_dists_stack = [];

for ( let _d = 0; _d < MAX_TRACE_DEPTH; _d ++ ) {

	_trace_side_dists_stack.push( new Float64Array( 6 ) );

}

export function trace_segs( point_x, point_y, point_z, start_segnum ) {

	return _trace_segs_recursive( point_x, point_y, point_z, start_segnum, 0 );

}

// Ported from: trace_segs() in GAMESEG.C lines 915-978
// Uses a do-while loop to retry multiple sides on failure,
// matching the original C behavior.
function _trace_segs_recursive( point_x, point_y, point_z, segnum, depth ) {

	if ( depth >= MAX_TRACE_DEPTH ) return - 1;
	if ( segnum < 0 || segnum >= Num_segments ) return - 1;

	const seg = Segments[ segnum ];
	const side_dists = _trace_side_dists_stack[ depth ];
	const centermask = get_seg_masks_point( point_x, point_y, point_z, segnum, side_dists );

	if ( centermask === 0 ) return segnum;	// Point is inside this segment

	// Retry loop: try sides in order of most-negative distance.
	// If recursion fails for one side, zero it out and try the next.
	// Ported from: GAMESEG.C lines 932-975 — do { ... } while (biggest_side != -1)
	let biggest_side;

	do {

		// Find the side where the point is farthest behind (most negative distance)
		biggest_side = - 1;
		let biggest_val = 0;

		for ( let s = 0; s < 6; s ++ ) {

			if ( ( centermask & ( 1 << s ) ) !== 0 ) {

				if ( IS_CHILD( seg.children[ s ] ) === true ) {

					if ( side_dists[ s ] < biggest_val ) {

						biggest_val = side_dists[ s ];
						biggest_side = s;

					}

				}

			}

		}

		if ( biggest_side !== - 1 ) {

			// Zero out this side's distance so it won't be retried
			side_dists[ biggest_side ] = 0;

			const check = _trace_segs_recursive( point_x, point_y, point_z, seg.children[ biggest_side ], depth + 1 );

			if ( check !== - 1 ) return check;

		}

	} while ( biggest_side !== - 1 );

	return - 1;	// No connected segment found

}

// Find the segment containing a point, with exhaustive fallback
// Ported from: find_point_seg() in GAMESEG.C
export function find_point_seg( point_x, point_y, point_z, start_segnum ) {

	// First try trace_segs from the starting segment
	if ( start_segnum >= 0 && start_segnum < Num_segments ) {

		const result = trace_segs( point_x, point_y, point_z, start_segnum );
		if ( result !== - 1 ) return result;

	}

	// Fallback: exhaustive search of all segments
	for ( let s = 0; s < Num_segments; s ++ ) {

		const mask = get_seg_masks_point( point_x, point_y, point_z, s, undefined );
		if ( mask === 0 ) return s;

	}

	return - 1;

}

// Collide a sphere moving from p0 to p1 within a segment
// Returns the clipped position and new segment number
// This is a simplified version of find_vector_intersection for camera movement
// All coordinates in Descent space
// Pre-allocated result object to avoid per-frame allocation
const _collide_result = { x: 0, y: 0, z: 0, segnum: 0, hit: false };

export function collide_camera_move( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, segnum, radius ) {

	_collide_result.x = p1_x;
	_collide_result.y = p1_y;
	_collide_result.z = p1_z;
	_collide_result.segnum = segnum;
	_collide_result.hit = false;

	if ( segnum < 0 || segnum >= Num_segments ) return _collide_result;

	// Iterative collision: re-check after portal transitions or wall pushbacks
	// Max 4 iterations handles: initial check + up to 3 cascading transitions
	const MAX_COLLISION_ITERS = 4;

	for ( let iter = 0; iter < MAX_COLLISION_ITERS; iter ++ ) {

		const seg = Segments[ _collide_result.segnum ];
		let transitioned = false;

		for ( let s = 0; s < 6; s ++ ) {

			const dist = get_side_dist(
				_collide_result.x, _collide_result.y, _collide_result.z,
				seg, s
			);

			if ( dist < radius ) {

				// Point is too close to or beyond this side
				const hasChild = IS_CHILD( seg.children[ s ] ) === true;
				const side = seg.sides[ s ];
				const hasWall = side.wall_num !== - 1;

				if ( hasChild === true && hasWall === false ) {

					// Pure portal (no wall) - check if we should transition
					if ( dist < - COLLISION_PLANE_DIST_TOLERANCE ) {

						const new_seg = trace_segs(
							_collide_result.x, _collide_result.y, _collide_result.z,
							seg.children[ s ]
						);

						if ( new_seg !== - 1 && new_seg !== _collide_result.segnum ) {

							_collide_result.segnum = new_seg;
							transitioned = true;
							break;

						}

					}

				} else if ( hasChild === true && hasWall === true ) {

					// Portal with wall (door/illusion/etc.)
					// Check for triggers when player contacts wall
					check_trigger( _collide_result.segnum, s );

					const passable = wall_is_doorway( _collide_result.segnum, s );

					if ( ( passable & WID_FLY_FLAG ) !== 0 ) {

						// Door is open - treat as portal
						if ( dist < - COLLISION_PLANE_DIST_TOLERANCE ) {

							const new_seg = trace_segs(
								_collide_result.x, _collide_result.y, _collide_result.z,
								seg.children[ s ]
							);

							if ( new_seg !== - 1 && new_seg !== _collide_result.segnum ) {

								_collide_result.segnum = new_seg;
								transitioned = true;
								break;

							}

						}

					} else {

						// Door is closed - trigger opening and push back
						if ( dist < radius * 0.8 ) {

							wall_hit_process( _collide_result.segnum, s );

						}

						// Push back from closed door
						let nx, ny, nz;

						if ( side.type === SIDE_IS_QUAD ) {

							nx = side.normals[ 0 ].x;
							ny = side.normals[ 0 ].y;
							nz = side.normals[ 0 ].z;

						} else {

							nx = ( side.normals[ 0 ].x + side.normals[ 1 ].x ) * 0.5;
							ny = ( side.normals[ 0 ].y + side.normals[ 1 ].y ) * 0.5;
							nz = ( side.normals[ 0 ].z + side.normals[ 1 ].z ) * 0.5;
							const mag = Math.sqrt( nx * nx + ny * ny + nz * nz );
							if ( mag > 0.000001 ) {

								nx /= mag;
								ny /= mag;
								nz /= mag;

							}

						}

						const pushback = radius - dist;
						_collide_result.x += nx * pushback;
						_collide_result.y += ny * pushback;
						_collide_result.z += nz * pushback;
						_collide_result.hit = true;

					}

				} else {

					// Solid wall - push the point back
					let nx, ny, nz;

					if ( side.type === SIDE_IS_QUAD ) {

						nx = side.normals[ 0 ].x;
						ny = side.normals[ 0 ].y;
						nz = side.normals[ 0 ].z;

					} else {

						nx = ( side.normals[ 0 ].x + side.normals[ 1 ].x ) * 0.5;
						ny = ( side.normals[ 0 ].y + side.normals[ 1 ].y ) * 0.5;
						nz = ( side.normals[ 0 ].z + side.normals[ 1 ].z ) * 0.5;
						const mag = Math.sqrt( nx * nx + ny * ny + nz * nz );
						if ( mag > 0.000001 ) {

							nx /= mag;
							ny /= mag;
							nz /= mag;

						}

					}

					// Push back: move point along normal so distance = radius
					const pushback = radius - dist;
					_collide_result.x += nx * pushback;
					_collide_result.y += ny * pushback;
					_collide_result.z += nz * pushback;
					_collide_result.hit = true;

				}

			}

		}

		// If no portal transition happened, we're done
		if ( transitioned !== true ) break;

	}

	return _collide_result;

}
