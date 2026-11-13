/* The Mixing tab's meter tap (item 217) — port of imix.js ImixMeterTap and of
 * engine-commands.js fillImixSeatInto, which drains it into the snapshot.
 *
 * One tap per seat (split pane) meters ONE instrument's bus: the mixer hands
 * it the bus as it enters its chain and as it leaves, the chain rings the
 * input of each tapped piece while it runs (te_imix_tap_stage_in), and the
 * snapshot takes the interval's figures and starts the next interval. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"
#include "snap_layout.h"

#define TAP_PRE 0
#define TAP_POST 1

/* The pieces whose input is rung, in the readout's order (IMX_TAP_STAGES). */
static const int TAP_STAGES[IMX_TAP_STAGE_COUNT] = { IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2 };

/* Fold one frame of a bus to the stereo pair the meters read: the pair
 * itself, or — for an ambisonic or a binaural scene — the coincident cardioid
 * pair W ± Y (imxMeterPair). The binaural decode is not called: its
 * convolution history belongs to the master bus. */
static void meter_pair(const TaudImixBus *bus, int n, double out[2])
{
    const double *d = bus->sb.data;
    if (bus->stereo || bus->nch == 2) {
        out[0] = d[n];
        out[1] = d[TRACKER_CHUNK + n];
    } else if (bus->sb.kind == RENDER_SPEAKERS) {
        /* A speaker layout's own monitor fold (stateless). */
        double l = 0.0, r = 0.0;
        int c;
        for (c = 0; c < bus->nch; c++) {
            double v = d[c * TRACKER_CHUNK + n];
            l += v * bus->sb.monitorGains[c * 2];
            r += v * bus->sb.monitorGains[c * 2 + 1];
        }
        out[0] = l;
        out[1] = r;
    } else {
        double w = d[n], y = d[TRACKER_CHUNK + n];
        out[0] = 0.5 * (w + y);
        out[1] = 0.5 * (w - y);
    }
}

static void clear_interval(TaudImixTap *t)
{
    int k;
    memset(t->peak, 0, sizeof t->peak);
    memset(t->truePeak, 0, sizeof t->truePeak);
    memset(t->sumSq, 0, sizeof t->sumSq);
    memset(t->clip, 0, sizeof t->clip);
    t->frames = 0;
    memset(&t->gr, 0, sizeof t->gr);
    t->gr.expdLvl = -120;
    for (k = 0; k < IMX_COMP_MAX_BANDS; k++) t->gr.compLvl[k] = -120;
    for (k = 0; k < IMX_DEQ_BANDS; k++) t->gr.deq1Lvl[k] = t->gr.deq2Lvl[k] = -120;
    t->unisLive = false;
}

void te_imix_tap_reset_all(TaudImixTap *t)
{
    memset(t->ring, 0, sizeof t->ring);
    memset(t->ringPre, 0, sizeof t->ringPre);
    memset(t->stageRings, 0, sizeof t->stageRings);
    memset(t->stageWrite, 0, sizeof t->stageWrite);
    t->write = 0;
    t->preWrite = 0;
    memset(t->probes, 0, sizeof t->probes);
    clear_interval(t);
}

static TaudImixTap *tap_new(int slot)
{
    TaudImixTap *t = (TaudImixTap *)calloc(1, sizeof *t);
    if (t == NULL) return NULL;
    t->slot = slot;
    te_tp_coef(t->tpCoef);
    clear_interval(t);
    return t;
}

/* Install (or drop, with a negative slot) the tap on one instrument's bus, in
 * `seat`. Asking again for the slot a seat already meters keeps its tap. */
void te_set_imix_meter(TaudEngine *e, int slot, int seat)
{
    if (seat < 0 || seat >= IMX_METER_SEATS) return;
    if (slot < 0) {
        free(e->imixMeters[seat]);
        e->imixMeters[seat] = NULL;
        return;
    }
    if (e->imixMeters[seat] == NULL || e->imixMeters[seat]->slot != slot) {
        TaudImixTap *t = tap_new(slot);
        if (t == NULL) { e->oom = true; return; }
        free(e->imixMeters[seat]);
        e->imixMeters[seat] = t;
    }
}

