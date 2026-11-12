/*
 * Engine internals — the C port of microtone-taudplay/src/engine.
 *
 * The file layout mirrors the JavaScript modules one for one (sampler.c is
 * sampler.js, tick.c is tick.js, …) so the two can be diffed when the engine
 * moves. Function names are the JS names in snake_case with a `te_` prefix.
 *
 * NUMERICS: the engine is bit-exact against the JS only if every expression
 * keeps its order of operations and every binary64/binary32 boundary stays
 * where the JS puts it. Compile with -ffp-contract=off (no fused multiply-add)
 * and without -ffast-math; on x87 targets add -fexcess-precision=standard.
 */
#ifndef TAUD_INTERNAL_H
#define TAUD_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <math.h>

#include "taudplay.h"

#ifdef __GNUC__
#pragma GCC diagnostic ignored "-Wunused-parameter"
#endif

/* ── constants (constants.js) ──────────────────────────────────────────── */

#define TRACKER_CHUNK TAUD_CHUNK
#define MAX_BG_VOICES 64
#define MIDDLE_C 0x5000
#define AMIGA_BASE_PERIOD 428.0
#define LINEAR_FREQ_C4_HZ 261.6255653005986
#define TUNING_REF_C4_HZ LINEAR_FREQ_C4_HZ
#define TUNING_DEFAULT_BASE_NOTE 0xa000
#define TUNING_DEFAULT_FREQ_HZ 8363.0
/* The tempo register: ten bits biased by -25 (song table byte 7, byte 8 bit 7,
 * byte 28 bit 7), so 25..1048 BPM. Every path that sets the tempo clamps to it. */
#define BPM_MIN 25
#define BPM_MAX (25 + 0x3ff)
#define RAMP_OUT_SEC 0.008
#define FAST_FADE_SEC 0.3
#define VOL_RAMP_SEC 0.002
#define ATTACK_RAMP_SEC (32.0 / 48000.0)
/* SoundFont-mode filter glide (item 297): FluidSynth's FLUID_BUFSIZE, 64
 * samples at its default 44.1 kHz, carried as a time. */
#define SF_FILTER_GLIDE_SEC (64.0 / 44100.0)
#define PITCH_GLIDE_FULL_RATIO 0.014545334937523746

#define SAMPLE_BIN_TOTAL 8388608
#define INSTBIN_SIZE 262144
#define SAMPLEINST_SIZE (SAMPLE_BIN_TOTAL + INSTBIN_SIZE)
#define NUM_VOICES 32
#define MAX_VOICES 64
/* The jam bank (item 140): voices of the editor's own above the lanes, which
 * an auditioned note sounds on without displacing a song voice. The tick and
 * mix passes walk all TOTAL_VOICES; only what is LANE-scoped stops at
 * JAM_VOICE_BASE. A player never triggers one, so they stay silent there. */
#define JAM_VOICES 16
#define JAM_VOICE_BASE MAX_VOICES
#define TOTAL_VOICES (MAX_VOICES + JAM_VOICES)
#define NUM_CUES 8192
#define NUM_PATTERNS 0x7fff
#define PATTERN_EMPTY 0x7fff
#define ROWS_PER_PATTERN 64
#define CELL_BYTES 8
#define CELL_BYTES_WIDE 16
#define PATTERN_BYTES 512
#define PATTERN_BYTES_WIDE 1024
#define VOLUME_MAX 0x3f
#define VOLUME_MAX_WIDE 0xff
#define VOLUME_STEP_WIDE 4

#define INTERP_DEFAULT 0
#define INTERP_NONE 1
#define INTERP_A500 2
#define INTERP_A1200 3
#define INTERP_SNES 4
#define INTERP_NES_DPCM 5

#define SINC_WIDTH 3
#define SINC_PRECISION 1024
#define SINC_TABLE_SIZE (SINC_PRECISION * SINC_WIDTH)

#define NUM_INTERRUPTS 16
#define AUDITION_SLOT 1024
#define NUM_INST_SLOTS (AUDITION_SLOT + 1)

#define LFO_PHASE_STEPS 1088
#define LFO_STEPS_PER_ENTRY 17
#define AUTOVIB_PHASE_STEPS 1024
#define AUTOVIB_DEPTH_MUL 43
#define AUTOVIB_DEPTH_SHIFT 12

/* Effect opcodes (base-36 digit values). */
enum {
    OP_NONE = 0x00, OP_1 = 0x01, OP_2, OP_3, OP_4, OP_5, OP_6, OP_7, OP_8, OP_9,
    OP_A = 0x0a, OP_B, OP_C, OP_D, OP_E, OP_F, OP_G, OP_H, OP_I, OP_J, OP_K, OP_L,
    OP_M, OP_N, OP_O, OP_P, OP_Q, OP_R, OP_S, OP_T, OP_U, OP_V, OP_W, OP_X,
    OP_Y, OP_Z,
    OP_COLON = 0xba
};

/* Surround models and monitor modes. */
#define SURROUND_STEREO 0
#define SURROUND_PLANAR 1
#define SURROUND_SPATIAL 2
#define AZIMUTH_TURN 512
#define ELEVATION_QUARTER 128
#define MONITOR_FOLD 0
#define MONITOR_BINAURAL 1

/* ── JS numeric semantics ──────────────────────────────────────────────── */

/** Math.round: half-way cases go towards +∞. */
static inline double js_round(double x)
{
    double r = floor(x);
    if (x - r >= 0.5) r += 1.0;
    return r;
}

/** ToInt32 — what `x | 0` does to a double. */
static inline int32_t js_toint32(double x)
{
    if (x >= -2147483648.0 && x < 2147483648.0) return (int32_t)x;
    if (!(x == x) || isinf(x)) return 0;
    {
        double t = trunc(x);
        double m = fmod(t, 4294967296.0);
        if (m < 0) m += 4294967296.0;
        return (int32_t)(uint32_t)m;
    }
}

/** ToUint32 — what `x >>> 0` does to a double. */
static inline uint32_t js_touint32(double x) { return (uint32_t)js_toint32(x); }

/** Arithmetic right shift of a signed value, portably. */
static inline int32_t asr32(int32_t x, int n)
{
    return x >= 0 ? (int32_t)((uint32_t)x >> n) : (int32_t)~((uint32_t)~x >> n);
}

static inline int imin(int a, int b) { return a < b ? a : b; }
static inline int imax(int a, int b) { return a > b ? a : b; }
static inline int iclamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline double dclamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline double dmin(double a, double b) { return a < b ? a : b; }
static inline double dmax(double a, double b) { return a > b ? a : b; }

/* JavaScript's transcendental functions (jsmath.c): fdlibm, exactly as V8
 * computes them, whatever the platform's libm — `pow` included: V8's own
 * fdlibm port (base/ieee754.cc, with one grouping of its own). Current V8
 * calls the platform's std::pow instead unless run with
 * --no-use-std-math-pow, which the tests pass; TAUD_LIBM_POW swaps in the
 * platform pow to match such a V8 on the same machine (no longer
 * platform-independent). */
double js_sin(double x);
double js_cos(double x);
double js_tan(double x);
double js_exp(double x);
double js_log10(double x);
double js_log2(double x);
double js_log(double x);
double js_acos(double x);
double js_asin(double x);
double js_atan2(double y, double x);
double js_log1p(double x);
double js_expm1(double x);
double js_tanh(double x);
double js_fdlibm_pow(double x, double y);
#ifdef TAUD_LIBM_POW
#define js_pow pow
#else
#define js_pow js_fdlibm_pow
#endif

/** Math.fround. */
static inline double fround(double x) { return (double)(float)x; }

/* ── instrument model (inst.js) ────────────────────────────────────────── */

struct TaudEngine;

typedef struct { uint8_t value, offset; } TaudEnvPoint;

#define ENV_POINTS 25

#define CHAN_MODE_DISCRETE 0
#define CHAN_MODE_MATRIX 1

typedef struct {
    int pitchStart, pitchEnd, volumeStart, volumeEnd;
    uint32_t samplePtr;
    int sampleLength, playStart, loopStart, loopEnd, samplingRate, sampleDetune;
    int loopMode, defaultPan, defaultNoteVolume;
    int vibratoSpeed, vibratoSweep, vibratoDepth, vibratoRate, vibratoWaveform;
    bool hasVolEnv, hasPanEnv, hasFilterEnv, hasPitchEnv;
    TaudEnvPoint volEnv[ENV_POINTS], panEnv[ENV_POINTS];
    TaudEnvPoint filterEnv[ENV_POINTS], pitchEnv[ENV_POINTS];
    int volEnvLoop, volEnvSustain, panEnvLoop, panEnvSustain;
    int filterEnvLoop, filterEnvSustain, pitchEnvLoop, pitchEnvSustain;
    bool hasExtra;
    int fadeoutStep;
    bool filterSfMode;
    int extraCutoff, extraResonance, extraInitialAttenOctet;
    bool hasChanBlock;
    int chanCount, chanMode, chanFlags, chanPtrCount;
    uint32_t chanPtrs[15];
} TaudPatch;

#define META_MAX_LAYERS 25
#define META_TYPE_LAYERED 0
#define META_TYPE_FM 4
#define META_LAYER_FIXED_PITCH 0x40
#define FM_MAX_OPERATORS 16
/* Bytes 4…253 hold an FM rack and its program; byte 255 is every record's
 * IMix id (item 217) and byte 254 stays clear (FM_PROGRAM_END). */
#define FM_PROGRAM_END 254
#define FM_STACK_MAX 16
#define FM_WORD_OSC 0x0000
#define FM_WORD_MOD 0x0400
#define FM_WORD_FB 0x0800
#define FM_WORD_OP 0xff00
#define FM_INDEX_MASK 0x03ff
#define FMOP_ADD 0xff00
#define FMOP_MUL 0xff01
#define FMOP_NEG 0xff02
#define FMOP_DUP 0xff03
#define FMOP_SWAP 0xff04
#define FMOP_END 0xffff

typedef struct {
    int instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd;
    bool fixedPitch;
} TaudMetaLayer;

typedef struct {
    int count;
    TaudMetaLayer layers[META_MAX_LAYERS];
    uint8_t flags;              /* record byte 0 */
    uint8_t imixId;             /* record byte 255: the IMix block (§9.15) */
    bool strict;
    int type;
    bool hasProgram;            /* FM: did the program decode? */
    int programLen;
    uint16_t program[128];
} TaudMeta;

/* ── OPL instruments, Metainstrument type 8 (opl.js) ───────────────────── */

#define META_TYPE_OPL 8
#define OPL_BLOCK_START 197
#define OPL_BLOCK_LEN 54
#define OPL_C4_RATE 8363
/* The chip's sample rate, 3579545 / 72 Hz (OPL_RATE). */
#define OPL_RATE_HZ (3579545.0 / 72)

/* The envelope generator's states, shared with the PSG (oplAdvanceEnvelope). */
#define EG_OFF 0
#define EG_ATTACK 1
#define EG_DECAY 2
#define EG_SUSTAIN 3
#define EG_RELEASE 4
#define OPL_ENV_MAX 511

