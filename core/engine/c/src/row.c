/* Row processing + cue advance — port of row.js. */

#include "taud_internal.h"

/* The argument an Int0..IntF marker on this row carries: the first `:`. */
static int interrupt_arg_of(const TaudEngine *e, const TaudCell *row)
{
    if (row->effect == OP_COLON) return row->effectArg & 0xffff;
    if (e->ts_wideCells && row->effect2 == OP_COLON) return row->effectArg2 & 0xffff;
    return 0;
}

/* This row's S $Dxny argument (first slot wins), or -1. */
static int s_delay_arg(const TaudEngine *e, const TaudCell *row)
{
    if (row->effect == OP_S && ((row->effectArg >> 12) & 0xf) == 0xd) return row->effectArg;
    if (e->ts_wideCells && row->effect2 == OP_S && ((row->effectArg2 >> 12) & 0xf) == 0xd) return row->effectArg2;
    return -1;
}

static void schedule_dxny_action(TaudVoice *v, int sArg, int delayTick)
{
    int y;
    if (sArg < 0) return;
    y = sArg & 0xf;
    if (y == 0) return;
    v->noteActionTick = delayTick + y;
    v->delayedAction = (sArg >> 4) & 0xf;
}

/* "Instrument byte without retrigger" (no-note-inst and porta+inst rows). */
static void apply_instrument_change(TaudEngine *e, TaudVoice *v, const TaudInst *newInst,
                                    const TaudPatch *newPatch, bool reAttack, bool mayCarry)
{
    int seedVol;
    const TaudInst *formantChip;
    const TaudFormantPatch *tract;
    te_apply_active_sample(v, newInst, newPatch);
    /* A formant instrument sung from a chip instrument takes the chip's C2SPD
     * where its sample's rate would be, as on a trigger (trigger.c). */
    formantChip = newInst->formant != NULL ? te_formant_chip_source(e, newInst) : NULL;
    if (formantChip != NULL) v->activeSamplingRate = te_formant_chip_rate(formantChip);
    /* An OPL voice takes the new patch onto the channel it is sounding; on a
     * porta row the instrument byte re-attacks its envelopes without
     * restarting the phase (§5.5.2). A sampled note handed an OPL instrument
     * gets a fresh channel, keyed at the note it is already playing. */
    if (newInst->opl != NULL && v->opl != NULL) {
        v->opl->patch = newInst->opl;
        v->opl->gen = -1;
        if (reAttack) te_opl_reattack(v->opl);
    } else if (newInst->opl != NULL) {
        v->opl = &v->oplStore;
        te_opl_state_init(v->opl);
        te_opl_key_on(v->opl, newInst->opl, false);
    } else {
        v->opl = NULL;
    }
    /* A PSG pair takes a new patch the same way, its internal status kept. */
    if (newInst->psg != NULL && v->psg != NULL) {
        v->psg->patch = newInst->psg;
        v->psg->gen = -1;
        if (reAttack) te_psg_reattack(v->psg);
    } else if (newInst->psg != NULL) {
        v->psg = &v->psgStore;
        te_psg_state_init(v->psg);
        te_psg_key_on(v->psg, newInst->psg, false);
    } else {
        v->psg = NULL;
    }
    /* A formant voice keeps saying its syllable under the new record's tract;
     * a sampled note handed one starts its tract at the vowel. Its source
     * follows the record, a chip channel taking a new patch where it stands.
     *
     * A LYRIC instrument's byte starts its lyrics over. The tract it hands
     * over is the syllable the note is already singing, when that is one of
     * this instrument's; otherwise its first syllable. */
    tract = newInst->formant;
    if (newInst->lyric != NULL) {
        const TaudFormantPatch *cur = v->formant != NULL ? v->formant->patch : NULL;
        v->lyricPos = 0;
        tract = cur != NULL && cur->lyricOf == newInst->formant ? cur : &newInst->lyric[0];
    }
    if (newInst->formant != NULL && v->formant != NULL) {
        te_formant_relatch(e, v->formant, tract);
        te_formant_relatch_source(v->formant, formantChip);
    } else if (newInst->formant != NULL) {
        v->formant = &v->formantStore;
        te_formant_state_init(v->formant);
        te_formant_start_at_vowel(e, v->formant, tract, false);
        te_formant_key_source(v->formant, formantChip);
    } else {
        v->formant = NULL;
    }
    seedVol = te_row_volume_from_default(newInst, newPatch, e->volMax);
    v->noteVolume = seedVol;
    v->rowVolume = seedVol;
    v->keyOff = false;
    v->noteFading = false;
    v->fadeoutVolume = 1.0;
    v->fadeoutMix = 1.0;
    v->fadeoutMixStep = 0.0;
    if (!reAttack) return;
    if (!(mayCarry && te_env_carry(v->activeVolEnvLoop))) {
        v->envIndex = 0;
        v->envTimeSec = 0.0;
        v->envVolume = dclamp(v->activeVolEnv[0].value / (double)v->activeVolEnvMax, 0.0, 1.0);
    }
    v->hasPanEnv = te_env_present(v->activePanEnvLoop);
    if (!(mayCarry && te_env_carry(v->activePanEnvLoop))) {
        v->envPanIndex = 0;
        v->envPanTimeSec = 0.0;
        v->envPan = v->activePanEnv[0].value / 255.0;
    }
    if (!v->hasPitchEnv) {
        v->envPitchValue = 0.5; v->envPitchIndex = 0; v->envPitchTimeSec = 0.0;
    } else if (!(mayCarry && te_env_carry(v->activePitchEnvLoop))) {
        v->envPitchValue = te_seed_pf_role(v->activePitchEnv, v->activePitchEnvLoop,
            v->activePitchEnvSustain, &v->envPitchIndex, &v->envPitchTimeSec);
    }
    if (!v->hasFilterEnv) {
        v->envFilterValue = 0.5; v->envFilterIndex = 0; v->envFilterTimeSec = 0.0;
    } else if (!(mayCarry && te_env_carry(v->activeFilterEnvLoop))) {
        v->envFilterValue = te_seed_pf_role(v->activeFilterEnv, v->activeFilterEnvLoop,
            v->activeFilterEnvSustain, &v->envFilterIndex, &v->envFilterTimeSec);
    }
}

