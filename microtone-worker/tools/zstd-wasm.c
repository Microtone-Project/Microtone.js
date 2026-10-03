/* The whole C surface of core/vendor/zstd-compress.wasm.js: upstream zstd's
 * compressor — one-shot, and streamed in steps for a save that shows its
 * progress — and the allocator the JavaScript side needs to hand it buffers.
 * Compiled together with zstd's lib/common and lib/compress by
 * tools/make-zstd-wasm.js — nothing else of zstd's is linked, so the module
 * cannot decompress (fzstd does that, synchronously, on every load path).
 *
 * The context is kept between calls: its workspace is sized by the largest
 * level asked for and reused after, so a run of saves does not re-allocate it.
 * WebAssembly memory never shrinks, so freeing it would not give anything back
 * anyway — dropping the whole instance does (core/format/zstd.js).
 *
 * Both write the content size into the frame header and no checksum, and the
 * same bytes for the same input and level. They are not the SAME bytes as each
 * other: a streamed frame's blocks end where its steps do, where the one-shot
 * encoder, seeing the whole input, sometimes splits them elsewhere — at level
 * 19, under a tenth of a percent either way. mt_compress matches native one-shot
 * libzstd (Python's zstandard.compress()), the stream matches its streaming
 * encoder with the size pledged (zstandard's compressobj(size=…)) fed the same
 * steps and ended by an empty one. */

#include <stdlib.h>
#include "zstd.h"

#define EXPORT(name) __attribute__((export_name(name)))

static ZSTD_CCtx *cctx = NULL;

EXPORT("mt_alloc") void *mt_alloc(size_t size) { return malloc(size ? size : 1); }

EXPORT("mt_free") void mt_free(void *p) { free(p); }

EXPORT("mt_bound") size_t mt_bound(size_t srcSize) { return ZSTD_compressBound(srcSize); }

EXPORT("mt_is_error") unsigned mt_is_error(size_t code) { return ZSTD_isError(code); }

EXPORT("mt_version") unsigned mt_version(void) { return ZSTD_versionNumber(); }

/** Compressed size, or an error code (test with mt_is_error). */
EXPORT("mt_compress")
size_t mt_compress(void *dst, size_t dstCapacity, const void *src, size_t srcSize, int level)
{
    if (cctx == NULL) cctx = ZSTD_createCCtx();
    if (cctx == NULL) return (size_t)-ZSTD_error_memory_allocation;
    return ZSTD_compressCCtx(cctx, dst, dstCapacity, src, srcSize, level);
}

/* ── streamed: mt_stream_begin, then mt_stream_feed until `last` ── */

static ZSTD_outBuffer out;

/** Start a frame of exactly `srcSize` bytes into `dst`, which must hold
 *  mt_bound(srcSize) — so no step ever waits for room. 0, or an error code. */
EXPORT("mt_stream_begin")
size_t mt_stream_begin(void *dst, size_t dstCapacity, size_t srcSize, int level)
{
    size_t r;
    if (cctx == NULL) cctx = ZSTD_createCCtx();
    if (cctx == NULL) return (size_t)-ZSTD_error_memory_allocation;
    r = ZSTD_CCtx_reset(cctx, ZSTD_reset_session_and_parameters);
    if (!ZSTD_isError(r)) r = ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level);
    if (!ZSTD_isError(r)) r = ZSTD_CCtx_setPledgedSrcSize(cctx, srcSize);
    out.dst = dst;
    out.size = dstCapacity;
    out.pos = 0;
    return ZSTD_isError(r) ? r : 0;
}

/** Compress the next `size` bytes (zstd copies them; the buffer may be reused),
 *  ending the frame when `last` is set. The frame's length so far, or an error. */
EXPORT("mt_stream_feed")
size_t mt_stream_feed(const void *src, size_t size, int last)
{
    ZSTD_inBuffer in = { src, size, 0 };
    ZSTD_EndDirective const op = last ? ZSTD_e_end : ZSTD_e_continue;
    for (;;) {
        size_t const r = ZSTD_compressStream2(cctx, &out, &in, op);
        if (ZSTD_isError(r)) return r;
        if (last ? r == 0 : in.pos == in.size) return out.pos;
        if (out.pos == out.size) return (size_t)-ZSTD_error_dstSize_tooSmall;
    }
}