typedef struct {
    int am, vib, eg, ksr, mult, ksl, tl, ar, dr, sl, rr, ws;
} TaudOplOperator;

/* A decoded type-8 patch (OplPatch). */
typedef struct {
    int gen;
    int kind;
    bool deepTremolo, deepVibrato, nts, lowFnum;
    int feedback, cntA, cntB, partnerMult, partnerDetune;
    TaudOplOperator ops[4];
    int outputs;
} TaudOplPatch;

/* One sounding OPL channel (OplState), hung off a voice. */
typedef struct {
    const TaudOplPatch *patch;
    int gen;
    double rate;
    uint32_t phase[4];
    int32_t inc[4], env[4];
    uint8_t state[4];
    int32_t out[4], prev[4], kslAtt[4], ksrOffset[4];
    uint32_t hhPhase, tcPhase;
    int32_t hhInc, tcInc;
    uint32_t noise;
    bool keyed;
    bool kValid;                /* false = the JS NaN: not yet on the chip clock */
    int64_t k;
    double cur, last;
    double vol;
    int volAtt;
    /* Phase modulation from outside the chip, in 1/1024 of a cycle, added to
     * every OUTPUT operator's phase: what an FM rack reading this channel as
     * an operator writes (§5.5.1). 0 on every other path. */
    double pm;
} TaudOplState;

/* ── PSG instruments, Metainstrument type 9 (psg.js) ───────────────────── */

#define META_TYPE_PSG 9
#define PSG_BLOCK_START 197
#define PSG_BLOCK_LEN 54
#define PSG_NOISE_LONG_LEN 32767
#define PSG_NOISE_MID_LEN 2047
#define PSG_NOISE_SHORT_LEN 127

/* One oscillator's twelve bytes, unpacked (PsgOscillator). The envelope's
 * fields sit in an operator, so the chip's envelope generator reads them
 * unchanged: ar dr sl rr eg, plus mult ksl tl ksr. */
typedef struct {
    TaudOplOperator op;
    int wave;
    bool reset, invert;
    int tremolo, vibrato;       /* 0 off, 1 shallow, 2 deep */
    int advance, pattern;
} TaudPsgOscillator;

/* A decoded type-9 patch (PsgPatch), with the S $Axxx run-time overlay: each
 * field -1 while the record's own value stands. */
typedef struct {
    int gen;
    bool multiply, muteA, muteB;
    TaudPsgOscillator osc[2];
    int rtAdvance[2], rtLevel[2], rtMute;
    int rtGen;
} TaudPsgPatch;

/* One sounding PSG pair (PsgState), hung off a voice. */
typedef struct {
    TaudPsgPatch *patch;
    int gen;
    double rate;
    uint8_t state[2];
    int32_t env[2], ksrOffset[2], kslAtt[2];
    double gain[2], inc[2];
    double phase[2], noise[2];
    uint8_t adv[2];
    int32_t advCount[2];
    double lfo[2];              /* set at every key-on; NaN = anchored at the next frame rendered */
    bool keyed;
    bool kValid;                /* false = the JS NaN */
    int64_t k;
    double cur, last;
    double pm;                  /* a 32-bit phase offset from an FM rack */
} TaudPsgState;

/* ── formant instruments, Metainstrument type 1 (formant.js) ───────────── */

#define META_TYPE_FORMANT 1
#define FORMANT_BLOCK_START 197
#define FORMANT_BLOCK_LEN 54
#define FORMANT_SLOTS 3
#define FORMANT_TRACK_MAX 32    /* doubles: 16 (time, value) points; the longest track has 13 */
#define NORM_HARMONICS 64

typedef struct {
    int cons;
    uint32_t ptr;
    int len, offset, rate, tilt, gain;
} TaudFormantSlot;

/* The decoded tract block (FormantPatch) — or a LYRIC SYLLABLE built from
 * one (te_formant_lyric_syllable). */
typedef struct TaudFormantPatch {
    uint32_t srcPtr;
    int srcInst;                /* the header's source instrument, 0 = the sample */
    int front, open, round, track, glide, timing;
    int refNote;                /* bits 0…14 of the word; 0 = the syllable has no vowel */
    bool nasal;                 /* bit 15: the vowel nasalised */
    int semivowel;
    bool rhotic;
    int secondary;              /* the onset's last consonant: ART_* */
    int codaArt;                /* the coda: CODA_* */
    uint32_t rangeLo, rangeHi;
    TaudFormantSlot slots[FORMANT_SLOTS];
    /* A lyric syllable times each of its consonants and its glide by a byte
     * of its own — [onset 1, onset 2, coda, glide], read as `timing` is and
     * applied ON TOP of it. hasSlotTiming false on a record, whose one byte
     * times them all. */
    bool hasSlotTiming;
    uint8_t slotTiming[4];
    /* …and the record it is a syllable of; NULL on a record. */
    const struct TaudFormantPatch *lyricOf;
} TaudFormantPatch;

/* ── lyric instruments: the `ILyr` section (lyric-section.js; file format
 *    §9.17, engine spec §5.5.3 "Lyric instruments") ── */

#define LYRIC_SYLLABLE_BYTES 12
#define LYRIC_RECIPE_BYTES 12

typedef struct {
    int front, open, round;
    bool vowel, nasal;
    int gr;                     /* the tract block's +53 */
    uint8_t cons[3];            /* onset 1, onset 2, coda */
    uint8_t timing[4];          /* onset 1, onset 2, coda, glide */
} TaudLyricSyllable;

/* A consonant slot's layout (§7.6): the noise consonant `cons` reads. */
typedef struct {
    int cons;
    uint32_t ptr;
    int len, offset, rate, tilt, gain;
} TaudLyricRecipe;

typedef struct {
    int instId;
    int numSyllables, numRecipes;
    TaudLyricSyllable *syllables;
    TaudLyricRecipe *recipes;
    /* The first recipe for each consonant id, -1 for none (the generator). */
    int16_t recipeOf[256];
} TaudLyricEntry;

typedef struct {
    int n;                      /* doubles used (2 per point) */
    double p[FORMANT_TRACK_MAX];
} TaudFormantTrack;

struct TaudConsonant;

/* One consonant as it sounds (FormantSegment). `next` is an index into the
 * onset array, -1 for the vowel. */
typedef struct {
    const struct TaudConsonant *row;
    TaudFormantSlot slot;
    double end;
    TaudFormantTrack w, av, ah, af, nz;
    int next;
    int art;                    /* as blendInto reads it: ART_NONE, _PALATAL or _DARK */
    double loop;                /* a held nucleus's repeat, ms (a trill's cycle); a coda's, while held */
    double hold;                /* a coda: where S $9010 holds it while the key is held */
    /* A coda after a hissing nucleus: its own noise starts this far in, the
     * nucleus's going on until then through the nucleus's bank. */
    double noiseAt;
    const struct TaudConsonant *prevRow;
    int prevArt;
} TaudFormantSegment;

/* How far the vowel is nasalised, or r-coloured (FormantAmount): 0 not at
 * all, 1 fully, and between while S $90kx (item 292), or an instrument change,
 * glides it. Until the note is given one of its own (`own`) it is the record's
 * bit, read afresh every update; `rejoin` is an instrument change's glide,
 * after which the note follows the new record again. */
typedef struct {
    bool own;
    double v;                   /* where it stands */
    double to, step, left;      /* where a glide is heading, per ms, ms to go */
    bool rejoin;
} TaudFormantAmount;

#define CHIP_NONE 0
#define CHIP_OPL 1
#define CHIP_PSG 2

typedef struct {
    const TaudFormantPatch *patch;
    int phase;
    int onsetCount;
    TaudFormantSegment onset[2];
    int seg;
    bool hasCoda;
    TaudFormantSegment coda;
    double t;
    bool codaVeto, codaNoise, fresh;
    /* A syllable with no vowel: the onset index of its nucleus (-1 when there
     * is a vowel), and whether it has come to hold. */
    int nucleus;
    bool held;
    /* The glottal source when it is a chip channel (CHIP_*), keyed with the
     * note; CHIP_NONE when the source is the record's sample. */
    int srcKind;
    TaudOplState srcOpl;
    TaudPsgState srcPsg;
    int upd, ctl, normCount;
    bool ownVowel;
    int sv;                     /* SEMIVOWELS index, 0 = none */
    TaudFormantTrack svW, svAv;
    double svT, svEnd;
    double VG[5], VGB[5];
    bool rejoin;
    double vFront, vOpen, vRound, gFront, gOpen, gRound, tFront, tOpen, tRound;
    double glideLeft;
    /* S $9xxx (item 292): the vowel's nasalisation and r-colouring as the note
     * has them, the glide time it was given (-1: the record's), and a coda
     * called for while the key is still held. */
    TaudFormantAmount nasAmt, rhoAmt;
    int glideOv;
    bool codaCall;
    double codaZ0;              /* the vowel nasality the coda was built from */
    bool atVowel;               /* started at the vowel (te_formant_start_at_vowel) */
    double av, avStep, ah, ahStep, af, afStep;
    double nv, nvStep, nvGoal;
    double nb, sg, sm;
    bool sgDue;
    double hw[NORM_HARMONICS + 1];
    int hwK;
    double casc[21], bank[15], bankGain[6];
    double cy[14], by[10];
    bool nOn;
    int64_t nBase;
    int nSpan;
    double nPos, nStep;
    int nTilt;
    double nTiltC, nGain, nZ;
    bool nGen;
    uint32_t nSeed;
    double V[5], VB[5], F[5], B[5], VR[5], VRB[5];
} TaudFormantState;

/* Sample-modification masks are sized per loop/sample and never exceed a
 * 16-bit length, so one lazily allocated 8 KiB buffer per mask serves. */
#define MOD_MASK_CAP 8192