int te_cue_row_limit(const TaudCue *c)
{
    int a = c->inst0.type == INST_PATLEN || c->inst0.type == INST_HALTAT ? c->inst0.rows : 64;
    int b = c->inst1.type == INST_PATLEN || c->inst1.type == INST_HALTAT ? c->inst1.rows : 64;
    return imin(a, b);
}

static void defer_note(TaudVoice *v, int tick, int note)
{
    v->noteDelayTick = tick;
    v->delayedNote = note;
    v->delayedInst = 0;
    v->delayedVol = -1;
}

void te_apply_tracker_row(TaudEngine *e)
{
    const TaudCue *cue = te_cue_at(e, e->cuePos);
    int channels = te_channel_count(e), vi;
    if (!e->patternDelayActive) e->sexWinningChannel = -1;
    e->finePatternDelayExtra = 0;

    for (vi = 0; vi < channels; vi++) {
        int patNum = cue->raw[vi] & 0x7fff;
        int patIdx, n, dittoArmRow, sArg, sDelayTick;
        double note;
        const TaudCell *rows, *rawRow, *row;
        TaudCell dittoRow;
        TaudVoice *voice;
        bool isArmer, toneG;
        int ext1 = 0, ext2 = 0;
        bool hasExt1 = false, hasExt2 = false;

        if (patNum == PATTERN_EMPTY) continue;
        patIdx = iclamp(patNum, 0, NUM_PATTERNS - 1);
        rows = te_pattern_read(e, patIdx);
        rawRow = &rows[e->rowIndex];
        voice = &e->voices[vi];

        /* ── Pattern Ditto (effect 7) row-time expansion ── */
        n = e->rowIndex;
        isArmer = rawRow->effect == OP_7 && rawRow->effectArg != 0;
        if (isArmer) {
            int length = (rawRow->effectArg >> 8) & 0xff;
            int repeats = rawRow->effectArg & 0xff;
            if (length > 0 && repeats > 0 && length <= n) {
                int patLen = te_cue_row_limit(cue);
                voice->dittoSourceStart = n - length;
                voice->dittoLength = length;
                voice->dittoEndRow = imin(n + length * repeats - 1, patLen - 1);
                voice->dittoActive = true;
            }
        }

        dittoArmRow = voice->dittoSourceStart + voice->dittoLength;
        if (voice->dittoActive && n >= dittoArmRow && n <= voice->dittoEndRow) {
            int rel = (n - voice->dittoSourceStart) % voice->dittoLength;
            const TaudCell *src = &rows[voice->dittoSourceStart + rel];
            bool volIsSet = !(rawRow->volumeEff == 3 && rawRow->volume == 0);
            bool panIsSet = e->ts_wideCells
                ? !(rawRow->panEff == 3 && rawRow->azimuth == 0 && rawRow->elevation == 0)
                : !(rawRow->panEff == 3 && rawRow->pan == 0);
            int destOp = isArmer ? 0 : rawRow->effect;
            int destArg = isArmer ? 0 : rawRow->effectArg;
            int effOp, effArg;
            bool dittoUsedSrc;
            if (destOp != 0) { effOp = destOp; effArg = destArg; }
            else if (src->effect != OP_7) { effOp = src->effect; effArg = src->effectArg; }
            else { effOp = 0; effArg = 0; }

            /* The note travels whole: its word and its sixteenths. */
            dittoRow.note = rawRow->note != 0 ? rawRow->note : src->note;
            dittoRow.noteFine = rawRow->note != 0 ? rawRow->noteFine : src->noteFine;
            dittoRow.noteFrac = rawRow->note != 0 ? rawRow->noteFrac : src->noteFrac;
            dittoRow.instrment = rawRow->instrment != 0 ? rawRow->instrment : src->instrment;
            dittoRow.volume = volIsSet ? rawRow->volume : src->volume;
            dittoRow.volumeEff = volIsSet ? rawRow->volumeEff : src->volumeEff;
            dittoRow.pan = panIsSet ? rawRow->pan : src->pan;
            dittoRow.panEff = panIsSet ? rawRow->panEff : src->panEff;
            dittoRow.azimuth = panIsSet ? rawRow->azimuth : src->azimuth;
            dittoRow.elevation = panIsSet ? rawRow->elevation : src->elevation;
            dittoRow.effect = effOp;
            dittoRow.effectArg = effArg;
            dittoUsedSrc = destOp == 0 && effOp != 0;
            dittoRow.effect2 = dittoUsedSrc ? src->effect2 : rawRow->effect2;
            dittoRow.effectArg2 = dittoUsedSrc ? src->effectArg2 : rawRow->effectArg2;
            row = &dittoRow;
        } else {
            row = rawRow;
        }

        /* Reset per-row transient state. */
        voice->cutAtTick = -1;
        voice->noteDelayTick = -1;
        voice->noteActionTick = -1;
        voice->delayedAction = -1;
        voice->slideMode = 0;
        voice->slideArg = 0;
        voice->arpActive = false;
        voice->tremorOn = 0;
        voice->vibratoActive = false;
        voice->tremoloActive = false;
        voice->panbrelloActive = false;
        voice->retrigActive = false;
        voice->tempoSlideDir = 0;
        voice->wSlideDir = 0;
        voice->volColSlideUp = 0; voice->volColSlideDown = 0;
        voice->panColSlideRight = 0; voice->panColSlideLeft = 0;
        voice->chanPanSlideRight = 0; voice->chanPanSlideLeft = 0;
        voice->spatialSlideActive = false;
        voice->nSlideDir = 0;
        voice->rowEffect = row->effect;
        voice->rowEffectArg = row->effectArg;
        voice->rowVolume = voice->noteVolume;

        /* ── Note ── */
        toneG = row->effect == OP_G || row->effect == OP_L;
        note = te_cell_note(row);
        sArg = s_delay_arg(e, row);
        sDelayTick = sArg < 0 ? 0 : (sArg >> 8) & 0xf;

        if (note == 0x0000) {
            bool pitchFx = row->effect == OP_E || row->effect == OP_F || row->effect == OP_G;
            if (row->instrment != 0 && pitchFx && voice->noteVal >= 0x20) {
                int trigVol = row->volumeEff == 0 ? row->volume : -1;
                te_apply_duplicate_check(e, vi, row->instrment, voice->noteVal);
                te_maybe_spawn_background_for_nna(e, voice, vi, row->instrment);
                te_trigger_meta_or_note(e, voice, vi, voice->noteVal, row->instrment, trigVol, true, false);
            } else if (row->instrment != 0 && !inst_is_meta(&e->instruments[row->instrment])) {
                const TaudInst *newInst;
                const TaudPatch *newPatch;
                voice->instrumentId = row->instrment;
                newInst = &e->instruments[voice->instrumentId];
                newPatch = te_inst_resolve_patch(newInst, voice->noteVal, te_narrow_vol_axis(e, voice->noteVolume));
                apply_instrument_change(e, voice, newInst, newPatch, false, false);
            }
            schedule_dxny_action(voice, sArg, sDelayTick);
        } else if (note == 0x0001) {
            if (sDelayTick > 0) defer_note(voice, sDelayTick, 0x0001);
            else {
                voice->keyOff = true;
                te_apply_key_lift(voice, &e->instruments[voice->instrumentId]);
            }
            schedule_dxny_action(voice, sArg, sDelayTick);
        } else if (note == 0x0002) {
            if (sDelayTick > 0) defer_note(voice, sDelayTick, 0x0002);
            else {
                te_start_cut_ramp(e, voice);
                te_cut_layer_children(e, vi);
            }
            schedule_dxny_action(voice, sArg, sDelayTick);
        } else if (note == 0x0004) {
            if (sDelayTick > 0) defer_note(voice, sDelayTick, 0x0004);
            else te_start_fast_fade(e, voice);
            schedule_dxny_action(voice, sArg, sDelayTick);
        } else if (note == 0x0003) {
            if (sDelayTick > 0) defer_note(voice, sDelayTick, 0x0003);
            else voice->noteFading = true;
            schedule_dxny_action(voice, sArg, sDelayTick);
        } else if (note >= 0x0005 && note <= 0x000f) {
            /* reserved sentinel range */
        } else if (note >= 0x0010 && note <= 0x001f) {
            if (sDelayTick > 0) {
                defer_note(voice, sDelayTick, (int)note);
                voice->delayedInterruptArg = interrupt_arg_of(e, row);
            } else {
                int k = (int)note - 0x0010;
                e->pendingInterrupts |= 1u << k;
                e->interruptArgs[k] = (uint16_t)interrupt_arg_of(e, row);
            }
        } else {
            if (toneG && voice->active) {
                voice->tonePortaTarget = voice->metaForeground && voice->layerFixedNote >= 0
                    ? -1
                    : dclamp(note + voice->metaForegroundDetune, 0x20, 0xffff);
                if (row->instrment != 0 && !inst_is_meta(&e->instruments[row->instrment])) {
                    bool mayCarry = !voice->keyOff && !voice->noteFading && row->instrment == voice->instrumentId;
                    const TaudInst *newInst;
                    const TaudPatch *newPatch;
                    voice->instrumentId = row->instrment;
                    newInst = &e->instruments[voice->instrumentId];
                    newPatch = te_inst_resolve_patch(newInst, voice->noteVal, te_narrow_vol_axis(e, voice->noteVolume));
                    apply_instrument_change(e, voice, newInst, newPatch, true, mayCarry);
                }
            } else if (sArg >= 0) {
                voice->noteDelayTick = sDelayTick;
                voice->delayedNote = note;
                voice->delayedInst = row->instrment;
                voice->delayedVol = row->volumeEff == 0 ? row->volume : -1;
                voice->delayedGlide = toneG; /* a G/L on a silent lane: a glide's trigger (lyrics) */
                schedule_dxny_action(voice, sArg, sDelayTick);
            } else {
                int trigVol = row->volumeEff == 0 ? row->volume : -1;
                te_apply_duplicate_check(e, vi, row->instrment, note);
                te_maybe_spawn_background_for_nna(e, voice, vi, row->instrment);
                /* toneG here = a G/L on a silent lane: it triggers, but as a
                 * glide (a lyric instrument's syllable, trigger.c lyric_trigger). */
                te_trigger_meta_or_note(e, voice, vi, note, row->instrment, trigVol, true, toneG);
                schedule_dxny_action(voice, sArg, sDelayTick);
            }
        }

        /* ── Volume / pan columns ── */
        te_apply_vol_column(e, voice, row->volume, row->volumeEff);
        if (e->ts_wideCells) te_apply_pan_column_wide(e, voice, row);
        else te_apply_pan_column(e, voice, row->pan, row->panEff);

        /* ── Effect columns (a `:` hands its argument to the other slot) ── */
        if (e->ts_wideCells) {
            if (row->effect == OP_COLON && row->effect2 != OP_COLON) { ext2 = row->effectArg; hasExt2 = true; }
            else if (row->effect2 == OP_COLON && row->effect != OP_COLON) { ext1 = row->effectArg2; hasExt1 = true; }
        }
        te_apply_effect_row(e, voice, vi, row->effect, row->effectArg, ext1, hasExt1);
        if (e->ts_wideCells && row->effect2 != 0) {
            te_apply_effect_row(e, voice, vi, row->effect2, row->effectArg2, ext2, hasExt2);
        }
    }
}

