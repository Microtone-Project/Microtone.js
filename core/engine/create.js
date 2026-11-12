// Which engine a host runs. The C engine built as WebAssembly is THE engine;
// the JavaScript one it was ported from is kept, for now, as the reference it
// is tested against and as a way back while the port is young (`?engine=js`
// on either app, core/audio/audio-system.js).

import { TaudEngine } from "./engine.js";
import { WasmTaudEngine } from "./wasm-engine.js";

export const ENGINE_WASM = "wasm";
export const ENGINE_JS = "js";

/** A new engine of `kind` (ENGINE_WASM unless ENGINE_JS is asked for). */
export function createEngine(kind = ENGINE_WASM) {
  return kind === ENGINE_JS ? new TaudEngine() : new WasmTaudEngine();
}