typedef struct TaudInst {
    int index;

    uint32_t samplePtr;
    int sampleLength, samplingRate, samplePlayStart, sampleLoopStart, sampleLoopEnd;
    int loopMode;
    int volEnvLoop, panEnvLoop, pfEnvLoop;
    int instGlobalVolume;
    TaudEnvPoint volEnvelopes[ENV_POINTS], panEnvelopes[ENV_POINTS];
    TaudEnvPoint pfEnvelopes[ENV_POINTS], pf2Envelopes[ENV_POINTS];
    int volumeFadeoutLow, fadeoutHigh, volumeSwing, vibratoSpeed, vibratoSweep;
    int defaultPan, pitchPanCentre, pitchPanSeparation, panSwing;
    int defaultCutoff, defaultResonance, sampleDetune, instrumentFlag;
    int vibratoDepth, vibratoRate;
    int volEnvSustainWord, panEnvSustainWord, pfEnvSustainWord;
    int dupCheckFlag, defaultNoteVolume, pf2EnvLoop, pf2EnvSustainWord;
    uint8_t reserved[5];
    int initialAttenOctet;

    int cutoffOverride, resonanceOverride;

    TaudPatch *extraPatches;    /* NULL when none */
    int patchCount;

    TaudMeta *meta;             /* NULL unless a metainstrument */
    TaudOplPatch *opl;          /* NULL unless a type-8 OPL instrument */
    TaudPsgPatch *psg;          /* NULL unless a type-9 PSG instrument */
    TaudFormantPatch *formant;  /* NULL unless a type-1 formant instrument */
    /* Lyric instrument: the `ILyr` entry installed (te_set_lyrics), kept
     * across record loads, and — while the record is a formant instrument —
     * one patch per syllable, refreshed in place on every load. `lyric` is
     * NULL for any other instrument; lyricStore is the storage it points at. */
    const TaudLyricEntry *lyricEntry;
    TaudFormantPatch *lyric;
    TaudFormantPatch *lyricStore;
    int lyricStoreCount;

    /* Invert loop (S $F0xx). invertMaskLen 0 = no mask. */
    uint8_t *invertMask;
    int invertMaskLen;

    /* Sample modification (notefx 2 / 3). */
    int modOp;
    bool modInvert;
    double modFrom, modTo;
    int modCombBits;
    bool modCombOdd;
    uint8_t *modMask;
    int modMaskLen;             /* 0 = no mask */
    int modRot, modSub, modScatter;
    uint32_t modSeed;
    bool modOn;
    int modEpoch;
    int modPrevRot, modPrevSub, modPrevScatter;
    uint32_t modPrevSeed;
    int modOpExt, modF, modStepIndex, modXor, modPrevXor, modBitRot, modBitPermIdx;
    bool modBitPermOn;
    int modExtSwapA, modExtSwapB;
    bool modExtMirror;
    int modFunkWalk, modFunkPos, modFunkLen;

    /* The engine this instrument belongs to, for te_retire: a record reload
     * replaces objects a sounding voice may still point at. NULL = none
     * (replaced objects are then freed at once). */
    struct TaudEngine *engine;
} TaudInst;

static inline bool inst_is_meta(const TaudInst *i) { return i->meta != NULL; }
/* The IMix block the instrument's voices mix through (byte 255; 0 = none):
 * a metainstrument's verbatim record, every other kind's reserved tail. */
static inline int inst_imix_id(const TaudInst *i) { return i->meta != NULL ? i->meta->imixId : i->reserved[4]; }
static inline bool inst_is_fm(const TaudInst *i) { return i->meta != NULL && i->meta->type == META_TYPE_FM; }
static inline int inst_new_note_action(const TaudInst *i)
{
    int n = (i->instrumentFlag & 0x03) | (((i->instrumentFlag >> 5) & 1) << 2);
    return n <= 4 ? n : 0;
}
static inline bool inst_nna_key_lift(const TaudInst *i) { return inst_new_note_action(i) == 4; }
/* Byte 186 bit 6: Q's retrigger hands the outgoing sound to the background
 * pool per the New Note Action instead of cutting it (spec §5.7). */
static inline bool inst_retrig_follows_nna(const TaudInst *i) { return (i->instrumentFlag & 0x40) != 0; }
static inline int inst_vibrato_waveform(const TaudInst *i) { return (i->instrumentFlag >> 2) & 0x07; }
static inline int inst_sample_detune_signed(const TaudInst *i)
{
    int v = i->sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
}
/* Byte 195's two nibbles, `0b AATT aatt` (packDupCheck). */
static inline int inst_dup_check_type(const TaudInst *i)
{
    return (i->dupCheckFlag & 0x03) | ((i->dupCheckFlag >> 2) & 0x0c);
}
static inline int inst_dup_check_action(const TaudInst *i)
{
    return ((i->dupCheckFlag >> 2) & 0x03) | ((i->dupCheckFlag >> 4) & 0x0c);
}
/* Duplicate Check Type 4 (item 216): every note arriving on the lane. */
#define DCT_LANE 4
static inline bool inst_is_opl(const TaudInst *i) { return i->opl != NULL; }
static inline bool inst_is_psg(const TaudInst *i) { return i->psg != NULL; }
/* A chip instrument (OPL or PSG): what a high meta can sound through (chipPatch). */
static inline bool inst_is_chip(const TaudInst *i) { return i->opl != NULL || i->psg != NULL; }
static inline bool inst_is_formant(const TaudInst *i) { return i->formant != NULL; }
/* Byte 14 bit 6: this instrument's volume envelopes — its own and its Ixmp
 * patches' — hold 0…255 rather than 0…63 (file format §7.2). */
#define INST_VOLENV8 0x40
static inline bool inst_vol_env8(const TaudInst *i) { return (i->loopMode & INST_VOLENV8) != 0; }

/* The metainstrument tiers (inst.js metaTier): types 0…7 are HIGH metas, made
 * out of sources; 8…13 LOW metas, sound generators of their own; 14, 15
 * reserved. An ordinary instrument has no tier. */
#define META_TIER_NONE (-1)
#define META_TIER_HIGH 0
#define META_TIER_LOW 1
#define META_TIER_RESERVED 2
static inline int meta_tier_of(int type)
{
    int t = type & 0x0f;
    return t <= 7 ? META_TIER_HIGH : t <= 13 ? META_TIER_LOW : META_TIER_RESERVED;
}
static inline int inst_meta_tier(const TaudInst *i)
{
    if (i->opl != NULL || i->psg != NULL) return META_TIER_LOW;
    if (i->formant != NULL) return META_TIER_HIGH;
    if (i->meta != NULL) return meta_tier_of(i->meta->type);
    return META_TIER_NONE;
}
static inline bool inst_is_high_meta(const TaudInst *i) { return inst_meta_tier(i) == META_TIER_HIGH; }
static inline bool inst_filter_sf_mode(const TaudInst *i) { return ((i->fadeoutHigh >> 4) & 1) != 0; }
static inline int inst_default_azimuth(const TaudInst *i)
{
    return ((i->loopMode & 0x20) != 0 ? 256 : 0) | (i->defaultPan & 0xff);
}
static inline int inst_default_elevation(const TaudInst *i)
{
    int b = i->reserved[3] & 0xff;
    return b >= 0x80 ? b - 256 : b;
}
static inline int inst_default_cutoff16(const TaudInst *i)
{
    if (i->cutoffOverride >= 0) return i->cutoffOverride;
    return inst_filter_sf_mode(i) ? ((i->defaultCutoff & 0xff) << 8) | (i->reserved[1] & 0xff)
                                  : i->defaultCutoff;
}
static inline int inst_default_resonance16(const TaudInst *i)
{
    if (i->resonanceOverride >= 0) return i->resonanceOverride;
    return inst_filter_sf_mode(i) ? ((i->defaultResonance & 0xff) << 8) | (i->reserved[2] & 0xff)
                                  : i->defaultResonance;
}

/* ── voices (voice.js) ─────────────────────────────────────────────────── */

typedef struct {
    int ef, g, huSpeed, huDepth, rSpeed, rDepth, ySpeed, yDepth;
    int d, i, j, jExt1, jExt2, o;
    double oExt;
    int q, tslide, w, k, l, n, p, z;
} TaudMemorySlots;

typedef struct {
    double filterY1, filterY2, filterX1, filterX2;
    int bitcrusherCounter;
    double bitcrusherHeld;
    int nesDpcmCounter;
} TaudChannelState;

typedef struct {
    int epoch;
    const TaudInst *inst;
    int base, len;
    bool live;
    int es, ee;
    int combN;
    bool combOdd;
    double combScale;
    int ds, dl;
} TaudModGeom;

typedef struct TaudVoice TaudVoice;

typedef struct {
    int count;
    TaudVoice *voices[FM_MAX_OPERATORS];
    double gain[FM_MAX_OPERATORS];
    double cur[FM_MAX_OPERATORS];
    double last[FM_MAX_OPERATORS];
    uint8_t done[FM_MAX_OPERATORS];
    const uint16_t *program;
    int programLen;
    double stack[FM_STACK_MAX + 2];
} TaudFmRig;

/* Renderer gains for a voice's (at most two) sample channels. */
typedef struct {
    bool valid;
    double az, el;
    int chans;
    unsigned rendererGen;
    double gains[2 * 17];       /* 2 sample channels × SPATIAL_MAX_CHANNELS */
} TaudSpatialCache;

struct TaudVoice {
    bool active;
    int fader;
    double samplePos;
    double playbackRate, currentPlaybackRate;
    int pitchRampSamples;
    double pitchRampStep;
    bool snapPlaybackRate;
    bool forward;
    int instrumentId;
    int displayInst;
    int sourceChannel;
    int activePatchIndex;

    bool isLayerChild;
    double layerRelDetune;
    int layerFixedNote;
    double layerRelPan, layerRelElevation;
    double layerMixGain;
    double layerPitchMod;
    int nnaOverride;
    bool volEnvOn, panEnvOn, pitchEnvOn, filterEnvOn;
    bool metaForeground;
    int metaForegroundDetune;
    bool noteFading;

    TaudFmRig *fmRig;            /* NULL, or &rigStore */
    TaudFmRig rigStore;
    bool fmOperator;
    TaudVoice *fmParent;

    /* OPL channel (item 209): NULL or &oplStore, kept across notes. */
    TaudOplState *opl;
    TaudOplState oplStore;
    bool oplCarry;
    /* PSG pair (type 9): NULL or &psgStore, kept across notes as OPL's is —
     * an oscillator's internal status lives here. */
    TaudPsgState *psg;
    TaudPsgState psgStore;
    bool psgCarry;
    /* Formant tract (item 212): NULL or &formantStore. */
    TaudFormantState *formant;
    TaudFormantState formantStore;
    /* A lyric instrument's place in its lyrics on this LANE: the syllable the
     * lane's next trigger of it sings. Read and written on the foreground
     * voice only. */
    int lyricPos;

    int noteVolume, channelVolume, rowVolume;
    int channelPan, rowPan;
    bool channelVolumeSet, channelPanSet;
    double notePan, noteElevation;

    double panAzimuth, panElevation;
    double spatialTargetAz, spatialTargetEl;
    bool spatialSlideActive;
    TaudSpatialCache spatial;
    TaudSpatialCache analysisSpatial;   /* …and the master-strip analysis bus's own */

    double currentMixVolume;
    int volRampSamples;
    double volRampStep;
    double currentPan;
    int panRampSamples;
    double panRampStep;
    bool snapPan, snapMixVolume;

    bool keyOff;
    int envIndex;
    double envTimeSec, envVolume, envVolMix, envVolStep;
    bool hasVolEnv;             /* the ACTIVE volume envelope's P bit */
    int envPanIndex;
    double envPanTimeSec, envPan;
    bool hasPanEnv;
    bool hasPitchEnv;
    int envPitchIndex;
    double envPitchTimeSec, envPitchValue;
    bool hasFilterEnv;
    int envFilterIndex;
    double envFilterTimeSec, envFilterValue;

    double fadeoutVolume;
    /* fadeoutVolume as the mixer glides it across the tick (advanceFadeout). */
    double fadeoutMix, fadeoutMixStep;
    /* The lane fader and the elevation as the mixer glides them
     * (te_advance_fader_ramp / te_advance_elev_ramp); NaN = snap next sample. */
    double faderCur, faderStep; int faderAim, faderLeft;
    double elevCur, elevAim, elevStep; int elevLeft;
    int rampOutSamples;
    double rampOutGain, rampOutStep;
    int attackRampSamples;
    int autoVibPhase;
    int64_t autoVibTicksSinceTrigger;