static bool cue_is_halt(const TaudCue *c)
{
    return c->inst0.type == INST_HALT || c->inst0.type == INST_HALTAT ||
           c->inst1.type == INST_HALT || c->inst1.type == INST_HALTAT;
}

static const TaudPlayInst *cue_flow_instruction(const TaudCue *c)
{
    static const TaudPlayInst nop = { INST_NOP, 0, 0 };
    int t0 = c->inst0.type, t1 = c->inst1.type;
    if (t0 == INST_GOBACK || t0 == INST_SKIP || t0 == INST_JUMP) return &c->inst0;
    if (t1 == INST_GOBACK || t1 == INST_SKIP || t1 == INST_JUMP) return &c->inst1;
    return &nop;
}

static void advance_tracker_cue(TaudEngine *e)
{
    const TaudCue *cue = te_cue_at(e, e->cuePos);
    const TaudPlayInst *instr;
    if (cue_is_halt(cue)) { e->isPlaying = false; return; }
    instr = cue_flow_instruction(cue);
    switch (instr->type) {
    case INST_GOBACK: e->cuePos = imax(e->cuePos - instr->arg, 0); break;
    case INST_SKIP: e->cuePos = imin(e->cuePos + instr->arg, NUM_CUES - 1); break;
    case INST_JUMP: e->cuePos = iclamp(instr->arg, 0, NUM_CUES - 1); break;
    default: e->cuePos = imin(e->cuePos + 1, NUM_CUES - 1); break;
    }
    e->position = e->cuePos;
}

