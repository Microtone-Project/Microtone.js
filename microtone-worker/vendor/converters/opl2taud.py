#!/usr/bin/env python3
"""opl2taud.py — AdLib/OPL2 (YM3812) instruments to Taud FM operator racks.

Usage:
    python3 opl2taud.py input.BNK output.tsii [-v] [--names NAME,NAME,...]

An AdLib .BNK patch is two YM3812 operators plus a connection and a feedback
setting.  A Taud type-4 Metainstrument is an operator RACK: a table of ordinary
instruments read as oscillators, plus an RPN algorithm saying how they feed each
other (TAUD_FILE_FORMAT.md §7.6, TAUD_ENGINE_SPEC.md §5.5.1).  The two line up
almost field for field once the chip's log-domain arithmetic is unpicked:

    OPL                      Taud
    ------------------------ --------------------------------------------------
    waveSel                  the operator instrument's SAMPLE — one cycle of the
                             chip's own sine / half / abs / pulse shape, 1024
                             points, exactly the chip's phase table
    totalLevel               the rack entry's mix octet (0.75 dB a step), with
                             the modulator's carrying the ×2 that turns an OPL
                             operator's ±full-scale output into Taud's ±1 cycle
                             of phase deviation
    multiple                 the rack entry's detune (a frequency ratio in
                             4096-TET units)
    attack/decay/sustain/    the operator instrument's VOLUME ENVELOPE, in real
      release/eg             seconds at the band's key
    ksl / ksr                pitch-BANDED entries: one entry (and one instrument)
                             per band of the keyboard, gated by the entry's pitch
                             rectangle, so only ever one of them sounds
    feedback                 a z⁻¹ tap ($08xx) scaled by a DC operator, which is
                             how a rack writes a constant
    connection               FM = `$0001 $0400`; additive = a DC gate operator 0
                             ring-modulating the sum of the two
    am (tremolo)             NOT REPRESENTED — 1.0 dB at 3.7 Hz, no Taud analogue
    vib                      the instrument's auto-vibrato (7 cents at ~6.08 Hz)

The rhythm-mode drums are the one place a rack is the wrong shape: the hi-hat,
snare and top cymbal are not oscillators at all — the chip builds their phase out
of single bits of two accumulators and its noise LFSR — so those three are
rendered here to a looped PCM waveform at unit envelope, and the OPL envelope is
then carried by the Taud instrument exactly as it is for a rack operator.

This module is importable: ims2taud (and rol2taud) call `build_bank` to inline
the patches a song actually uses.  Run as a script it writes a .tsii bank.
"""

import argparse
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_KIND_SAMPLEINST,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, INST_RECORD_SIZE,
    SAMPLE_LEN_LIMIT, TAUD_C4,
    META_GAIN, nearest_minifloat, compress_blob, build_project_data,
)


# ── OPL2 hardware tables ─────────────────────────────────────────────────────
#
# Computed from their closed forms rather than pasted in, exactly as the
# reference implementation does; the derivations are in iyagimusic-js
# docs/OPL2_NOTES.en.md.

CHIP_CLOCK_HZ = 3579545
CLOCKS_PER_SAMPLE = 72
NATIVE_RATE = CHIP_CLOCK_HZ / CLOCKS_PER_SAMPLE      # 49716.05 Hz

ENV_MAX = 511
ENV_STEP_DB = 0.1875
TL_STEP_DB = 0.75
ENV_TO_LOG = 8
TL_TO_LOG = 32

LOG_SIN = [round(-math.log2(math.sin((i + 0.5) * math.pi / 512)) * 256)
           for i in range(256)]
EXP = [round((2.0 ** (i / 256.0) - 1.0) * 1024) for i in range(256)]

SILENCE = 0x1000


def expand(att: int) -> int:
    """Log-domain attenuation to a linear amplitude, chip-style.  The table plus
    its implicit leading bit spans 1024…2047 and the output carries one more bit
    below the sign, so full scale is ±4090 — the factor that makes feedback 7 the
    documented 4π of phase modulation."""
    if att >= 0x1800:
        return 0
    frac = att & 0xFF
    whole = att >> 8
    return ((EXP[255 - frac] + 1024) << 1) >> whole


OPL_FULL_SCALE = expand(0)          # 4090

def waveform(shape: int, phase: int):
    """(attenuation, sign) for a 10-bit phase; attenuation SILENCE means muted.

    Shapes 0…3 are the YM3812's.  Shapes 4…7 are the four the YMF262 adds, and
    they add no table: they are the same quarter sine read differently, exactly
    as the chip's published waveform figure draws them.  A `.sop` instrument
    selects from all eight (SOP_FORMAT §3.2), so the compiler has to be able to
    build all eight; a `.bnk` only ever names the first four."""
    quarter = phase & 0xFF
    mirrored = 255 - quarter if (phase & 0x100) else quarter
    negative = (phase & 0x200) != 0
    shape &= 7
    if shape == 0:                                        # full sine
        return LOG_SIN[mirrored], (-1 if negative else 1)
    if shape == 1:                                        # half sine
        return (SILENCE, 1) if negative else (LOG_SIN[mirrored], 1)
    if shape == 2:                                        # absolute sine
        return LOG_SIN[mirrored], 1
    if shape == 3:                                        # pulse sine
        return (SILENCE, 1) if (phase & 0x100) else (LOG_SIN[quarter], 1)
    if shape == 4:                                        # even sine
        # The first half cycle stretched over a whole one, sign and all; the
        # second half is silent.
        if negative:
            return SILENCE, 1
        p = (phase << 1) & 0x3FF
        q = p & 0xFF
        return LOG_SIN[255 - q if (p & 0x100) else q], (-1 if (p & 0x200) else 1)
    if shape == 5:                                        # even absolute sine
        if negative:
            return SILENCE, 1
        p = (phase << 1) & 0x1FF                          # as 4, sign dropped
        q = p & 0xFF
        return LOG_SIN[255 - q if (p & 0x100) else q], 1
    if shape == 6:                                        # square
        return 0, (-1 if negative else 1)
    # Logarithmic sawtooth: down across the first half and back up across the
    # second, so the two halves meet at silence rather than at a step.
    ramp = phase & 0x1FF
    return ((0x1FF - ramp if negative else ramp) << 3), (-1 if negative else 1)


KSL_ROM = (0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56)
KSL_SHIFT = (None, 1, 2, 0)

MULTIPLE_X2 = (1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30)

SUSTAIN_LEVEL = tuple([i * 16 for i in range(15)] + [496])

EG_DUTY = ((1, 0, 1, 0, 1, 0, 1, 0),
           (1, 0, 1, 0, 1, 0, 1, 1),
           (1, 0, 1, 1, 1, 0, 1, 1),
           (1, 0, 1, 1, 1, 1, 1, 1))

# The AdLib driver's F-number table: one octave in 1/16-semitone steps.  Values
# that would overflow the chip's ten-bit F-number are stored halved with 0xFE in
# the high byte.
FNUM_TABLE = (
    0x02b2, 0x02b4, 0x02b7, 0x02b9, 0x02bc, 0x02be, 0x02c1, 0x02c3,
    0x02c6, 0x02c9, 0x02cb, 0x02ce, 0x02d0, 0x02d3, 0x02d6, 0x02d8,
    0x02db, 0x02dd, 0x02e0, 0x02e3, 0x02e5, 0x02e8, 0x02eb, 0x02ed,
    0x02f0, 0x02f3, 0x02f6, 0x02f8, 0x02fb, 0x02fe, 0x0301, 0x0303,
    0x0306, 0x0309, 0x030c, 0x030f, 0x0311, 0x0314, 0x0317, 0x031a,
    0x031d, 0x0320, 0x0323, 0x0326, 0x0329, 0x032b, 0x032e, 0x0331,
    0x0334, 0x0337, 0x033a, 0x033d, 0x0340, 0x0343, 0x0346, 0x0349,
    0x034c, 0x034f, 0x0352, 0x0356, 0x0359, 0x035c, 0x035f, 0x0362,
    0x0365, 0x0368, 0x036b, 0x036f, 0x0372, 0x0375, 0x0378, 0x037b,
    0x037f, 0x0382, 0x0385, 0x0388, 0x038c, 0x038f, 0x0392, 0x0395,
    0x0399, 0x039c, 0x039f, 0x03a3, 0x03a6, 0x03a9, 0x03ad, 0x03b0,
    0x03b4, 0x03b7, 0x03bb, 0x03be, 0x03c1, 0x03c5, 0x03c8, 0x03cc,
    0x03cf, 0x03d3, 0x03d7, 0x03da, 0x03de, 0x03e1, 0x03e5, 0x03e8,
    0x03ec, 0x03f0, 0x03f3, 0x03f7, 0x03fb, 0x03fe, 0xfe01, 0xfe03,
    0xfe05, 0xfe07, 0xfe08, 0xfe0a, 0xfe0c, 0xfe0e, 0xfe10, 0xfe12,
    0xfe14, 0xfe16, 0xfe18, 0xfe1a, 0xfe1c, 0xfe1e, 0xfe20, 0xfe21,
    0xfe23, 0xfe25, 0xfe27, 0xfe29, 0xfe2b, 0xfe2d, 0xfe2f, 0xfe31,
    0xfe34, 0xfe36, 0xfe38, 0xfe3a, 0xfe3c, 0xfe3e, 0xfe40, 0xfe42,
    0xfe44, 0xfe46, 0xfe48, 0xfe4a, 0xfe4c, 0xfe4f, 0xfe51, 0xfe53,
    0xfe55, 0xfe57, 0xfe59, 0xfe5c, 0xfe5e, 0xfe60, 0xfe62, 0xfe64,
    0xfe67, 0xfe69, 0xfe6b, 0xfe6d, 0xfe6f, 0xfe72, 0xfe74, 0xfe76,
    0xfe79, 0xfe7b, 0xfe7d, 0xfe7f, 0xfe82, 0xfe84, 0xfe86, 0xfe89,
    0xfe8b, 0xfe8d, 0xfe90, 0xfe92, 0xfe95, 0xfe97, 0xfe99, 0xfe9c,
    0xfe9e, 0xfea1, 0xfea3, 0xfea5, 0xfea8, 0xfeaa, 0xfead, 0xfeaf,
)
CHIP_NOTES = 96          # the driver's note range, MIDI 12…107
MIDI_TO_CHIP = 12        # the driver's MIDI→chip transpose: MIDI 60 is chip 48
SUBSTEPS = 16


