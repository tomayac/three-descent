// Ported from: DXX-Rebirth common/misc/hmp.cpp
// HMP (Human Machine Interfaces MIDI) file parser
// Converts HMP format to scheduled MIDI events for Web Audio playback

// HMP header offsets (from DXX-Rebirth hmp_open)
const HMP_SIGNATURE = 'HMIMIDIP';
const HMP_OFFSET_NUM_TRACKS = 0x30;	// 48
const HMP_OFFSET_TEMPO = 0x38;			// 56
const HMP_OFFSET_TRACK_DATA = 0x308;	// 776

// MIDI command lengths: for status bytes 0x80-0xE0
const MIDI_CMD_LEN = [ 3, 3, 3, 3, 2, 2, 3 ];

// Read HMI-style variable length quantity (different from standard MIDI VLQ)
// In HMI: MSB=0 means "more bytes follow", MSB=1 means "last byte"
// (Standard MIDI VLQ is the opposite)
function readHmiVLQ( data, offset ) {

	let value = 0;
	let multiplier = 1;
	let pos = offset;

	while ( pos < data.length ) {

		const byte = data[ pos ];
		const digit = byte & 0x7F;
		const bytesRead = pos - offset + 1;

		// HMP deltas are unsigned 32-bit values.  Reject overlong values
		// instead of letting JavaScript bitwise arithmetic wrap them.
		if ( bytesRead > 5 || digit * multiplier > 0xFFFFFFFF - value ) {

			return { value: 0, bytesRead: 0 };

		}

		value += digit * multiplier;
		pos ++;

		// In HMI VLQs, a set MSB marks the final byte.
		if ( ( byte & 0x80 ) !== 0 ) {

			return { value: value, bytesRead: bytesRead };

		}

		multiplier *= 128;

	}

	return { value: 0, bytesRead: 0 };

}

// Read a standard MIDI variable length quantity.  MIDI VLQs are limited to
// four bytes and 28 bits.
function readMidiVLQ( data, offset ) {

	let value = 0;
	let pos = offset;

	for ( let bytesRead = 1; bytesRead <= 4; bytesRead ++ ) {

		if ( pos >= data.length ) return { value: 0, bytesRead: 0 };

		const byte = data[ pos ++ ];
		value = value * 128 + ( byte & 0x7F );

		if ( ( byte & 0x80 ) === 0 ) {

			return { value: value, bytesRead: bytesRead };

		}

	}

	return { value: 0, bytesRead: 0 };

}

// Parse an HMP file and extract MIDI events
// Returns: { tempo, tracks: [ { events: [...], endTime } ] }, in HMP ticks.
export function hmp_parse( hmpData ) {

	if ( ! ( hmpData instanceof Uint8Array ) || hmpData.length < HMP_OFFSET_TEMPO + 4 ) {

		console.warn( 'HMP: File is missing or too short for its header' );
		return null;

	}

	const view = new DataView( hmpData.buffer, hmpData.byteOffset, hmpData.byteLength );

	// Verify signature
	let sig = '';
	for ( let i = 0; i < 8; i ++ ) {

		sig += String.fromCharCode( hmpData[ i ] );

	}

	if ( sig !== HMP_SIGNATURE ) {

		console.warn( 'HMP: Invalid signature: ' + sig );
		return null;

	}

	// Read header
	const numTracks = view.getUint32( HMP_OFFSET_NUM_TRACKS, true );
	const tempo = view.getUint32( HMP_OFFSET_TEMPO, true );

	if ( numTracks < 1 || numTracks > 32 ) {

		console.warn( 'HMP: Invalid track count: ' + numTracks );
		return null;

	}

	if ( tempo === 0 ) {

		console.warn( 'HMP: Invalid tempo: 0' );
		return null;

	}

	// Read track data starting at offset 0x308
	const tracks = [];
	let offset = HMP_OFFSET_TRACK_DATA;

	for ( let t = 0; t < numTracks; t ++ ) {

		if ( offset + 12 > hmpData.length ) {

			console.warn( 'HMP: Track ' + t + ' header is truncated' );
			return null;

		}

		// Each track has a 12-byte header: 3 × int32
		// tdata[0] = unknown, tdata[1] = data length (including header), tdata[2] = unknown
		const tdata1 = view.getInt32( offset + 4, true );
		offset += 12;

		const dataLen = tdata1 - 12;

		if ( dataLen < 0 || offset + dataLen > hmpData.length ) {

			console.warn( 'HMP: Track ' + t + ' invalid data length: ' + dataLen );
			return null;

		}

		// Extract track event data
		const trackData = hmpData.subarray( offset, offset + dataLen );
		offset += dataLen;

		// Parse MIDI events from track data
		const track = parseTrackEvents( trackData );
		if ( track === null ) {

			console.warn( 'HMP: Track ' + t + ' contains malformed event data' );
			return null;

		}
		tracks.push( track );

	}

	return {
		tempo: tempo,	// ticks per quarter note (PPQN)
		numTracks: numTracks,
		tracks: tracks
	};

}

