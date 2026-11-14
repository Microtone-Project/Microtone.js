/* Mixer + output quantiser — port of mixer.js.
 *
 * The voices sum in binary64; the pair narrows to binary32 (the mix bus)
 * exactly once per frame, then mastering, clamp and (optionally) dither. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

#define PI 3.141592653589793

/* One voice's contribution as a [left, right] pair, before pan and gain. */
static void render_voice_pair(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, double spt,
                              double out[2], int n)
{
    double s, c0, c1;
    /* An FM rack (item 159) replaces the voice's own sample fetch. It is asked
     * first because its operator 0 may itself be a chip channel (§5.5.1),
     * which the rack reads — the voice it sounds on is the rack's. */
    if (v->fmRig != NULL) {
        s = te_render_fm_voice(e, v, interpMode, spt, e->oplFrame + n);
        s = te_apply_voice_filter_self(v, s);
        s = te_apply_taud_voice_fx(v, s, &v->bitcrusherCounter, &v->bitcrusherHeld);
        out[0] = s;
        out[1] = s;
        te_advance_filter_glide(e, v);
        return;
    }
    /* An OPL channel (item 209) replaces the sample fetch, reading the chip
     * clock at this frame; it has applied the note volume itself. */
    if (v->opl != NULL) {
        s = te_render_opl_voice(e, v, e->oplFrame + n);
        s = te_apply_voice_filter_self(v, s);
        s = te_apply_taud_voice_fx(v, s, &v->bitcrusherCounter, &v->bitcrusherHeld);
        out[0] = s;
        out[1] = s;
        te_advance_filter_glide(e, v);
        return;
    }
    /* A PSG pair (§7.9) on the same chip clock. Unlike OPL it leaves the note
     * volume to the gain chain, as a sample does: its multiplying mix would
     * otherwise square it. */
    if (v->psg != NULL) {
        s = te_render_psg_voice(e, v, e->oplFrame + n);
        s = te_apply_voice_filter_self(v, s);
        s = te_apply_taud_voice_fx(v, s, &v->bitcrusherCounter, &v->bitcrusherHeld);
        out[0] = s;
        out[1] = s;
        te_advance_filter_glide(e, v);
        return;
    }
    /* A formant voice (item 212) plays its sample — or the chip channel it is
     * sourced from, on the same clock — through the tract. */
    if (v->formant != NULL) {
        s = te_render_formant_voice(e, v, inst, interpMode, e->oplFrame + n);
        s = te_apply_voice_filter_self(v, s);
        s = te_apply_taud_voice_fx(v, s, &v->bitcrusherCounter, &v->bitcrusherHeld);
        out[0] = s;
        out[1] = s;
        te_advance_filter_glide(e, v);
        return;
    }
    if (v->activeChanCount != 2) {
        s = te_fetch_tracker_sample(e, v, inst, interpMode, 0);
        s = te_apply_voice_filter_self(v, s);
        s = te_apply_taud_voice_fx(v, s, &v->bitcrusherCounter, &v->bitcrusherHeld);
        out[0] = s;
        out[1] = s;
        te_advance_filter_glide(e, v);
        return;
    }
    te_fetch_tracker_sample_stereo(e, v, inst, interpMode, out);
    c0 = out[0];
    c1 = out[1];
    if (v->activeChanMode == CHAN_MODE_MATRIX) {
        double m = c0, sd = c1;
        c0 = m + sd;
        c1 = m - sd;
    }
    out[0] = te_apply_taud_voice_fx(v, te_apply_voice_filter_self(v, c0), &v->bitcrusherCounter, &v->bitcrusherHeld);
    out[1] = te_apply_taud_voice_fx(v, te_apply_voice_filter(v, c1, &v->right),
                                    &v->right.bitcrusherCounter, &v->right.bitcrusherHeld);
    /* Once per frame, after both channels: they share the coefficients. */
    te_advance_filter_glide(e, v);
}

/* ── pcm32fToPcm8: noise-shaped TPDF dither, binary32 at every step ── */

