/* The host API — what the tracker (and anything else that UPLOADS a song
 * piece by piece instead of opening a file) drives the engine through. It is
 * the `audio.*` surface of core/engine/engine.js, one function per call, in
 * shapes WebAssembly can carry: integers, doubles and pointers into the
 * module's own memory. core/engine/wasm-engine.js is its JavaScript half.
 *
 * The player library (taudplay.h, player.c) is the other way in: it parses a
 * file and owns the document. Here there is no document, so whatever the
 * engine would have borrowed from one is kept on the engine (ownPool,
 * ownImix, ownLyrics) and freed when it is replaced.
 *
 * Structured parameters — the mastering chain, the instruments' mixing
 * chains, the lyrics — cross as the bytes the FILE holds them in (the `sMst`
 * block, the `IMix` and `ILyr` sections), read by the very parsers a file is
 * read with. One codec per structure instead of two, and a chain that is
 * being edited sounds exactly as it will once saved.
 *
 * Every function takes the engine first. Buffers are the caller's unless a
 * comment says the engine adopts them; the caller allocates with the module's
 * malloc and frees what it still owns. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* ── lifetime ── */

TW_EXPORT(tw_new)
TaudEngine *tw_new(int rate) { return te_engine_new(rate > 0 ? rate : 48000); }

TW_EXPORT(tw_free)
void tw_free(TaudEngine *e) { te_engine_free(e); }

/** Seed the engine's own uniform source (mulberry32; rng.js makeSeededRandom).
 *  It is the only source a host can have: the module imports nothing. */
TW_EXPORT(tw_seed)
void tw_seed(TaudEngine *e, uint32_t seed)
{
    e->random = NULL;
    e->randomUser = NULL;
    e->mulberry = seed;
}

/** Non-zero once an allocation has failed; the engine keeps running on what
 *  it has, and the host decides what to tell the user. */
TW_EXPORT(tw_oom)
int tw_oom(const TaudEngine *e) { return e->oom ? 1 : 0; }

/* ── content upload ── */

/**
 * Install a sample+instrument image. `pool` is the sample pool up to its last
 * non-zero byte (a read past `poolLen` is the zero the full 8 MB pool holds
 * there) in a malloc'd buffer the engine ADOPTS — NULL with poolLen 0 for an
 * empty pool. `inst` is `instCount` 256-byte records; the slots past them are
 * cleared. Every instrument's extra patches are dropped: they point into the
 * pool that was replaced.
 */
TW_EXPORT(tw_upload_sample_inst)
void tw_upload_sample_inst(TaudEngine *e, uint8_t *pool, uint32_t poolLen, const uint8_t *inst, int instCount)
{
    uint8_t *recs = (uint8_t *)calloc(1024, 256);
    if (recs == NULL) { e->oom = true; free(pool); return; }
    if (instCount > 1024) instCount = 1024;
    if (instCount > 0) memcpy(recs, inst, (size_t)instCount * 256);
    te_upload_sample_inst_blob(e, pool, poolLen, recs);
    free(recs);
    free(e->ownPool);
    e->ownPool = pool;
}

/** One instrument record (up to 256 bytes, zero-padded). */
TW_EXPORT(tw_upload_instrument)
void tw_upload_instrument(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len)
{
    uint8_t rec[256];
    int i;
    memset(rec, 0, sizeof rec);
    memcpy(rec, bytes, len < 256 ? len : 256);
    te_inst_load_record(&e->instruments[slot & 0x3ff], rec);
    /* As the whole-image upload: a chip patch may now live where another did. */
    e->formantTables.chipMemoCount = 0;
    e->hasPsg = false;
    for (i = 0; i < 1024; i++) if (e->instruments[i].psg != NULL) { e->hasPsg = true; break; }
    e->imixGen++;
}

TW_EXPORT(tw_upload_instrument_patches)
void tw_upload_instrument_patches(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len)
{
    te_upload_instrument_patches(e, slot, bytes, len);
}