def chip_freq(note: int, bend_16ths: int = 0):
    """(block, fnum) the AdLib driver programmes for chip note `note`.  `note` is
    in semitones; `bend_16ths` shifts it in 1/16 semitones."""
    t = (note * 256 + bend_16ths * 16 + 8) >> 4
    limit = CHIP_NOTES * SUBSTEPS - 1
    t = 0 if t < 0 else (limit if t > limit else t)
    semitone, sixteenth = t >> 4, t & 15
    entry = FNUM_TABLE[(semitone % 12) * SUBSTEPS + sixteenth]
    block = semitone // 12 - 1
    if entry & 0x8000:
        block += 1
    if block < 0:
        block += 1
        entry >>= 1
    return block, entry & 0x3FF


def chip_note_hz(note: int) -> float:
    block, fnum = chip_freq(note)
    return fnum * NATIVE_RATE / (1 << (20 - block))


#: The chip's own middle C — what Taud note $5000 must be declared to sound at.
OPL_C4_HZ = chip_note_hz(48)


def ksl_attenuation(block: int, fnum: int, ksl: int) -> int:
    """Key-scale attenuation in 0.75 dB units for the note, after the setting."""
    shift = KSL_SHIFT[ksl & 3]
    if shift is None:
        return 0
    v = KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block)
    return (v if v > 0 else 0) >> shift


def ksr_offset(block: int, fnum: int, ksr: bool) -> int:
    """What the note adds to every envelope RATE (note-select is always 0 here)."""
    value = (block << 1) | ((fnum >> 8) & 1)
    return value if ksr else value >> 2


def eg_steps_per_sample(rate_param: int, ksr_off: int) -> float:
    """Envelope steps (0.1875 dB each) per output sample.  Zero means frozen: a
    RATE parameter of 0 is not "slow" but "never", whatever key scaling adds."""
    if rate_param == 0:
        return 0.0
    rate = min(63, rate_param * 4 + ksr_off)
    if rate > 60:
        rate = 60                       # RM 15 ignores RL
    if rate == 0:
        return 0.0
    return (4 + (rate & 3)) / 8.0 * (2.0 ** ((rate >> 2) - 12))


#: The attack trajectory: env values as `env -= (env >> 3) + 1` walks 511 → 0.
ATTACK_TRAJECTORY = []
_e = ENV_MAX
while _e > 0:
    ATTACK_TRAJECTORY.append(_e)
    _e -= (_e >> 3) + 1
ATTACK_TRAJECTORY.append(0)
ATTACK_STEPS = len(ATTACK_TRAJECTORY) - 1       # 36


def env_amplitude(env: float) -> float:
    """Envelope attenuation (in 0.1875 dB steps) to linear amplitude."""
    return 2.0 ** (-env / 32.0)


# ── BNK reader ───────────────────────────────────────────────────────────────

OPERATOR_FIELDS = ('ksl', 'multiple', 'feedback', 'attack', 'sustain', 'eg',
                   'decay', 'release', 'totalLevel', 'am', 'vib', 'ksr',
                   'connection')
BNK_NAME_RECORD = 12
BNK_PATCH_RECORD = 30


class OplPatch:
    """One AdLib bank patch: two operators, two wave selects, and a name.

    `pair` is a SECOND OplPatch, and it is what makes this an OPL3
    four-operator instrument rather than an OPL2 one: the YMF262 joins two
    channels and runs their four operators as one voice (SOP_FORMAT §3.3).
    A BNK never sets it; a `.sop` type-0 instrument always does.  `wave_mask`
    is 3 for a patch that came off an OPL2 — an AdLib bank has four waveforms
    and stores the two bits — and 7 for one that came off an OPL3, where all
    three bits of register 0xE0 mean something.
    """
    __slots__ = ('name', 'mod', 'car', 'mod_wave', 'car_wave', 'pair')

    def __init__(self, name, mod, car, mod_wave, car_wave, pair=None,
                 wave_mask=3):
        self.name = name
        self.mod = mod
        self.car = car
        self.mod_wave = mod_wave & wave_mask
        self.car_wave = car_wave & wave_mask
        self.pair = pair

    @property
    def additive(self) -> bool:
        """Connection 0 is ADDITIVE; anything else is FM.  The driver tests the
        byte for truth, so out-of-range values (which the corpus has) are FM."""
        return not self.mod['connection']

    @property
    def feedback(self) -> int:
        return self.mod['feedback'] & 7

    def key(self):
        return (tuple(self.mod[f] for f in OPERATOR_FIELDS),
                tuple(self.car[f] for f in OPERATOR_FIELDS),
                self.mod_wave, self.car_wave,
                self.pair.key() if self.pair else None)


def _read_operator(b: bytes, o: int) -> dict:
    return {f: b[o + i] for i, f in enumerate(OPERATOR_FIELDS)}


def parse_bnk(data: bytes) -> dict:
    """Parse an AdLib instrument bank.  Never assume a fixed header size: five
    corpus banks (the big general one included) carry no pad, so the name and
    data offsets in the header are the only reliable way in."""
    if len(data) < 20 or data[2:8] != b'ADLIB-':
        sys.exit("error: not a BNK file (bad ADLIB- signature)")
    count = struct.unpack_from('<H', data, 10)[0]
    off_name, off_data = struct.unpack_from('<II', data, 12)
    patches, by_name = [], {}
    for i in range(count):
        o = off_name + i * BNK_NAME_RECORD
        if o + BNK_NAME_RECORD > len(data):
            break
        index = struct.unpack_from('<H', data, o)[0]
        flags = data[o + 2]
        name = data[o + 3:o + 12].split(b'\x00')[0].decode('latin-1')
        if not flags or not name:
            continue                        # any non-zero flag is "in use"
        po = off_data + index * BNK_PATCH_RECORD
        if po + BNK_PATCH_RECORD > len(data):
            continue
        patch = OplPatch(name, _read_operator(data, po + 2),
                         _read_operator(data, po + 15), data[po + 28], data[po + 29])
        patches.append(patch)
        # Patch lookup is case-INSENSITIVE: exact matching resolves 29% of the
        # corpus's references and case-folded matching 99.95%.  First writer wins,
        # matching a linear scan of the name records.
        by_name.setdefault(name.upper(), patch)
    return {'patches': patches, 'by_name': by_name}


def resolve_patch(name: str, *banks) -> 'OplPatch|None':
    key = name.upper()
    for bank in banks:
        if bank and key in bank['by_name']:
            return bank['by_name'][key]
    return None


# ── Envelopes ────────────────────────────────────────────────────────────────
#
# OPL's envelope is a counter in the log domain: attack closes an eighth of the
# remaining attenuation per step, decay and release walk it linearly at 0.1875 dB
# a step.  A Taud envelope is a list of (linear amplitude, time) nodes.  The
# translation is therefore a re-sampling, and where the nodes are put is the whole
# of the accuracy: an exponential decay is placed at amplitude HALVINGS (32 env
# steps apart, so the value column reads 63, 32, 16, 8, 4, 2, 1, 0), where linear
# interpolation between nodes is within half a decibel of the curve everywhere.

ENV_NODE_MAX = 25
#: Amplitude milestones the attack is sampled at.
ATTACK_MILESTONES = (0.0, 0.125, 0.25, 0.5, 0.75, 1.0)
#: The envelope-offset minifloat's smallest non-zero step: 1/256 s.  No node may
#: be closer to the next than this, because an offset of 0 is the format's
#: "hold here forever" terminator, so a segment shorter than one step either
#: stretches to it or is dropped.
MIN_NODE_SECONDS = 1.0 / 256.0


