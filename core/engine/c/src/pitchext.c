/* The pitch extension — the `IPit` section (file format §9.18).
 *
 * An instrument's pitch fields are sixteen bits each: 4096 steps to the
 * octave over sixteen octaves. `IPit` gives a field one more byte, `oooo
 * ffff`: four more bits of fraction below it (65536 steps to the octave, the
 * cell's own grid) and four more bits of octave above it, as a two's-
 * complement nibble. The value of an extended field, in 65536-TET units, is
 *
 *     field × 16 + ffff + oooo × 2^20
 *
 * with the field read as it always was — so a zero byte changes nothing, and
 * a file that needs none of this has no section. The engine keeps a field's
 * sixteen bits where they were and the extension beside them as a DELTA in
 * its own units (4096-TET, a double): 0 wherever there is none.
 *
 * A range's HIGH bound keeps its fraction complemented: unextended, the
 * bound covers the whole of the unit it names, and the engine's test is
 * against the exclusive end `pitchEnd + 1 + dHi` (te_pitch_in_range).
 *
 * An entry carries a guard, a CRC-16 of the sixteen-bit fields it extends. An
 * editor that does not know the section keeps it while it rewrites the
 * instruments under it; an entry whose guard no longer matches is ignored
 * whole, and the instrument plays its sixteen-bit values. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

#define IPIT_BASE 0x04
#define IPIT_TABLE 0x08
#define IPIT_PATCHES 0x10
#define IPIT_RESERVED 0xe0

typedef struct TaudPitchExt {
    uint8_t flags;
    uint16_t guard;
    uint8_t base[3];            /* sample detune, pitch-pan centre, the kind's own field */
    int tableN, patchN;
    uint8_t data[];             /* tableN × 3 (detune, low, high), then patchN × 3 (start, end, detune) */
} TaudPitchExt;

/* oooo, as sixteen-octave steps in 4096-TET units. */
static double ext_octaves(uint8_t x)
{
    int o = x >> 4;
    if (o >= 8) o -= 16;
    return o * 65536.0;
}
/* What a byte adds to its field… */
static double ext_delta(uint8_t x) { return ext_octaves(x) + (x & 15) / 16.0; }
/* …and to the exclusive end of a range, whose fraction is kept complemented. */
static double ext_delta_high(uint8_t x) { return ext_octaves(x) - (x & 15) / 16.0; }

