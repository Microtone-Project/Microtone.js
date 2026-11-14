/* What a page draws from: the playhead, one block per voice (the lanes AND the
 * jam bank) and the envelope playheads, written into a float buffer at the
 * offsets core/worklet/protocol.js gives them (snap_layout.h is generated
 * from it), every meter's block included. Port of engine-commands.js
 * fillSnapshotInto, less the interrupt latch, which the host drains.
 *
 * Also the readbacks a view polls by message: an instrument's invert-loop and
 * modification masks, its live sample modification, and what a PSG or formant
 * instrument is doing right now. */

#include <string.h>

#include "taud_internal.h"
#include "snap_layout.h"

/* One voice's envelope-playhead entry at index n, if it is sounding. */
static int put_env_playhead(float *f, int n, const TaudVoice *v)
{
    float *o;
    if (!v->active || n >= SNAP_EP_MAX) return n;
    o = f + SNAP_EP_ENTRIES + n * SNAP_EP_STRIDE;
    o[SNAP_EP_INST] = (float)(v->instrumentId & 0x3ff);
    o[SNAP_EP_VOL_IDX] = (float)v->envIndex;
    o[SNAP_EP_VOL_TIME] = (float)v->envTimeSec;
    o[SNAP_EP_PAN_IDX] = (float)v->envPanIndex;
    o[SNAP_EP_PAN_TIME] = (float)v->envPanTimeSec;
    o[SNAP_EP_PITCH_IDX] = (float)v->envPitchIndex;
    o[SNAP_EP_PITCH_TIME] = (float)v->envPitchTimeSec;
    o[SNAP_EP_FILTER_IDX] = (float)v->envFilterIndex;
    o[SNAP_EP_FILTER_TIME] = (float)v->envFilterTimeSec;
    return n + 1;
}