    uint32_t activeSamplePtr;
    int activeSampleLength, activeSamplePlayStart, activeSampleLoopStart, activeSampleLoopEnd;
    int activeSamplingRate, activeSampleDetune, activeLoopMode;
    int activeVibratoSpeed, activeVibratoSweep, activeVibratoDepth, activeVibratoRate;
    int activeVibratoWaveform;
    int activeChanCount, activeChanMode;
    uint32_t activeChanPtr2;
    TaudChannelState right;

    const TaudEnvPoint *activeVolEnv;
    int activeVolEnvLoop, activeVolEnvSustain;
    /* A node value's full volume: 63, or 255 for an instrument whose byte 14
     * bit 6 says its volume envelopes are 8-bit (resolve_active_envelopes). */
    int activeVolEnvMax;
    const TaudEnvPoint *activePanEnv;
    int activePanEnvLoop, activePanEnvSustain;
    const TaudEnvPoint *activePitchEnv;
    int activePitchEnvLoop, activePitchEnvSustain;
    const TaudEnvPoint *activeFilterEnv;
    int activeFilterEnvLoop, activeFilterEnvSustain;
    int activeFadeoutStep, activeDefaultCutoff, activeDefaultResonance;
    bool filterSfMode;
    double activeAttenGain;

    int nesDpcmCounter;

    int currentCutoff, currentResonance;
    bool filterActive;
    double filterA0, filterB0, filterB1, filterY1, filterY2;
    bool filterIsBiquad;
    double filterBqB02, filterBqB1, filterBqA1, filterBqA2, filterX1, filterX2;
    int filterCutoffCached, filterResonanceCached;
    /* SoundFont-mode filter glide (te_advance_filter_glide): cutoff in cents
     * and Q where they stand, per-sample steps, samples left, the refresh's
     * targets. sfCents NaN = the next refresh lands at once. */
    double sfCents, sfCentsIncr, sfHzAim, sfQ, sfQIncr, sfQAim;
    int sfCentsLeft, sfCentsAim, sfQLeft;

    int randomVolBias, randomPanBias;

    double noteVal, basePitch;  /* 4096-TET; a wide cell's note carries sixteenths */
    double amigaPeriod, linearFreq;
    double renderPitch;
    double pitchModDelta;

    int rowEffect, rowEffectArg;
    int slideMode, slideArg;
    double tonePortaTarget;
    int tonePortaSpeed;
    int arpOff1, arpOff2;
    bool arpActive;
    int lastArpVoice;
    int tremorOn, tremorOnTime, tremorOffTime;
    bool tremorPhaseOn;
    int tremorTickInPhase;

    bool vibratoActive;
    int vibratoLfoPos, vibratoWave;
    bool vibratoRetrig;
    int vibratoFineShift;
    bool tremoloActive;
    int tremoloLfoPos, tremoloWave;
    bool tremoloRetrig;
    bool panbrelloActive;
    int panbrelloLfoPos, panbrelloWave;
    bool panbrelloRetrig;
    int panbrelloOffset;
    bool glissandoOn;

    int retrigCounter, retrigInterval, retrigVolMod;
    bool retrigActive;
    /* Set by te_retrig_hand_off on a voice Q just ghosted; read and cleared
     * by the restart, whose chip then keys on from silence. */
    bool retrigFresh;

    int noteDelayTick;
    double delayedNote;
    int delayedInst, delayedVol;
    bool delayedGlide;  /* the delayed note was a G/L's (a lyric's glide, trigger.c) */
    int delayedInterruptArg;
    int noteActionTick, delayedAction;
    int cutAtTick;
    bool noteWasCut;

    int invertSpeed, invertAccumulator, invertWritePos;

    int funkSpeed, funkMode, funkAccumulator;
    int funkWalk, funkPos, funkWindow;
    int funkXfade, funkXfadeLen, funkXfadeOffset;

    int modPeriod, modTickCount, modWritePos, modXfade;
    bool modExtended;
    double modStepTicks, modSamplesIntoStep;
    TaudModGeom modGeom;
    int modFunkWindow, modFunkXfade, modFunkXfadeLen, modFunkXfadeOffset;

    int loopStartRow, loopCount;
    bool dittoActive;
    int dittoSourceStart, dittoLength, dittoEndRow;

    int tempoSlideDir, tempoSlideAmount;
    int wSlideDir, wSlideAmount;
    int volColSlideUp, volColSlideDown;
    int panColSlideRight, panColSlideLeft, chanPanSlideRight, chanPanSlideLeft;
    int nSlideDir;

    int clipMode, bitcrusherDepth, bitcrusherSkip, bitcrusherCounter;
    double bitcrusherHeld;
    int overdriveAmp;

    TaudMemorySlots mem;

    double panLawPan, panLawL, panLawR;

    /* Pool bookkeeping (not engine state). */
    bool pooled;
    bool marked;
    TaudVoice *nextFree;
};

/* ── pattern data + cue sheet (state.js) ───────────────────────────────── */

/* One pattern cell, either wire layout (8-byte v1/2 or 16-byte v3). Kept
 * small: a song holds hundreds of 64-row patterns. The note is stored as it
 * arrives — the word, and a wide cell's fine nibble (byte 13's high nibble,
 * the four bits that make its pitch 65536-TET, file format §5.5) — and read
 * through te_cell_note. */
typedef struct {
    uint16_t note;
    uint8_t instrment, volume, volumeEff, pan, panEff, effect;
    uint16_t effectArg, azimuth;
    int8_t elevation;
    uint8_t effect2;
    uint16_t effectArg2;
    uint8_t noteFine;           /* 0..15: byte 13's nibble as a wide decode last left it */
    /* The sixteenths the note CARRIES — the reference keeps one number, word
     * plus fraction, and these are its fraction: the nibble under a wide
     * decode (none under a sentinel word), and none at all once a narrow
     * decode has written a note byte. A pattern slot is reused across files,
     * so a narrow song can be decoded into cells a wide one left its nibbles
     * in; reading noteFine itself would then bend the narrow song's pitch. */
    uint8_t noteFrac;
} TaudCell;

/* The cell's note in 4096-TET units: the word plus the sixteenths it carries. */
static inline double te_cell_note(const TaudCell *c)
{
    return c->note + c->noteFrac / 16.0;
}

#define INST_NOP 0
#define INST_GOBACK 1
#define INST_SKIP 2
#define INST_JUMP 3
#define INST_PATLEN 4
#define INST_HALTAT 5
#define INST_HALT 6

typedef struct { int type, arg, rows; } TaudPlayInst;

typedef struct {
    uint16_t raw[MAX_VOICES];
    TaudPlayInst inst0, inst1;
} TaudCue;

#define CUE_BLOCK 256
#define CUE_BLOCKS (NUM_CUES / CUE_BLOCK)

/* ── spatial bus / renderers (spatial.js, binaural.js) ─────────────────── */

typedef struct {
    bool sphere;
    int numChannels;
    int acn[16];
    int8_t mirror[16];
    int taps;
    double *hrir;               /* numChannels × taps */
    double *hist;               /* numChannels × taps × 2 */
    int histPos;
} TaudBinaural;

/* The widest bus: the analysis target's nine scope harmonics and a 7.1
 * layout's eight speaker feeds after them. */
#define SPATIAL_MAX_CHANNELS 17
#define SCOPE_CHANNELS 9        /* second-order ACN/SN3D (analysis.js) */
#define SPEAKER_MAX 8

typedef struct {
    int kind;                   /* 0 = stereo fold, 1 = binaural, 2 = analysis */
    TaudBinaural *bin;
    int numChannels;
    /* kind 2's speaker layout (speakers.js SpeakerRenderer): the non-LFE
     * speakers as a ring sorted by azimuth; spkCount 0 = harmonics only. */
    int spkCount, ringSize;
    int ringChannel[SPEAKER_MAX];
    double ringAz[SPEAKER_MAX];
    double data[SPATIAL_MAX_CHANNELS * TRACKER_CHUNK];
} TaudSpatialBus;

/* ── mastering (mastering.js) ──────────────────────────────────────────── */

#define EQ_BANDS 4
#define EQ_LOW_SHELF 0
#define EQ_PEAKING 1
#define EQ_HIGH_SHELF 2
#define COMP_PEAK 0
#define COMP_RMS 1
#define HP_SLOPE_12 0
#define HP_SLOPE_24 1

typedef struct { bool on; int type; float freq, gainDb, q; } TaudEqBand;

typedef struct {
    bool on;
    float trimDb;
    bool hpOn; float hpFreq; int hpSlope;
    bool eqOn;
    TaudEqBand eq[EQ_BANDS];
    bool compOn; int compDetector;
    float compThreshDb, compRatio, compAttackMs, compReleaseMs, compKneeDb, compMakeupDb;
    bool widthOn; float width;
    bool limOn, limTruePeak; float limCeilingDb, limReleaseMs;
    float outGainDb;
} TaudMastering;

typedef struct TaudMasterChain TaudMasterChain;

/* The chain's stages, exported for the instrument chains (imix.c) at any
 * channel count up to TE_MAX_BUS_CH — the widest bus a song can have. */
#define TE_MAX_BUS_CH 16

/* An RBJ section, Direct Form I: one set of coefficients, a delay line per
 * channel. */
typedef struct {
    double b0, b1, b2, a1, a2;
    double x1[TE_MAX_BUS_CH], x2[TE_MAX_BUS_CH], y1[TE_MAX_BUS_CH], y2[TE_MAX_BUS_CH];
} TaudBiquad;

static inline double te_bq_run(TaudBiquad *s, int c, double x)
{
    double y = s->b0 * x + s->b1 * s->x1[c] + s->b2 * s->x2[c] - s->a1 * s->y1[c] - s->a2 * s->y2[c];
    s->x2[c] = s->x1[c]; s->x1[c] = x;
    s->y2[c] = s->y1[c]; s->y1[c] = y;
    return y;
}

void te_bq_init(TaudBiquad *s);
void te_bq_reset(TaudBiquad *s);
void te_bq_high_pass(TaudBiquad *s, double freq, double q, double rate);
void te_bq_low_pass(TaudBiquad *s, double freq, double q, double rate);
void te_bq_band_pass(TaudBiquad *s, double freq, double q, double rate);
void te_bq_notch(TaudBiquad *s, double freq, double q, double rate);
void te_bq_all_pass(TaudBiquad *s, double freq, double q, double rate);
void te_bq_peaking(TaudBiquad *s, double freq, double gainDb, double q, double rate);
void te_bq_low_shelf(TaudBiquad *s, double freq, double gainDb, double q, double rate);
void te_bq_high_shelf(TaudBiquad *s, double freq, double gainDb, double q, double rate);

double te_db_to_gain(double db);
double te_one_pole(double ms, double rate);

typedef struct {
    double grDb, levelDb, rms, rmsCoef, attackCoef, releaseCoef, thresh, ratio, knee, makeup;
    bool peakMode;
} TaudCompressor;

void te_comp_configure(TaudCompressor *c, int detector, double threshDb, double ratio, double attackMs,
                       double releaseMs, double kneeDb, double makeupDb, double rate);