void te_reconstruct_ditto_state(TaudEngine *e, int startRow)
{
    const TaudCue *cue = te_cue_at(e, e->cuePos);
    int patLen = te_cue_row_limit(cue);
    int limit = imin(startRow, patLen);
    int channels = te_channel_count(e), vi, n;
    for (vi = 0; vi < channels; vi++) {
        TaudVoice *voice = &e->voices[vi];
        int patNum;
        const TaudCell *rows;
        voice->dittoActive = false;
        voice->dittoSourceStart = 0;
        voice->dittoLength = 0;
        voice->dittoEndRow = 0;
        patNum = cue->raw[vi] & 0x7fff;
        if (patNum == PATTERN_EMPTY) continue;
        rows = te_pattern_read(e, iclamp(patNum, 0, NUM_PATTERNS - 1));
        for (n = 0; n < limit; n++) {
            const TaudCell *rawRow = &rows[n];
            int length, repeats;
            if (rawRow->effect != OP_7 || rawRow->effectArg == 0) continue;
            length = (rawRow->effectArg >> 8) & 0xff;
            repeats = rawRow->effectArg & 0xff;
            if (length > 0 && repeats > 0 && length <= n) {
                voice->dittoSourceStart = n - length;
                voice->dittoLength = length;
                voice->dittoEndRow = imin(n + length * repeats - 1, patLen - 1);
                voice->dittoActive = true;
            }
        }
    }
}

