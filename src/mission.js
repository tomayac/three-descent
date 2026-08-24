// Ported from: descent-master/MAIN/MISSION.C
// Mission metadata and level routing (builtin defaults + .MSN parsing)

const MAX_LEVELS_PER_MISSION = 30;
const MAX_SECRET_LEVELS_PER_MISSION = 5;

const BUILTIN_SECRET_TABLE = [ 10, 21, 24 ];

let _missionFilename = '';
let _missionLongname = 'Descent';
let _lastLevel = 7;
let _lastSecretLevel = 0; // 0 = no secret levels, else negative count

let _briefingFilename = 'briefing.tex';
let _endingFilename = 'ending.tex';

const _levelNames = new Array( MAX_LEVELS_PER_MISSION ).fill( '' );
const _secretLevelNames = new Array( MAX_SECRET_LEVELS_PER_MISSION ).fill( '' );
const _secretLevelTable = new Int16Array( MAX_SECRET_LEVELS_PER_MISSION );

function clear_level_arrays() {

	for ( let i = 0; i < MAX_LEVELS_PER_MISSION; i ++ ) _levelNames[ i ] = '';
	for ( let i = 0; i < MAX_SECRET_LEVELS_PER_MISSION; i ++ ) {

		_secretLevelNames[ i ] = '';
		_secretLevelTable[ i ] = 0;

	}

}

function add_term( s ) {

	const trimmed = s.trim();
	if ( trimmed.length <= 0 ) return '';
	const parts = trimmed.split( /\s+/ );
	return parts[ 0 ].trim();

}

function parse_value( line ) {

	const eq = line.indexOf( '=' );
	if ( eq < 0 ) return null;

	const val = line.substring( eq + 1 ).trim();
	if ( val.length <= 0 ) return null;
	return val;

}

function strip_comments( line ) {

	const semi = line.indexOf( ';' );
	if ( semi >= 0 ) return line.substring( 0, semi );
	return line;

}

function normalize_filename( name ) {

	return name.trim().toLowerCase();

}

function cfile_to_string( cfile ) {

	const bytes = cfile.readBytes( cfile.length() );
	let text = '';
	for ( let i = 0; i < bytes.length; i ++ ) {

		text += String.fromCharCode( bytes[ i ] );

	}

	return text;

}

function detect_builtin_extension( hogFile, isShareware ) {

	if ( isShareware === true ) {

		if ( hogFile.findFile( 'level01.sdl' ) !== null ) return 'sdl';
		if ( hogFile.findFile( 'level01.rdl' ) !== null ) return 'rdl';
		return 'sdl';

	}

	if ( hogFile.findFile( 'level01.rdl' ) !== null ) return 'rdl';
	if ( hogFile.findFile( 'level01.sdl' ) !== null ) return 'sdl';
	return 'rdl';

}

function count_sequential_levels( hogFile, ext ) {

	let count = 0;

	for ( let i = 1; i <= MAX_LEVELS_PER_MISSION; i ++ ) {

		const num = i < 10 ? '0' + i : '' + i;
		const name = 'level' + num + '.' + ext;

		if ( hogFile.findFile( name ) !== null ) {

			count ++;

		} else {

			break;

		}

	}

	return count;

}

function count_sequential_secret_levels( hogFile, ext ) {

	let count = 0;

	for ( let i = 1; i <= MAX_SECRET_LEVELS_PER_MISSION; i ++ ) {

		const name = 'levels' + i + '.' + ext;
		if ( hogFile.findFile( name ) !== null ) {

			count ++;

		} else {

			break;

		}

	}

	return count;

}

