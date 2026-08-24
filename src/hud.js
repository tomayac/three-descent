// Ported from: descent-master/MAIN/HUD.C
// HUD message display system

// --- HUD messages ---

const MAX_HUD_MESSAGES = 4;
const NEW_MESSAGE_TIME = 3.0;	// HUD_init_message() sets F1_0*3
const OLD_MESSAGE_TIME = 2.0;	// HUD_render_message_frame() shifts every F1_0*2
const _messages = [];
let _messageTimer = 0;

const COCKPIT_W = 320;
const COCKPIT_H = 200;
const CM_STATUS_BAR = 2;
const STATUSBAR_MESSAGE_Y = COCKPIT_H - 49;	// Rendered just above the status bar strip

export function hud_show_message( msg ) {

	if ( typeof msg !== 'string' || msg === '' ) return;

	const last = _messages.length > 0 ? _messages[ _messages.length - 1 ] : null;
	if ( last !== null && last === msg ) {

		_messageTimer = NEW_MESSAGE_TIME;
		return;

	}

	_messages.push( msg );
	_messageTimer = NEW_MESSAGE_TIME;

	if ( _messages.length > MAX_HUD_MESSAGES ) {

		_messages.shift();

	}

}

// Update message timers (call every frame, regardless of dirty state)
export function hud_update_timers( dt ) {

	if ( _messages.length <= 0 ) return;

	_messageTimer -= dt;
	if ( _messageTimer > 0 ) return;

	_messages.shift();

	if ( _messages.length > 0 ) {

		_messageTimer = OLD_MESSAGE_TIME;

	} else {

		_messageTimer = 0;

	}

}

// Check if any HUD messages are active
export function hud_has_messages() {

	return _messages.length > 0;

}

export function hud_draw_messages( ctx, cockpitMode ) {

	if ( _messages.length === 0 ) return;

	ctx.font = '7px monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#00cc00';

	if ( cockpitMode === CM_STATUS_BAR ) {

		// Status bar mode shows only the newest message.
		const message = _messages[ _messages.length - 1 ];
		ctx.fillText( message, COCKPIT_W / 2, STATUSBAR_MESSAGE_Y );
		return;

	}

	let y = 3;

	for ( let i = 0; i < _messages.length; i ++ ) {

		ctx.fillText( _messages[ i ], COCKPIT_W / 2, y );
		y += 8;

	}

}