void te_reset_pattern_loop_state(TaudEngine *e)
{
    int i;
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        v->loopStartRow = 0;
        v->loopCount = 0;
        v->dittoActive = false;
        v->dittoSourceStart = 0;
        v->dittoLength = 0;
        v->dittoEndRow = 0;
    }
}

/* Advance to the next row: pending B/C jumps and pattern-delay repeats. */
void te_advance_row(TaudEngine *e)
{
    te_advance_row_position(e);
    te_apply_tracker_row(e);
}

/* advanceRow's first half: move to the row that plays next — the same row
 * again while a pattern delay repeats it, else wherever a pending jump or the
 * cue's end sends it — without applying it. */
void te_advance_row_position(TaudEngine *e)
{
    int pendingB, pendingC;
    bool pendingLocal;
    if (e->patternDelayRemaining > 0) {
        e->patternDelayRemaining--;
        e->patternDelayActive = true;
        return;
    }
    e->patternDelayActive = false;

    pendingB = e->pendingOrderJump;
    pendingC = e->pendingRowJump;
    pendingLocal = e->pendingRowJumpLocal;
    e->pendingOrderJump = -1;
    e->pendingRowJump = -1;
    e->pendingRowJumpLocal = false;

    if (pendingB >= 0) {
        e->cuePos = imin(pendingB, NUM_CUES - 1);
        e->rowIndex = pendingC >= 0 ? pendingC : 0;
        e->position = e->cuePos;
        te_reset_pattern_loop_state(e);
    } else if (pendingC >= 0 && pendingLocal) {
        e->rowIndex = iclamp(pendingC, 0, 63);
    } else if (pendingC >= 0) {
        advance_tracker_cue(e);
        e->rowIndex = iclamp(pendingC, 0, 63);
        te_reset_pattern_loop_state(e);
    } else {
        e->rowIndex++;
        if (e->rowIndex >= te_cue_row_limit(te_cue_at(e, e->cuePos))) {
            e->rowIndex = 0;
            advance_tracker_cue(e);
            te_reset_pattern_loop_state(e);
        }
    }
}