function load_builtin_mission( hogFile, isShareware ) {

	clear_level_arrays();

	_missionFilename = '';
	_missionLongname = 'Descent';

	const ext = detect_builtin_extension( hogFile, isShareware );
	let levelCount = count_sequential_levels( hogFile, ext );

	if ( levelCount <= 0 ) {

		levelCount = isShareware === true ? 7 : 27;

	}

	for ( let i = 0; i < levelCount; i ++ ) {

		const n = i + 1;
		const num = n < 10 ? '0' + n : '' + n;
		_levelNames[ i ] = 'level' + num + '.' + ext;

	}

	_lastLevel = levelCount;
	_briefingFilename = 'briefing.tex';
	_endingFilename = isShareware === true ? 'ending.tex' : 'endreg.tex';

	if ( isShareware === true ) {

		_lastSecretLevel = 0;
		return;

	}

	const secretFileCount = count_sequential_secret_levels( hogFile, ext );
	let validSecretCount = 0;

	for ( let i = 0; i < MAX_SECRET_LEVELS_PER_MISSION; i ++ ) {

		if ( i >= secretFileCount ) break;
		if ( i >= BUILTIN_SECRET_TABLE.length ) break;

		const fromLevel = BUILTIN_SECRET_TABLE[ i ];
		if ( fromLevel < 1 || fromLevel > _lastLevel ) continue;

		_secretLevelNames[ validSecretCount ] = 'levels' + ( i + 1 ) + '.' + ext;
		_secretLevelTable[ validSecretCount ] = fromLevel;
		validSecretCount ++;

	}

	_lastSecretLevel = - validSecretCount;

}

function parse_mission_text( text, missionBaseName ) {

	const localLevelNames = new Array( MAX_LEVELS_PER_MISSION ).fill( '' );
	const localSecretNames = new Array( MAX_SECRET_LEVELS_PER_MISSION ).fill( '' );
	const localSecretTable = new Int16Array( MAX_SECRET_LEVELS_PER_MISSION );

	let localMissionName = missionBaseName;
	let localBriefing = '';
	let localEnding = '';
	let localLevelCount = 0;
	let localSecretCount = 0;

	const lines = text.replaceAll( '\r', '' ).split( '\n' );

	for ( let i = 0; i < lines.length; i ++ ) {

		const src = strip_comments( lines[ i ] ).trim();
		if ( src.length <= 0 ) continue;

		const lower = src.toLowerCase();

		if ( lower.startsWith( 'name' ) ) {

			const value = parse_value( src );
			if ( value !== null ) localMissionName = value.trim();
			continue;

		}

		if ( lower.startsWith( 'briefing' ) ) {

			const value = parse_value( src );
			if ( value !== null ) localBriefing = normalize_filename( add_term( value ) );
			continue;

		}

		if ( lower.startsWith( 'ending' ) ) {

			const value = parse_value( src );
			if ( value !== null ) localEnding = normalize_filename( add_term( value ) );
			continue;

		}

		if ( lower.startsWith( 'num_levels' ) ) {

			const value = parse_value( src );
			if ( value === null ) continue;

			const count = Math.max( 0, Math.min( MAX_LEVELS_PER_MISSION, Number.parseInt( value ) ) );

			localLevelCount = 0;

			for ( let j = 0; j < count; j ++ ) {

				i ++;
				if ( i >= lines.length ) break;

				const levelLine = normalize_filename( add_term( strip_comments( lines[ i ] ) ) );
				if ( levelLine.length <= 0 || levelLine.length > 12 ) break;

				localLevelNames[ localLevelCount ] = levelLine;
				localLevelCount ++;

			}

			continue;

		}

		if ( lower.startsWith( 'num_secrets' ) ) {

			const value = parse_value( src );
			if ( value === null ) continue;

			const count = Math.max( 0, Math.min( MAX_SECRET_LEVELS_PER_MISSION, Number.parseInt( value ) ) );
			localSecretCount = 0;

			for ( let j = 0; j < count; j ++ ) {

				i ++;
				if ( i >= lines.length ) break;

				const row = strip_comments( lines[ i ] ).trim();
				if ( row.length <= 0 ) break;

				const comma = row.indexOf( ',' );
				if ( comma < 0 ) break;

				const file = normalize_filename( add_term( row.substring( 0, comma ) ) );
				const fromLevel = Number.parseInt( row.substring( comma + 1 ) );

				if ( file.length <= 0 || file.length > 12 ) break;
				if ( Number.isFinite( fromLevel ) !== true ) break;
				if ( fromLevel < 1 || fromLevel > localLevelCount ) break;

				localSecretNames[ localSecretCount ] = file;
				localSecretTable[ localSecretCount ] = fromLevel;
				localSecretCount ++;

			}

			continue;

		}

	}

	if ( localLevelCount <= 0 ) return false;

	clear_level_arrays();

	_missionFilename = missionBaseName.toLowerCase();
	_missionLongname = localMissionName;
	_lastLevel = localLevelCount;
	_lastSecretLevel = - localSecretCount;

	for ( let i = 0; i < localLevelCount; i ++ ) _levelNames[ i ] = localLevelNames[ i ];
	for ( let i = 0; i < localSecretCount; i ++ ) {

		_secretLevelNames[ i ] = localSecretNames[ i ];
		_secretLevelTable[ i ] = localSecretTable[ i ];

	}

	_briefingFilename = localBriefing.length > 0 ? localBriefing : 'briefing.tex';
	_endingFilename = localEnding.length > 0 ? localEnding : 'ending.tex';

	return true;

}