void te_fill_snapshot(TaudEngine *e, float *f)
{
    int vi, i, n = 0, k;
    bool stereo = e->ts_surroundModel == SURROUND_STEREO;
    f[SNAP_CUE_POS] = (float)e->cuePos;
    f[SNAP_ROW_INDEX] = (float)e->rowIndex;
    f[SNAP_TICK_IN_ROW] = (float)e->tickInRow;
    f[SNAP_BPM] = (float)e->bpm;
    f[SNAP_TICK_RATE] = (float)e->tickRate;
    f[SNAP_FLAGS] = (float)((e->isPlaying ? 1 : 0) | (e->jamActive ? 2 : 0));
    f[SNAP_CHANNEL_COUNT] = (float)te_channel_count(e);
    f[SNAP_GLOBAL_VOLUME] = (float)e->globalVolume;
    for (vi = 0; vi < SNAP_MAX_VOICES; vi++) {
        const TaudVoice *v = &e->voices[vi];
        float *o = f + SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE;
        o[SNAP_V_ACTIVE] = v->active ? 1.0f : 0.0f;
        if (v->active) {
            /* The meter's own reading, which does not ask whether the
             * instrument HAS a volume envelope (as the page has always had it). */
            double effEnvVol = v->volEnvOn ? v->envVolMix : 1.0;
            double faderGain = (255 - v->fader) / 255.0;
            double ev = effEnvVol * v->fadeoutMix * v->currentMixVolume * faderGain;
            o[SNAP_V_EFF_VOL] = (float)(ev < 0 ? 0 : ev > 1 ? 1 : ev);
            /* Where the lane SOUNDS: the sum the mixer pans by, and for a
             * metainstrument the mix-weighted mean of its layers. */
            o[SNAP_V_EFF_PAN] = (float)te_display_pan_byte(e, vi, v);
            if (!stereo) {
                double ang[2];
                te_display_angles(e, vi, v, ang);
                o[SNAP_V_EFF_PAN] = (float)js_round(te_fold_azimuth_to_pan(ang[0]));
                o[SNAP_V_AZIMUTH] = (float)ang[0];
                o[SNAP_V_ELEVATION] = (float)ang[1];
            } else {
                o[SNAP_V_AZIMUTH] = o[SNAP_V_EFF_PAN];
                o[SNAP_V_ELEVATION] = 0.0f;
            }
            o[SNAP_V_NOTE] = (float)(js_toint32(v->renderPitch > 0 ? v->renderPitch : v->noteVal) & 0xffff);
            /* The pattern-level instrument (a meta's slot), not the layer it
             * resolved to. */
            o[SNAP_V_INST] = (float)((v->displayInst != 0 ? v->displayInst : v->instrumentId) & 0x3ff);
            o[SNAP_V_SAMPLE_POS] = (float)v->samplePos;
            o[SNAP_V_SAMPLE_PTR] = (float)v->activeSamplePtr;
            o[SNAP_V_SAMPLE_LEN] = (float)v->activeSampleLength;
            o[SNAP_V_ENV_VOL_IDX] = (float)v->envIndex;
            o[SNAP_V_ENV_VOL_TIME] = (float)v->envTimeSec;
            o[SNAP_V_ENV_PAN_IDX] = (float)v->envPanIndex;
            o[SNAP_V_ENV_PAN_TIME] = (float)v->envPanTimeSec;
            o[SNAP_V_ENV_PITCH_IDX] = (float)v->envPitchIndex;
            o[SNAP_V_ENV_PITCH_TIME] = (float)v->envPitchTimeSec;
            o[SNAP_V_ENV_FILTER_IDX] = (float)v->envFilterIndex;
            o[SNAP_V_ENV_FILTER_TIME] = (float)v->envFilterTimeSec;
            o[SNAP_V_FUNK_WINDOW] = (float)v->funkWindow;
            o[SNAP_V_FUNK_POS] = (float)v->funkPos;
            o[SNAP_V_FUNK_LEN] = (float)(v->activeSampleLoopEnd - v->activeSampleLoopStart);
            o[SNAP_V_FUNK_MODE] = (float)v->funkMode;
            o[SNAP_V_MOD_FUNK_WINDOW] = (float)v->modFunkWindow;
        } else {
            for (k = 1; k < SNAP_VOICE_STRIDE; k++) o[k] = 0.0f;
            o[SNAP_V_EFF_PAN] = 128.0f;
            o[SNAP_V_AZIMUTH] = 128.0f;    /* centre/front, matching EFF_PAN's rest value */
            o[SNAP_V_SAMPLE_POS] = -1.0f;
            o[SNAP_V_SAMPLE_PTR] = -1.0f;
            o[SNAP_V_ENV_VOL_IDX] = -1.0f;
            o[SNAP_V_ENV_PAN_IDX] = -1.0f;
            o[SNAP_V_ENV_PITCH_IDX] = -1.0f;
            o[SNAP_V_ENV_FILTER_IDX] = -1.0f;
            o[SNAP_V_FUNK_WINDOW] = -1.0f;
            o[SNAP_V_FUNK_POS] = -1.0f;
            o[SNAP_V_MOD_FUNK_WINDOW] = -1.0f;
        }
        /* The LANE axis — outside the active/inactive split on purpose: M's
         * volume and the lane's position belong to the lane, not to whatever
         * is sounding on it. */
        o[SNAP_V_CHAN_VOL] = (float)v->channelVolume;
        o[SNAP_V_CHAN_AZ] = (float)(stereo ? v->channelPan : v->panAzimuth);
        o[SNAP_V_CHAN_EL] = (float)(e->ts_surroundModel == SURROUND_SPATIAL ? v->panElevation : 0.0);
        o[SNAP_V_CHAN_SET] = (float)((v->channelVolumeSet ? SNAP_V_CHAN_SET_VOL : 0) |
                                     (v->channelPanSet ? SNAP_V_CHAN_SET_PAN : 0));
    }
    /* Envelope playheads: lane voices first, then the background voices (FM
     * operators, layers, NNA ghosts), each tagged with the instrument it is
     * actually playing. */
    for (vi = 0; vi < SNAP_MAX_VOICES; vi++) n = put_env_playhead(f, n, &e->voices[vi]);
    for (i = 0; i < e->bgCount; i++) n = put_env_playhead(f, n, e->bg[i]);
    f[SNAP_EP_COUNT] = (float)n;
    /* The Mixing tab's meters, one block per seat. */
    te_fill_imix_meters(e, f);
    /* The master strip's and the Mastering view's (meters.c). */
    te_fill_meters(e, f);
}