void te_comp_reset(TaudCompressor *c);
double te_comp_step_planar(TaudCompressor *c, const double *data, int n, int stride, int nch);

#define TP_PHASES 4
#define TP_TAPS 8
typedef struct { double hist[TP_TAPS]; } TaudTruePeakProbe;

typedef struct {
    int width, cap;
    double *val;
    int32_t *at;
    int head, tail;
    int32_t n;
} TaudSlidingMin;

/* The look-ahead limiter: `nch` channels, channel-major, 2D deep each. */
typedef struct {
    int nch;
    int d, dstride, dpos;
    double *delay;
    TaudSlidingMin min;
    bool hasMin;
    double *avg;
    int avgLen;
    double avgSum;
    int apos;
    double env, releaseCoef, ceiling;
    bool truePeak;
    TaudTruePeakProbe probes[TE_MAX_BUS_CH];
    double tpCoef[TP_PHASES * TP_TAPS];
    double grDb;
} TaudLimiter;

void te_lim_init(TaudLimiter *L, int nch);
void te_lim_free(TaudLimiter *L);
void te_lim_reset(TaudLimiter *L);
bool te_lim_configure(TaudLimiter *L, double ceilingDb, bool truePeak, double releaseMs, double rate);
void te_lim_step_planar(TaudLimiter *L, double *data, int n, int stride);

void te_mastering_default(TaudMastering *p);
bool te_mastering_engaged(const TaudMastering *p);
bool te_mastering_parse_block(const uint8_t *b, size_t len, TaudMastering *out);
TaudMasterChain *te_master_chain_new(const TaudMastering *p, int rate);
void te_master_chain_free(TaudMasterChain *c);
void te_master_chain_set_params(TaudMasterChain *c, const TaudMastering *p);
void te_master_chain_reset(TaudMasterChain *c);
void te_master_chain_process(TaudMasterChain *c, float *left, float *right, int frames);
/** The last chunk's deepest gain reduction, dB (≤ 0); 0 with no chain. */
double te_master_chain_comp_gr(const TaudMasterChain *c);
double te_master_chain_lim_gr(const TaudMasterChain *c);

/* ── instrument mixing chains (imix.js, imix-section.js) ───────────────── */

/* The equipment, in pipeline-0 order; pipeline 1 swaps the delay and the
 * reverb. The index is this port's; the file names each by its FourCC. */
enum {
    IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2,
    IMX_UNIS, IMX_SATU, IMX_DLAY, IMX_VERB, IMX_LIMI, IMX_MXTL, IMX_KINDS
};
#define IMX_EQ_MAX_BANDS 8
#define IMX_COMP_MAX_BANDS 6
#define IMX_TSH_MAX_BANDS 6
#define IMX_DEQ_BANDS 6
#define IMX_UNIS_MAX_VOICES 8

typedef struct { int wave; bool retrigger, sync; uint32_t rate; float depth; } TaudImxLfoParams;
typedef struct { bool on; int shape, slope; float freq, gainDb, q; } TaudImxEqBand;
typedef struct { bool on; float threshDb, ratio, attackMs, releaseMs, kneeDb, makeupDb; } TaudImxCompBand;
typedef struct { bool on; float attackDb, sustainDb, attackMs, releaseMs, outDb; } TaudImxTshBand;
typedef struct {
    bool on, unlinked, boost;
    float freq, q, gainDb, senseFreq, senseQ, threshDb, ratio, attackMs, releaseMs, rangeDb, actorDb;
} TaudImxDeqBand;

/* One piece of equipment, normalised (normaliseEquipment): every float a
 * binary32, every 16.16 quantity an integer. */
typedef struct {
    bool present, bypass;
    int dry;                    /* 0 = all wet … 255 = all dry */
    union {
        struct { float gainDb; } trim;
        /* floorDb is −∞ for no floor (a pure expander). */
        struct {
            bool keyFilter; int detector;
            float threshDb, floorDb, ratio, rangeDb, attackMs, holdMs, releaseMs, hysteresisDb, keyLowCut, keyHighCut;
        } expd;
        struct { int n; float xover[IMX_TSH_MAX_BANDS - 1]; TaudImxTshBand b[IMX_TSH_MAX_BANDS]; } tsh;
        struct { int n; TaudImxEqBand b[IMX_EQ_MAX_BANDS]; } eq;
        struct { int detector, n; float xover[IMX_COMP_MAX_BANDS - 1]; TaudImxCompBand b[IMX_COMP_MAX_BANDS]; } comp;
        struct { TaudImxDeqBand b[IMX_DEQ_BANDS]; } deq;
        struct { int curve; float driveDb, inDb, outDb, bias; } sat;
        struct { int voices; float detune, width, spacing; TaudImxLfoParams detuneLfo, widthLfo; } unis;
        struct { float size, decay, damping; uint32_t preDelay; } verb;
        struct { bool sync, pingPong, pingRight; uint32_t time; float feedback, highCut, lowCut, wow, driveDb; } dlay;
        struct { bool truePeak; float ceilingDb, releaseMs, gainDb; } lim;
        struct { bool swap, invL, invR, removeDc; float gainDb, width; } mx;
    } u;
} TaudImxEquipment;

/* One IMix block (§9.15): what playback reads of it. Equipment this reader
 * does not know is skipped, as it is by the reference. */
typedef struct {
    int id;                     /* 1…255 */
    bool enabled, bus;
    int order;                  /* 0 or 1 */
    TaudImxEquipment eq[IMX_KINDS];
} TaudImixBlock;

typedef struct TaudImxChain TaudImxChain;

/* ── the Mixing tab's meter tap (imix.js ImixMeterTap; imixtap.c) ── */

#define IMX_RING_FRAMES 2048
#define IMX_METER_SEATS 2
#define IMX_TAP_STAGE_COUNT 6   /* EQU1, DEQ1, TSH1, COMP, EQU2, DEQ2 */

/* A chain's gain reductions over a span (InstrumentChain.readGr). */
typedef struct {
    double comp[IMX_COMP_MAX_BANDS], deq1[IMX_DEQ_BANDS], deq2[IMX_DEQ_BANDS], tsh1[IMX_TSH_MAX_BANDS];
    double expd, expdLvl, lim;
    double compLvl[IMX_COMP_MAX_BANDS], deq1Lvl[IMX_DEQ_BANDS], deq2Lvl[IMX_DEQ_BANDS];
} TaudImxGr;

struct TaudImixTap;

/* One bus on the playhead (InstrumentBus): a chunk of channel-major binary64
 * in the song's own channel layout — `sb` is filled the way the master object
 * bus is, through the same renderer gains — and the chain that runs over it.
 * In bus mode `slots` lists every instrument sharing it, ascending. */
typedef struct {
    int slot;
    int *slots;
    int nSlots, capSlots;
    int blockId;
    uintptr_t renderer;         /* identity of the render target it was built for */
    int nch;
    bool stereo;
    TaudSpatialBus sb;          /* sb.data is the bus; sb.numChannels = nch */
    TaudImxChain *chain;
    bool fed;
} TaudImixBus;

/* Slots a route table covers: the 1024 bank slots and the audition slot. */
#define IMX_ROUTE_SLOTS NUM_INST_SLOTS

/* imix.c */
int te_imix_parse_section(const uint8_t *b, size_t len, TaudImixBlock **out);
bool te_imix_block_engaged(const TaudImixBlock *b);
TaudImxChain *te_imx_chain_new(const TaudImixBlock *block, int rate, int nch, bool stereo, bool ambisonic);
void te_imx_chain_free(TaudImxChain *c);
void te_imx_chain_set_block(TaudImxChain *c, const TaudImixBlock *block);
void te_imx_chain_reset(TaudImxChain *c);
void te_imx_chain_note_on(TaudImxChain *c);
bool te_imx_chain_idle(const TaudImxChain *c);
void te_imx_chain_process(TaudImxChain *c, double *data, int stride, int n0, int n1, int bpm, bool fed);
void te_imx_chain_set_probes(TaudImxChain *c, struct TaudImixTap *a, struct TaudImixTap *b);
void te_imx_chain_read_gr(const TaudImxChain *c, TaudImxGr *out);
bool te_imx_chain_unison_now(const TaudImxChain *c, double *cents, double *width);

/* What the Mixing tab draws for ONE instrument's bus: level figures on both
 * sides of the chain, the chain's gain reductions, a stereo ring after the
 * chain and a mono ring before it, a mono ring at the input of each tapped
 * piece, and the unison's detune and width. It exists only while the view
 * that reads it is up. */
typedef struct TaudImixTap {
    int slot;
    float ring[IMX_RING_FRAMES * 2], ringPre[IMX_RING_FRAMES];
    int write, preWrite;
    TaudTruePeakProbe probes[4];
    double tpCoef[TP_PHASES * TP_TAPS];
    double peak[4], truePeak[4], sumSq[4], clip[4];
    int frames;
    TaudImxGr gr;
    float stageRings[IMX_TAP_STAGE_COUNT][IMX_RING_FRAMES];
    int stageWrite[IMX_TAP_STAGE_COUNT];
    const TaudImixBus *bus;
    bool unisLive;
    double unisCents, unisWidth;
} TaudImixTap;

/* imixtap.c */
void te_set_imix_meter(struct TaudEngine *e, int slot, int seat);
void te_imix_tap_reset_all(TaudImixTap *t);
void te_imix_tap_push_pre(TaudImixTap *t, const TaudImixBus *bus, int n0, int n1);
void te_imix_tap_stage_in(TaudImixTap *t, int kind, int n0, int n1);
void te_imix_tap_push_post(TaudImixTap *t, const TaudImixBus *bus, int n0, int n1);
void te_fill_imix_meters(struct TaudEngine *e, float *f);
void te_tp_coef(double h[TP_PHASES * TP_TAPS]);
double te_tp_push(TaudTruePeakProbe *pr, const double *coef, double v);

/* ── the engine (engine.js + state.js Playhead/TrackerState) ───────────── */

/* formant.js's module-level tables, computed once per engine. The bank grid
 * is built at the engine rate: formant.js builds it when the module loads,
 * from the rate set by then (setSamplingRate before the import, as the
 * reference harness does). */
#define ISO226_N 29
#define BANK_GRID_MAX 64
#define SOURCE_DFT_MAX 4096
typedef struct {
    double logCard[4][4][2];
    double artF[3][5];              /* ART_F: [ART_PALATAL], [ART_DARK] */
    double elwLogF[ISO226_N], elwDb[ISO226_N];
    int bankN;
    double bankW[BANK_GRID_MAX], bankC1[BANK_GRID_MAX], bankS1[BANK_GRID_MAX];
    double bankC2[BANK_GRID_MAX], bankS2[BANK_GRID_MAX];
    double bankRef;
    double dft[SOURCE_DFT_MAX];     /* scratch */
    /* sourceHarmonics' memo: the same bytes measure the same. */
    int memoCount;
    struct {
        int64_t p, N;
        double m, P;
        uint32_t h;
        int K;
        double w[NORM_HARMONICS + 1];
    } memo[32];
    /* measureChipSource's memo: a chip patch's measurement at a rate. Cleared
     * whenever the instruments are uploaded, so a patch pointer is never
     * reused for another patch while an entry names it. */
    int chipMemoCount;
    struct {
        const void *patch;
        int kind, gen, rtGen;
        double pr, sm, sg;
        int K;
        double w[NORM_HARMONICS + 1];
    } chipMemo[32];
    double chipBuf[4096];               /* scratch */
} TaudFormantTables;

