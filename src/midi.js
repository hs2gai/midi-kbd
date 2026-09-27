// A thin wrapper around the input side of the Web MIDI API only.
// requestMIDIAccess isn't available outside a secure context (https:// or http://localhost).

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const PITCH_BEND = 0xe0;

export function isSupported() {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

/**
 * Connects to MIDI inputs.
 * @param {object} handlers onNoteOn / onNoteOff / onControlChange / onPitchBend / onPorts
 * @returns {Promise<MIDIAccess>}
 */
export async function connectMidi(handlers) {
  if (!isSupported()) {
    throw new Error(
      "このブラウザは Web MIDI API に対応していません（Chrome / Edge / Firefox 108+ が必要。Safari は非対応）。",
    );
  }
  if (!window.isSecureContext) {
    throw new Error("Web MIDI は https:// か http://localhost でしか使えません。");
  }

  const access = await navigator.requestMIDIAccess({ sysex: false });

  const attach = () => {
    const inputs = [...access.inputs.values()];
    for (const input of inputs) input.onmidimessage = (event) => dispatch(event.data, handlers);
    handlers.onPorts?.(inputs.map((i) => ({ id: i.id, name: i.name, state: i.state })));
  };

  access.onstatechange = attach;
  attach();
  return access;
}

function dispatch(data, handlers) {
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;

  switch (status) {
    case NOTE_ON:
      // A Note On with velocity 0 means Note Off (many keyboards send this)
      if (data[2] > 0) handlers.onNoteOn?.(data[1], data[2], channel);
      else handlers.onNoteOff?.(data[1], channel);
      break;
    case NOTE_OFF:
      handlers.onNoteOff?.(data[1], channel);
      break;
    case CONTROL_CHANGE:
      handlers.onControlChange?.(data[1], data[2], channel);
      break;
    case PITCH_BEND:
      handlers.onPitchBend?.(((data[2] << 7) | data[1]) - 8192, channel);
      break;
  }
}