/* ── readbacks ── */

/* Copy up to `cap` bytes of the S $Fx invert-loop mask; returns its length
 * (0 = none). */
int te_get_invert_mask(const TaudEngine *e, int slot, uint8_t *out, int cap)
{
    const TaudInst *inst = &e->instruments[slot & 0x3ff];
    int n = inst->invertMaskLen;
    if (n <= 0 || inst->invertMask == NULL) return 0;
    memcpy(out, inst->invertMask, (size_t)(n < cap ? n : cap));
    return n;
}

/* …and notefx 2/3's inversion mask, one bit per sample byte. */
int te_get_mod_mask(const TaudEngine *e, int slot, uint8_t *out, int cap)
{
    const TaudInst *inst = &e->instruments[slot & 0x3ff];
    int n = inst->modMaskLen;
    if (n <= 0 || inst->modMask == NULL) return 0;
    memcpy(out, inst->modMask, (size_t)(n < cap ? n : cap));
    return n;
}

/* The instrument's live sample modification as 24 doubles, in the order
 * wasm-engine.js names them (getInstrumentSampleMod). */
void te_get_sample_mod(const TaudEngine *e, int slot, double *out)
{
    const TaudInst *i = &e->instruments[slot & 0x3ff];
    out[0] = i->modOp; out[1] = i->modInvert; out[2] = i->modFrom; out[3] = i->modTo;
    out[4] = i->modCombBits; out[5] = i->modCombOdd; out[6] = i->modRot; out[7] = i->modSub;
    out[8] = i->modOn; out[9] = i->modScatter; out[10] = i->modSeed; out[11] = i->modEpoch;
    out[12] = i->modOpExt; out[13] = i->modF; out[14] = i->modStepIndex; out[15] = i->modXor;
    out[16] = i->modBitRot; out[17] = i->modBitPermIdx; out[18] = i->modBitPermOn;
    out[19] = i->modExtSwapA; out[20] = i->modExtSwapB; out[21] = i->modExtMirror;
    out[22] = i->modFunkWalk; out[23] = i->modFunkPos;
    out[24] = i->modFunkLen;
}

/* A PSG instrument's live state: the S $Axxx overlay (rtAdvance ×2, rtLevel
 * ×2, rtMute) and the waveform each oscillator is playing on the first
 * sounding voice of it — a lane's before a ghost's — or −1, −1 when nothing
 * sounds it. Returns 0 for any other instrument. */
int te_get_psg_state(const TaudEngine *e, int slot, int *out)
{
    const TaudPsgPatch *patch = e->instruments[slot & 0x3ff].psg;
    int i;
    if (patch == NULL) return 0;
    out[0] = patch->rtAdvance[0]; out[1] = patch->rtAdvance[1];
    out[2] = patch->rtLevel[0]; out[3] = patch->rtLevel[1];
    out[4] = patch->rtMute;
    out[5] = out[6] = -1;
    out[7] = 0;
    for (i = 0; i < TOTAL_VOICES + e->bgCount; i++) {
        const TaudVoice *v = i < TOTAL_VOICES ? &e->voices[i] : e->bg[i - TOTAL_VOICES];
        if (v->active && v->psg != NULL && v->psg->patch == patch) {
            out[5] = te_psg_current_wave(v->psg, 0);
            out[6] = te_psg_current_wave(v->psg, 1);
            out[7] = 1;
            break;
        }
    }
    return 1;
}

/* How many sounding voices te_get_formant_state reports at most. */
#define FORMANT_LIVE_MAX 8
#define FORMANT_VOICE_DOUBLES 13

