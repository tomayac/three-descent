// Scalar ports of the VECMAT orientation constructors used by gameplay code.
// Targets expose Descent's orient_rvec/uvec/fvec component fields.

function set_orientation( target,
	right_x, right_y, right_z,
	up_x, up_y, up_z,
	forward_x, forward_y, forward_z ) {

	target.orient_rvec_x = right_x;
	target.orient_rvec_y = right_y;
	target.orient_rvec_z = right_z;
	target.orient_uvec_x = up_x;
	target.orient_uvec_y = up_y;
	target.orient_uvec_z = up_z;
	target.orient_fvec_x = forward_x;
	target.orient_fvec_y = forward_y;
	target.orient_fvec_z = forward_z;

}

// Ported from vm_vector_2_matrix() in VECMAT.ASM.  Supplying an up vector
// preserves its roll reference; a missing or parallel up vector uses D1's
// canonical zero-bank construction.
export function vm_vector_2_matrix( target, forward_x, forward_y, forward_z,
	up_x, up_y, up_z ) {

	if ( target === null || target === undefined ||
		Number.isFinite( forward_x ) !== true ||
		Number.isFinite( forward_y ) !== true ||
		Number.isFinite( forward_z ) !== true ) return false;

	const forwardMagnitude = Math.sqrt(
		forward_x * forward_x + forward_y * forward_y + forward_z * forward_z
	);
	if ( forwardMagnitude <= 0.000001 ) return false;
	forward_x /= forwardMagnitude;
	forward_y /= forwardMagnitude;
	forward_z /= forwardMagnitude;

	if ( Number.isFinite( up_x ) === true && Number.isFinite( up_y ) === true &&
		Number.isFinite( up_z ) === true ) {

		const upMagnitude = Math.sqrt( up_x * up_x + up_y * up_y + up_z * up_z );
		if ( upMagnitude > 0.000001 ) {

			up_x /= upMagnitude;
			up_y /= upMagnitude;
			up_z /= upMagnitude;

			// right = up x forward
			let right_x = up_y * forward_z - up_z * forward_y;
			let right_y = up_z * forward_x - up_x * forward_z;
			let right_z = up_x * forward_y - up_y * forward_x;
			const rightMagnitude = Math.sqrt(
				right_x * right_x + right_y * right_y + right_z * right_z
			);

			if ( rightMagnitude > 0.000001 ) {

				right_x /= rightMagnitude;
				right_y /= rightMagnitude;
				right_z /= rightMagnitude;

				// Recompute up so fixed-point drift in the hint cannot skew the basis.
				up_x = forward_y * right_z - forward_z * right_y;
				up_y = forward_z * right_x - forward_x * right_z;
				up_z = forward_x * right_y - forward_y * right_x;
				set_orientation(
					target,
					right_x, right_y, right_z,
					up_x, up_y, up_z,
					forward_x, forward_y, forward_z
				);
				return true;

			}

		}

	}

	const horizontalMagnitude = Math.sqrt(
		forward_x * forward_x + forward_z * forward_z
	);
	let right_x, right_y, right_z;

	if ( horizontalMagnitude <= 0.000001 ) {

		right_x = 1;
		right_y = 0;
		right_z = 0;
		up_x = 0;
		up_y = 0;
		up_z = forward_y < 0 ? 1 : - 1;

	} else {

		right_x = forward_z / horizontalMagnitude;
		right_y = 0;
		right_z = - forward_x / horizontalMagnitude;
		up_x = forward_y * right_z - forward_z * right_y;
		up_y = forward_z * right_x - forward_x * right_z;
		up_z = forward_x * right_y - forward_y * right_x;

	}

	set_orientation(
		target,
		right_x, right_y, right_z,
		up_x, up_y, up_z,
		forward_x, forward_y, forward_z
	);
	return true;

}