TW_EXPORT(tw_clear_instrument_patches)
void tw_clear_instrument_patches(TaudEngine *e, int slot)
{
    TaudInst *inst = &e->instruments[slot & 0x3ff];
    te_retire(e, inst->extraPatches, sizeof(TaudPatch) * (size_t)inst->patchCount);
    inst->extraPatches = NULL;
    inst->patchCount = 0;
}

TW_EXPORT(tw_instrument_patch_count)
int tw_instrument_patch_count(const TaudEngine *e, int slot) { return e->instruments[slot & 0x3ff].patchCount; }

/** The instrument's mixing-chain id, the way a test or a tool overrides byte
 *  255 without rewriting the record. */
TW_EXPORT(tw_set_instrument_imix_id)
void tw_set_instrument_imix_id(TaudEngine *e, int slot, int id)
{
    TaudInst *inst = &e->instruments[slot & 0x3ff];
    if (inst->meta != NULL) inst->meta->imixId = id & 0xff;
    else inst->reserved[4] = (uint8_t)(id & 0xff);
    e->imixGen++;
}

/** Count a change the host made to an instrument's chain id or to a block
 *  behind the engine's back (a view of the records): the route table is
 *  rebuilt before the next chunk. */
TW_EXPORT(tw_bump_imix_gen)
void tw_bump_imix_gen(TaudEngine *e) { e->imixGen++; }

/** Grow the engine's own sample pool to the full SAMPLE_BIN_TOTAL bytes (the
 *  tail zero) and return it, writable: for a host that writes samples in
 *  place. NULL when there is no memory for it. */
TW_EXPORT(tw_sample_pool_full)
uint8_t *tw_sample_pool_full(TaudEngine *e)
{
    if (e->ownPool == NULL || e->samplePoolLen < SAMPLE_BIN_TOTAL || e->sampleBin != e->ownPool) {
        uint8_t *full = (uint8_t *)calloc(1, SAMPLE_BIN_TOTAL);
        if (full == NULL) { e->oom = true; return NULL; }
        if (e->sampleBin != NULL && e->samplePoolLen > 0) {
            memcpy(full, e->sampleBin, e->samplePoolLen < SAMPLE_BIN_TOTAL ? e->samplePoolLen : SAMPLE_BIN_TOTAL);
        }
        free(e->ownPool);
        e->ownPool = full;
        e->sampleBin = full;
        e->samplePoolLen = SAMPLE_BIN_TOTAL;
    }
    return e->ownPool;
}

/* ── an instrument's runtime state, as its JavaScript methods wrote it ── */

#define TW_INST(e, slot) (&(e)->instruments[(slot) < 0 ? 0 : (slot) >= NUM_INST_SLOTS ? NUM_INST_SLOTS - 1 : (slot)])

TW_EXPORT(tw_inst_toggle_invert_bit)
void tw_inst_toggle_invert_bit(TaudEngine *e, int slot, int off, int len) { te_inst_toggle_invert_bit(TW_INST(e, slot), off, len); }

TW_EXPORT(tw_inst_invert_bit)
int tw_inst_invert_bit(TaudEngine *e, int slot, int off, int len) { return te_inst_invert_bit(TW_INST(e, slot), off, len) ? 1 : 0; }

TW_EXPORT(tw_inst_toggle_mod_bit)
void tw_inst_toggle_mod_bit(TaudEngine *e, int slot, int i, int sampleLen) { te_inst_toggle_mod_bit(TW_INST(e, slot), i, sampleLen); }

TW_EXPORT(tw_inst_mod_bit)
int tw_inst_mod_bit(const TaudEngine *e, int slot, int i) { return te_inst_mod_bit(TW_INST(e, slot), i) ? 1 : 0; }

TW_EXPORT(tw_inst_set_mod_region)
int tw_inst_set_mod_region(TaudEngine *e, int slot, double from, double to) { return te_inst_set_mod_region(TW_INST(e, slot), from, to) ? 1 : 0; }