// Parse MIDI events from HMP track data
function parseTrackEvents( data ) {

	const events = [];
	let pos = 0;
	let currentTime = 0; // cumulative time in ticks

	while ( pos < data.length ) {

		// Read delta time (HMI VLQ)
		const vlq = readHmiVLQ( data, pos );

		if ( vlq.bytesRead === 0 ) return null;

		pos += vlq.bytesRead;
		if ( ! Number.isSafeInteger( currentTime + vlq.value ) ) return null;
		currentTime += vlq.value;

		if ( pos >= data.length ) return null;

		const statusByte = data[ pos ];

		// Check for end-of-track meta event (0xFF 0x2F)
		if ( statusByte === 0xFF ) {

			pos ++; // skip 0xFF
			if ( pos >= data.length ) return null;

			const metaType = data[ pos ++ ];
			const metaLength = readMidiVLQ( data, pos );
			if ( metaLength.bytesRead === 0 ) return null;

			pos += metaLength.bytesRead;
			if ( metaLength.value > data.length - pos ) return null;

			if ( metaType === 0x2F ) {

				// End-of-track has no payload.  Bytes after a valid marker are
				// ignored, as they are by the original HMP player.
				if ( metaLength.value !== 0 ) return null;
				return { events: events, endTime: currentTime };

			}

			pos += metaLength.value;
			continue;

		}

		// D1 HMP tracks do not admit SysEx or other system-common/realtime
		// events.  Reject the file instead of consuming only the status byte and
		// accidentally interpreting its payload as later delta times/events.
		if ( statusByte >= 0xF0 && statusByte < 0xFF ) {

			return null;

		}

		// Invalid status byte
		if ( statusByte < 0x80 ) {

			return null;

		}

		// Channel MIDI event
		const cmd = ( statusByte >> 4 ) - 8; // 0-6 for 0x80-0xE0
		const channel = statusByte & 0x0F;
		const cmdLen = MIDI_CMD_LEN[ cmd ];
		pos ++; // skip status byte

		if ( pos + cmdLen - 1 > data.length ) return null;

		const data1 = data[ pos ++ ];
		let data2 = 0;

		if ( cmdLen === 3 ) {

			data2 = data[ pos ++ ];

		}

		events.push( {
			time: currentTime,
			status: statusByte,
			type: ( statusByte >> 4 ),
			channel: channel,
			data1: data1,
			data2: data2
		} );

	}

	return { events: events, endTime: currentTime };

}

// Flatten all tracks into a single sorted event list with absolute times in seconds
export function hmp_get_events( hmpFile ) {

	if ( hmpFile === null ) return [];

	// HMP tempo = ticks per quarter note (PPQN), use directly
	// DXX-Rebirth Windows path: time_div = hmp->tempo, tempo = 1,000,000 µs/beat
	// DXX-Rebirth hmp2mid path: time_div = hmp->tempo*1.6, tempo = 0x188000 µs/beat
	// Both paths produce the same tick duration — use the simpler Windows formula
	const ppqn = hmpFile.tempo;
	const usPerQuarter = 1000000;
	const tickDuration = usPerQuarter / ppqn / 1000000; // seconds per tick

	const allEvents = [];

	// Skip track 0 — DXX-Rebirth starts at track 1 (hmp.cpp line 710)
	for ( let t = 1; t < hmpFile.tracks.length; t ++ ) {

		const track = hmpFile.tracks[ t ];

		for ( let e = 0; e < track.events.length; e ++ ) {

			const ev = track.events[ e ];
			allEvents.push( {
				time: ev.time * tickDuration,
				status: ev.status,
				type: ev.type,
				channel: ev.channel,
				data1: ev.data1,
				data2: ev.data2
			} );

		}

	}

	// Sort by time
	allEvents.sort( ( a, b ) => a.time - b.time );

	return allEvents;

}

// Return the audible timeline length in seconds.  Track 0 is skipped for
// playback, just as it is by hmp_get_events(), but each played track's final
// end-of-track delta still contributes to the song duration.
export function hmp_get_duration( hmpFile ) {

	if ( hmpFile === null || Number.isFinite( hmpFile.tempo ) !== true ||
		hmpFile.tempo <= 0 ) return 0;

	let endTime = 0;
	for ( let t = 1; t < hmpFile.tracks.length; t ++ ) {

		const trackEndTime = hmpFile.tracks[ t ].endTime;
		if ( Number.isFinite( trackEndTime ) === true && trackEndTime > endTime ) {

			endTime = trackEndTime;

		}

	}

	return endTime / hmpFile.tempo;

}