typedef struct TaudVoiceChunk {
    struct TaudVoiceChunk *next;
    int count;
    TaudVoice voices[1];        /* over-allocated */
} TaudVoiceChunk;

/* A level the host or the song sets outright, walked to its new value over the
 * volume ramp (sampler.js ByteGlide); byte units, cur NaN = snap. */
typedef struct {
    double cur, aim, step;
    int left;
} TaudByteGlide;

typedef struct TaudEngine {
    /* Rate-derived configuration (setSamplingRate). */
    int rate;
    int rampOutSamples, volRampSamples, attackRampSamples, sfFilterGlideSamples;
    double a500B1, a500A0, ledA1, ledA2, ledB1, ledB2;

    /* The sample pool, BORROWED from the parsed document and trimmed to its
     * last non-zero byte: a read at or past samplePoolLen is 0, which is
     * exactly what the untrimmed 8 MB pool holds there. */
    const uint8_t *sampleBin;
    size_t samplePoolLen;
    TaudInst *instruments;      /* NUM_INST_SLOTS */
    TaudCell **playdata;        /* NUM_PATTERNS slots, lazily allocated */
    TaudCell *sharedBlank[2];   /* the blank pattern every blank slot shares: narrow, wide */
    TaudCue *cueBlocks[CUE_BLOCKS];
    TaudCell emptyPattern[ROWS_PER_PATTERN];
    TaudCue emptyCue;
    bool is64ChannelMode;
    bool wideCells;

    /* Playhead 0 — the only one a player drives. */
    int position;
    int masterVolume, masterPan, bpm, tickRate, globalVolume, mixingVolume;
    int tuningBaseNote;
    double tuningFreq;
    int initialGlobalFlags;
    int surroundModel;
    int monitorMode;
    bool isPlaying;
    /* An audition is sounding with the transport stopped: the host keeps
     * rendering for it, and the mixer clears this once it has rung out. */
    bool jamActive;
    /* A lyric instrument jammed sings its lyrics on over the whole jam bank,
     * so the place is the playhead's, kept per instrument (item 280). */
    int jamLyricInst, jamLyricPos;

    /* TrackerState. */
    int cuePos, rowIndex, tickInRow;
    double samplesIntoTick;
    bool firstRow;
    int64_t oplFrame;           /* the OPL chip clock: frames mixed since reset */
    int psgQuarter;             /* the quarter of the tick the PSG auto-advance has reached */
    bool hasPsg;                /* some instrument is a PSG one (else no voice can sound a pair) */
    TaudVoice voices[TOTAL_VOICES];
    int toneMode, interpolationMode;
    bool ledFilterOn;
    bool ts_wideCells;
    int volMax, volStep;
    double volDiv;
    int ts_surroundModel;
    TaudSpatialBus *spatial;    /* NULL for the stereo model */
    TaudBinaural *binaural;     /* kept across model switches */
    unsigned rendererGen;
    /* The master strip's analysis bus (item 98): a SECOND object bus through
     * the analysis target, fed with every voice the monitor's is while a
     * surround song's strip is on screen; NULL otherwise. */
    TaudSpatialBus *analysisBus;
    unsigned analysisGen;
    TaudMastering masteringParams;
    bool hasMasteringParams;
    TaudMasterChain *mastering;
    double tuningRatio;
    double amigaLPStateL, amigaLPStateR;
    double amigaLEDStateL[4], amigaLEDStateR[4];
    int pendingOrderJump, pendingRowJump;
    bool pendingRowJumpLocal;
    int patternDelayRemaining;
    bool patternDelayActive;
    int sexWinningChannel;
    int finePatternDelayExtra;
    unsigned pendingInterrupts;
    uint16_t interruptArgs[NUM_INTERRUPTS];
    float mixLeft[TRACKER_CHUNK], mixRight[TRACKER_CHUNK];
    /* The mix as it goes INTO the mastering chain, kept only while a host's
     * meter asks for it (preTap): the Mastering view reads both sides. */
    bool preTap;
    float preLeft[TRACKER_CHUNK], preRight[TRACKER_CHUNK];

    TaudVoice **bg;
    int bgCount, bgCap;

    /* Voice pool. */
    TaudVoiceChunk *chunks;
    TaudVoice *freeList;
    int poolSize;

    /* Dither (pcm32fToPcm8). */
    uint32_t xorshift;
    float ditherError[4];

    /* Randomness seam (rng.js). */
    TaudRandomFn random;
    void *randomUser;
    uint32_t mulberry;

    /* Tables. */
    double sincTable[SINC_TABLE_SIZE];
    TaudFormantTables formantTables;
    /* The PSG noises: one period of each shift register's output. */
    uint8_t psgNoiseLong[PSG_NOISE_LONG_LEN];
    uint8_t psgNoiseMid[PSG_NOISE_MID_LEN];
    uint8_t psgNoiseShort[PSG_NOISE_SHORT_LEN];

    /* Instrument mixing chains (item 217): the project's blocks by id
     * (borrowed from the parsed document), and the playhead's route table —
     * rebuilt whenever imixGen moves or the render target changes. */
    const TaudImixBlock *imixBlocks[256];
    unsigned imixGen, imixSyncedGen;
    uintptr_t imixRenderer;
    TaudImixBus *imixRoutes[IMX_ROUTE_SLOTS];
    TaudImixBus **imixList;     /* ascending by slot */
    int imixCount, imixCap;
    uint8_t imixTrig[IMX_ROUTE_SLOTS];  /* a note started on the slot since its bus last ran */
    /* The Mixing tab's taps (item 217), one per split pane; NULL = off. */
    TaudImixTap *imixMeters[IMX_METER_SEATS];
    /* The frame accumulators the buses join (mixAccL/R): a span's frames are
     * finished only once every bus has run over it. */
    double accL[TRACKER_CHUNK], accR[TRACKER_CHUNK];
    /* The song's global, mixing and master volumes as the mixer glides them
     * (TaudByteGlide), and each frame's combined gain, which the buses read. */
    TaudByteGlide gvolGlide, mvolGlide, masterGlide;
    double gainSpan[TRACKER_CHUNK];

    bool oom;                   /* an allocation failed on the render path */

    /* Instrument data that was replaced while voices may still point at it
     * (te_retire): freed once no voice does. */
    struct TaudRetired *retired;
    int retiredCount, retiredCap, retireSweepAt;
    size_t retiredBytes;

    /* What the host API (wasm_api.c) holds on the engine's behalf. A player
     * borrows all of this from its parsed document and leaves these NULL; a
     * host that UPLOADS (the tracker) has no document, so the engine keeps
     * the copies and frees them when they are replaced or it is. */
    uint8_t *ownPool;
    TaudImixBlock *ownImix;
    TaudLyricEntry *ownLyrics;
    int ownLyricCount;
} TaudEngine;

/* engine.c */
static inline int te_pool_at(const TaudEngine *e, int64_t p)
{
    return (uint64_t)p < e->samplePoolLen ? e->sampleBin[p] : 0;
}

TaudEngine *te_engine_new(int rate);
/** Give up `p` (`size` bytes, malloc'd) without freeing it under a voice that
 *  still points into it: it joins the retired list, which te_retire_sweep
 *  empties of everything no voice can reach. The JavaScript engine left this
 *  to its garbage collector; a host that re-uploads an instrument while its
 *  notes sound needs the same. NULL is ignored; a NULL engine frees at once. */
void te_retire(struct TaudEngine *e, void *p, size_t size);
/** Free every retired block that no voice (and no retired block still kept)
 *  holds a pointer into. */
void te_retire_sweep(TaudEngine *e);
void te_engine_free(TaudEngine *e);
double te_random(TaudEngine *e);
static inline int te_channel_count(const TaudEngine *e) { return e->is64ChannelMode ? MAX_VOICES : NUM_VOICES; }
const TaudCell *te_pattern_read(const TaudEngine *e, int idx);
const TaudCue *te_cue_at(const TaudEngine *e, int idx);
void te_upload_sample_inst_blob(TaudEngine *e, const uint8_t *pool, size_t poolLen, const uint8_t *instBin);
void te_upload_pattern(TaudEngine *e, int slot, const uint8_t *bytes, size_t len);
void te_clear_pattern(TaudEngine *e, int slot);
void te_upload_cue(TaudEngine *e, int idx, const uint8_t *bytes, size_t len);
void te_upload_instrument_patches(TaudEngine *e, int slot, const uint8_t *bytes, size_t len);
void te_set_cell_format(TaudEngine *e, bool wide);
void te_set_tuning(TaudEngine *e, int baseNote, double freq);
void te_set_tracker_mixer_flags(TaudEngine *e, int flags);
void te_update_global_behaviour(TaudEngine *e, int flags);
void te_set_surround_model(TaudEngine *e, int model);
void te_set_monitor_mode(TaudEngine *e, int mode);
void te_set_mastering(TaudEngine *e, const TaudMastering *params);
void te_set_imix(TaudEngine *e, const TaudImixBlock *blocks, int count);
void te_set_lyrics(TaudEngine *e, const TaudLyricEntry *entries, int count);
void te_sync_imix_routes(TaudEngine *e);
void te_imix_free_routes(TaudEngine *e);
void te_imix_reset_chains(TaudEngine *e);
void te_set_cue_position(TaudEngine *e, int pos);
void te_reset_play_state(TaudEngine *e);
void te_set_tracker_row(TaudEngine *e, int row);
void te_play(TaudEngine *e);
void te_stop(TaudEngine *e);
void te_silence_song_voices(TaudEngine *e, bool ramp);
void te_reset_sample_fx_state(TaudEngine *e);
unsigned te_drain_interrupts(TaudEngine *e);
bool te_render_chunk(TaudEngine *e);
void te_pcm32f_to_pcm8(TaudEngine *e, uint8_t *out);
/** The device's dither over any pair of buffers, its state passed in: the
 *  engine's own, or a fresh one (seed TE_XORSHIFT_SEED, errors zero) for a
 *  gritty WAV. */
void te_dither_u8(uint32_t *xs, float err[4], const float *left, const float *right, size_t frames, uint8_t *out);
/** One step of the dither's xorshift32 stream. */
uint32_t te_xorshift32(uint32_t *state);
/** The adapter's xorshift32 seed (AudioAdapter.kt; rng.js makeXorshift32). */
#define TE_XORSHIFT_SEED 0x9e3779b9u

/* Voice pool + background list. */
TaudVoice *te_voice_alloc(TaudEngine *e);
void te_voice_init(TaudVoice *v);
void te_bg_push(TaudEngine *e, TaudVoice *v);
void te_bg_remove_at(TaudEngine *e, int i);