/* CRC-16/CCITT-FALSE: polynomial $1021, initial value $FFFF, no reflection. */
static uint16_t crc16(uint16_t crc, const uint8_t *p, size_t n)
{
    size_t i;
    int b;
    for (i = 0; i < n; i++) {
        crc ^= (uint16_t)(p[i] << 8);
        for (b = 0; b < 8; b++) crc = (uint16_t)((crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1);
    }
    return crc;
}
static uint16_t crc16_word(uint16_t crc, int word)
{
    uint8_t le[2];
    le[0] = (uint8_t)(word & 0xff);
    le[1] = (uint8_t)((word >> 8) & 0xff);
    return crc16(crc, le, 2);
}

/* The sixteen-bit word of the pitch field an instrument's KIND keeps in its
 * own block: a formant instrument's reference word, an OPL instrument's
 * rhythm-partner pitch; 0 for a kind with none. */
static int kind_pitch_word(const TaudInst *inst)
{
    if (inst->formant != NULL) return (inst->formant->refNote & 0x7fff) | (inst->formant->nasal ? 0x8000 : 0);
    if (inst->opl != NULL) return inst->opl->partnerDetune & 0xffff;
    return 0;
}

void te_pitch_ext_free(TaudEngine *e)
{
    int i;
    if (e->pitchExt == NULL) return;
    for (i = 0; i < 1024; i++) free(e->pitchExt[i]);
    free(e->pitchExt);
    e->pitchExt = NULL;
}

/* Bring one instrument's deltas in line with its entry: cleared, then — when
 * there is an entry, its groups fit the instrument as it is now and its guard
 * matches — set. Called whenever the instrument's record, its patch list or
 * the section is (re)loaded, in whatever order a host does those. */
void te_apply_pitch_ext(TaudEngine *e, TaudInst *inst)
{
    const TaudPitchExt *x;
    const uint8_t *table, *patch;
    bool tabled = inst->meta != NULL &&
        (inst->meta->type == META_TYPE_LAYERED || inst->meta->type == META_TYPE_FM);
    uint16_t crc = 0xffff;
    int i;

    inst->dSampleDetune = 0.0;
    inst->dPitchPanCentre = 0.0;
    if (inst->opl != NULL) inst->opl->dPartnerDetune = 0.0;
    if (inst->formant != NULL) {
        bool had = inst->formant->dRefNote != 0.0;
        inst->formant->dRefNote = 0.0;
        if (had && inst->lyric != NULL) te_inst_refresh_lyric(inst);
    }
    if (inst->meta != NULL) {
        for (i = 0; i < inst->meta->count; i++) {
            TaudMetaLayer *l = &inst->meta->layers[i];
            l->dLo = l->dHi = l->dDetune = 0.0;
        }
    }
    for (i = 0; i < inst->patchCount; i++) {
        TaudPatch *p = &inst->extraPatches[i];
        p->dLo = p->dHi = p->dDetune = 0.0;
    }

    if (e->pitchExt == NULL || inst->index < 0 || inst->index > 1023) return;
    x = e->pitchExt[inst->index];
    if (x == NULL) return;
    /* A group must be about what the instrument HAS: a table record has no
     * base fields (its bytes are entries), and the counts are the record's. */
    if ((x->flags & IPIT_BASE) != 0 && tabled) return;
    if ((x->flags & IPIT_TABLE) != 0 && (!tabled || x->tableN != inst->meta->rawCount)) return;
    if ((x->flags & IPIT_PATCHES) != 0 && x->patchN != inst->patchCount) return;

    if ((x->flags & IPIT_BASE) != 0) {
        crc = crc16_word(crc, inst->sampleDetune);
        crc = crc16_word(crc, inst->pitchPanCentre);
        crc = crc16_word(crc, kind_pitch_word(inst));
    }
    if ((x->flags & IPIT_TABLE) != 0) crc = crc16(crc, inst->meta->rawPitch, (size_t)x->tableN * 6);
    if ((x->flags & IPIT_PATCHES) != 0) {
        for (i = 0; i < inst->patchCount; i++) {
            const TaudPatch *p = &inst->extraPatches[i];
            crc = crc16_word(crc, p->pitchStart);
            crc = crc16_word(crc, p->pitchEnd);
            crc = crc16_word(crc, p->sampleDetune);
        }
    }
    if (crc != x->guard) return;

    table = x->data;
    patch = x->data + (size_t)x->tableN * 3;
    if ((x->flags & IPIT_BASE) != 0) {
        inst->dSampleDetune = ext_delta(x->base[0]);
        inst->dPitchPanCentre = ext_delta(x->base[1]);
        if (inst->opl != NULL) inst->opl->dPartnerDetune = ext_delta(x->base[2]);
        if (inst->formant != NULL) {
            inst->formant->dRefNote = ext_delta(x->base[2]);
            /* A lyric instrument's syllables carry the record's reference note. */
            if (inst->lyric != NULL) te_inst_refresh_lyric(inst);
        }
    }
    if ((x->flags & IPIT_TABLE) != 0) {
        for (i = 0; i < inst->meta->count; i++) {
            TaudMetaLayer *l = &inst->meta->layers[i];
            const uint8_t *b = table + (size_t)l->srcIndex * 3;
            l->dDetune = ext_delta(b[0]);
            l->dLo = ext_delta(b[1]);
            l->dHi = ext_delta_high(b[2]);
        }
    }
    if ((x->flags & IPIT_PATCHES) != 0) {
        for (i = 0; i < inst->patchCount; i++) {
            TaudPatch *p = &inst->extraPatches[i];
            const uint8_t *b = patch + (size_t)i * 3;
            p->dLo = ext_delta(b[0]);
            p->dHi = ext_delta_high(b[1]);
            p->dDetune = ext_delta(b[2]);
        }
    }
}

/* Install the whole `IPit` payload (len 0 = none) and apply it. An entry the
 * section cannot finish — a reserved flag, a group that runs off the end —
 * ends the read: what came before it stands. Two entries for one instrument
 * are INVALID, and the later one wins. */
void te_set_pitch_ext(TaudEngine *e, const uint8_t *s, size_t len)
{
    size_t o = 0;
    int i;
    te_pitch_ext_free(e);
    if (len >= 4) {
        e->pitchExt = (TaudPitchExt **)calloc(1024, sizeof *e->pitchExt);
        if (e->pitchExt == NULL) e->oom = true;
    }
    while (e->pitchExt != NULL && o + 4 <= len) {
        int flags = s[o + 1];
        int id = s[o] | ((flags & 0x03) << 8);
        int guard = s[o + 2] | (s[o + 3] << 8);
        int tableN = 0, patchN = 0;
        const uint8_t *base = NULL, *table = NULL, *patch = NULL;
        TaudPitchExt *x;
        size_t p = o + 4;
        if ((flags & IPIT_RESERVED) != 0) break;
        if ((flags & IPIT_BASE) != 0) {
            if (p + 3 > len) break;
            base = s + p;
            p += 3;
        }
        if ((flags & IPIT_TABLE) != 0) {
            if (p + 1 > len) break;
            tableN = s[p];
            if (p + 1 + (size_t)tableN * 3 > len) break;
            table = s + p + 1;
            p += 1 + (size_t)tableN * 3;
        }
        if ((flags & IPIT_PATCHES) != 0) {
            if (p + 2 > len) break;
            patchN = s[p] | (s[p + 1] << 8);
            if (p + 2 + (size_t)patchN * 3 > len) break;
            patch = s + p + 2;
            p += 2 + (size_t)patchN * 3;
        }
        x = (TaudPitchExt *)malloc(sizeof *x + ((size_t)tableN + (size_t)patchN) * 3);
        if (x == NULL) { e->oom = true; break; }
        x->flags = (uint8_t)flags;
        x->guard = (uint16_t)guard;
        x->tableN = tableN;
        x->patchN = patchN;
        memset(x->base, 0, sizeof x->base);
        if (base != NULL) memcpy(x->base, base, 3);
        if (table != NULL) memcpy(x->data, table, (size_t)tableN * 3);
        if (patch != NULL) memcpy(x->data + (size_t)tableN * 3, patch, (size_t)patchN * 3);
        free(e->pitchExt[id]);
        e->pitchExt[id] = x;
        o = p;
    }
    for (i = 0; i < 1024; i++) te_apply_pitch_ext(e, &e->instruments[i]);
}