TW_EXPORT(tw_inst_set_mod_comb)
int tw_inst_set_mod_comb(TaudEngine *e, int slot, int bits, int odd) { return te_inst_set_mod_comb(TW_INST(e, slot), bits, odd != 0) ? 1 : 0; }

TW_EXPORT(tw_inst_set_mod_op)
int tw_inst_set_mod_op(TaudEngine *e, int slot, int op, int invert) { return te_inst_set_mod_op(TW_INST(e, slot), op, invert != 0) ? 1 : 0; }

TW_EXPORT(tw_inst_set_mod_op_ext)
int tw_inst_set_mod_op_ext(TaudEngine *e, int slot, int code, int invert, int f) { return te_inst_set_mod_op_ext(TW_INST(e, slot), code, invert != 0, f) ? 1 : 0; }

TW_EXPORT(tw_inst_clear_mod_state)
void tw_inst_clear_mod_state(TaudEngine *e, int slot) { te_inst_clear_mod_state(TW_INST(e, slot)); }

TW_EXPORT(tw_inst_reset_mod)
void tw_inst_reset_mod(TaudEngine *e, int slot) { te_inst_reset_mod(TW_INST(e, slot)); }

/** The 64 cells of pattern `idx` as the engine holds them (TaudCell records;
 *  the shared empty pattern for a slot never written). */
TW_EXPORT(tw_pattern_read)
const TaudCell *tw_pattern_read(const TaudEngine *e, int idx) { return te_pattern_read(e, idx); }

/** Bring the instruments' route table up to date now (the mixer does it at
 *  the top of a chunk): for a host that wants to look at the buses first. */
TW_EXPORT(tw_sync_imix_routes)
void tw_sync_imix_routes(TaudEngine *e) { if (e->imixSyncedGen != e->imixGen) te_sync_imix_routes(e); }

/** The empty pattern every unwritten slot reads as. */
TW_EXPORT(tw_empty_pattern)
const TaudCell *tw_empty_pattern(const TaudEngine *e) { return e->emptyPattern; }

/** Run the row event at the playhead's position now, as the mixer's clock
 *  would at the top of the row (a test stepping the song by hand). */
TW_EXPORT(tw_apply_tracker_row)
void tw_apply_tracker_row(TaudEngine *e) { te_apply_tracker_row(e); }

TW_EXPORT(tw_apply_tracker_tick)
void tw_apply_tracker_tick(TaudEngine *e) { te_apply_tracker_tick(e); }

TW_EXPORT(tw_upload_pattern)
void tw_upload_pattern(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len) { te_upload_pattern(e, slot, bytes, len); }

/** Back to unallocated: the slot reads as the empty pattern again. */
TW_EXPORT(tw_clear_pattern)
void tw_clear_pattern(TaudEngine *e, int slot) { te_clear_pattern(e, slot); }

TW_EXPORT(tw_upload_cue)
void tw_upload_cue(TaudEngine *e, int idx, const uint8_t *bytes, uint32_t len) { te_upload_cue(e, idx, bytes, len); }

TW_EXPORT(tw_set_64_channel_mode)
void tw_set_64_channel_mode(TaudEngine *e, int on) { e->is64ChannelMode = on != 0; }

TW_EXPORT(tw_set_cell_format)
void tw_set_cell_format(TaudEngine *e, int wide) { te_set_cell_format(e, wide != 0); }

/* ── the song's chains and lyrics, as the file's own bytes ── */

/** One `sMst` parameter block, or len 0 for none. Returns 0 when the block
 *  was not understood (the chain is then dropped, as for none). */
TW_EXPORT(tw_set_mastering)
int tw_set_mastering(TaudEngine *e, const uint8_t *block, uint32_t len)
{
    TaudMastering m;
    if (len == 0 || !te_mastering_parse_block(block, len, &m)) {
        te_set_mastering(e, NULL);
        return len == 0;
    }
    te_set_mastering(e, &m);
    return 1;
}

/** The whole `IMix` section payload (len 0 = no blocks). Returns the number
 *  of blocks installed, or -1 out of memory (the old set stays). */
