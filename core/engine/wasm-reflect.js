// Views of the C engine's records in the WebAssembly module's memory, under
// the records' own field names — which the port keeps the JavaScript engine's
// (`voice.envVolMix`, `inst.sampleLength`, `ts.rowIndex`). A view reads and
// writes the engine's state in place; nothing is copied, and nothing here
// knows what any field means.
//
// The offsets come from core/engine/taud-engine.layout.js, which the build
// writes from the compiler's own record layouts (tools/engine-layout.js), so a
// field added to a C struct is readable here the moment the module is rebuilt.
//
// This is for the page's side and for tests — inspection, the exporters, a
// tool that needs to see inside. The audio thread does not load it.
//
// What a field reads as:
//   a scalar            a number (a `_Bool` a boolean; 64-bit integers as numbers)
//   an inline record    a view of it
//   a pointer to one    a view, or null
//   any other pointer   its address
//   an array of scalars a typed array ON the memory — valid until the memory
//                       grows; take it afresh rather than keep it
//   an array of records an array of views (kept: the records do not move)
//   an array of pointers  an array of views-or-null, built when read
// Multi-dimensional arrays come flat, outermost dimension slowest.
//
// A record has ONE view (ReflectMemory.view): however it is reached, the same
// object comes back, so identity means what it meant between the JavaScript
// engine's objects.

import { ENGINE_LAYOUT } from "./taud-engine.layout.js";

const SCALAR_KINDS = {
  b: { size: 1, array: Uint8Array, get: (dv, o) => dv.getUint8(o) !== 0, set: (dv, o, v) => dv.setUint8(o, v ? 1 : 0) },
  u8: { size: 1, array: Uint8Array, get: (dv, o) => dv.getUint8(o), set: (dv, o, v) => dv.setUint8(o, v) },
  i8: { size: 1, array: Int8Array, get: (dv, o) => dv.getInt8(o), set: (dv, o, v) => dv.setInt8(o, v) },
  u16: { size: 2, array: Uint16Array, get: (dv, o) => dv.getUint16(o, true), set: (dv, o, v) => dv.setUint16(o, v, true) },
  i16: { size: 2, array: Int16Array, get: (dv, o) => dv.getInt16(o, true), set: (dv, o, v) => dv.setInt16(o, v, true) },
  u32: { size: 4, array: Uint32Array, get: (dv, o) => dv.getUint32(o, true), set: (dv, o, v) => dv.setUint32(o, v, true) },
  i32: { size: 4, array: Int32Array, get: (dv, o) => dv.getInt32(o, true), set: (dv, o, v) => dv.setInt32(o, v, true) },
  f32: { size: 4, array: Float32Array, get: (dv, o) => dv.getFloat32(o, true), set: (dv, o, v) => dv.setFloat32(o, v, true) },
  f64: { size: 8, array: Float64Array, get: (dv, o) => dv.getFloat64(o, true), set: (dv, o, v) => dv.setFloat64(o, v, true) },
  i64: {
    size: 8, array: BigInt64Array,
    get: (dv, o) => Number(dv.getBigInt64(o, true)),
    set: (dv, o, v) => dv.setBigInt64(o, BigInt(Math.trunc(v)), true),
  },
  u64: {
    size: 8, array: BigUint64Array,
    get: (dv, o) => Number(dv.getBigUint64(o, true)),
    set: (dv, o, v) => dv.setBigUint64(o, BigInt(Math.trunc(v)), true),
  },
  p: { size: 4, array: Uint32Array, get: (dv, o) => dv.getUint32(o, true), set: (dv, o, v) => dv.setUint32(o, v >>> 0, true) },
};

/**
 * The module's memory as a view layer wants it: a DataView that is taken
 * afresh whenever the memory has grown (the old buffer is detached then).
 */
export class ReflectMemory {
  constructor(memory) {
    this.memory = memory;
    this._dv = null;
    this._views = new Map(); // type → address → view
  }
  get dv() {
    const buf = this.memory.buffer;
    if (this._dv === null || this._dv.buffer !== buf) this._dv = new DataView(buf);
    return this._dv;
  }
  get buffer() { return this.memory.buffer; }