/* tables.c */
extern const int32_t SNES_GAUSS[512];
extern const int32_t MOD_SIN_TABLE[64];
extern const int32_t FINETUNE_OFFSET[16];
extern const double META_MIX_GAIN[256];
void te_build_tables(TaudEngine *e);
double te_sinc_tap(const TaudEngine *e, double frac, int tap);
int te_advance_lfo_phase(int pos, int speed);
int te_lfo_sample(TaudEngine *e, int pos, int wave);
int te_lfo_sample_wide(TaudEngine *e, int pos, int wave);
double te_atten_gain_of(int octet);
double te_note_val_to_amiga_period(double noteVal);
int te_amiga_period_to_note_val(double period);
double te_note_val_to_freq_hz(double noteVal);
int te_freq_hz_to_note_val(double freq);
double te_tuning_ratio_of(int baseNote, double freq);
int te_amiga_slide_tick(TaudVoice *v, int slideArg);
int te_amiga_slide_once(double noteVal, int slideArg);
int te_linear_freq_slide_tick(TaudVoice *v, int slideArg);
int te_linear_freq_slide_once(double noteVal, int slideArg);

/* minifloat */
extern const float MINIFLOAT_LUT[256];
static inline double minifloat_to_double(int index) { return (double)MINIFLOAT_LUT[index & 0xff]; }

/* inst.c */
void te_inst_init(TaudInst *inst, int index);
void te_inst_free(TaudInst *inst);
void te_inst_load_record(TaudInst *inst, const uint8_t *b);
void te_inst_set_lyric(TaudInst *inst, const TaudLyricEntry *entry);
int te_parse_patches_blob(const uint8_t *bytes, size_t len, TaudPatch **out);
const TaudPatch *te_inst_resolve_patch(const TaudInst *inst, double noteVal, int rowVolume);
const TaudPatch *te_patch_at(const TaudInst *inst, int patchIndex);
int te_inst_resolve_meta_layers(const TaudInst *inst, double noteVal, int rowVolume, const TaudMetaLayer **out);
bool te_patch_is_stereo(const TaudPatch *p);
bool te_patch_vibrato_inherits(const TaudPatch *p);
static inline double te_layer_note(const TaudMetaLayer *l, double noteVal)
{
    return l->fixedPitch ? (l->detune & 0xffff) : noteVal + l->detune;
}
void te_inst_toggle_invert_bit(TaudInst *inst, int loopOffset, int loopLen);
bool te_inst_invert_bit(TaudInst *inst, int loopOffset, int loopLen);
bool te_inst_set_mod_region(TaudInst *inst, double from, double to);
bool te_inst_set_mod_comb(TaudInst *inst, int bits, bool odd);
bool te_inst_set_mod_op(TaudInst *inst, int op, bool invert);
bool te_inst_set_mod_op_ext(TaudInst *inst, int code, bool invert, int f);
void te_inst_clear_mod_state(TaudInst *inst);
void te_inst_snapshot_mod_state(TaudInst *inst);
void te_inst_reset_mod(TaudInst *inst);
void te_inst_toggle_mod_bit(TaudInst *inst, int i, int sampleLen);
static inline bool te_inst_mod_bit(const TaudInst *inst, int i)
{
    int byte;
    if (inst->modMaskLen == 0) return false;
    byte = i >> 3;
    if (byte < 0 || byte >= inst->modMaskLen) return false;
    return ((inst->modMask[byte] >> (i & 7)) & 1) != 0;
}

/* samplemod.c */
#define MOD_OFF 0x0
#define MOD_INVERT 0x1
#define MOD_ROL1 0x2
#define MOD_ROL8 0x5
#define MOD_SUB2 0x6
#define MOD_SUB128 0x9
#define MOD_JUMP8 0xa
#define MOD_JUMP16 0xb
#define MOD_JUMP_ALL 0xc
#define MOD_RND512 0xd
#define MOD_RND8 0xf
#define MOD_WALK_SCAN 4096
#define MOD_XFADE_SAMPLES 64
#define REGION_NONE 0
#define REGION_SET 1
#define REGION_COMB 2
extern const int MOD_STEP[16];

enum {
    EXT_KIND_NOOP, EXT_KIND_INVERT, EXT_KIND_FUNK, EXT_KIND_XOR, EXT_KIND_MIRROR,
    EXT_KIND_INVERT_JIT, EXT_KIND_FUNK_JIT, EXT_KIND_JUMP_N, EXT_KIND_JUMP_N_BOUNDED,
    EXT_KIND_SWAP, EXT_KIND_SCATTER, EXT_KIND_ROL, EXT_KIND_SUB, EXT_KIND_BITROT,
    EXT_KIND_BITPERM
};
typedef struct { int kind; double param; } TaudExtOp;

int te_mod_step_period(int y);
int te_jump_rot(TaudEngine *e, int op, int domainLen);
int te_scatter_reach(int op, int domainLen);
uint32_t te_scatter_seed(TaudEngine *e);
int te_decode_sample_region(int se, double out[4]);
const TaudModGeom *te_resolve_mod_geom(TaudModGeom *g, const TaudInst *inst, int loopStart, int loopEnd, int sampleLen);
bool te_mod_touches(const TaudModGeom *g, bool invert, int i);
int te_mod_address(const TaudModGeom *g, int i, int rot, int scatter, uint32_t seed);
bool te_ext_mod_touches(const TaudModGeom *g, bool invert, int f, int stepIndex, int i);
TaudExtOp te_decode_ext_op(int code);
double te_ext_yk_period_ticks(int yk);
double te_ext_jitter_frac(int x);
int te_mod_address_ext(const TaudModGeom *g, int i, const TaudInst *inst);
int te_apply_ext_level(const TaudInst *inst, int b);
int te_apply_ext_level_prev(const TaudInst *inst, int b);
static inline bool te_is_ext_funk_op(int code) { return code == 0x102 || (code >= 0x120 && code <= 0x12f); }
static inline bool te_is_rol_op(int op) { return op >= MOD_ROL1 && op <= MOD_ROL8; }
static inline bool te_is_sub_op(int op) { return op >= MOD_SUB2 && op <= MOD_SUB128; }
static inline bool te_is_jump_op(int op) { return op >= MOD_JUMP8 && op <= MOD_JUMP_ALL; }
static inline bool te_is_rnd_op(int op) { return op >= MOD_RND512 && op <= MOD_RND8; }

/* sampler.c */
double te_compute_playback_rate(const TaudEngine *e, const TaudVoice *v, double noteVal, double tuningRatio);
double te_fetch_tracker_sample(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, double posOffset);
void te_fetch_tracker_sample_stereo(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, double out[2]);
void te_start_ramp_out(TaudEngine *e, TaudVoice *v);
void te_start_cut_ramp(TaudEngine *e, TaudVoice *v);
void te_start_fast_fade(TaudEngine *e, TaudVoice *v);
void te_advance_pitch_ramp(TaudEngine *e, TaudVoice *v, double spt);
double te_advance_pan_ramp(TaudEngine *e, TaudVoice *v, double target, bool wrap);
void te_advance_volume_ramp(TaudEngine *e, TaudVoice *v, double div);
double te_advance_fadeout(TaudVoice *v);
double te_byte_glide_next(const TaudEngine *e, TaudByteGlide *g, int target);
double te_advance_fader_ramp(const TaudEngine *e, TaudVoice *v, int target);
double te_advance_elev_ramp(const TaudEngine *e, TaudVoice *v, double target);

/* envelope.c */
void te_apply_key_lift(TaudVoice *v, const TaudInst *inst);
void te_force_key_lift(TaudVoice *v);
void te_advance_envelope(TaudEngine *e, TaudVoice *v, double tickSec);
double te_seed_pf_role(const TaudEnvPoint *env, int loopWord, int susWord, int *idxOut, double *timeOut);
void te_advance_pitch_envelope(TaudVoice *v, double tickSec);
void te_advance_filter_envelope(TaudVoice *v, double tickSec);
int te_advance_auto_vibrato(TaudEngine *e, TaudVoice *v);
static inline bool te_env_present(int loopWord) { return ((loopWord >> 13) & 1) != 0; }
static inline bool te_env_carry(int loopWord) { return ((loopWord >> 6) & 1) != 0; }

/* filter.c */
void te_refresh_voice_filter(const TaudEngine *e, TaudVoice *v);
double te_apply_voice_filter(const TaudVoice *v, double x0, TaudChannelState *st);
double te_apply_voice_filter_self(TaudVoice *v, double x0);
void te_advance_filter_glide(const TaudEngine *e, TaudVoice *v);
double te_apply_taud_voice_fx(const TaudVoice *v, double sample, int *bitcrusherCounter, double *bitcrusherHeld);

/* fm.c */
void te_fm_rig_init(TaudFmRig *rig, int count);
void te_fm_rig_clone(TaudFmRig *dst, const TaudFmRig *src);
void te_fm_referenced_operators(const uint16_t *program, int len, int count, uint8_t *used);
void te_fm_seed_gains(TaudFmRig *rig, const TaudMeta *meta);
double te_render_fm_voice(TaudEngine *e, TaudVoice *v, int interpMode, double spt, int64_t frame);
void te_drop_fm_operators(TaudEngine *e, int vi);
bool te_fm_principal_is_dsp(const uint16_t *program, int len);
void te_fm_set_operator_vibrato(TaudFmRig *rig, int p, int s, int d);

/* opl.c */
extern const int32_t OPL_MULTIPLE_X2[16];
extern const int32_t OPL_SUSTAIN_LEVEL[16];
#define OPL_VIBRATO_PERIOD 8192
#define OPL_TREMOLO_PERIOD 13440
void te_decode_opl_patch(const uint8_t *bytes, TaudOplPatch *into);
void te_opl_state_init(TaudOplState *st);
void te_opl_key_on(TaudOplState *st, const TaudOplPatch *patch, bool carry);
void te_opl_key_off(TaudOplState *st);
void te_opl_reattack(TaudOplState *st);
double te_opl_render(const TaudEngine *e, TaudOplState *st, int64_t frame, double rate, double vol, bool keyOff);
bool te_opl_channel_alive(const TaudOplState *st);
double te_render_opl_voice(TaudEngine *e, TaudVoice *v, int64_t frame);
/* What the PSG borrows from the chip (psg.js imports them from opl.js). */
int te_opl_expand(double att);
void te_opl_advance_envelope(uint8_t *state, int32_t *env, int32_t ksrOffset, const TaudOplOperator *op, int32_t eg);
void te_opl_key_scaling(double hz, int ksr, int ksl, int32_t out[2]);
int64_t te_opl_chip_index(const TaudEngine *e, int64_t frame, double *frac);
double te_opl_tremolo_at(int deep, int p);
double te_opl_vibrato_at(int deep, int p);

/* psg.c */
void te_psg_tables_init(TaudEngine *e);
void te_decode_psg_patch(const uint8_t *bytes, TaudPsgPatch *into);
void te_psg_clear_runtime(TaudPsgPatch *patch);
bool te_psg_write_register(TaudPsgPatch *patch, int reg);
void te_psg_state_init(TaudPsgState *st);
void te_psg_key_on(TaudPsgState *st, TaudPsgPatch *patch, bool carry);
void te_psg_key_off(TaudPsgState *st);
void te_psg_reattack(TaudPsgState *st);
int te_psg_current_wave(const TaudPsgState *st, int i);
void te_psg_quarter_tick(TaudPsgState *st);
int te_psg_quarter_at(double into, double spt);
double te_psg_render(const TaudEngine *e, TaudPsgState *st, int64_t frame, double rate, bool keyOff);
bool te_psg_channel_alive(const TaudPsgState *st);
double te_render_psg_voice(TaudEngine *e, TaudVoice *v, int64_t frame);

