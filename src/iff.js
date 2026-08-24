// Ported from: descent-master/IFF/IFF.C
// The end-level .BBM assets are 8-bit IFF PBM bitmaps.

const FORM_ID = 0x464F524D;
const PBM_ID = 0x50424D20;
const BMHD_ID = 0x424D4844;
const CMAP_ID = 0x434D4150;
const BODY_ID = 0x424F4459;

const MASK_NONE = 0;
const MASK_HAS_MASK = 1;
const MASK_TRANSPARENT_COLOR = 2;

const COMPRESSION_NONE = 0;
const COMPRESSION_BYTE_RUN_1 = 1;

function decode_byte_run_row( bytes, position, end, row, rowLength ) {

	let written = 0;

	while ( written < rowLength ) {

		if ( position >= end ) return - 1;
		let control = bytes[ position ++ ];
		if ( control >= 128 ) control -= 256;

		if ( control >= 0 ) {

			const count = control + 1;
			if ( position + count > end || written + count > rowLength ) return - 1;
			row.set( bytes.subarray( position, position + count ), written );
			position += count;
			written += count;

		} else if ( control >= - 127 ) {

			const count = 1 - control;
			if ( position >= end || written + count > rowLength ) return - 1;
			row.fill( bytes[ position ++ ], written, written + count );
			written += count;

		}
		// -128 is the ByteRun1 no-op.

	}

	return position;

}

function decode_body( bytes, bodyStart, bodyLength, header ) {

	const bodyEnd = bodyStart + bodyLength;
	const pixels = new Uint8Array( header.width * header.height );
	let position = bodyStart;

	if ( header.compression === COMPRESSION_NONE ) {

		for ( let y = 0; y < header.height; y ++ ) {

			if ( position + header.width > bodyEnd ) return null;
			pixels.set(
				bytes.subarray( position, position + header.width ), y * header.width
			);
			position += header.width;

			// Match IFF.C's PBM mask and odd-row handling.
			if ( header.masking === MASK_HAS_MASK ) position += header.width;
			if ( ( header.width & 1 ) !== 0 ) position ++;
			if ( position > bodyEnd ) return null;

		}

	} else if ( header.compression === COMPRESSION_BYTE_RUN_1 ) {

		const storedWidth = ( header.width + 1 ) & ~ 1;
		const row = new Uint8Array( storedWidth );

		for ( let y = 0; y < header.height; y ++ ) {

			position = decode_byte_run_row( bytes, position, bodyEnd, row, storedWidth );
			if ( position < 0 ) return null;
			pixels.set( row.subarray( 0, header.width ), y * header.width );

			if ( header.masking === MASK_HAS_MASK ) {

				position = decode_byte_run_row( bytes, position, bodyEnd, row, storedWidth );
				if ( position < 0 ) return null;

			}

		}

	} else {

		return null;

	}

	if ( position !== bodyEnd ) return null;
	return pixels;

}

export function iff_parse_pbm( cfile ) {

	if ( cfile === null || cfile === undefined || cfile.length() < 12 ) return null;

	const bytes = cfile.readBytes( cfile.length() );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	if ( view.getUint32( 0, false ) !== FORM_ID ) return null;

	const formLength = view.getUint32( 4, false );
	const formEnd = formLength + 8;
	if ( formEnd > bytes.length || formEnd < 12 ) return null;
	if ( view.getUint32( 8, false ) !== PBM_ID ) return null;

	let header = null;
	let palette = null;
	let bodyStart = - 1;
	let bodyLength = 0;
	let position = 12;

	while ( position < formEnd ) {

		if ( position + 8 > formEnd ) return null;
		const chunkId = view.getUint32( position, false );
		const chunkLength = view.getUint32( position + 4, false );
		const chunkStart = position + 8;
		const chunkEnd = chunkStart + chunkLength;
		const paddedEnd = chunkEnd + ( chunkLength & 1 );
		if ( chunkEnd > formEnd || paddedEnd > formEnd ) return null;

		if ( chunkId === BMHD_ID ) {

			if ( chunkLength < 20 ) return null;
			const width = view.getUint16( chunkStart, false );
			const height = view.getUint16( chunkStart + 2, false );
			const planes = view.getUint8( chunkStart + 8 );
			const masking = view.getUint8( chunkStart + 9 );
			const compression = view.getUint8( chunkStart + 10 );
			const transparentColor = view.getUint16( chunkStart + 12, false );

			if ( width <= 0 || height <= 0 || planes !== 8 ) return null;
			if ( masking !== MASK_NONE && masking !== MASK_HAS_MASK &&
				masking !== MASK_TRANSPARENT_COLOR ) return null;
			if ( compression !== COMPRESSION_NONE &&
				compression !== COMPRESSION_BYTE_RUN_1 ) return null;

			header = {
				width: width,
				height: height,
				masking: masking,
				compression: compression,
				transparentColor: transparentColor
			};

		} else if ( chunkId === CMAP_ID ) {

			if ( chunkLength > 768 || chunkLength % 3 !== 0 ) return null;
			palette = new Uint8Array( 768 );
			palette.set( bytes.subarray( chunkStart, chunkEnd ) );

		} else if ( chunkId === BODY_ID ) {

			bodyStart = chunkStart;
			bodyLength = chunkLength;

		}

		position = paddedEnd;

	}

	if ( position !== formEnd || header === null || palette === null || bodyStart < 0 ) return null;

	const pixels = decode_body( bytes, bodyStart, bodyLength, header );
	if ( pixels === null ) return null;

	return {
		width: header.width,
		height: header.height,
		pixels: pixels,
		palette: palette,
		hasTransparency: header.masking === MASK_TRANSPARENT_COLOR,
		transparentColor: header.transparentColor
	};

}

export function iff_read_bitmap( hogFile, filename ) {

	if ( hogFile === null || hogFile === undefined ) return null;
	const cfile = hogFile.findFile( filename );
	if ( cfile === null ) {

		console.warn( 'IFF: File not found: ' + filename );
		return null;

	}

	const bitmap = iff_parse_pbm( cfile );
	if ( bitmap === null ) console.warn( 'IFF: Invalid PBM bitmap: ' + filename );
	return bitmap;

}