TW_EXPORT(tw_set_imix)
int tw_set_imix(TaudEngine *e, const uint8_t *section, uint32_t len)
{
    TaudImixBlock *blocks = NULL;
    int n = len > 0 ? te_imix_parse_section(section, len, &blocks) : 0;
    if (n < 0) { e->oom = true; return -1; }
    /* The route table reads the blocks by id when it next syncs, and a chain
     * copies what it runs on, so nothing still points into the old set. */
    te_set_imix(e, blocks, n);
    free(e->ownImix);
    e->ownImix = blocks;
    return n;
}

/** The whole `IPit` section payload (len 0 = none): the instruments' pitch
 *  extensions (§9.18). The engine copies what it keeps. */
TW_EXPORT(tw_set_pitch_ext)
void tw_set_pitch_ext(TaudEngine *e, const uint8_t *section, uint32_t len) { te_set_pitch_ext(e, section, len); }

/** The whole `ILyr` section payload (len 0 = no lyrics). Returns the number of
 *  entries installed, or -1 out of memory (the old set stays). */
TW_EXPORT(tw_set_lyrics)
int tw_set_lyrics(TaudEngine *e, const uint8_t *section, uint32_t len)
{
    TaudLyricEntry *entries = NULL;
    int i;
    int n = len > 0 ? te_parse_lyrics(section, len, &entries) : 0;
    if (n < 0) { e->oom = true; return -1; }
    te_set_lyrics(e, entries, n);
    /* A voice mid-syllable still reads the entries it was triggered from. */
    for (i = 0; i < e->ownLyricCount; i++) {
        te_retire(e, e->ownLyrics[i].syllables, sizeof(TaudLyricSyllable) * (size_t)e->ownLyrics[i].numSyllables);
        te_retire(e, e->ownLyrics[i].recipes, sizeof(TaudLyricRecipe) * (size_t)e->ownLyrics[i].numRecipes);
    }
    te_retire(e, e->ownLyrics, sizeof(TaudLyricEntry) * (size_t)e->ownLyricCount);
    e->ownLyrics = entries;
    e->ownLyricCount = n;
    return n;
}

/* ── transport and the song's parameters ── */

TW_EXPORT(tw_play)
void tw_play(TaudEngine *e) { te_play(e); }

TW_EXPORT(tw_stop)
void tw_stop(TaudEngine *e) { te_stop(e); }

TW_EXPORT(tw_is_playing)
int tw_is_playing(const TaudEngine *e) { return e->isPlaying ? 1 : 0; }

TW_EXPORT(tw_set_master_volume)
void tw_set_master_volume(TaudEngine *e, int v) { e->masterVolume = v & 255; }

TW_EXPORT(tw_set_master_pan)
void tw_set_master_pan(TaudEngine *e, int v) { e->masterPan = v & 255; }

TW_EXPORT(tw_set_bpm)
void tw_set_bpm(TaudEngine *e, int bpm) { e->bpm = iclamp(bpm, BPM_MIN, BPM_MAX); }

TW_EXPORT(tw_set_tick_rate)
void tw_set_tick_rate(TaudEngine *e, int rate) { e->tickRate = rate & 255; }

TW_EXPORT(tw_set_tuning)
void tw_set_tuning(TaudEngine *e, int baseNote, double freq) { te_set_tuning(e, baseNote, freq); }

TW_EXPORT(tw_set_song_global_volume)
void tw_set_song_global_volume(TaudEngine *e, int v) { e->globalVolume = v & 255; }

TW_EXPORT(tw_set_song_mixing_volume)
void tw_set_song_mixing_volume(TaudEngine *e, int v) { e->mixingVolume = v & 255; }

TW_EXPORT(tw_set_tracker_mixer_flags)
void tw_set_tracker_mixer_flags(TaudEngine *e, int flags) { te_set_tracker_mixer_flags(e, flags); }

TW_EXPORT(tw_set_surround_model)
void tw_set_surround_model(TaudEngine *e, int model) { te_set_surround_model(e, model); }