/* formant.c */
#define PHASE_ONSET 0
#define PHASE_VOWEL 1
#define PHASE_CODA 2
#define PHASE_DONE 3
void te_formant_tables_init(TaudFormantTables *t, int rate);
void te_decode_formant_block(const uint8_t *raw, TaudFormantPatch *patch);
void te_formant_state_init(TaudFormantState *st);
void te_formant_note_on(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch, bool keep);
void te_formant_restart(TaudEngine *e, TaudFormantState *st);
void te_formant_relatch(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch);
void te_formant_start_at_vowel(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch, bool keep);
void te_formant_set_vowel(TaudFormantState *st, int f, int g, int r);
void te_formant_command(TaudEngine *e, TaudFormantState *st, int arg);
const TaudInst *te_formant_chip_source(const TaudEngine *e, const TaudInst *inst);
int te_formant_chip_rate(const TaudInst *src);
void te_formant_key_source(TaudFormantState *st, const TaudInst *chip);
void te_formant_relatch_source(TaudFormantState *st, const TaudInst *chip);
void te_formant_lyric_syllable(const TaudFormantPatch *rec, const TaudLyricSyllable *syl,
                               const TaudLyricEntry *entry, TaudFormantPatch *out);
double te_render_formant_voice(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, int64_t frame);

/* spatial.c */
double te_wrap_azimuth(double a);
double te_fold_azimuth_to_pan(double az);
void te_direction_from_angles(double az, double el, double out[3]);
void te_angles_from_direction(double x, double y, double z, double out[2]);
void te_sample_channel_angles(double az, double el, double localAz, double out[2]);
void te_angles_from_spatial_arg(int arg, double out[2]);
void te_step_toward_target(double az, double el, double tgtAz, double tgtEl, double stepUnits, double out[2]);
void te_encode_sn3d(double az, double el, int order, double *out);
void te_apply_pan_set(TaudEngine *e, TaudVoice *v, double pan);
void te_apply_pan_slide(TaudEngine *e, TaudVoice *v, double delta);
void te_apply_elevation(TaudEngine *e, TaudVoice *v, double el);
double te_bound_note_pan(const TaudEngine *e, double off);
void te_apply_note_pan_set(TaudEngine *e, TaudVoice *v, double pan);
void te_apply_note_pan_slide(TaudEngine *e, TaudVoice *v, double delta);
void te_apply_note_elevation(TaudEngine *e, TaudVoice *v, double el);
double te_voice_azimuth(const TaudVoice *v);
double te_voice_pan_byte(const TaudVoice *v);
double te_voice_elevation(const TaudVoice *v);
double te_display_pan_byte(TaudEngine *e, int vi, const TaudVoice *v);
void te_display_angles(TaudEngine *e, int vi, const TaudVoice *v, double out[2]);
/** Install the analysis bus: layout −1 = none, 0 = the scope harmonics alone,
 *  1 quad, 2 5.1, 3 7.1 (speakers.js). */
void te_set_analysis_bus(TaudEngine *e, int layout);
const double *te_analysis_voice_gains(TaudEngine *e, TaudVoice *v);

/* snapshot.c — what the page draws from */
void te_fill_snapshot(TaudEngine *e, float *f);
int te_get_invert_mask(const TaudEngine *e, int slot, uint8_t *out, int cap);
int te_get_mod_mask(const TaudEngine *e, int slot, uint8_t *out, int cap);
void te_get_sample_mod(const TaudEngine *e, int slot, double *out);
int te_get_psg_state(const TaudEngine *e, int slot, int *out);
int te_get_formant_state(const TaudEngine *e, int slot, double *voices, int *extra, int *lyric, int lyricCap,
                         int *counts);
void te_get_active_note_counts(const TaudEngine *e, int32_t *out);
const double *te_spatial_voice_gains(TaudEngine *e, TaudVoice *v);
void te_spatial_bus_add_source(TaudSpatialBus *bus, int n, double value, const double *gains, int off, double ramp);
void te_spatial_bus_stereo_at(TaudSpatialBus *bus, int n, double out[2]);
bool te_is_sounding_child(const TaudEngine *e, const TaudVoice *bg, int vi);

/* binaural.c */
TaudBinaural *te_binaural_new(bool sphere, int rate);
void te_binaural_free(TaudBinaural *b);
void te_binaural_reset(TaudBinaural *b);
void te_binaural_channel_gains(const TaudBinaural *b, double az, double el, double *out, int off);
void te_binaural_monitor_stereo(TaudBinaural *b, const double *data, int frames, int n, double out[2]);
extern const int16_t HRIR_SADIE[16 * 256];

/* trigger.c */
void te_apply_active_sample(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch);
int te_row_volume_from_default(const TaudInst *inst, const TaudPatch *patch, int volMax);
void te_cap_background_voices(TaudEngine *e);
void te_cut_layer_children(TaudEngine *e, int vi);
/* glide: a G/L on a silent lane, triggering as its note's glide (lyrics). */
void te_trigger_meta_or_note(TaudEngine *e, TaudVoice *v, int vi, double noteVal, int instId, int rowVolOverride,
                             bool lyricReset, bool glide);
void te_trigger_note(TaudEngine *e, TaudVoice *v, double noteVal, int instId, int volOverride,
                     const TaudFormantPatch *lyricPatch);
int te_narrow_vol_axis(const TaudEngine *e, int v);
void te_apply_duplicate_check(TaudEngine *e, int channel, int instId, double note);
void te_maybe_spawn_background_for_nna(TaudEngine *e, TaudVoice *v, int channel, int incomingInst);
void te_retrig_hand_off(TaudEngine *e, TaudVoice *voice, int vi);
void te_apply_past_note_action(TaudEngine *e, int channel, int action);
void te_apply_vol_column(TaudEngine *e, TaudVoice *v, int value, int sel);
void te_apply_pan_column(TaudEngine *e, TaudVoice *v, int value, int sel);
void te_apply_pan_column_wide(TaudEngine *e, TaudVoice *v, const TaudCell *row);

/* effects.c */
void te_apply_effect_row(TaudEngine *e, TaudVoice *v, int vi, int op, int rawArg, int ext, bool hasExt);
int te_apply_retrig_vol_mod(int vol, int x, int step, int max);

/* row.c */
void te_apply_tracker_row(TaudEngine *e);
void te_advance_row(TaudEngine *e);
void te_advance_row_position(TaudEngine *e);
void te_reconstruct_ditto_state(TaudEngine *e, int startRow);

/* host.c — what a host that edits asks for and a player never does */
void te_jam_note(TaudEngine *e, int vi, int note, int instId, bool audition);
void te_jam_sample(TaudEngine *e, int vi, int note, uint32_t ptr, int len, int rate, int playStart,
                   int loopStart, int loopEnd, int loopMode, int detune, uint32_t chanPtr2, int chanMode);
void te_jam_stop(TaudEngine *e);
void te_jam_stop_voice(TaudEngine *e, int vi);
void te_jam_key_off(TaudEngine *e, int vi);
void te_jam_release(TaudEngine *e, int vi);
void te_set_voice_fader(TaudEngine *e, int vi, int fader);
int te_get_voice_fader(const TaudEngine *e, int vi);
void te_reset_params(TaudEngine *e);
bool te_chase_tracker_row(TaudEngine *e, int cue, int row);
int te_cue_row_limit(const TaudCue *c);
void te_reset_pattern_loop_state(TaudEngine *e);

/* tick.c */
void te_apply_tracker_tick(TaudEngine *e);
void te_apply_tick_events(TaudEngine *e);
void te_psg_quarter_pass(TaudEngine *e);
bool te_psg_live(const TaudEngine *e);
void te_advance_sample_mod_extended(TaudEngine *e, TaudVoice *v, double spt);
int te_funk_walk_step(int funkMode, int walk, int loopStart, int loopLen, int sampleLen);
int te_funk_walk_pointer(TaudEngine *e, int funkMode, int walk, int loopStart, int loopLen, int sampleLen);

/* mixer.c */
bool te_generate_tracker_audio(TaudEngine *e);

/* ── format layer (taud-parse.js) ──────────────────────────────────────── */

typedef struct {
    int instId;
    const uint8_t *blob;
    size_t len;
} TaudIxmpEntry;

typedef struct {
    int numVoices, numPats, bpm, tickRate, tuningBaseNote;
    float tuningFreq;
    int globalFlags, globalVolume, mixingVolume, numCuesStored, surroundModel;
    uint8_t *patBin;            /* numPats × patSize, owned */
    size_t patBinLen;           /* bytes actually decompressed */
    int patSize;
    int numCues;
    uint16_t *cues;             /* numCues × MAX_VOICES words, owned */
    bool hasMastering;
    TaudMastering mastering;
    char *name;                 /* sMet name, owned (may be NULL) */
} TaudSong;

typedef struct {
    int kind;                   /* 0 taud, 1 tsii, 2 tpif */
    int fmtVer;
    bool is64Channel;
    bool wideCells;
    /* The sample+instrument image, owned (NULL if absent): the sample pool
     * trimmed to samplePoolLen bytes, followed by the 256 KiB instrument bin. */
    uint8_t *sampleInstImage;
    size_t samplePoolLen;
    int numSongs;
    TaudSong *songs;
    uint8_t *projData;          /* copy of the Project-Data region, owned */
    size_t projLen;
    int numIxmp;
    TaudIxmpEntry *ixmp;        /* blobs point into projData */
    char *projectName;
    int numImix;
    TaudImixBlock *imix;        /* the IMix section's valid blocks, owned */
    int numLyrics;
    TaudLyricEntry *lyrics;     /* the ILyr section's valid entries, owned */
} TaudDoc;

TaudError te_parse_taud(const uint8_t *file, size_t len, TaudDoc *doc);
void te_doc_free(TaudDoc *doc);
/** The `ILyr` section's entries (§9.17): the count kept, or -1 out of memory. */
int te_parse_lyrics(const uint8_t *pl, size_t len, TaudLyricEntry **out);
void te_lyrics_free(TaudLyricEntry *list, int count);
void te_load_into_engine(TaudEngine *e, const TaudDoc *doc, int songIndex);

/* Decompressors: return a malloc'd buffer (at least `expected` bytes, zero
 * padded, when expected > 0) or NULL. */
uint8_t *te_decompress(const uint8_t *src, size_t len, size_t expected, size_t *outLen);
uint8_t *te_zstd_decompress(const uint8_t *src, size_t len, size_t expected, size_t *outLen);
uint8_t *te_gunzip(const uint8_t *src, size_t len, size_t expected, size_t *outLen);

/* resample.c */
float *te_resample_interleaved(const float *in, size_t frames, int channels, int srcRate, int dstRate, size_t *outFrames);

#endif /* TAUD_INTERNAL_H */
