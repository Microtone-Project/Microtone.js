// The Taud engine as WebAssembly: this module turns the committed, base64'd
// build (taud-engine.wasm.js, written by tools/make-engine-wasm.js from
// core/engine/c/) into WebAssembly instances.
//
// It runs wherever the engine does — a page, a Worker, an AudioWorklet, Node —
// so it uses nothing but the language and WebAssembly itself: no fetch, no
// atob (an AudioWorkletGlobalScope has neither). The module imports nothing,
// so instantiating it needs no import object and cannot fail on a missing
// host function.
//
// ONE WebAssembly.Module is compiled per realm and shared; each engine gets an
// INSTANCE of its own (instantiateEngine), hence a linear memory of its own.
// That is deliberate: WebAssembly memory never shrinks, so an engine's samples
// are given back the only way they can be — by dropping the instance. An
// offline render's engine goes when the render does.

import { ENGINE_WASM_BASE64 } from "./taud-engine.wasm.js";

// (Top-level names here are long on purpose: the worklet bundle concatenates
// every module into one scope.)
const ENGINE_B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 → bytes, without atob. */
export function decodeBase64(text) {
  const lut = new Uint8Array(128);
  for (let i = 0; i < 64; i++) lut[ENGINE_B64_ALPHABET.charCodeAt(i)] = i;
  let len = text.length;
  while (len > 0 && text.charCodeAt(len - 1) === 61) len--; // '='
  const out = new Uint8Array((len * 3) >>> 2);
  let o = 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const v = (lut[text.charCodeAt(i)] << 18) | (lut[text.charCodeAt(i + 1)] << 12) |
      (lut[text.charCodeAt(i + 2)] << 6) | lut[text.charCodeAt(i + 3)];
    out[o++] = v >>> 16;
    out[o++] = (v >>> 8) & 0xff;
    out[o++] = v & 0xff;
  }
  const rest = len - i;
  if (rest >= 2) {
    const v = (lut[text.charCodeAt(i)] << 18) | (lut[text.charCodeAt(i + 1)] << 12) |
      (rest === 3 ? lut[text.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = v >>> 16;
    if (rest === 3) out[o++] = (v >>> 8) & 0xff;
  }
  return out;
}

let engineBytesCache = null;
let engineCompiled = null;

/** The module's bytes (decoded once). */
export function engineWasmBytes() {
  if (engineBytesCache === null) engineBytesCache = decodeBase64(ENGINE_WASM_BASE64);
  return engineBytesCache;
}

/**
 * The compiled module, compiling it on the calling thread if nobody has yet.
 * Fine in a Worker, a worklet and Node; a PAGE should call prepareEngineModule
 * first — browsers may refuse a synchronous compile of this size on the main
 * thread, and it would block it for a few milliseconds besides.
 */
export function engineModule() {
  if (engineCompiled === null) engineCompiled = new WebAssembly.Module(engineWasmBytes());
  return engineCompiled;
}

/** Compile off the calling thread; afterwards engineModule() is immediate. */
export async function prepareEngineModule() {
  if (engineCompiled === null) {
    const m = await WebAssembly.compile(engineWasmBytes());
    if (engineCompiled === null) engineCompiled = m;
  }
  return engineCompiled;
}

/** Adopt a module compiled elsewhere (posted from the page to a worklet, say). */
export function adoptEngineModule(module) {
  if (engineCompiled === null) engineCompiled = module;
}

/** A fresh instance — its own memory, its own heap — ready to call. */
export function instantiateEngine() {
  const instance = new WebAssembly.Instance(engineModule(), {});
  instance.exports._initialize();
  return instance.exports;
}