  /**
   * THE view of the `type` record at `ptr`: asked twice, the same object, so
   * two paths to one record (a lane's voice and the operator an FM rack names,
   * a pointer and the inline store it points at) compare equal with ===, as
   * the JavaScript engine's objects did. null for a null pointer.
   */
  view(type, ptr) {
    ptr >>>= 0;
    if (ptr === 0) return null;
    let ofType = this._views.get(type);
    if (ofType === undefined) this._views.set(type, ofType = new Map());
    let v = ofType.get(ptr);
    if (v === undefined) ofType.set(ptr, v = new (viewClass(type))(this, ptr));
    return v;
  }

  /** Make `view` (of a subclass, say) the one `view(type, ptr)` returns. */
  adopt(type, view) {
    let ofType = this._views.get(type);
    if (ofType === undefined) this._views.set(type, ofType = new Map());
    ofType.set(view.$ptr, view);
    return view;
  }
}

/** The base of every record view: `$mem` the memory, `$ptr` where the record is. */
export class StructView {
  constructor(mem, ptr) {
    // Not enumerable: a view's own keys are none, and what it shows of itself
    // (toJSON) is the record's fields.
    Object.defineProperty(this, "$mem", { value: mem });
    Object.defineProperty(this, "$ptr", { value: ptr >>> 0 });
    Object.defineProperty(this, "$kept", { value: null, writable: true }); // arrays of views, made once
  }

  /** The record as plain data — every field by name, records and arrays
   *  through and through, a pointer as its address — so JSON.stringify of a
   *  view says what the record holds, as it did of the JavaScript object. */
  toJSON() {
    const out = {};
    for (const [name, [, kind, dims]] of Object.entries(ENGINE_LAYOUT[this.constructor.typeName].fields)) {
      if (kind.startsWith("p")) {
        const off = ENGINE_LAYOUT[this.constructor.typeName].fields[name][0];
        const n = dims ? dims.reduce((a, b) => a * b, 1) : 1;
        const at = (i) => this.$mem.dv.getUint32(this.$ptr + off + i * 4, true);
        out[name] = dims ? Array.from({ length: n }, (_, i) => at(i)) : at(0);
        continue;
      }
      const v = this[name];
      if (kind.startsWith("s:")) out[name] = dims ? v.map((x) => x.toJSON()) : v.toJSON();
      else out[name] = dims ? Array.from(v, Number) : v;
    }
    return out;
  }
  /** True when `other` views the same record. Two reads of a pointer field
   *  give two view objects; compare them with this, not with ===. */
  is(other) { return other instanceof StructView && other.$ptr === this.$ptr; }
}

/** The address a pointer field is set to from `v`: a view's, a number, or 0. */
function addressOf(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v >>> 0;
  return v.$ptr >>> 0;
}

function keep(view, name, make) {
  const kept = view.$kept ?? (view.$kept = Object.create(null));
  return kept[name] ?? (kept[name] = make());
}

/** How big one element of `kind` is. */
export function sizeOfKind(kind) {
  if (kind.startsWith("s:")) return ENGINE_LAYOUT[kind.slice(2)].size;
  if (kind.startsWith("p")) return 4;
  return SCALAR_KINDS[kind].size;
}