uint32_t te_xorshift32(uint32_t *state)
{
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

static float urand(uint32_t *xs) { return (float)((te_xorshift32(xs) & 0xffffff) / 16777216.0); }
static float tpdf1(uint32_t *xs) { float a = urand(xs); float b = urand(xs); return a - b; }

void te_dither_u8(uint32_t *xs, float err[4], const float *left, const float *right, size_t frames, uint8_t *out)
{
    const float b1 = 1.5f, b2 = -0.75f, scale = 127.5f, ditherScale = 0.2f;
    size_t i;
    for (i = 0; i < frames; i++) {
        float feedback, dither, shaped, qerr;
        int q;
        /* left */
        feedback = (float)((float)(b1 * err[0]) + (float)(b2 * err[1]));
        dither = (float)(ditherScale * tpdf1(xs));
        shaped = (float)((float)(left[i] + feedback) + (float)(dither / scale));
        shaped = shaped < -1.0f ? -1.0f : shaped > 1.0f ? 1.0f : shaped;
        q = (int)js_round((float)(shaped * scale));
        q = q < -128 ? -128 : q > 127 ? 127 : q;
        out[i * 2] = (uint8_t)((q + 128) & 0xff);
        qerr = (float)(shaped - (float)(q / scale));
        err[1] = err[0];
        err[0] = qerr;
        /* right */
        feedback = (float)((float)(b1 * err[2]) + (float)(b2 * err[3]));
        dither = (float)(ditherScale * tpdf1(xs));
        shaped = (float)((float)(right[i] + feedback) + (float)(dither / scale));
        shaped = shaped < -1.0f ? -1.0f : shaped > 1.0f ? 1.0f : shaped;
        q = (int)js_round((float)(shaped * scale));
        q = q < -128 ? -128 : q > 127 ? 127 : q;
        out[i * 2 + 1] = (uint8_t)((q + 128) & 0xff);
        qerr = (float)(shaped - (float)(q / scale));
        err[3] = err[2];
        err[2] = qerr;
    }
}

void te_pcm32f_to_pcm8(TaudEngine *e, uint8_t *out)
{
    te_dither_u8(&e->xorshift, e->ditherError, e->mixLeft, e->mixRight, TRACKER_CHUNK, out);
    /* The Mastering view's census counts the codes delivered. */
    if (e->masterMeter != NULL) te_master_meter_bin(e->masterMeter, out, e->mixLeft, e->mixRight, TRACKER_CHUNK);
}

static inline double attack_gain(const TaudEngine *e, int attackRampSamples)
{
    int elapsed = e->attackRampSamples - attackRampSamples;
    return 0.5 - 0.5 * js_cos((PI * elapsed) / e->attackRampSamples);
}

/* Every instrument bus runs its chain over [n0, n1) and joins the mix —
 * the stereo accumulators, or the object bus channel for channel — scaled by
 * the song's global gain, in ascending slot order (runImixBuses). A bus whose
 * chain is idle and was not fed is skipped outright. Each bus is then left
 * clear for the next span. */
static void run_imix_buses(TaudEngine *e, int n0, int n1)
{
    const double *gainSpan = e->gainSpan;
    TaudSpatialBus *spatial = e->spatial;
    /* Each tap meters the bus its instrument mixes into — in bus mode the one
     * every instrument on the block shares. Two seats (one per split pane)
     * may meter two buses, or both the same one. */
    TaudImixTap *meterA = e->imixMeters[0], *meterB = e->imixMeters[1];
    const TaudImixBus *busA = meterA != NULL ? e->imixRoutes[meterA->slot & 0x3ff] : NULL;
    const TaudImixBus *busB = meterB != NULL ? e->imixRoutes[meterB->slot & 0x3ff] : NULL;
    int b, k, n, c;
    for (b = 0; b < e->imixCount; b++) {
        TaudImixBus *bus = e->imixList[b];
        TaudImxChain *chain = bus->chain;
        double *d = bus->sb.data;
        bool hit = false;
        /* A note on ANY instrument of a shared bus retriggers its LFOs. */
        for (k = 0; k < bus->nSlots; k++) {
            if (e->imixTrig[bus->slots[k]] != 0) { e->imixTrig[bus->slots[k]] = 0; hit = true; }
        }
        if (hit) te_imx_chain_note_on(chain);
        if (te_imx_chain_idle(chain) && !bus->fed) {
            te_imx_chain_process(chain, d, TRACKER_CHUNK, n0, n1, e->bpm, false);
        } else {
            TaudImixTap *ta = busA == bus ? meterA : NULL;
            TaudImixTap *tb = busB == bus ? meterB : NULL;
            if (ta != NULL) te_imix_tap_push_pre(ta, bus, n0, n1);
            if (tb != NULL) te_imix_tap_push_pre(tb, bus, n0, n1);
            te_imx_chain_set_probes(chain, ta, tb);
            te_imx_chain_process(chain, d, TRACKER_CHUNK, n0, n1, e->bpm, bus->fed);
            te_imx_chain_set_probes(chain, NULL, NULL);
            if (ta != NULL) te_imix_tap_push_post(ta, bus, n0, n1);
            if (tb != NULL) te_imix_tap_push_post(tb, bus, n0, n1);
            if (spatial == NULL) {
                for (n = n0; n < n1; n++) {
                    e->accL[n] += d[n] * gainSpan[n];
                    e->accR[n] += d[TRACKER_CHUNK + n] * gainSpan[n];
                }
            } else {
                for (c = 0; c < bus->nch; c++) {
                    int o = c * TRACKER_CHUNK;
                    for (n = n0; n < n1; n++) spatial->data[o + n] += d[o + n] * gainSpan[n];
                }
            }
        }
        for (c = 0; c < bus->nch; c++) memset(d + c * TRACKER_CHUNK + n0, 0, sizeof(double) * (size_t)(n1 - n0));
        bus->fed = false;
    }
}

/* Finish frames [n0, n1) — one of the JS mixer's spans, which end where the
 * tick clock fires next: the buses join the mix, then every frame is folded to
 * the device's pair, through the Amiga filters, and narrowed to binary32. It
 * runs before that tick, so it sees the span's tempo, gain and filter state. */
static void finish_span(TaudEngine *e, int n0, int n1)
{
    TaudSpatialBus *spatial = e->spatial;
    int n;
    if (e->imixCount > 0) run_imix_buses(e, n0, n1);
    for (n = n0; n < n1; n++) {
        double mixL, mixR;
        if (spatial != NULL) {
            double pair[2];
            te_spatial_bus_stereo_at(spatial, n, pair);
            mixL = pair[0];
            mixR = pair[1];
        } else {
            mixL = e->accL[n];
            mixR = e->accR[n];
        }

        if (e->interpolationMode == INTERP_A500) {
            e->amigaLPStateL = mixL * e->a500A0 + e->amigaLPStateL * e->a500B1;
            e->amigaLPStateR = mixR * e->a500A0 + e->amigaLPStateR * e->a500B1;
            mixL = e->amigaLPStateL;
            mixR = e->amigaLPStateR;
        }
        if ((e->interpolationMode == INTERP_A500 || e->interpolationMode == INTERP_A1200) && e->ledFilterOn) {
            double *sl = e->amigaLEDStateL, *sr = e->amigaLEDStateR;
            double outL = mixL * e->ledA1 + sl[0] * e->ledA2 + sl[1] * e->ledA1 - sl[2] * e->ledB1 - sl[3] * e->ledB2;
            double outR = mixR * e->ledA1 + sr[0] * e->ledA2 + sr[1] * e->ledA1 - sr[2] * e->ledB1 - sr[3] * e->ledB2;
            sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
            sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
            mixL = outL;
            mixR = outR;
        }

        e->mixLeft[n] = (float)mixL;
        e->mixRight[n] = (float)mixR;
    }
}

/* The bus a voice mixes into (item 217), or NULL for the plain path: the
 * chain of the instrument the NOTE named — a metainstrument's, not its
 * layer's. */
static inline TaudImixBus *voice_route(const TaudEngine *e, const TaudVoice *v)
{
    if (e->imixCount == 0) return NULL;
    return e->imixRoutes[(v->displayInst != 0 ? v->displayInst : v->instrumentId) & 0x3ff];
}

/* The stem tap: one more entry in the chunk's log. */
static void stem_push(TaudEngine *e, int frame, int lane, const TaudVoice *v, double value)
{
    TaudStemEntry *it;
    if (e->stemCount == e->stemCap) {
        int nc = e->stemCap ? e->stemCap * 2 : 4096;
        TaudStemEntry *nl = (TaudStemEntry *)realloc(e->stemLog, sizeof *nl * (size_t)nc);
        if (nl == NULL) { e->oom = true; return; }
        e->stemLog = nl;
        e->stemCap = nc;
    }
    it = &e->stemLog[e->stemCount++];
    it->frame = frame;
    it->lane = lane;
    it->top = v->displayInst != 0 ? v->displayInst : v->instrumentId;
    it->sub = v->instrumentId;
    it->patch = v->activePatchIndex;
    it->pad = 0;
    it->value = value;
}

/* Render one TRACKER_CHUNK into mixLeft/mixRight. */
bool te_generate_tracker_audio(TaudEngine *e)
{
    bool advancing = e->isPlaying;
    TaudSpatialBus *spatial = e->spatial;
    TaudSpatialBus *abus = e->analysisBus;
    double srate = e->rate;
    int n, vi, i, n0 = 0;

    if (spatial != NULL) {
        int c;
        for (c = 0; c < spatial->numChannels * TRACKER_CHUNK; c++) spatial->data[c] = 0.0;
    }
    /* The master strip's analysis bus (item 98): an accumulator like the
     * monitor's, fed with the same sources. */
    if (abus != NULL) memset(abus->data, 0, sizeof(double) * (size_t)(abus->numChannels * TRACKER_CHUNK));
    e->stemCount = 0;

    if (advancing && e->firstRow) {
        e->firstRow = false;
        te_apply_tracker_row(e);
    }

    /* Instrument mixing chains (item 217): bring the route table up to date
     * with the blocks, the records and the channel layout (imixGen counts
     * every change to any of them). */
    if (e->imixSyncedGen != e->imixGen) te_sync_imix_routes(e);

    for (n = 0; n < TRACKER_CHUNK; n++) {
        double spt = (srate * 2.5) / e->bpm;
        double gvol, mvol, master, globalGain;

        /* A tick about to fire ends the span before it. */
        if (n > n0 && e->samplesIntoTick + 1.0 >= spt) {
            finish_span(e, n0, n);
            n0 = n;
        }

        if (advancing) {
            e->samplesIntoTick += 1.0;
            if (e->samplesIntoTick >= spt) {
                e->samplesIntoTick -= spt;
                te_apply_tracker_tick(e);
                e->tickInRow++;
                if (e->tickInRow >= e->tickRate + e->finePatternDelayExtra) {
                    e->tickInRow = 0;
                    te_advance_row(e);
                } else {
                    /* what the row scheduled for the tick now starting (item 232) */
                    te_apply_tick_events(e);
                }
            }
        } else {
            e->samplesIntoTick += 1.0;
            if (e->samplesIntoTick >= spt) {
                e->samplesIntoTick -= spt;
                te_apply_tracker_tick(e);
            }
        }
        /* PSG quarter ticks (§5.5.4): the tick pass ran the first; each later
         * quarter runs at the first frame inside it, while a PSG pair sounds.
         * (The JS cuts its spans there; one frame at a time is the same.) */
        if (te_psg_live(e)) {
            int q = te_psg_quarter_at(e->samplesIntoTick, spt);
            while (e->psgQuarter < q) { e->psgQuarter++; te_psg_quarter_pass(e); }
        }

        /* The song-level gains glide to a new value over the volume ramp
         * (ByteGlide); held still they are the very numbers they always were. */
        gvol = te_byte_glide_next(e, &e->gvolGlide, e->globalVolume) / 255.0;
        mvol = te_byte_glide_next(e, &e->mvolGlide, e->mixingVolume) / 255.0;
        master = te_byte_glide_next(e, &e->masterGlide, e->masterVolume) / 1.0;
        globalGain = (gvol * mvol * master) / 255.0;
        e->gainSpan[n] = globalGain;
        e->accL[n] = 0.0;
        e->accR[n] = 0.0;

        for (vi = 0; vi < TOTAL_VOICES; vi++) {
            TaudVoice *voice = &e->voices[vi];
            TaudInst *inst;
            TaudImixBus *route;
            double pair[2], sL, sR, instGv, swingScale, effEnvVol, fade, faderGain, perVoiceGain, vol;
            double lGain = 0.0, rGain = 0.0, rampGain;
            if (!voice->active || isnan(voice->faderCur)) {
                /* Nothing sounding (or nothing glided yet): the fader is
                 * where the host put it. */
                voice->faderCur = voice->fader; voice->faderAim = voice->fader; voice->faderLeft = 0;
            }
            /* Muted, and the fader's glide down has finished: frozen. */
            if (!voice->active || (voice->fader == 255 && voice->faderCur == 255)) continue;
            inst = &e->instruments[voice->instrumentId];
            te_advance_sample_mod_extended(e, voice, spt);
            render_voice_pair(e, voice, inst, e->interpolationMode, spt, pair, n);
            sL = pair[0];
            sR = pair[1];
            instGv = inst->instGlobalVolume / 255.0;
            swingScale = 1.0 + voice->randomVolBias / 255.0;
            voice->envVolMix += voice->envVolStep;
            effEnvVol = voice->hasVolEnv && voice->volEnvOn ? voice->envVolMix : 1.0;
            te_advance_volume_ramp(e, voice, e->volDiv);
            te_advance_pitch_ramp(e, voice, spt);
            fade = te_advance_fadeout(voice);
            faderGain = (255 - te_advance_fader_ramp(e, voice, voice->fader)) / 255.0;
            /* An OPL voice took its note volume into the operators — unless the
             * chip is operator 0 of a rack, which reads it at unity and leaves
             * the note's volume to the finished patch (§5.5.1). */
            perVoiceGain = effEnvVol * fade *
                (voice->opl != NULL && voice->fmRig == NULL ? 1.0 : voice->currentMixVolume) *
                swingScale * instGv * faderGain * voice->layerMixGain * voice->activeAttenGain;
            vol = perVoiceGain * globalGain;
            if (spatial == NULL) {
                double pan = te_advance_pan_ramp(e, voice, te_voice_pan_byte(voice), false);
                if (pan != voice->panLawPan) {
                    voice->panLawPan = pan;
                    voice->panLawL = js_cos((PI * pan) / 512.0);
                    voice->panLawR = js_sin((PI * pan) / 512.0);
                }
                lGain = voice->panLawL;
                rGain = voice->panLawR;
            } else {
                te_advance_pan_ramp(e, voice, te_voice_azimuth(voice), true);
                te_advance_elev_ramp(e, voice, te_voice_elevation(voice));
            }
            if (voice->rampOutSamples > 0) {
                rampGain = voice->rampOutGain;
                voice->rampOutGain -= voice->rampOutStep;
                voice->rampOutSamples--;
                if (voice->rampOutSamples == 0) voice->active = false;
            } else {
                rampGain = 1.0;
            }
            if (voice->attackRampSamples > 0) {
                rampGain *= attack_gain(e, voice->attackRampSamples);
                voice->attackRampSamples--;
            }
            if (e->stemTap) {
                stem_push(e, n, vi, voice, (voice->activeChanCount == 2 ? (sL + sR) * 0.5 : sL) * vol * rampGain);
            }
            /* An instrument with a mixing chain mixes into its own bus, ahead of
             * the song's global gain — which the bus's output gets instead. */
            route = voice_route(e, voice);
            if (route != NULL) {
                route->fed = true;
                if (spatial == NULL) {
                    route->sb.data[n] += sL * perVoiceGain * lGain * rampGain;
                    route->sb.data[TRACKER_CHUNK + n] += sR * perVoiceGain * rGain * rampGain;
                } else {
                    const double *g = te_spatial_voice_gains(e, voice);
                    te_spatial_bus_add_source(&route->sb, n, sL * perVoiceGain, g, 0, rampGain);
                    if (voice->activeChanCount == 2) {
                        te_spatial_bus_add_source(&route->sb, n, sR * perVoiceGain, g, spatial->numChannels, rampGain);
                    }
                }
            } else if (spatial == NULL) {
                e->accL[n] += sL * vol * lGain * rampGain;
                e->accR[n] += sR * vol * rGain * rampGain;
            } else {
                const double *g = te_spatial_voice_gains(e, voice);
                te_spatial_bus_add_source(spatial, n, sL * vol, g, 0, rampGain);
                if (voice->activeChanCount == 2) {
                    te_spatial_bus_add_source(spatial, n, sR * vol, g, spatial->numChannels, rampGain);
                }
            }
            if (abus != NULL) {
                const double *ag = te_analysis_voice_gains(e, voice);
                te_spatial_bus_add_source(abus, n, sL * vol, ag, 0, rampGain);
                if (voice->activeChanCount == 2) {
                    te_spatial_bus_add_source(abus, n, sR * vol, ag, abus->numChannels, rampGain);
                }
            }
        }

        for (i = 0; i < e->bgCount; i++) {
            TaudVoice *bg = e->bg[i];
            TaudVoice *srcVoice;
            TaudInst *inst;
            TaudImixBus *route;
            int bgFader;
            double pair[2], sL, sR, instGv, swingScale, effEnvVol, fade, faderGain, vol;
            double lGain = 0.0, rGain = 0.0, rampGain;
            if (bg->fmOperator) continue;
            srcVoice = bg->sourceChannel >= 0 && bg->sourceChannel < TOTAL_VOICES ? &e->voices[bg->sourceChannel] : NULL;
            bgFader = srcVoice != NULL && srcVoice->fader > bg->fader ? srcVoice->fader : bg->fader;
            if (!bg->active) continue;
            if (isnan(bg->faderCur)) { bg->faderCur = bgFader; bg->faderAim = bgFader; bg->faderLeft = 0; }
            if (bgFader == 255 && bg->faderCur == 255) continue; /* muted, glide finished */
            inst = &e->instruments[bg->instrumentId];
            if (bg->isLayerChild) te_advance_sample_mod_extended(e, bg, spt);
            render_voice_pair(e, bg, inst, e->interpolationMode, spt, pair, n);
            sL = pair[0];
            sR = pair[1];
            instGv = inst->instGlobalVolume / 255.0;
            swingScale = 1.0 + bg->randomVolBias / 255.0;
            bg->envVolMix += bg->envVolStep;
            effEnvVol = bg->hasVolEnv && bg->volEnvOn ? bg->envVolMix : 1.0;
            te_advance_volume_ramp(e, bg, e->volDiv);
            te_advance_pitch_ramp(e, bg, spt);
            fade = te_advance_fadeout(bg);
            faderGain = (255 - te_advance_fader_ramp(e, bg, bgFader)) / 255.0;
            vol = (effEnvVol * fade *
                   (bg->opl != NULL && bg->fmRig == NULL ? 1.0 : bg->currentMixVolume) *
                   swingScale * gvol * mvol * instGv * faderGain * bg->layerMixGain * bg->activeAttenGain *
                   master) / 255.0;
            if (spatial == NULL) {
                double pan = te_advance_pan_ramp(e, bg, te_voice_pan_byte(bg), false);
                if (pan != bg->panLawPan) {
                    bg->panLawPan = pan;
                    bg->panLawL = js_cos((PI * pan) / 512.0);
                    bg->panLawR = js_sin((PI * pan) / 512.0);
                }
                lGain = bg->panLawL;
                rGain = bg->panLawR;
            } else {
                te_advance_pan_ramp(e, bg, te_voice_azimuth(bg), true);
                te_advance_elev_ramp(e, bg, te_voice_elevation(bg));
            }
            if (bg->rampOutSamples > 0) {
                rampGain = bg->rampOutGain;
                bg->rampOutGain -= bg->rampOutStep;
                bg->rampOutSamples--;
                if (bg->rampOutSamples == 0) bg->active = false;
            } else {
                rampGain = 1.0;
            }
            if (bg->attackRampSamples > 0) {
                rampGain *= attack_gain(e, bg->attackRampSamples);
                bg->attackRampSamples--;
            }
            /* Ghosts and layer children belong to the stem of the lane that spawned them. */
            if (e->stemTap) {
                stem_push(e, n, bg->sourceChannel, bg, (bg->activeChanCount == 2 ? (sL + sR) * 0.5 : sL) * vol * rampGain);
            }
            route = voice_route(e, bg);
            if (route != NULL) {
                /* The same chain without the three song-level gains the bus is ahead of. */
                double bvol = effEnvVol * fade *
                    (bg->opl != NULL && bg->fmRig == NULL ? 1.0 : bg->currentMixVolume) *
                    swingScale * instGv * faderGain * bg->layerMixGain * bg->activeAttenGain;
                route->fed = true;
                if (spatial == NULL) {
                    route->sb.data[n] += sL * bvol * lGain * rampGain;
                    route->sb.data[TRACKER_CHUNK + n] += sR * bvol * rGain * rampGain;
                } else {
                    const double *g = te_spatial_voice_gains(e, bg);
                    te_spatial_bus_add_source(&route->sb, n, sL * bvol, g, 0, rampGain);
                    if (bg->activeChanCount == 2) {
                        te_spatial_bus_add_source(&route->sb, n, sR * bvol, g, spatial->numChannels, rampGain);
                    }
                }
            } else if (spatial == NULL) {
                e->accL[n] += sL * vol * lGain * rampGain;
                e->accR[n] += sR * vol * rGain * rampGain;
            } else {
                const double *g = te_spatial_voice_gains(e, bg);
                te_spatial_bus_add_source(spatial, n, sL * vol, g, 0, rampGain);
                if (bg->activeChanCount == 2) {
                    te_spatial_bus_add_source(spatial, n, sR * vol, g, spatial->numChannels, rampGain);
                }
            }
            if (abus != NULL) {
                const double *ag = te_analysis_voice_gains(e, bg);
                te_spatial_bus_add_source(abus, n, sL * vol, ag, 0, rampGain);
                if (bg->activeChanCount == 2) {
                    te_spatial_bus_add_source(abus, n, sR * vol, ag, abus->numChannels, rampGain);
                }
            }
        }
    }
    finish_span(e, n0, TRACKER_CHUNK);

    if (e->preTap) {
        memcpy(e->preLeft, e->mixLeft, sizeof e->preLeft);
        memcpy(e->preRight, e->mixRight, sizeof e->preRight);
    }
    if (e->mastering != NULL) te_master_chain_process(e->mastering, e->mixLeft, e->mixRight, TRACKER_CHUNK);
    /* The OPL chip clock (item 209) counts the frames this playhead has mixed. */
    e->oplFrame += TRACKER_CHUNK;
    for (n = 0; n < TRACKER_CHUNK; n++) {
        float fl = e->mixLeft[n], fr = e->mixRight[n];
        if (fl < -1.0f) e->mixLeft[n] = -1.0f; else if (fl > 1.0f) e->mixLeft[n] = 1.0f;
        if (fr < -1.0f) e->mixRight[n] = -1.0f; else if (fr > 1.0f) e->mixRight[n] = 1.0f;
    }

    /* A halt cue clears isPlaying mid-chunk: end the song's voices here —
     * ramped while an audition keeps the mix running. */
    if (advancing && !e->isPlaying) te_silence_song_voices(e, e->jamActive);

    /* Stop the jam-render spin once the audition has gone fully silent. */
    if (e->jamActive && !e->isPlaying) {
        bool sounding = false;
        for (vi = 0; vi < TOTAL_VOICES && !sounding; vi++) sounding = e->voices[vi].active;
        for (i = 0; i < e->bgCount && !sounding; i++) sounding = e->bg[i]->active;
        if (!sounding) e->jamActive = false;
    }
    return true;
}