def _attack_points(steps_per_sample: float):
    """[(seconds, value)] along the attack, at the amplitude milestones.

    An attack faster than one minifloat step cannot be written as a ramp at all,
    so it is written as no ramp: the envelope simply starts at full and the
    engine's own attack ramp takes the edge off.  Stretching it to 3.9 ms instead
    would turn every plucked OPL patch into a soft one."""
    total = ATTACK_STEPS / steps_per_sample / NATIVE_RATE
    if total < MIN_NODE_SECONDS:
        return [(0.0, 63)]
    amps = [env_amplitude(e) for e in ATTACK_TRAJECTORY]
    out, used = [], set()
    for target in ATTACK_MILESTONES:
        k = min(range(len(amps)), key=lambda i: abs(amps[i] - target))
        if k in used:
            continue
        used.add(k)
        out.append((k / steps_per_sample / NATIVE_RATE,
                    max(0, min(63, round(63.0 * amps[k])))))
    out.sort()
    return out


def _decay_envs(env_from: int, env_to: int):
    """Envelope values to place nodes at, walking from `env_from` to `env_to` at
    amplitude halvings, stopping once the 6-bit value has reached 0."""
    envs = []
    e = ((env_from // 32) + 1) * 32
    while e < env_to and round(63.0 * env_amplitude(e)) > 0:
        envs.append(e)
        e += 32
    if round(63.0 * env_amplitude(env_to)) > 0 or not envs:
        envs.append(env_to)
    return envs


def _thin(points, keep, limit=ENV_NODE_MAX):
    """Drop nodes that sit closer together than one minifloat step, then any
    excess over the record's 25, always keeping the indices in `keep`."""
    out, keep_set = [], set(keep)
    for i, p in enumerate(points):
        if not out or i in keep_set or i == len(points) - 1:
            out.append((i, p))
        elif p[0] - out[-1][1][0] >= MIN_NODE_SECONDS:
            out.append((i, p))
    while len(out) > limit:
        # Give up the node whose removal moves the curve least: the one closest
        # in time to its neighbours, never an endpoint and never the sustain.
        best, best_gap = None, None
        for j in range(1, len(out) - 1):
            if out[j][0] in keep_set:
                continue
            gap = out[j + 1][1][0] - out[j - 1][1][0]
            if best_gap is None or gap < best_gap:
                best, best_gap = j, gap
        if best is None:
            del out[limit:]
            break
        del out[best]
    index_map = {orig: n for n, (orig, _) in enumerate(out)}
    return [p for _, p in out], index_map


#: The engine's Volume Fadeout is LINEAR IN AMPLITUDE (fadeoutVolume drops 1→0
#: by fadeStep/1024 per tick) while the chip's release ramps ATTENUATION linearly
#: — amplitude decays exponentially, 96 dB over the release.  Matching the two on
#: "time to the floor" makes the linear fade sound far longer: it is still at
#: −6 dB at half its length and −20 dB only at 90%, by which time the chip is
#: silent.  A tail is perceived to end around −18…−24 dB, and completing the
#: linear fade in a QUARTER of the chip's release time is what puts the two
#: there together.  Same constant, and the same reasoning, as midi2taud's
#: _RELEASE_PERCEPTUAL_SCALE for SoundFont releases — where it has been measured
#: against FluidSynth and sounds right.
RELEASE_PERCEPTUAL_SCALE = 0.25


def release_fadeout(steps_per_sample: float, bpm: float) -> int:
    """Volume Fadeout step for an operator whose release runs at
    `steps_per_sample`, as the record's 12-bit field.

    THE FADEOUT IS THE RELEASE, and that is the whole point of using it.  A Taud
    key-off only lets the volume envelope's sustain LOOP go, so a playhead still
    in the attack or the decay has to walk the rest of those nodes before it
    reaches any release node — a note the chip would have dropped in 20 ms takes
    a third of a second.  The fadeout has no playhead: it drains from wherever
    the note had got to, at a fixed rate, exactly as the chip switches to its
    release RATE wherever its envelope had got to.

    A release RATE of 0 is not "slow" but "never" (§3-1-5), so such an operator
    gets no fadeout and rings until something retriggers it — the chip's own
    behaviour, and the one case where a key-off really does nothing."""
    if steps_per_sample <= 0.0:
        return 0
    full = ENV_MAX / steps_per_sample / NATIVE_RATE     # 0 → −96 dB, as the chip runs it
    fade_sec = max(0.02, RELEASE_PERCEPTUAL_SCALE * full)
    # The engine subtracts fadeStep/1024 of unit volume per TICK, and there are
    # bpm·2/5 ticks a second.
    return max(1, min(0xFFF, round(2560.0 / (fade_sec * bpm))))


def opl_envelope(op: dict, ksr_off: int):
    """OPL ADSR at one key -> (points, sustain_index).

    `points` is [(seconds since trigger, value 0...63)]; `sustain_index` is the
    node the envelope holds at while the key is down, or None for an envelope
    that runs straight through (`eg` clear -- a "diminishing" sound, which the
    chip carries on decaying at the RELEASE rate once it reaches sustain)."""
    attack = op['attack'] & 15
    decay = op['decay'] & 15
    release = op['release'] & 15
    sl = SUSTAIN_LEVEL[op['sustain'] & 15]
    sustaining = bool(op['eg'])

    sa = eg_steps_per_sample(attack, ksr_off)
    if sa == 0.0:
        return [(0.0, 0)], None          # RATE 0 never attacks: silent
    sd = eg_steps_per_sample(decay, ksr_off)
    sr = eg_steps_per_sample(release, ksr_off)

    points = _attack_points(sa)
    attack_end = points[-1][0]

    if sd == 0.0:
        # Decay RATE 0 freezes the envelope at full: the note holds until key-off
        # whatever `eg` says, and only then releases.
        hold_env = 0
        sustain_index = len(points) - 1
    else:
        for env in _decay_envs(0, sl):
            points.append((attack_end + env / sd / NATIVE_RATE,
                           max(0, min(63, round(63.0 * env_amplitude(env))))))
        hold_env = sl
        sustain_index = len(points) - 1 if sustaining else None

    # The envelope keeps its release nodes even though the key-off fadeout
    # (release_fadeout) is what usually ends a released note.  They are not
    # redundant: they are the whole of a DIMINISHING sound's decay past the
    # sustain level, they are what `envelope_tail_seconds` measures when a gate
    # operator has to be told how long to hold open for, and a voice whose
    # release RATE is 0 gets no fadeout at all and is left holding by them.
    # Where both do run the faster wins, which is the fadeout by construction.
    if sr > 0.0 and round(63.0 * env_amplitude(hold_env)) > 0:
        base_t = points[-1][0]
        for env in _decay_envs(hold_env, ENV_MAX):
            points.append((base_t + (env - hold_env) / sr / NATIVE_RATE,
                           max(0, min(63, round(63.0 * env_amplitude(env))))))
    # An envelope that runs through -- no sustain to hold it -- must reach zero,
    # or the node list's last value rings on for ever at 1/63.  One that DOES
    # sustain and has no release (RATE 0) is left holding, which is the chip's
    # own behaviour: such a voice rings until something retriggers it.
    if points[-1][1] != 0 and (sustain_index is None or sr > 0.0):
        points.append((points[-1][0] + MIN_NODE_SECONDS, 0))

    keep = [] if sustain_index is None else [sustain_index]
    points, index_map = _thin(points, keep)
    if sustain_index is not None:
        sustain_index = index_map.get(sustain_index, len(points) - 1)
    return points, sustain_index


def points_to_env_block(points, sustain_index):
    """[(seconds, value)] → the record's (loop word, sustain word, nodes).

    Offsets are quantised against the RUNNING total rather than one another, so
    a long envelope's nodes stay where the source put them instead of drifting.
    A non-final offset is floored at one minifloat step (1/256 s): an offset of
    zero is the format's "hold here forever" terminator."""
    nodes = []
    emitted = 0.0
    for i, (t, v) in enumerate(points):
        if i + 1 < len(points):
            dt = points[i + 1][0] - emitted
            mf = nearest_minifloat(dt if dt > 0 else 0.0)
            if mf == 0:
                mf = 1
            emitted += minifloat_seconds(mf)
        else:
            mf = 0
        nodes.append((v, mf))
    loop_word = 1 << 13                                   # P: present, no wrap
    sustain_word = 0
    if sustain_index is not None and sustain_index < len(nodes):
        sustain_word = (sustain_index << 8) | (1 << 5) | sustain_index
    return loop_word, sustain_word, nodes


def minifloat_seconds(index: int) -> float:
    e, m = index >> 5, index & 31
    return m / 256.0 if e == 0 else (32 + m) * (2.0 ** (e - 1)) / 256.0


def envelope_tail_seconds(points, sustain_index) -> float:
    """How long the envelope runs after key-off — what a gate operator has to
    stay open for so the operators it gates can finish."""
    if not points:
        return 0.0
    start = points[sustain_index][0] if sustain_index is not None else points[0][0]
    return max(0.0, points[-1][0] - start)


# ── Gain ─────────────────────────────────────────────────────────────────────

def gain_to_octet(gain: float) -> int:
    """Linear gain → the nearest "perceptually significant" octet (159 = unity).
    Never returns 0 for a non-zero gain: octet 0 is genuine silence here."""
    if gain <= 0.0:
        return 0
    lo = min(range(1, 256), key=lambda o: abs(META_GAIN[o] - gain))
    return lo


#: A modulator's full-scale output displaces the carrier's phase by this many
#: whole cycles on the chip — ±4084 into a 1024-step phase index, WHOLE — which
#: is what a Taud modulator's mix octet has to reproduce for the modulation index
#: to come out the same.
#:
#: This was halved until it was measured (iyagimusic-js OPL2_NOTES.en.md, "the
#: direct modulation path was halved"): the emulator's own FM path had been
#: scaled to match the manual's 4π FEEDBACK figure, which is the only modulation
#: number Yamaha states, and the converter inherited the same ½. Both were wrong
#: by the same factor, so a converted rack agreed with a dull emulator. Full
#: scale is 8π, which is twice the strongest feedback.
MOD_INDEX_FULL = OPL_FULL_SCALE / 1024.0


def tl_gain(total_level: int) -> float:
    return 10.0 ** (-TL_STEP_DB * (total_level & 63) / 20.0)


def volume_column(vol: int, total_level: int) -> int:
    """An OPL channel volume (0…127) → Taud's 6-bit LINEAR volume axis.

    AdLib's volume is not a linear gain: the driver scales the operator's
    6-bit AMPLITUDE — a 0.75 dB-per-step logarithmic quantity — so volume 64 is
    23 dB down, not 6.  Converting it as if it were linear makes every fade in
    the format arrive far too late and far too suddenly.  The exact curve
    depends on the operator's own total level, which is why the caller passes
    the patch currently on the channel."""
    tl = total_level & 63
    full = ((63 - tl) * 127 + 64) >> 7
    here = ((63 - tl) * max(0, min(127, vol)) + 64) >> 7
    if full <= 0:
        return 63
    gain = 10.0 ** (-TL_STEP_DB * (full - here) / 20.0)
    return max(0, min(63, round(63.0 * gain)))


# ── Oscillator samples ───────────────────────────────────────────────────────
#
# An operator's oscillator is an ordinary Taud instrument, so the chip's phase
# table becomes a single-cycle sample: 1024 unsigned bytes, one per phase step,
# which is EXACTLY the resolution the chip reads at.  All four shapes share one
# peak, so normalising each to its own maximum leaves their relative levels
# untouched.

WAVE_LEN = 1024
DC_LEN = 16


def wave_sample(shape: int) -> bytes:
    out = bytearray(WAVE_LEN)
    for phase in range(WAVE_LEN):
        logv, sign = waveform(shape, phase)
        v = 0 if logv == SILENCE else sign * expand(logv)
        out[phase] = max(0, min(255, round(127.5 + 127.5 * v / OPL_FULL_SCALE)))
    return bytes(out)


#: A constant +1.0.  A rack has no way to push a literal, so a DC oscillator is
#: how one writes a constant: ring-modulating by it scales, and its own mix octet
#: IS the scale factor.
DC_SAMPLE = bytes([255]) * DC_LEN


RHYTHM_SAMPLE_FRAMES = 32768        # 0.66 s at the chip's native rate


def rhythm_sample(drum: str, wave: int, multiple: int, tom_note: int) -> bytes:
    """The raw waveform of one noise-driven rhythm voice, at unit envelope.

    The hi-hat, snare and top cymbal are not oscillators: the chip throws away
    their accumulators' low bits and builds a phase out of single bits of the
    hi-hat's and top cymbal's, XORed against the noise LFSR.  There is no rack
    that does that, so the waveform is rendered here and the envelope — which a
    rack WOULD have got right — is carried by the instrument record instead.

    Channel 7 (hi-hat and snare) runs at the snare's pitch, which the driver
    keeps seven semitones above the tom's; channel 8 (tom and cymbal) at the
    tom's own.  Both therefore move when a song plays tom notes, and this bakes
    them at `tom_note`."""
    b7, f7 = chip_freq(tom_note + 7)
    b8, f8 = chip_freq(tom_note)
    mult2 = MULTIPLE_X2[multiple & 15]
    inc7 = ((f7 * mult2) << b7) >> 1
    inc8 = ((f8 * mult2) << b8) >> 1
    hh_phase = sd_phase = tc_phase = 0
    noise = 1
    out = bytearray(RHYTHM_SAMPLE_FRAMES)
    for n in range(RHYTHM_SAMPLE_FRAMES):
        hh_phase = (hh_phase + inc7) & 0xFFFFFFFF
        sd_phase = (sd_phase + inc7) & 0xFFFFFFFF
        tc_phase = (tc_phase + inc8) & 0xFFFFFFFF
        hp = (hh_phase >> 10) & 0x3FF
        tp = (tc_phase >> 10) & 0x3FF
        nz = noise & 1
        xor = (((hp >> 2) ^ (hp >> 7)) | (hp >> 3) | ((tp >> 5) ^ (tp >> 3))) & 1
        if drum == 'hh':
            phase = (xor << 9) | (0x0D0 if (xor ^ nz) else 0x034)
        elif drum == 'tc':
            phase = (xor << 9) | 0x100
        else:                                     # 'sd'
            phase = (0x200 if ((hp >> 8) & 1) else 0x100) ^ (nz << 8)
        logv, sign = waveform(wave, phase)
        v = 0 if logv == SILENCE else sign * expand(logv)
        out[n] = max(0, min(255, round(127.5 + 127.5 * v / OPL_FULL_SCALE)))
        noise = ((noise >> 1) | (((noise ^ (noise >> 14)) & 1) << 22)) & 0x7FFFFF
    return bytes(out)


# ── Taud note words ──────────────────────────────────────────────────────────

def note_word(chip_note: int) -> int:
    """Chip note (MIDI − 12) → Taud 4096-TET note word, C4 = $5000."""
    return round(chip_note * 4096 / 12) + 4096


def note_word_bent(chip_note: int, bend_256ths: int) -> int:
    """The same with a pitch bend folded in, following the chip's own arithmetic:
    the driver works in 1/256 semitones and rounds to the F-number table's 1/16,
    so a converted note lands exactly where the chip would have put it."""
    t = (chip_note * 256 + bend_256ths + 8) >> 4
    limit = CHIP_NOTES * SUBSTEPS - 1
    t = 0 if t < 0 else (limit if t > limit else t)
    return round(t * 4096 / 192) + 4096


#: 12-TET concert middle C — the pitch the song is tuned to, and the reference
#: everything below is scaled against.
CONCERT_C4_HZ = 261.6255653005986

#: A 1024-point cycle at C4 would need a 268 kHz sampling rate, and the record's
#: rate field is a u16 — so the sample is declared three octaves down and the
#: instrument's own detune puts it back.
OSC_OCTAVE_SHIFT = 3
OSC_RATE = round(WAVE_LEN * CONCERT_C4_HZ / (1 << OSC_OCTAVE_SHIFT))
OSC_DETUNE = OSC_OCTAVE_SHIFT * 4096

#: Declared song tuning: **A4 at 440 Hz**, which the engine reads as an exact
#: identity — the ratio is 1.0 to the bit, so nothing is scaled at playback and
#: the song is an ordinary concert-pitch one to work on.
#:
#: The chip's own middle C is 261.719 Hz, about 0.6 cents above concert, and an
#: earlier version of this converter declared exactly that so a converted note
#: sounded where an AdLib card put it. Six tenths of a cent is inaudible and the
#: cost of keeping it is a song that is fractionally out of tune with everything
#: it might be remixed alongside, so concert pitch wins. Every note moves by the
#: same 0.6 cents, so nothing within the song shifts relative to anything else.
TAUD_A4 = 0x5C00
TUNING_BASE_NOTE = TAUD_A4
TUNING_BASE_FREQ = 440.0
#: What the notation index says these note words MEAN: plain 12-TET, so the
#: grid reads C-4 / F#5 and a remix can be typed into it.
NOTATION_12TET = 120
#: Playback-rate correction for anything sampled at the chip's own rate. The
#: declared tuning is an exact identity, so this is the rate itself.
NATIVE_RATE_TUNED = round(NATIVE_RATE)


def multiple_detune(multiple: int) -> int:
    """OPL frequency multiple → a detune in 4096-TET units (×2 is +4096)."""
    return round(4096.0 * math.log2(MULTIPLE_X2[multiple & 15] / 2.0))


# ── Auto-vibrato ─────────────────────────────────────────────────────────────
#
# The chip's vibrato is a shared LFO at ~6.08 Hz and, with the depth bit clear
# (which the AdLib driver never sets), ±7 cents.  Taud's auto-vibrato is per
# instrument and per voice, which is what an OPL operator's `vib` bit really is.

VIBRATO_HZ = NATIVE_RATE / 8192.0
VIBRATO_CENTS = 7.0

#: The engine's auto-vibrato phase is 1024 steps advanced by the SPEED byte once
#: a tick, so one LFO cycle is `1024 ÷ speed` ticks (TAUD_FILE_FORMAT byte 175,
#: and `AUTOVIB_PHASE_STEPS` in the engine's tables).
AUTOVIB_PHASE_STEPS = 1024
#: What one unit of the DEPTH byte is worth on the 4096-TET grid: the engine
#: computes `lfo × depth × 43 >> 12` and its LFO is ±127, so byte 255 is ±340
#: units — the ±1 semitone byte 187 is documented as.
AUTOVIB_UNITS_PER_DEPTH = 127.0 * 43.0 / 4096.0


def vibrato_fields(bpm: float):
    """(speed, depth) for the instrument record at a given tempo.

    The rate is tempo-dependent because the LFO is clocked in TICKS, so the
    caller has to know the song's BPM; the depth is not.

    Both numbers were wrong until measured against the engine, and wrong in the
    audible direction: the speed was derived as though a cycle were `128 ÷ speed`
    ticks and the depth as though the byte ran to 127 units, which rendered the
    chip's 6.07 Hz ±7 cent shimmer as a **0.80 Hz ±76 cent wobble** — eight times
    too slow and eleven times too deep, which is what a lazy pitch bend sounds
    like.  32 of the 134 operators in one reference `.sop` set the bit, so it is
    not a corner.  Do not re-derive these from the field names; the engine's own
    arithmetic is above and `test/node/convert.test.js` pins the result."""
    ticks_per_second = bpm * 2.0 / 5.0
    # A converted song's BPM is always near the 535 ceiling, so the clamp below
    # never bites in practice; a slow one would get a vibrato slower than the
    # chip's rather than a wrapped one.
    speed = (round(AUTOVIB_PHASE_STEPS * VIBRATO_HZ / ticks_per_second)
             if ticks_per_second else 0)
    depth = round(VIBRATO_CENTS * 4096.0 / 1200.0 / AUTOVIB_UNITS_PER_DEPTH)
    return max(1, min(255, speed)), max(1, min(255, depth))


# ── Instrument records ───────────────────────────────────────────────────────

META_TYPE_FM = 0x40
META_PERCUSSION = 0x02
# New Note Action is a FIVE-value field, not four plus a flag (TAUD_FILE_FORMAT
# byte 186): key lift is its own action, a note off that releases the envelope
# the way a MIDI key release does, and it therefore EXCLUDES the other four.
NNA_NOTE_CUT = 1          # the next note on the channel takes it outright
NNA_KEY_LIFT = 4          # key-off jumps to the sustain node: a MIDI key release

FM_ADD, FM_MUL, FM_NEG, FM_DUP, FM_SWAP, FM_END = (
    0xFF00, 0xFF01, 0xFF02, 0xFF03, 0xFF04, 0xFFFF)
FM_OSC, FM_MOD, FM_FB = 0x0000, 0x0400, 0x0800
FM_MAX_OPERATORS = 16
FM_RECORD_BUDGET = 252


def build_instrument_record(*, sample_ptr, sample_length, rate, loop_start=0,
                            loop_end=0, loop_mode=0, detune=0,
                            vol_env=None, sustain_word=0,
                            atten_octet=0, percussion=False,
                            vib_speed=0, vib_depth=0, name_pan=0x80,
                            nna=NNA_KEY_LIFT, fadeout=0) -> bytes:
    """One 256-byte ordinary instrument record (TAUD_FILE_FORMAT.md §7.1)."""
    r = bytearray(INST_RECORD_SIZE)
    struct.pack_into('<I', r, 0, sample_ptr)
    struct.pack_into('<H', r, 4, sample_length & 0xFFFF)
    struct.pack_into('<H', r, 6, rate & 0xFFFF)
    struct.pack_into('<H', r, 8, 0)
    struct.pack_into('<H', r, 10, loop_start & 0xFFFF)
    struct.pack_into('<H', r, 12, loop_end & 0xFFFF)
    r[14] = (loop_mode & 3) | (0x10 if percussion else 0)
    loop_word, nodes = vol_env if vol_env else (0, [(63, 0)])
    struct.pack_into('<H', r, 15, loop_word)
    struct.pack_into('<H', r, 17, 0)                       # no pan envelope
    struct.pack_into('<H', r, 19, 0)                       # no pitch envelope
    o = 21
    last = nodes[-1] if nodes else (0, 0)
    for i in range(25):
        v, mf = nodes[i] if i < len(nodes) else (last[0], 0)
        r[o] = v & 0xFF
        r[o + 1] = mf & 0xFF
        o += 2
    r[171] = 0xFF                                          # instrument global vol
    # Volume Fadeout IS the key-off release here — see release_fadeout.  Zero
    # leaves the envelope to end the note on its own, which is what a gate, a
    # constant and a rendered drum want.
    r[172] = fadeout & 0xFF
    r[173] = (fadeout >> 8) & 0x0F
    r[175] = vib_speed & 0xFF
    r[176] = 0                                             # no vibrato sweep
    r[177] = name_pan & 0xFF
    r[182] = 0xFF                                          # filter off
    r[183] = 0xFF
    struct.pack_into('<h', r, 184, max(-32768, min(32767, detune)))
    # Byte 186 packs the NNA as bits 0-1 plus bit 5, with the auto-vibrato
    # waveform between them: key lift (4) is 0b100_000, not 0b100.
    r[186] = (nna & 3) | (((nna >> 2) & 1) << 5)
    r[187] = vib_depth & 0xFF
    r[188] = 0
    struct.pack_into('<H', r, 189, sustain_word)
    r[196] = 0xFF                                          # default note volume
    r[251] = atten_octet & 0xFF
    return bytes(r)


def build_rack_record(operators, program, percussion=False) -> bytes:
    """One 256-byte type-4 Metainstrument: the operator table then the RPN
    algorithm, terminated by $FFFF.  Both live in the record's 252 bytes."""
    if len(operators) > FM_MAX_OPERATORS:
        raise ValueError("rack has more than 16 operators")
    need = len(operators) * 10 + (len(program) + 1) * 2
    if need > FM_RECORD_BUDGET:
        raise ValueError(f"rack needs {need} bytes of the record's 252")
    r = bytearray(INST_RECORD_SIZE)
    r[0] = META_TYPE_FM | (META_PERCUSSION if percussion else 0)
    r[1] = len(operators) & 0xFF
    r[2] = 0xFF
    r[3] = 0xFF
    o = 4
    for op in operators:
        idx = op['inst'] & 0x3FF
        r[o] = idx & 0xFF
        r[o + 1] = op['octet'] & 0xFF
        struct.pack_into('<h', r, o + 2, max(-32768, min(32767, op['detune'])))
        struct.pack_into('<H', r, o + 4, op['plo'] & 0xFFFF)
        struct.pack_into('<H', r, o + 6, op['phi'] & 0xFFFF)
        r[o + 8] = (op.get('vlo', 0) & 0x3F) | (((idx >> 8) & 3) << 6)
        r[o + 9] = op.get('vhi', 63) & 0x3F
        o += 10
    for w in program:
        struct.pack_into('<H', r, o, w & 0xFFFF)
        o += 2
    struct.pack_into('<H', r, o, FM_END)
    return bytes(r)


# ── Key banding ──────────────────────────────────────────────────────────────
#
# KSL (an attenuation that grows with pitch) and KSR (an envelope that speeds up
# with pitch) are the two things a rack entry cannot express, because a Taud
# envelope is in seconds and a mix octet is one number.  What a rack CAN do is
# gate an entry by pitch — so an operator becomes several entries over disjoint
# key bands, each pointing at its own instrument with that band's envelope and
# level.  Only one of them is ever inside the trigger's rectangle, so the rack
# still sounds one voice per operator; the cost is instrument slots, not voices.

def operator_keying(op: dict, chip_note: int):
    """(ksr offset, KSL attenuation in 0.75 dB units) for one operator at a key."""
    block, fnum = chip_freq(chip_note)
    return (ksr_offset(block, fnum, bool(op['ksr'])),
            ksl_attenuation(block, fnum, op['ksl'] & 3))


def key_bands(op: dict, notes, max_bands: int = 4,
              tol_ksr: int = 2, tol_ksl: int = 2):
    """Contiguous key bands over `notes`, as [(lo, hi, representative)].

    A band may span an envelope-rate spread of `tol_ksr` (one rate unit is 2^¼ of
    speed, so 2 is within 41%) and a level spread of `tol_ksl` (1.5 dB).  Bands
    over the cap are merged cheapest-first."""
    notes = sorted(set(int(n) for n in notes)) or [48]
    keyed = {n: operator_keying(op, n) for n in notes}
    groups = []
    for n in notes:
        k = keyed[n]
        if groups:
            members = groups[-1]
            ksrs = [keyed[m][0] for m in members] + [k[0]]
            ksls = [keyed[m][1] for m in members] + [k[1]]
            if max(ksrs) - min(ksrs) <= tol_ksr and max(ksls) - min(ksls) <= tol_ksl:
                members.append(n)
                continue
        groups.append([n])
    while len(groups) > max_bands:
        best, best_cost = None, None
        for i in range(len(groups) - 1):
            members = groups[i] + groups[i + 1]
            ksrs = [keyed[m][0] for m in members]
            ksls = [keyed[m][1] for m in members]
            cost = (max(ksrs) - min(ksrs)) * 4 + (max(ksls) - min(ksls))
            if best_cost is None or cost < best_cost:
                best, best_cost = i, cost
        groups[best:best + 2] = [groups[best] + groups[best + 1]]
    return [(g[0], g[-1], g[len(g) // 2]) for g in groups]


def band_rect(bands, i):
    """The pitch rectangle of band `i`: the bands tile the whole note space, with
    the split half a semitone above the lower band's top note so that a note
    arriving with a pitch bend still lands in the band it was written for."""
    lo = 0 if i == 0 else note_word(bands[i][0]) - 170
    hi = 0xFFFF if i == len(bands) - 1 else note_word(bands[i][1]) + 170
    return max(0, lo), min(0xFFFF, hi)


# ── Bank assembly ────────────────────────────────────────────────────────────

MAIN_SLOTS = 255            # $01…$FF — what a pattern cell can name
AUX_BASE = 256              # $100…$3FF — Metainstrument entries only
AUX_SLOTS = 768

#: What each channel is in rhythm mode.  The bass drum is an ordinary two-operator
#: voice and the tom an ordinary oscillator; the other three are the noise-driven
#: ones, and they use the patch's MODULATOR half because that is the operator the
#: driver loads into their single slot.
RHYTHM_KIND = {6: 'bd', 7: 'sd', 8: 'tom', 9: 'tc', 10: 'hh'}
RHYTHM_KINDS = frozenset(RHYTHM_KIND.values())

#: In rhythm mode the chip sums channels 6, 7 and 8 into the accumulator twice
#: over, so a drum sits 6 dB above where the same operator would sit on a
#: melodic channel.  A Taud instrument has no such quirk, so the gain goes on
#: the drum itself — on whichever of its operators reaches the mix, never on a
#: modulator, whose octet is a phase deviation and not a level.  See
#: iyagimusic-js OPL2_NOTES.en.md; the claim there is second-hand and labelled.
RHYTHM_MIX = 2.0

#: The four-operator connections, as chains of operator indices: each operator
#: modulates the next, and each chain's last one reaches the mix.  This is the
#: YMF262's published figure keyed by the two halves' CNT bits; see `_add_rack4`.
CHAINS_FOUR_OP = {
    (0, 0): [[0, 1, 2, 3]],
    (0, 1): [[0, 1, 2], [3]],
    (1, 0): [[0], [1, 2, 3]],
    (1, 1): [[0], [1, 2], [3]],
}

#: Four operators at four key bands would want eighteen of the sixteen entries a
#: rack holds, so a wide rack bands no finer than this however many were asked for.
MAX_BANDS_FOUR_OP = 3
DEFAULT_TOM_NOTE = 24       # the driver's own starting tom pitch


class BankBuilder:
    """Accumulates samples, operator instruments and racks for one conversion."""

    def __init__(self, bpm: float = 125.0, max_bands: int = 4,
                 tom_note: int = DEFAULT_TOM_NOTE, feedback_scale: float = 1.0):
        self.bpm = bpm
        self.max_bands = max_bands
        self.tom_note = tom_note
        self.feedback_scale = feedback_scale
        self.pool = bytearray()
        self._pool_index = {}
        self.sample_names = []
        self.aux_records = []
        self._aux_index = {}
        self.aux_names = []
        self.main_records = []
        self.main_names = []
        self.wave_ptr = {}
        self.dc_ptr = self._add_sample(DC_SAMPLE, 'OPL DC')
        # The YM3812's four shapes always; the YMF262's other four only when a
        # patch asks for one, so an OPL2 conversion carries no dead samples.
        for shape in range(4):
            self.wave_ptr[shape] = self._add_sample(
                wave_sample(shape), f'OPL wave {shape}')
        self._rhythm_ptr = {}

    # -- pool -----------------------------------------------------------------
    def _add_sample(self, data: bytes, name: str) -> int:
        hit = self._pool_index.get(data)
        if hit is not None:
            return hit
        off = len(self.pool)
        if off + len(data) > SAMPLEBIN_SIZE:
            sys.exit("error: OPL sample pool overflowed 8 MB")
        self.pool += data
        self._pool_index[data] = off
        self.sample_names.append(name)
        return off

    def wave_pointer(self, shape: int) -> int:
        """The single-cycle sample for one of the chip's eight wave shapes."""
        shape &= 7
        if shape not in self.wave_ptr:
            self.wave_ptr[shape] = self._add_sample(
                wave_sample(shape), f'OPL wave {shape}')
        return self.wave_ptr[shape]

    def rhythm_pointer(self, drum: str, wave: int, multiple: int) -> int:
        key = (drum, wave, multiple & 15)
        if key not in self._rhythm_ptr:
            self._rhythm_ptr[key] = self._add_sample(
                rhythm_sample(drum, wave, multiple, self.tom_note),
                f'OPL {drum} w{wave} m{multiple & 15}')
        return self._rhythm_ptr[key]

    # -- instrument slots -----------------------------------------------------
    def _add_aux(self, record: bytes, name: str) -> int:
        hit = self._aux_index.get(record)
        if hit is not None:
            return hit
        if len(self.aux_records) >= AUX_SLOTS:
            sys.exit("error: more than 768 OPL operator instruments; "
                     "lower --ksl-bands or use fewer patches")
        slot = AUX_BASE + len(self.aux_records)
        self.aux_records.append(record)
        self.aux_names.append(name)
        self._aux_index[record] = slot
        return slot

    def _add_main(self, record: bytes, name: str) -> int:
        if len(self.main_records) >= MAIN_SLOTS:
            sys.exit("error: more than 255 instruments in one song")
        self.main_records.append(record)
        self.main_names.append(name)
        return 1 + len(self.main_records) - 1

    # -- operators ------------------------------------------------------------
    def _operator_instrument(self, op, wave, rep_note, name):
        """One key band of one OPL operator, as an ordinary Taud instrument.

        NNA = Note Cut, because an OPL channel is MONOPHONIC: keying a note on
        it replaces whatever it was playing, with no tail.  Operator 0 is the
        rack's principal, so its New Note Action is the whole rack's — and Note
        Off, which is what the field's zero encodes, would leave a ghost of the
        entire rack ringing behind every note in the song.  There is no fadeout
        to end one either (bytes 172/173 are 0 here, because on this chip the
        ENVELOPE is what ends a note), so a sustaining patch would ring until
        the song did.  Same answer TAUD_CONVERSION_NOTES already gives for
        sample-mode instruments, and for the same reason.

        The cost is key lift, which is the FIFTH NNA value and so cannot be had
        alongside Note Cut: a pattern key-off now walks the rest of the
        envelope instead of jumping to the sustain-end node."""
        ksr_off, _ = operator_keying(op, rep_note)
        points, sustain = opl_envelope(op, ksr_off)
        loop_word, sustain_word, nodes = points_to_env_block(points, sustain)
        vib_speed, vib_depth = vibrato_fields(self.bpm) if op['vib'] else (0, 0)
        rec = build_instrument_record(
            sample_ptr=self.wave_pointer(wave), sample_length=WAVE_LEN,
            rate=OSC_RATE, loop_start=0, loop_end=WAVE_LEN, loop_mode=1,
            detune=OSC_DETUNE,
            vol_env=(loop_word, nodes), sustain_word=sustain_word,
            vib_speed=vib_speed, vib_depth=vib_depth, nna=NNA_NOTE_CUT,
            fadeout=release_fadeout(
                eg_steps_per_sample(op['release'] & 15, ksr_off), self.bpm))
        return self._add_aux(rec, name), points, sustain

    def _gate_instrument(self, hold_seconds: float, name: str) -> int:
        """A DC operator that holds at full while the key is down and then stays
        open long enough for everything it gates to finish.  Operator 0's envelope
        is the whole note's shape, so a rack whose operators must keep their OWN
        envelopes — an additive patch, or a key-banded carrier — needs operator 0
        to be a gate that shapes nothing."""
        nodes, remaining = [], max(hold_seconds, MIN_NODE_SECONDS)
        while remaining > 0 and len(nodes) < 23:
            step = min(remaining, 15.75)
            mf = nearest_minifloat(step)
            nodes.append((63, max(1, mf)))
            remaining -= minifloat_seconds(max(1, mf))
        nodes.append((0, 0))
        rec = build_instrument_record(
            sample_ptr=self.dc_ptr, sample_length=DC_LEN, rate=OSC_RATE,
            loop_start=0, loop_end=DC_LEN, loop_mode=1,
            vol_env=(1 << 13, nodes), sustain_word=(1 << 5), nna=NNA_NOTE_CUT)
        return self._add_aux(rec, name)

    def _constant_instrument(self, name: str) -> int:
        """A DC operator with a flat, endless envelope: a pure constant, used as
        the scale factor a feedback tap is multiplied by."""
        rec = build_instrument_record(
            sample_ptr=self.dc_ptr, sample_length=DC_LEN, rate=OSC_RATE,
            loop_start=0, loop_end=DC_LEN, loop_mode=1,
            vol_env=(1 << 13, [(63, 0)]), sustain_word=0, nna=NNA_NOTE_CUT)
        return self._add_aux(rec, name)

    # -- racks ----------------------------------------------------------------
    def add_patch(self, patch, kind='melodic', notes=None, name=None) -> int:
        """Add one OPL patch and return the directly-addressable slot that plays
        it.  `notes` is the chip notes the song triggers it at, which is what the
        key banding is fitted to; None means the whole 96-note range."""
        name = name or (patch.name if patch else 'silence')
        if patch is None:
            return self._add_main(build_instrument_record(
                sample_ptr=0, sample_length=0, rate=OSC_RATE), name)
        notes = list(notes) if notes else list(range(CHIP_NOTES))
        # A second operator pair is what makes a patch four-operator, and only a
        # melodic voice can be given one: the chip's rhythm voices are one and
        # two operators and have no pair to join.
        if kind == 'melodic' and patch.pair is not None:
            return self._add_rack4(patch, name, notes)
        mix = RHYTHM_MIX if kind in RHYTHM_KINDS else 1.0
        if kind in ('sd', 'tc', 'hh'):
            return self._add_rhythm_pcm(patch, kind, name, mix)
        if kind == 'tom':
            return self._add_rack(patch, name, single_op=True,
                                  notes=[self.tom_note] + notes, percussion=True,
                                  mix=mix)
        return self._add_rack(patch, name, single_op=False, notes=notes,
                              percussion=(kind == 'bd'), mix=mix)

    def _add_rhythm_pcm(self, patch, drum, name, mix=1.0):
        op = patch.mod
        block, fnum = chip_freq(self.tom_note + (7 if drum in ('sd', 'hh') else 0))
        ksr_off = ksr_offset(block, fnum, bool(op['ksr']))
        ksl = ksl_attenuation(block, fnum, op['ksl'] & 3)
        points, sustain = opl_envelope(op, ksr_off)
        loop_word, sustain_word, nodes = points_to_env_block(points, sustain)
        gain = tl_gain(op['totalLevel']) * 10.0 ** (-TL_STEP_DB * ksl / 20.0) * mix
        ptr = self.rhythm_pointer(drum, patch.mod_wave, op['multiple'])
        rec = build_instrument_record(
            sample_ptr=ptr, sample_length=RHYTHM_SAMPLE_FRAMES,
            rate=NATIVE_RATE_TUNED, loop_start=0, loop_end=RHYTHM_SAMPLE_FRAMES,
            loop_mode=1, vol_env=(loop_word, nodes), sustain_word=sustain_word,
            atten_octet=gain_to_octet(gain), percussion=True)
        return self._add_main(rec, name)

    def _add_rack4(self, patch, name, notes):
        """An OPL3 four-operator voice: two channels' operators as one chain.

        The two halves each keep their own CNT bit in register 0xC0, and reading
        CNT as "this half's first operator goes straight to the output instead of
        modulating" gives the YMF262's four published connections at once:

            0,0   1 → 2 → 3 → 4          0,1   1 → 2 → 3, and 4
            1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4

        Feedback belongs to operator 1 alone — operator 3 is fed by the chain
        rather than by itself, so the slave half's feedback setting has nowhere
        to act, and the register layout says as much.

        Everything else is `_add_rack`'s reasoning four times over: key bands per
        operator, the modulation-index factor on whichever operators modulate,
        and a DC gate as operator 0, because with two to four operators reaching
        the output there is no single one whose envelope is the whole rack's.
        """
        ops = [patch.mod, patch.car, patch.pair.mod, patch.pair.car]
        waves = [patch.mod_wave, patch.car_wave,
                 patch.pair.mod_wave, patch.pair.car_wave]
        chains = CHAINS_FOUR_OP[(int(bool(patch.additive)),
                                 int(bool(patch.pair.additive)))]
        #: Operators that modulate rather than sound: all but each chain's last.
        modulates = {i for chain in chains for i in chain[:-1]}

        fb = patch.feedback
        fb_scale = 2.0 ** (fb - 7) * self.feedback_scale if fb else 1.0
        needs_fb_entry = bool(fb) and abs(fb_scale - 1.0) > 1e-9

        def program_for(ids, fb_id):
            p = []
            for n, chain in enumerate(chains):
                head = ids[chain[0]]
                # Feedback is operator 1's own output a sample ago, so the tap
                # reads the entries it is about to drive.
                if fb and chain[0] == 0:
                    p += _sum_taps(head)
                    if fb_id is not None:
                        p += [FM_OSC | fb_id, FM_MUL]
                    p += _fan_mod(head)
                else:
                    p += _sum_free(head)
                for i in chain[1:]:
                    p += _fan_mod(ids[i])
                if n:
                    p.append(FM_ADD)
            return p + [FM_OSC | 0, FM_MUL]           # entry 0 is the gate

        # Fit the banding to the record BEFORE anything is allocated: the
        # operator table and the algorithm share the record's 252 bytes, and a
        # four-operator rack is the only thing here that can run out of them.
        # Four operators at four bands would need eighteen entries against the
        # sixteen a rack holds, so three is the ceiling whatever the budget says.
        bands, ids = None, None
        for limit in range(min(self.max_bands, MAX_BANDS_FOUR_OP), 0, -1):
            bands = [key_bands(op, notes, limit) for op in ops]
            ids, n = [], 1                            # entry 0 is the gate
            for b in bands:
                ids.append(list(range(n, n + len(b))))
                n += len(b)
            count = n + (1 if needs_fb_entry else 0)
            words = len(program_for(ids, n if needs_fb_entry else None))
            if count <= FM_MAX_OPERATORS and \
                    count * 10 + (words + 1) * 2 <= FM_RECORD_BUDGET:
                break

        entries = [None]                              # reserved for the gate
        tails = []
        for i, op in enumerate(ops):
            for j, (_lo, _hi, rep) in enumerate(bands[i]):
                _, ksl = operator_keying(op, rep)
                inst, pts, sus = self._operator_instrument(
                    op, waves[i], rep, f'{name} op{i + 1}.{j}')
                tails.append(envelope_tail_seconds(pts, sus))
                gain = tl_gain(op['totalLevel']) * 10.0 ** (-TL_STEP_DB * ksl / 20.0)
                # A modulator's output IS a phase deviation; an operator that
                # reaches the mix instead means the level it states.
                if i in modulates:
                    gain *= MOD_INDEX_FULL
                plo, phi = band_rect(bands[i], j) if len(bands[i]) > 1 else (0, 0xFFFF)
                entries.append({'inst': inst, 'octet': gain_to_octet(gain),
                                'detune': multiple_detune(op['multiple']),
                                'plo': plo, 'phi': phi, 'vlo': 0, 'vhi': 63})

        fb_id = None
        if needs_fb_entry:
            entries.append({'inst': self._constant_instrument('OPL feedback scale'),
                            'octet': gain_to_octet(fb_scale), 'detune': 0,
                            'plo': 0, 'phi': 0xFFFF, 'vlo': 0, 'vhi': 63})
            fb_id = len(entries) - 1

        entries[0] = {'inst': self._gate_instrument(max(tails) if tails else 1.0,
                                                   f'{name} gate'),
                      'octet': 159, 'detune': 0, 'plo': 0, 'phi': 0xFFFF,
                      'vlo': 0, 'vhi': 63}
        rec = build_rack_record(entries, program_for(ids, fb_id))
        return self._add_main(rec, name)

    def _add_rack(self, patch, name, single_op, notes, percussion, mix=1.0):
        additive = patch.additive
        fb = patch.feedback
        car_op, mod_op = patch.car, patch.mod

        mod_bands = key_bands(mod_op, notes, self.max_bands)
        car_bands = [] if single_op else key_bands(car_op, notes, self.max_bands)
        # A single-operator voice (the tom) loads the patch's MODULATOR into its
        # one slot, so that operator is the carrier and nothing modulates it.
        if single_op:
            car_op, car_bands, mod_bands = mod_op, mod_bands, []
            car_wave, mod_wave = patch.mod_wave, patch.mod_wave
        else:
            car_wave, mod_wave = patch.car_wave, patch.mod_wave

        gate_needed = additive or len(car_bands) > 1
        entries, tails = [], []

        def add_entry(inst, octet, detune, bands, i):
            plo, phi = band_rect(bands, i) if len(bands) > 1 else (0, 0xFFFF)
            entries.append({'inst': inst, 'octet': octet, 'detune': detune,
                            'plo': plo, 'phi': phi, 'vlo': 0, 'vhi': 63})
            return len(entries) - 1

        gate_index = None
        if gate_needed:
            entries.append(None)                      # reserved for operator 0
            gate_index = 0

        car_ids = []
        for i, (lo, hi, rep) in enumerate(car_bands):
            _, ksl = operator_keying(car_op, rep)
            inst, pts, sus = self._operator_instrument(
                car_op, car_wave, rep, f'{name} car{i}')
            tails.append(envelope_tail_seconds(pts, sus))
            gain = tl_gain(car_op['totalLevel']) * 10.0 ** (-TL_STEP_DB * ksl / 20.0) * mix
            car_ids.append(add_entry(inst, gain_to_octet(gain),
                                     multiple_detune(car_op['multiple']),
                                     car_bands, i))

        mod_ids = []
        for i, (lo, hi, rep) in enumerate(mod_bands):
            _, ksl = operator_keying(mod_op, rep)
            inst, pts, sus = self._operator_instrument(
                mod_op, mod_wave, rep, f'{name} mod{i}')
            tails.append(envelope_tail_seconds(pts, sus))
            gain = tl_gain(mod_op['totalLevel']) * 10.0 ** (-TL_STEP_DB * ksl / 20.0)
            # In FM the modulator's output IS a phase deviation, and the chip's
            # full scale is very nearly two whole cycles of it; in additive it is
            # a second carrier and its level means what it says.
            if additive:
                gain *= mix                       # a second carrier: a LEVEL
            else:
                gain *= MOD_INDEX_FULL            # a phase deviation, not a level
            mod_ids.append(add_entry(inst, gain_to_octet(gain),
                                     multiple_detune(mod_op['multiple']),
                                     mod_bands, i))

        fb_id = None
        if fb and mod_ids:
            # OPL's feedback is the modulator's own output, halved and shifted
            # down by (8 − feedback); the tap already carries the modulator's mix
            # gain, so what is left to apply is 2^(feedback − 7).
            scale = 2.0 ** (fb - 7) * self.feedback_scale
            if abs(scale - 1.0) > 1e-9:
                fb_id = add_entry(self._constant_instrument('OPL feedback scale'),
                                  gain_to_octet(scale), 0, [], 0)

        if gate_index is not None:
            hold = max(tails) if tails else 1.0
            entries[0] = {'inst': self._gate_instrument(hold, f'{name} gate'),
                          'octet': 159, 'detune': 0, 'plo': 0, 'phi': 0xFFFF,
                          'vlo': 0, 'vhi': 63}

        program = _fm_program(car_ids, mod_ids, gate_index, fb_id,
                              additive, bool(fb and mod_ids))
        rec = build_rack_record(entries, program, percussion=percussion)
        return self._add_main(rec, name)

    # -- output ---------------------------------------------------------------
    def finish(self):
        sample_bin = bytes(self.pool) + b'\x00' * (SAMPLEBIN_SIZE - len(self.pool))
        inst_bin = bytearray(INSTBIN_SIZE)
        names = [''] * 1024
        for i, rec in enumerate(self.main_records):
            inst_bin[(1 + i) * 256:(2 + i) * 256] = rec
            names[1 + i] = self.main_names[i]
        for i, rec in enumerate(self.aux_records):
            slot = AUX_BASE + i
            inst_bin[slot * 256:(slot + 1) * 256] = rec
            names[slot] = self.aux_names[i]
        return {'sample_bin': sample_bin, 'inst_bin': bytes(inst_bin),
                'instrument_names': names, 'sample_names': list(self.sample_names),
                'pool_bytes': len(self.pool)}


def _sum_free(ids):
    p = []
    for i, k in enumerate(ids):
        p.append(FM_OSC | k)
        if i:
            p.append(FM_ADD)
    return p


def _sum_taps(ids):
    p = []
    for i, k in enumerate(ids):
        p.append(FM_FB | k)
        if i:
            p.append(FM_ADD)
    return p


def _fan_mod(ids):
    """Consume the phase-modulation value on the stack top and leave the SUM of
    `ids` read with it.  DUP/SWAP is what lets one modulator reach several
    key-banded carriers: only one of them is inside the trigger's rectangle, so
    the sum is that one and the rest read zero."""
    if len(ids) == 1:
        return [FM_MOD | ids[0]]
    p = []
    for k in ids[:-1]:
        p += [FM_DUP, FM_MOD | k, FM_SWAP]
    p.append(FM_MOD | ids[-1])
    return p + [FM_ADD] * (len(ids) - 1)


def _fm_program(car_ids, mod_ids, gate_id, fb_id, additive, has_fb):
    """The rack's RPN algorithm.

    FM is `<modulator> $04<carrier>` — postfix is what makes "operator 1
    modulates operator 0" writable at all, since the modulator's whole value has
    to be on the stack before the carrier is read.  Feedback closes the loop with
    a z⁻¹ tap on the modulator itself; additive gives up on modulation entirely
    and rings the sum through the gate."""
    p = []
    if mod_ids:
        if has_fb:
            p += _sum_taps(mod_ids)
            if fb_id is not None:
                p += [FM_OSC | fb_id, FM_MUL]
            p += _fan_mod(mod_ids)
        else:
            p += _sum_free(mod_ids)
    if additive:
        for i, k in enumerate(car_ids):
            p.append(FM_OSC | k)
            if i or mod_ids:
                p.append(FM_ADD)
    elif mod_ids:
        p += _fan_mod(car_ids)
    else:
        p += _sum_free(car_ids)
    if gate_id is not None:
        p += [FM_OSC | gate_id, FM_MUL]
    return p


SIGNATURE = b"opl2taud/TSVM "     # 14 bytes


def escape_non_ascii(text: str) -> str:
    """Stored NAMES carry non-ASCII as literal `\\uHHHH` escapes, because the
    TSVM-side string reader is ASCII-only (Microtone.js src/ui/names.js resolves
    them for display and re-escapes on save).  Titles in this family are Korean
    by nature, so this is not an edge case."""
    return ''.join(c if ord(c) < 0x80 else '\\u%04X' % ord(c) for c in text)


def build_bank(entries, *, bpm: float = 125.0, max_bands: int = 4,
               tom_note: int = DEFAULT_TOM_NOTE, feedback_scale: float = 1.0):
    """Compile OPL patches into Taud instruments.

    `entries` is a list of dicts: `patch` (an OplPatch or None for an unresolved
    name), `kind` ('melodic', 'bd', 'sd', 'tom', 'tc' or 'hh'), `notes` (the chip
    notes the song plays it at, or None for the whole range) and `name`.

    Returns the sample bin, the instrument bin, the name tables, and `slots` —
    the directly-addressable instrument index of each entry, in order."""
    b = BankBuilder(bpm=bpm, max_bands=max_bands, tom_note=tom_note,
                    feedback_scale=feedback_scale)
    slots = [b.add_patch(e.get('patch'), e.get('kind', 'melodic'),
                         e.get('notes'), e.get('name')) for e in entries]
    out = b.finish()
    out['slots'] = slots
    return out


def assemble_tsii(bank) -> bytes:
    """Wrap a compiled bank as a .tsii (sample and instrument image alone)."""
    raw = bank['sample_bin'] + bank['inst_bin']
    assert len(raw) == SAMPLEINST_SIZE
    compressed = compress_blob(raw, "sample+inst bin")
    proj = build_project_data(
        instrument_names=[escape_non_ascii(n) for n in bank['instrument_names']],
        sample_names=[escape_non_ascii(n) for n in bank['sample_names']])
    proj_off = TAUD_HEADER_SIZE + len(compressed) if proj else 0
    header = (TAUD_MAGIC
              + bytes([TAUD_KIND_SAMPLEINST | TAUD_VERSION, 0])
              + struct.pack('<I', len(compressed))
              + struct.pack('<I', proj_off)
              + (SIGNATURE + b' ' * 14)[:14])
    assert len(header) == TAUD_HEADER_SIZE
    return header + compressed + proj


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='Input AdLib .BNK bank')
    ap.add_argument('output', help='Output .tsii instrument bank')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--names', default=None,
                    help='Comma-separated patch names to convert '
                         '(default: every patch, up to 255)')
    ap.add_argument('--ksl-bands', type=int, default=4,
                    help='Key bands per operator for KSL/KSR (1 disables banding)')
    ap.add_argument('--bpm', type=float, default=125.0,
                    help="Tempo the auto-vibrato rate is fitted to")
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        bank = parse_bnk(f.read())
    vprint(f"  {len(bank['patches'])} patches in bank")

    if args.names:
        wanted = [n.strip() for n in args.names.split(',') if n.strip()]
        chosen = [(n, resolve_patch(n, bank)) for n in wanted]
    else:
        chosen = [(p.name, p) for p in bank['patches'][:MAIN_SLOTS]]
    if len(chosen) > MAIN_SLOTS:
        vprint(f"  warning: {len(chosen)} patches > {MAIN_SLOTS} slots; truncating")
        chosen = chosen[:MAIN_SLOTS]

    entries = [{'patch': p, 'kind': 'melodic', 'name': n} for n, p in chosen]
    out = build_bank(entries, bpm=args.bpm, max_bands=args.ksl_bands)
    vprint(f"  {len(out['slots'])} racks, "
           f"{sum(1 for n in out['instrument_names'][AUX_BASE:] if n)} operator "
           f"instruments, {out['pool_bytes']} bytes of samples")
    data = assemble_tsii(out)
    with open(args.output, 'wb') as f:
        f.write(data)
    print(f"wrote {len(data)} bytes to '{args.output}'")


if __name__ == '__main__':
    main()