static void tap_stage(TaudImixTap *t, int stage, const TaudImixBus *bus, int n0, int n1)
{
    double pair[2];
    int base = stage * 2, n, c;
    for (n = n0; n < n1; n++) {
        meter_pair(bus, n, pair);
        for (c = 0; c < 2; c++) {
            double x = pair[c];
            double a = x < 0 ? -x : x;
            int i = base + c;
            double tp;
            if (a > t->peak[i]) t->peak[i] = a;
            tp = te_tp_push(&t->probes[i], t->tpCoef, x);
            if (tp > t->truePeak[i]) t->truePeak[i] = tp;
            t->sumSq[i] += x * x;
            if (a >= 1) t->clip[i] += 1;
        }
        if (stage == TAP_POST) {
            int w = t->write;
            t->ring[w * 2] = (float)pair[0];
            t->ring[w * 2 + 1] = (float)pair[1];
            t->write = (w + 1) & (IMX_RING_FRAMES - 1);
        } else {
            t->ringPre[t->preWrite] = (float)((pair[0] + pair[1]) * 0.5);
            t->preWrite = (t->preWrite + 1) & (IMX_RING_FRAMES - 1);
        }
    }
}

/* The bus as it enters the chain. */
void te_imix_tap_push_pre(TaudImixTap *t, const TaudImixBus *bus, int n0, int n1)
{
    t->bus = bus;
    tap_stage(t, TAP_PRE, bus, n0, n1);
}

/* The chain's probe: piece `kind` is about to process [n0, n1) of the bus. */
void te_imix_tap_stage_in(TaudImixTap *t, int kind, int n0, int n1)
{
    double pair[2];
    float *ring;
    int k, n, w;
    if (t->bus == NULL) return;
    for (k = 0; k < IMX_TAP_STAGE_COUNT; k++) if (TAP_STAGES[k] == kind) break;
    if (k == IMX_TAP_STAGE_COUNT) return;
    ring = t->stageRings[k];
    w = t->stageWrite[k];
    for (n = n0; n < n1; n++) {
        meter_pair(t->bus, n, pair);
        ring[w] = (float)((pair[0] + pair[1]) * 0.5);
        w = (w + 1) & (IMX_RING_FRAMES - 1);
    }
    t->stageWrite[k] = w;
}

/* …and as it leaves, with the chain's gain reductions over the span. */
void te_imix_tap_push_post(TaudImixTap *t, const TaudImixBus *bus, int n0, int n1)
{
    TaudImxGr g;
    TaudImxGr *gr = &t->gr;
    double cents, width;
    int i;
    tap_stage(t, TAP_POST, bus, n0, n1);
    t->frames += n1 - n0;
    te_imx_chain_read_gr(bus->chain, &g);
    for (i = 0; i < IMX_COMP_MAX_BANDS; i++) if (g.comp[i] < gr->comp[i]) gr->comp[i] = g.comp[i];
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        if (fabs(g.deq1[i]) > fabs(gr->deq1[i])) gr->deq1[i] = g.deq1[i];
        if (fabs(g.deq2[i]) > fabs(gr->deq2[i])) gr->deq2[i] = g.deq2[i];
    }
    for (i = 0; i < IMX_TSH_MAX_BANDS; i++) if (fabs(g.tsh1[i]) > fabs(gr->tsh1[i])) gr->tsh1[i] = g.tsh1[i];
    if (g.lim < gr->lim) gr->lim = g.lim;
    if (g.expd < gr->expd) gr->expd = g.expd;
    if (g.expdLvl > gr->expdLvl) gr->expdLvl = g.expdLvl;
    for (i = 0; i < IMX_COMP_MAX_BANDS; i++) if (g.compLvl[i] > gr->compLvl[i]) gr->compLvl[i] = g.compLvl[i];
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        if (g.deq1Lvl[i] > gr->deq1Lvl[i]) gr->deq1Lvl[i] = g.deq1Lvl[i];
        if (g.deq2Lvl[i] > gr->deq2Lvl[i]) gr->deq2Lvl[i] = g.deq2Lvl[i];
    }
    if (te_imx_chain_unison_now(bus->chain, &cents, &width)) {
        t->unisLive = true;
        t->unisCents = cents;
        t->unisWidth = width;
    }
}