/** Install an exporter's render target in place of the device's monitor:
 *  kind 0 a stereo fold, 3 ambisonic (`order`, `planar`), 4 a speaker layout
 *  (1 quad, 2 5.1, 3 7.1); −1 removes it. The bus is tw_spatial_bus. */
TW_EXPORT(tw_set_spatial_renderer)
void tw_set_spatial_renderer(TaudEngine *e, int kind, int order, int planar, int layout)
{
    te_set_spatial_renderer(e, kind, order, planar != 0, layout);
}

/** The object bus's data — numChannels × TRACKER_CHUNK doubles, channel-major,
 *  the chunk just rendered — or NULL for a stereo song. */
TW_EXPORT(tw_spatial_bus)
const double *tw_spatial_bus(const TaudEngine *e) { return e->spatial != NULL ? e->spatial->data : NULL; }

TW_EXPORT(tw_spatial_bus_channels)
int tw_spatial_bus_channels(const TaudEngine *e) { return e->spatial != NULL ? e->spatial->numChannels : 0; }

TW_EXPORT(tw_set_monitor_mode)
void tw_set_monitor_mode(TaudEngine *e, int mode) { te_set_monitor_mode(e, mode); }

TW_EXPORT(tw_set_cue_position)
void tw_set_cue_position(TaudEngine *e, int pos) { te_set_cue_position(e, pos); }

TW_EXPORT(tw_set_tracker_row)
void tw_set_tracker_row(TaudEngine *e, int row) { te_set_tracker_row(e, row); }

TW_EXPORT(tw_reset_sample_fx_state)
void tw_reset_sample_fx_state(TaudEngine *e) { te_reset_sample_fx_state(e); }

TW_EXPORT(tw_reset_params)
void tw_reset_params(TaudEngine *e) { te_reset_params(e); }

/** Put the playhead on (cue, row) as the song itself arrives there. Returns 0
 *  when the song's own path never reaches the row (the cues were then walked
 *  in order). */
TW_EXPORT(tw_chase_tracker_row)
int tw_chase_tracker_row(TaudEngine *e, int cue, int row) { return te_chase_tracker_row(e, cue, row) ? 1 : 0; }

/* ── jam / audition ── */

TW_EXPORT(tw_jam_note)
void tw_jam_note(TaudEngine *e, int vi, int note, int inst, int audition) { te_jam_note(e, vi, note, inst, audition != 0); }

/** `spec` is twelve 32-bit integers the caller wrote into the module's
 *  memory: ptr, len, rate, playStart, loopStart, loopEnd, loopMode, detune,
 *  chanPtr2, chanMode (and two spare). */
TW_EXPORT(tw_jam_sample)
void tw_jam_sample(TaudEngine *e, int vi, int note, const int32_t *spec)
{
    te_jam_sample(e, vi, note, (uint32_t)spec[0], spec[1], spec[2], spec[3], spec[4], spec[5], spec[6], spec[7],
                  (uint32_t)spec[8], spec[9]);
}

TW_EXPORT(tw_jam_stop)
void tw_jam_stop(TaudEngine *e) { te_jam_stop(e); }

TW_EXPORT(tw_jam_stop_voice)
void tw_jam_stop_voice(TaudEngine *e, int vi) { te_jam_stop_voice(e, vi); }

TW_EXPORT(tw_jam_key_off)
void tw_jam_key_off(TaudEngine *e, int vi) { te_jam_key_off(e, vi); }

TW_EXPORT(tw_jam_release)
void tw_jam_release(TaudEngine *e, int vi) { te_jam_release(e, vi); }

TW_EXPORT(tw_jam_active)
int tw_jam_active(const TaudEngine *e) { return e->jamActive ? 1 : 0; }

/* ── the desk ── */

TW_EXPORT(tw_set_voice_fader)
void tw_set_voice_fader(TaudEngine *e, int vi, int fader) { te_set_voice_fader(e, vi, fader); }

TW_EXPORT(tw_get_voice_fader)
int tw_get_voice_fader(const TaudEngine *e, int vi) { return te_get_voice_fader(e, vi); }

