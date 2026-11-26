// MIDI ports for the control surface (item 379): one input and one output,
// from whichever of two places has them.
//
//   - A browser: Web MIDI (`navigator.requestMIDIAccess`). Chromium asks the
//     person once; Firefox installs a site permission first; Safari has none.
//   - The Qt desktop app: QtWebEngine has Web MIDI compiled in and refuses
//     every request (it has no MIDI permission to grant), so the shell opens
//     the ports itself with RtMidi and hands them over a WebSocket of its own
//     (`__MICROTONE_NATIVE__.midi`, desktop-qt/src/nativemidi.cpp):
//       page → shell  text  {"open": {"input": name|null, "output": name|null}}
//                     binary one whole MIDI message, for the open output
//       shell → page  text  {"ports": {"inputs": [...], "outputs": [...]},
//                            "open": {"input", "output"}, "error"?}
//                     binary one whole MIDI message from the open input
//
// Ports are named, not numbered: a name is what survives a replug and a
// restart, so it is what the app remembers. Both sides give whole messages,
// SysEx included, so no running status or reassembly is needed here.

const NATIVE = globalThis.__MICROTONE_NATIVE__?.midi ?? null;

/** Can this page reach MIDI at all? */
export function midiAvailable() {
  return typeof NATIVE === "string" || typeof globalThis.navigator?.requestMIDIAccess === "function";
}

/** Is the person going to be asked? (A browser asks; the desktop does not.) */
export function midiAsks() { return typeof NATIVE !== "string"; }

/**
 * Has a browser already been given MIDI with SysEx? Lets a reload reconnect
 * without a prompt appearing out of nowhere. False where it cannot say.
 */
export async function midiGranted() {
  if (typeof NATIVE === "string") return true;
  try {
    const st = await navigator.permissions.query({ name: "midi", sysex: true });
    return st.state === "granted";
  } catch {
    return false;
  }
}

/**
 * The ports and the one open pair. `onMessage(bytes)` hears the open input;
 * `onChange()` fires when the lists or the open pair change (a device plugged
 * in or out). `sysex` says whether SysEx may be sent (the scribble strip).
 */
export class MidiPorts {
  constructor() {
    this.onMessage = null;
    this.onChange = null;
    this.sysex = false;
    this.inputName = null;
    this.outputName = null;
    this._access = null; // Web MIDI
    this._in = null;
    this._out = null;
    this._ws = null;     // the desktop's
    this._lists = { inputs: [], outputs: [] };
    this._want = { input: null, output: null };
    this._closed = false;
  }

  /** Get access (the browser may ask the person). Throws when refused. */
  async start() {
    if (typeof NATIVE === "string") return this._startNative();
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch (err) {
      // Refused SysEx alone still leaves the buttons, the lamps and the
      // faders; only the scribble strip needs it.
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this.sysex = false;
      if (!this._access) throw err;
    }
    this._access.onstatechange = () => this._webChanged();
    this._webChanged();
  }

  _startNative() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(NATIVE);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.ports) this._lists = { inputs: msg.ports.inputs ?? [], outputs: msg.ports.outputs ?? [] };
          if (msg.open) {
            this.inputName = msg.open.input ?? null;
            this.outputName = msg.open.output ?? null;
          }
          if (!settled) { settled = true; resolve(); }
          this.onChange?.();
        } else {
          this.onMessage?.(new Uint8Array(e.data));
        }
      };
      ws.onopen = () => { this._ws = ws; this.sysex = true; };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error("the desktop's MIDI is not answering")); } };
      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
        this.inputName = this.outputName = null;
        if (!settled) { settled = true; reject(new Error("the desktop's MIDI is not answering")); }
        this.onChange?.();
      };
    });
  }

  /** Port names, each list in the system's order. */
  inputs() { return this._lists.inputs.slice(); }
  outputs() { return this._lists.outputs.slice(); }

  /** Open the input and output named (null: none). Kept as the WISH: a port
   *  that is not there now is opened when it turns up. */
  open(input, output) {
    this._want = { input: input || null, output: output || null };
    if (this._ws) {
      this._ws.send(JSON.stringify({ open: this._want }));
      return;
    }
    this._bindWeb();
    this.onChange?.();
  }

  /** Send one message to the open output (dropped when there is none, and a
   *  SysEx dropped where it was not allowed). */
  send(bytes) {
    if (bytes[0] === 0xf0 && !this.sysex) return;
    if (this._ws) {
      if (this.outputName) this._ws.send(Uint8Array.from(bytes));
      return;
    }
    try { this._out?.send(bytes); } catch { /* the port went as we wrote */ }
  }

  /** Tell the desktop's shell that everything sent before this is the last
   *  word: it waits for it before it quits (nativemidi.cpp `whenFlushed`).
   *  Web MIDI needs no such thing — a closing tab sends what it was given. */
  flush() {
    if (this._ws) this._ws.send(JSON.stringify({ flush: true }));
  }

  get connected() { return this.inputName !== null || this.outputName !== null; }

  close() {
    this._closed = true;
    this._want = { input: null, output: null };
    if (this._ws) { try { this._ws.close(); } catch { /* gone */ } this._ws = null; }
    if (this._in) this._in.onmidimessage = null;
    if (this._access) this._access.onstatechange = null;
    this._in = this._out = null;
    this.inputName = this.outputName = null;
  }

  // ── Web MIDI ──

  _webChanged() {
    if (!this._access || this._closed) return;
    const names = (map) => [...map.values()].filter((p) => p.state !== "disconnected").map((p) => p.name);
    this._lists = { inputs: names(this._access.inputs), outputs: names(this._access.outputs) };
    this._bindWeb();
    this.onChange?.();
  }

  _bindWeb() {
    if (!this._access) return;
    const find = (map, name) => name === null ? null
      : [...map.values()].find((p) => p.name === name && p.state !== "disconnected") ?? null;
    const inp = find(this._access.inputs, this._want.input);
    const out = find(this._access.outputs, this._want.output);
    if (inp !== this._in) {
      if (this._in) this._in.onmidimessage = null;
      this._in = inp;
      if (inp) inp.onmidimessage = (e) => this.onMessage?.(e.data);
    }
    this._out = out;
    this.inputName = inp?.name ?? null;
    this.outputName = out?.name ?? null;
  }
}

/**
 * The output that goes with an input: the same name, or failing that the
 * one whose name shares the longest start with it ("X-Touch One MIDI 1" in
 * and out), else null.
 */
export function partnerOutput(input, outputs) {
  if (!input) return null;
  if (outputs.includes(input)) return input;
  let best = null, bestLen = 3; // at least a few characters in common
  for (const o of outputs) {
    let n = 0;
    while (n < o.length && n < input.length && o[n] === input[n]) n++;
    if (n > bestLen) { best = o; bestLen = n; }
  }
  return best;
}

/** Does a port's name look like a Mackie Control surface? Used to offer it
 *  first; any port can be chosen. */
export function looksLikeSurface(name) {
  return /x-?touch|mackie|\bmcu\b|logic control|qcon|platform m|faderport|behringer|icon p1|v1-m|ssl uf/i.test(name ?? "");
}
