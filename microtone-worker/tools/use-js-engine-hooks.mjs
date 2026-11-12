// The resolve hook tools/use-js-engine.mjs installs: core/engine/engine.js
// resolves to core/engine/engine-js.js, whoever imports it.
export function resolve(specifier, context, nextResolve) {
  const r = nextResolve(specifier, context);
  if (r.url.endsWith("/core/engine/engine.js")) {
    return { ...r, url: r.url.replace(/engine\.js$/, "engine-js.js") };
  }
  return r;
}