/** Free whatever replaced instrument data no voice points at any more. The
 *  engine does this by itself as the list grows; a test asks for it. */
TW_EXPORT(tw_retire_sweep)
int tw_retire_sweep(TaudEngine *e) { te_retire_sweep(e); return e->retiredCount; }

/* ── reading the playhead ── */

#define TW_GET_INT(name, expr) \
    TW_EXPORT(name) int name(const TaudEngine *e) { return (int)(expr); }

TW_GET_INT(tw_get_master_volume, e->masterVolume)
TW_GET_INT(tw_get_master_pan, e->masterPan)
TW_GET_INT(tw_get_bpm, e->bpm)
TW_GET_INT(tw_get_tick_rate, e->tickRate)
TW_GET_INT(tw_get_song_global_volume, e->globalVolume)
TW_GET_INT(tw_get_song_mixing_volume, e->mixingVolume)
TW_GET_INT(tw_get_tracker_mixer_flags, e->initialGlobalFlags)
TW_GET_INT(tw_get_surround_model, e->surroundModel)
TW_GET_INT(tw_get_monitor_mode, e->monitorMode)
TW_GET_INT(tw_get_cue_position, e->position)
TW_GET_INT(tw_get_cue_pos, e->cuePos)
TW_GET_INT(tw_get_tracker_row, e->rowIndex)
TW_GET_INT(tw_get_tick_in_row, e->tickInRow)
TW_GET_INT(tw_get_cell_format, e->wideCells)
TW_GET_INT(tw_get_64_channel_mode, e->is64ChannelMode)
TW_GET_INT(tw_get_rate, e->rate)

TW_EXPORT(tw_get_tuning_ratio)
double tw_get_tuning_ratio(const TaudEngine *e) { return e->tuningRatio; }

/** The interrupts latched since the last call, as a bit mask; the latch is
 *  cleared. Their arguments stay readable until the next one fires. */
TW_EXPORT(tw_poll_interrupts)
unsigned tw_poll_interrupts(TaudEngine *e) { return te_drain_interrupts(e); }

TW_EXPORT(tw_interrupt_arg)
int tw_interrupt_arg(const TaudEngine *e, int n) { return e->interruptArgs[n & (NUM_INTERRUPTS - 1)]; }

/* ── what the page draws from ── */

/** The playhead, the voice blocks, the Mixing tab's meter blocks and the
 *  envelope playheads, at protocol.js's offsets in `f` (SNAP_FLOATS floats;
 *  the strip's and the Mastering view's blocks and the interrupt latch are
 *  left as they are). */
TW_EXPORT(tw_fill_snapshot)
void tw_fill_snapshot(TaudEngine *e, float *f) { te_fill_snapshot(e, f); }

TW_EXPORT(tw_get_invert_mask)
int tw_get_invert_mask(const TaudEngine *e, int slot, uint8_t *out, int cap) { return te_get_invert_mask(e, slot, out, cap); }

TW_EXPORT(tw_get_mod_mask)
int tw_get_mod_mask(const TaudEngine *e, int slot, uint8_t *out, int cap) { return te_get_mod_mask(e, slot, out, cap); }

TW_EXPORT(tw_get_sample_mod)
void tw_get_sample_mod(const TaudEngine *e, int slot, double *out) { te_get_sample_mod(e, slot, out); }

TW_EXPORT(tw_get_psg_state)
int tw_get_psg_state(const TaudEngine *e, int slot, int *out) { return te_get_psg_state(e, slot, out); }

TW_EXPORT(tw_get_formant_state)
int tw_get_formant_state(const TaudEngine *e, int slot, double *voices, int *extra, int *lyric, int lyricCap, int *counts)
{
    return te_get_formant_state(e, slot, voices, extra, lyric, lyricCap, counts);
}

TW_EXPORT(tw_get_active_note_counts)
void tw_get_active_note_counts(const TaudEngine *e, int32_t *out) { te_get_active_note_counts(e, out); }

/* ── rendering ── */