function try_load_mission_from_hog( hogFile ) {

	const names = hogFile.listFiles().filter( name => name.toUpperCase().endsWith( '.MSN' ) );
	if ( names.length <= 0 ) return false;

	names.sort();

	let preferredIndex = names.findIndex( name => name.toLowerCase() === 'descent.msn' );
	if ( preferredIndex < 0 ) preferredIndex = 0;

	for ( let i = 0; i < names.length; i ++ ) {

		const index = ( i === 0 ) ? preferredIndex : ( i <= preferredIndex ? i - 1 : i );
		const missionName = names[ index ];
		if ( missionName === undefined ) continue;

		const cfile = hogFile.findFile( missionName );
		if ( cfile === null ) continue;

		const missionBase = missionName.substring( 0, missionName.lastIndexOf( '.' ) );
		const text = cfile_to_string( cfile );
		if ( parse_mission_text( text, missionBase ) === true ) return true;

	}

	return false;

}

export function mission_init( hogFile, isShareware ) {

	if ( hogFile === null || hogFile === undefined ) return false;

	load_builtin_mission( hogFile, isShareware === true );

	const parsed = try_load_mission_from_hog( hogFile );

	console.log(
		'MISSION: ' + _missionLongname +
		' levels=' + _lastLevel +
		' secrets=' + ( - _lastSecretLevel ) +
		' briefing=' + _briefingFilename +
		' ending=' + _endingFilename +
		(parsed === true ? ' (from .msn)' : ' (builtin)')
	);

	return true;

}

export function mission_get_last_level() { return _lastLevel; }
export function mission_get_last_secret_level() { return _lastSecretLevel; }
export function mission_get_briefing_filename() { return _briefingFilename; }
export function mission_get_ending_filename() { return _endingFilename; }
export function mission_get_name() { return _missionLongname; }
export function mission_get_filename() { return _missionFilename; }

export function mission_get_level_name( levelNum ) {

	if ( levelNum === 0 ) return '';

	if ( levelNum < 0 ) {

		const idx = ( - levelNum ) - 1;
		if ( idx < 0 || idx >= - _lastSecretLevel ) return '';
		return _secretLevelNames[ idx ];

	}

	const idx = levelNum - 1;
	if ( idx < 0 || idx >= _lastLevel ) return '';
	return _levelNames[ idx ];

}

export function mission_is_final_level( levelNum ) {

	return levelNum > 0 && levelNum >= _lastLevel;

}

// Ported from: AdvanceLevel(secret_flag) in GAMESEQ.C
export function mission_compute_next_level( currentLevelNum, secretFlag ) {

	let nextLevelNum = currentLevelNum + 1;

	if ( secretFlag === true ) {

		for ( let i = 0; i < - _lastSecretLevel; i ++ ) {

			if ( _secretLevelTable[ i ] === currentLevelNum ) {

				nextLevelNum = - ( i + 1 );
				break;

			}

		}

	}

	if ( currentLevelNum < 0 ) {

		const idx = ( - currentLevelNum ) - 1;
		if ( idx >= 0 && idx < - _lastSecretLevel ) {

			nextLevelNum = _secretLevelTable[ idx ] + 1;

		} else {

			nextLevelNum = 1;

		}

	}

	return nextLevelNum;

}
