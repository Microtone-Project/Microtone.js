/* The native audio host's engine side, in C: what the web build's render
 * Worker does with the engine (core/audio/render.worker.js) and its command
 * dispatcher (core/worklet/engine-commands.js), over the same tw_* host API
 * (core/engine/c/src/wasm_api.c, compiled natively).
 *
 * A command arrives as the page lowered it (core/audio/native-engine.js): the
 * name of a CMD, then integers, doubles and byte blobs that are already the
 * C arguments. Everything here runs under the caller's engine lock; nothing
 * here knows about threads, sockets or devices (nativeaudio.cpp does). */
#ifndef MICROTONE_ENGINEHOST_H
#define MICROTONE_ENGINEHOST_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MtHost MtHost;

typedef struct MtCommand {
    const char *name;
    int nameLen;
    const int32_t *ints;   /* not aligned: read with memcpy */
    int nInts;
    const double *doubles; /* not aligned: read with memcpy */
    int nDoubles;
    const uint8_t *blob[4];
    uint32_t blobLen[4];
    int nBlobs;
} MtCommand;

enum {
    MT_UNKNOWN = -1,  /* not a command this host knows */
    MT_IGNORED = 0,   /* no engine yet, or nothing to do */
    MT_APPLIED = 1,   /* the engine changed: a snapshot should follow */
    MT_REPLIED = 2    /* a reply was written (malloc'd; the caller frees it) */
};

/** A host whose engines run at `rate`. */
MtHost *mt_host_new(int rate);
void mt_host_free(MtHost *h);
int mt_host_rate(const MtHost *h);
int mt_host_has_engine(const MtHost *h);
int mt_host_snapshot_interval_ms(const MtHost *h);

/** Apply one command. INIT builds a fresh engine (a reloaded page starts
 *  clean, as a new render Worker would). */
int mt_host_apply(MtHost *h, const MtCommand *c, uint8_t **reply, size_t *replyLen);

/** Playing or auditioning: the only time the engine is rendered. */
int mt_host_active(const MtHost *h);

/** Render `frames` (any number) as interleaved stereo float into `out`, in
 *  spans of at most a chunk; zeros once the song halts. Returns 1 when the
 *  engine rendered, 0 for silence (not active, or no engine). */
int mt_host_render(MtHost *h, float *out, int frames);

/** Voices sounding now (a profiler's reading). */
int mt_host_sounding_voices(const MtHost *h);

/** The snapshot the page draws from, written into `out` (SNAP_FLOATS floats)
 *  as engine-commands.js fillSnapshotInto writes it: a meter that is off
 *  leaves its block alone. `*analysisOn` / `*meterOn` say which blocks are
 *  current. The interrupt latch is drained separately. */
void mt_host_fill_snapshot(MtHost *h, float *out, int *analysisOn, int *meterOn);

/** Drain the interrupt latch: the mask, and each fired interrupt's argument
 *  into args[n]. */
uint32_t mt_host_drain_interrupts(MtHost *h, int32_t args[16]);

/** Snapshot layout figures the C++ side needs (from snap_layout.h). */
int mt_snap_floats(void);
typedef struct MtSnapLayout {
    int floats, interruptMask, interruptArgs, headerSize, meterBase, mmBase,
        imBase, imStride, imSeats, imSlot, epBase, epEntries, epStride, epCount,
        lsLanes, lsData, lsFrames;
} MtSnapLayout;
void mt_snap_layout(MtSnapLayout *out);

#ifdef __cplusplus
}
#endif

#endif