/** Mix one TRACKER_CHUNK into the engine's float bus (tw_mix_left / _right).
 *  Returns 0 when the song has halted and nothing was mixed. */
TW_EXPORT(tw_render_chunk)
int tw_render_chunk(TaudEngine *e) { return te_render_chunk(e) ? 1 : 0; }

TW_EXPORT(tw_mix_left)
const float *tw_mix_left(const TaudEngine *e) { return e->mixLeft; }

TW_EXPORT(tw_mix_right)
const float *tw_mix_right(const TaudEngine *e) { return e->mixRight; }

/** Install the master strip's analysis bus (te_set_analysis_bus) and return
 *  its data — numChannels × TRACKER_CHUNK doubles, channel-major: the nine
 *  scope harmonics, then the layout's speaker feeds — or NULL for none. */
TW_EXPORT(tw_set_analysis_bus)
const double *tw_set_analysis_bus(TaudEngine *e, int layout)
{
    te_set_analysis_bus(e, layout);
    return e->analysisBus != NULL ? e->analysisBus->data : NULL;
}

TW_EXPORT(tw_analysis_bus_channels)
int tw_analysis_bus_channels(const TaudEngine *e) { return e->analysisBus != NULL ? e->analysisBus->numChannels : 0; }

/** Switch the stem-export tap on or off. While on, each rendered chunk
 *  leaves a log of every voice's pre-pan mono contribution to every frame —
 *  tw_stem_log, tw_stem_count entries of {i32 frame, lane, top, sub, patch,
 *  pad; f64 value} — in the order the mixer added them. */
TW_EXPORT(tw_set_stem_tap)
void tw_set_stem_tap(TaudEngine *e, int on) { e->stemTap = on != 0; e->stemCount = 0; }

TW_EXPORT(tw_stem_log)
const TaudStemEntry *tw_stem_log(const TaudEngine *e) { return e->stemLog; }

TW_EXPORT(tw_stem_count)
int tw_stem_count(const TaudEngine *e) { return e->stemCount; }

/** Install (or drop, slot < 0) the Mixing tab's tap on one instrument's bus,
 *  in `seat` (one per split pane). tw_fill_snapshot writes its block. */
TW_EXPORT(tw_set_imix_meter)
void tw_set_imix_meter(TaudEngine *e, int slot, int seat) { te_set_imix_meter(e, slot, seat); }

/** Keep (or stop keeping) the mix as it enters the mastering chain, for a
 *  meter that reads both sides of it: tw_pre_left / tw_pre_right. */
TW_EXPORT(tw_set_pre_tap)
void tw_set_pre_tap(TaudEngine *e, int on) { e->preTap = on != 0; }

TW_EXPORT(tw_pre_left)
const float *tw_pre_left(const TaudEngine *e) { return e->preLeft; }

TW_EXPORT(tw_pre_right)
const float *tw_pre_right(const TaudEngine *e) { return e->preRight; }

/** The last chunk's deepest compressor / limiter gain reduction, dB (≤ 0). */
TW_EXPORT(tw_master_comp_gr)
double tw_master_comp_gr(const TaudEngine *e) { return te_master_chain_comp_gr(e->mastering); }

TW_EXPORT(tw_master_lim_gr)
double tw_master_lim_gr(const TaudEngine *e) { return te_master_chain_lim_gr(e->mastering); }

/** Voices sounding right now: the lanes', the jam bank's and the background
 *  list's (a profiler's reading). */
TW_EXPORT(tw_sounding_voices)
int tw_sounding_voices(const TaudEngine *e)
{
    int n = e->bgCount, i;
    for (i = 0; i < TOTAL_VOICES; i++) if (e->voices[i].active) n++;
    return n;
}

/** The chunk just mixed as the device plays it: noise-shaped, dithered
 *  unsigned 8-bit, interleaved stereo, 2 × TRACKER_CHUNK bytes into `out`. */
TW_EXPORT(tw_pcm8)
void tw_pcm8(TaudEngine *e, uint8_t *out) { te_pcm32f_to_pcm8(e, out); }
