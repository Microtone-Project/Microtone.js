// Run anything that imports core/engine/engine.js on the JavaScript engine
// instead (core/engine/engine-js.js — what engine.js was before the C engine
// built as WebAssembly took the name):
//
//   node --import ./tools/use-js-engine.mjs --test            (from microtone-worker/)
//
// While the JavaScript engine is kept as the reference, this is how the test
// suite is held against it: whatever fails under this flag and passes without
// it is a place the two engines disagree (or a test that reads a shape only
// the C engine's views have). It goes when engine-js.js does.
import { registerHooks } from "node:module";
import { resolve } from "./use-js-engine-hooks.mjs";

registerHooks({ resolve });