/* A formant instrument's live state (item 240). `voices` receives up to
 * FORMANT_LIVE_MAX records of FORMANT_VOICE_DOUBLES doubles — own, front,
 * open, round, toFront, toOpen, toRound, nasal own / v / to, rhotic own / v /
 * to — and `extra` two ints per record (glide, coda); `lyric` the syllable
 * indices its notes are singing, ascending, each once (up to lyricCap).
 * counts[0] = voices written, counts[1] = syllables written. Returns 0 for
 * any other instrument. */
int te_get_formant_state(const TaudEngine *e, int slot, double *voices, int *extra, int *lyric, int lyricCap,
                         int *counts)
{
    const TaudInst *inst = &e->instruments[slot & 0x3ff];
    const TaudFormantPatch *patch = inst->formant;
    int nv = 0, nl = 0, i, j;
    counts[0] = counts[1] = 0;
    if (patch == NULL) return 0;
    if (inst->lyric != NULL && inst->lyricEntry != NULL) {
        int syl = inst->lyricEntry->numSyllables;
        for (i = 0; i < TOTAL_VOICES; i++) {
            const TaudVoice *v = &e->voices[i];
            const TaudFormantState *st = v->formant;
            int k = -1;
            if (!v->active || st == NULL || st->patch == NULL || st->patch->lyricOf != patch) continue;
            for (j = 0; j < syl; j++) if (&inst->lyric[j] == st->patch) { k = j; break; }
            if (k < 0) continue;
            for (j = 0; j < nl; j++) if (lyric[j] == k) break;
            if (j == nl && nl < lyricCap) lyric[nl++] = k;
        }
        /* ascending */
        for (i = 1; i < nl; i++) {
            int x = lyric[i];
            for (j = i - 1; j >= 0 && lyric[j] > x; j--) lyric[j + 1] = lyric[j];
            lyric[j + 1] = x;
        }
    }
    for (i = 0; i < TOTAL_VOICES + e->bgCount && nv < FORMANT_LIVE_MAX; i++) {
        const TaudVoice *v = i < TOTAL_VOICES ? &e->voices[i] : e->bg[i - TOTAL_VOICES];
        const TaudFormantState *st = v->formant;
        double *o;
        bool gliding;
        if (!v->active || st == NULL) continue;
        if (!st->ownVowel && !st->nasAmt.own && !st->rhoAmt.own && st->glideOv < 0 && !st->codaCall) continue;
        /* A lyric instrument's note sings one of its syllables. */
        if (st->patch != patch && (st->patch == NULL || st->patch->lyricOf != patch)) continue;
        gliding = st->glideLeft > 0;
        o = voices + nv * FORMANT_VOICE_DOUBLES;
        o[0] = st->ownVowel;
        o[1] = st->vFront; o[2] = st->vOpen; o[3] = st->vRound;
        o[4] = gliding ? st->tFront : st->vFront;
        o[5] = gliding ? st->tOpen : st->vOpen;
        o[6] = gliding ? st->tRound : st->vRound;
        o[7] = st->nasAmt.own; o[8] = st->nasAmt.v; o[9] = st->nasAmt.left > 0 ? st->nasAmt.to : st->nasAmt.v;
        o[10] = st->rhoAmt.own; o[11] = st->rhoAmt.v; o[12] = st->rhoAmt.left > 0 ? st->rhoAmt.to : st->rhoAmt.v;
        extra[nv * 2] = st->glideOv;
        extra[nv * 2 + 1] = st->codaCall ? 1 : 0;
        nv++;
    }
    counts[0] = nv;
    counts[1] = nl;
    return 1;
}

/* How many notes each instrument is sounding on the lanes and the jam bank
 * (getActiveNoteCounts): 1024 ints. */
void te_get_active_note_counts(const TaudEngine *e, int32_t *out)
{
    int i;
    memset(out, 0, sizeof(int32_t) * 1024);
    for (i = 0; i < TOTAL_VOICES; i++) if (e->voices[i].active) out[e->voices[i].instrumentId & 0x3ff]++;
}