function describeField(name, [off, kind, dims]) {
  const count = dims ? dims.reduce((a, b) => a * b, 1) : 0;
  if (!dims) {
    if (kind.startsWith("s:")) {
      const type = kind.slice(2);
      return {
        get() { return this.$mem.view(type, this.$ptr + off); },
        set(v) {
          if (!(v instanceof StructView) || v.constructor.typeName !== type) {
            throw new TypeError(`${name}: a ${type} record can only be assigned from a ${type} view`);
          }
          const size = ENGINE_LAYOUT[type].size;
          new Uint8Array(this.$mem.buffer).copyWithin(this.$ptr + off, v.$ptr, v.$ptr + size);
        },
      };
    }
    if (kind.startsWith("p:")) {
      const type = kind.slice(2);
      return {
        get() {
          return this.$mem.view(type, this.$mem.dv.getUint32(this.$ptr + off, true));
        },
        set(v) { this.$mem.dv.setUint32(this.$ptr + off, addressOf(v), true); },
      };
    }
    const s = SCALAR_KINDS[kind];
    return {
      get() { return s.get(this.$mem.dv, this.$ptr + off); },
      set(v) { s.set(this.$mem.dv, this.$ptr + off, v); },
    };
  }
  if (kind.startsWith("s:")) {
    const type = kind.slice(2);
    const size = ENGINE_LAYOUT[type].size;
    return {
      get() {
        return keep(this, name, () => {
          const list = new Array(count);
          for (let i = 0; i < count; i++) list[i] = this.$mem.view(type, this.$ptr + off + i * size);
          return recordArray(list);
        });
      },
    };
  }
  if (kind.startsWith("p:")) {
    const type = kind.slice(2);
    return {
      get() {
        const dv = this.$mem.dv;
        const list = new Array(count);
        for (let i = 0; i < count; i++) list[i] = this.$mem.view(type, dv.getUint32(this.$ptr + off + i * 4, true));
        return list;
      },
    };
  }
  const s = SCALAR_KINDS[kind];
  return {
    get() { return new s.array(this.$mem.buffer, this.$ptr + off, count); },
    set(v) { new s.array(this.$mem.buffer, this.$ptr + off, count).set(v); },
  };
}

/** Copy the fields `from` has (a plain object, or another view) into the
 *  record `view` shows — what assigning an object into a slot of an array of
 *  records means here, where the JavaScript engine replaced the object. */
export function assignRecord(view, from) {
  if (from === view) return;
  const fields = ENGINE_LAYOUT[view.constructor.typeName].fields;
  for (const name of Object.keys(fields)) {
    const v = from[name];
    if (v === undefined) continue;
    const [, kind, dims] = fields[name];
    if (kind.startsWith("s:")) {
      if (dims) { const dst = view[name]; for (let i = 0; i < dst.length && i < v.length; i++) assignRecord(dst[i], v[i]); }
      else assignRecord(view[name], v);
    } else {
      view[name] = v;
    }
  }
}

/** An array of record views that cannot be re-seated: `list[i] = obj` copies
 *  obj's fields into record i (the records are where they are). */
function recordArray(list) {
  return new Proxy(list, {
    set(target, key, value) {
      if (typeof key === "string" && /^\d+$/.test(key) && +key < target.length) {
        assignRecord(target[+key], value);
        return true;
      }
      return false;
    },
    deleteProperty() { return false; },
  });
}

/**
 * Define an accessor on `proto` for every field of record `type`. An object
 * using them needs `$mem`, `$ptr` and `$kept` (StructView has them). With
 * `keepExisting`, a name `proto` (or its chain) already answers is left
 * alone — so a class can give some fields a meaning of its own.
 */
export function defineStructFields(proto, type, { keepExisting = false } = {}) {
  const rec = ENGINE_LAYOUT[type];
  if (!rec) throw new Error(`no layout for ${type}`);
  for (const [name, field] of Object.entries(rec.fields)) {
    if (keepExisting && name in proto) continue;
    Object.defineProperty(proto, name, { ...describeField(name, field), enumerable: true, configurable: true });
  }
}

const viewClasses = new Map();

/** The view class of record `type` (made once). */
export function viewClass(type) {
  let C = viewClasses.get(type);
  if (C) return C;
  if (!ENGINE_LAYOUT[type]) throw new Error(`no layout for ${type}`);
  C = class extends StructView {};
  Object.defineProperty(C, "name", { value: `${type.replace(/\W/g, "_")}View` });
  C.typeName = type;
  C.byteSize = ENGINE_LAYOUT[type].size;
  viewClasses.set(type, C); // before its fields: a record may point at its own kind
  defineStructFields(C.prototype, type);
  return C;
}

/** The view of the `type` record at `ptr`, or null for a null pointer. */
export function structView(mem, type, ptr) { return mem.view(type, ptr); }

/** Give record `type`'s view extra properties — the names the JavaScript
 *  object had that the C record spells differently. */
export function extendView(type, descriptors) {
  Object.defineProperties(viewClass(type).prototype, descriptors);
}

/** Where field `name` of `type` is, and how big the record is. */
export function fieldOffset(type, name) { return ENGINE_LAYOUT[type].fields[name][0]; }
export function recordSize(type) { return ENGINE_LAYOUT[type].size; }