/* One seat's block at `b` (fillImixSeatInto): the interval's figures, then the
 * next interval starts. With the seat's tap off only the "no frames" marker
 * is written. */
static void fill_seat(TaudImixTap *t, float *b)
{
    int i, k;
    if (t == NULL) {
        b[SNAP_IM_FRAMES] = 0.0f;
        b[SNAP_IM_SLOT] = -1.0f;
        return;
    }
    b[SNAP_IM_FRAMES] = (float)t->frames;
    b[SNAP_IM_SLOT] = (float)t->slot;
    b[SNAP_IM_RING_WRITE] = (float)t->write;
    b[SNAP_IM_LIM_GR] = (float)t->gr.lim;
    for (i = 0; i < IMX_COMP_MAX_BANDS; i++) b[SNAP_IM_COMP_GR + i] = (float)t->gr.comp[i];
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        b[SNAP_IM_DEQ1 + i] = (float)t->gr.deq1[i];
        b[SNAP_IM_DEQ2 + i] = (float)t->gr.deq2[i];
    }
    for (i = 0; i < 4; i++) {
        float *o = b + SNAP_IM_LEVELS + i * SNAP_MM_C_STRIDE;
        o[SNAP_MM_C_PEAK] = (float)t->peak[i];
        o[SNAP_MM_C_TRUE_PEAK] = (float)t->truePeak[i];
        o[SNAP_MM_C_MEAN_SQUARE] = (float)(t->frames > 0 ? t->sumSq[i] / t->frames : 0);
        o[SNAP_MM_C_CLIP] = (float)t->clip[i];
    }
    memcpy(b + SNAP_IM_RING, t->ring, sizeof t->ring);
    memcpy(b + SNAP_IM_RING_PRE, t->ringPre, sizeof t->ringPre);
    b[SNAP_IM_UNIS_CENTS] = (float)(t->unisLive ? t->unisCents : -1);
    b[SNAP_IM_UNIS_WIDTH] = (float)t->unisWidth;
    for (i = 0; i < IMX_COMP_MAX_BANDS; i++) b[SNAP_IM_COMP_LVL + i] = (float)t->gr.compLvl[i];
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        b[SNAP_IM_DEQ1_LVL + i] = (float)t->gr.deq1Lvl[i];
        b[SNAP_IM_DEQ2_LVL + i] = (float)t->gr.deq2Lvl[i];
    }
    for (i = 0; i < IMX_TSH_MAX_BANDS; i++) b[SNAP_IM_TSH1 + i] = (float)t->gr.tsh1[i];
    b[SNAP_IM_EXPD_GR] = (float)t->gr.expd;
    b[SNAP_IM_EXPD_LVL] = (float)t->gr.expdLvl;
    for (k = 0; k < IMX_TAP_STAGE_COUNT; k++) {
        b[SNAP_IM_STAGE_WRITE + k] = (float)t->stageWrite[k];
        memcpy(b + SNAP_IM_STAGE_RINGS + k * SNAP_IM_RING_FRAMES, t->stageRings[k], sizeof t->stageRings[k]);
    }
    clear_interval(t);
}

/* Every seat's block into the snapshot, each SNAP_IM_STRIDE apart. */
void te_fill_imix_meters(TaudEngine *e, float *f)
{
    int s;
    for (s = 0; s < SNAP_IM_SEATS; s++) fill_seat(e->imixMeters[s], f + SNAP_IM_BASE + s * SNAP_IM_STRIDE);
}
