#!/usr/bin/env python3
"""opl2taud.py — AdLib/OPL instruments to Taud OPL instruments (Metainstrument type 8).

Usage:
    python3 opl2taud.py input.BNK output.tsii [-v] [--names NAME,NAME,...]

An AdLib .BNK patch is two YM3812 operators plus a connection and a feedback
setting; a `.sop` instrument is the same thing as register bytes, or four
operators for the YMF262's joined channels, or one of the rhythm mode's five
drums.  A Taud type-8 Metainstrument is exactly that: an ordinary instrument
record with one OPL channel where its sample would be (TAUD_FILE_FORMAT.md §7.7),
which the engine runs as the chip runs it — its own log-sine and exponential
tables, its envelope generator and its counter, key scaling, feedback, the
tremolo and vibrato LFOs, the drums' phase equations — at the chip's own
49716 Hz (TAUD_ENGINE_SPEC.md §5.5.2).  So this module no longer COMPILES a
patch into anything: it writes the registers down.

    OPL                     Taud type-8 record
    ----------------------- -------------------------------------------------
    the patch's registers   bytes 197…250, register images bit for bit
    a rhythm drum           its kind; snare, cymbal and hi-hat also name their
                            partner operator's multiplier and channel pitch
    channel volume          the volume column, on the driver's own decibel
                            curve (`volume_column`); the engine applies it as
                            operator attenuation, which is what a driver does
    key-on / key-off        a note / a key-off; a retrigger keys the SAME
                            channel on again, envelopes carried (NNA Note Cut)

This module is importable: ims2taud and sop2taud call `build_bank` to write the
patches a song actually uses; bnkbank.py (Microtone.js) uses it to import a raw
bank.  Run as a script it writes a .tsii bank.
"""

import argparse
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_KIND_SAMPLEINST,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, INST_RECORD_SIZE,
    TAUD_C4, compress_blob, build_project_data,
    OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM,
    OPL_KIND_TC, OPL_KIND_HH, OPL_C4_RATE, opl_block, build_opl_record,
)


# ── The chip ─────────────────────────────────────────────────────────────────

CHIP_CLOCK_HZ = 3579545
CLOCKS_PER_SAMPLE = 72
NATIVE_RATE = CHIP_CLOCK_HZ / CLOCKS_PER_SAMPLE      # 49716.05 Hz
TL_STEP_DB = 0.75

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


# ── Volume ───────────────────────────────────────────────────────────────────

def tl_gain(total_level: int) -> float:
    return 10.0 ** (-TL_STEP_DB * (total_level & 63) / 20.0)


def volume_column(vol: int, total_level: int, atten_db: float = 0.0) -> int:
    """An OPL channel volume (0…127) → Taud's 6-bit LINEAR volume axis.

    AdLib's volume is not a linear gain: the driver scales the operator's
    6-bit AMPLITUDE — a 0.75 dB-per-step logarithmic quantity — so volume 64 is
    23 dB down, not 6.  Converting it as if it were linear makes every fade in
    the format arrive far too late and far too suddenly.  The exact curve
    depends on the operator's own total level, which is why the caller passes
    the patch currently on the channel.  The engine puts the result back into
    the operators as attenuation (TAUD_ENGINE_SPEC.md §5.5.2), so what reaches
    the chip is the level the driver would have written, to the nearest step
    the 6-bit column can say.  `atten_db` takes a further fixed amount off —
    the caller's, for something the chip does that Taud's mixer does not."""
    tl = total_level & 63
    full = ((63 - tl) * 127 + 64) >> 7
    here = ((63 - tl) * max(0, min(127, vol)) + 64) >> 7
    if full <= 0:
        return 63
    gain = 10.0 ** (-(TL_STEP_DB * (full - here) + atten_db) / 20.0)
    return max(0, min(63, round(63.0 * gain)))


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


#: 12-TET concert middle C — the pitch the song is tuned to.
CONCERT_C4_HZ = 261.6255653005986

#: Declared song tuning: **A4 at 440 Hz**, which the engine reads as an exact
#: identity — the ratio is 1.0 to the bit, so nothing is scaled at playback and
#: the song is an ordinary concert-pitch one to work on.
#:
#: The chip's own middle C is 261.719 Hz, about 0.6 cents above concert.  The
#: engine re-derives the F-number from the sounding frequency and rounds it, and
#: the AdLib table is itself `round(689.76 · 2^(i/192))` but for a quarter-cent
#: here and there, so a concert-pitch note word lands on the F-number the driver
#: wrote — the 0.6 cents are inside the rounding.  Every note keeps its place on
#: the 12-TET grid, which is what a remix needs.
TAUD_A4 = 0x5C00
TUNING_BASE_NOTE = TAUD_A4
TUNING_BASE_FREQ = 440.0
#: What the notation index says these note words MEAN: plain 12-TET, so the
#: grid reads C-4 / F#5 and a remix can be typed into it.
NOTATION_12TET = 120


# ── Rhythm mode ──────────────────────────────────────────────────────────────

#: What each channel is in rhythm mode.  The bass drum is an ordinary two-operator
#: voice and the tom an ordinary oscillator; the other three are the noise-driven
#: ones, and all four single-operator drums use the patch's MODULATOR half because
#: that is the operator the driver loads into their one slot.
RHYTHM_KIND = {6: 'bd', 7: 'sd', 8: 'tom', 9: 'tc', 10: 'hh'}
RHYTHM_KINDS = frozenset(RHYTHM_KIND.values())
#: §6 of the IMS library's ENGINE_SPEC: the tom starts two octaves below chip
#: middle C, and the snare's channel — the hi-hat's too — sits seven semitones
#: above the tom's, retuned whenever the tom is.
DEFAULT_TOM_NOTE = 24
TOM_TO_SD = 7
#: Which drum's patch supplies a noise drum's partner operator: the snare and
#: the cymbal read the hi-hat operator's accumulator, the hi-hat the cymbal's.
PARTNER_ROLE = {'sd': 'hh', 'tc': 'hh', 'hh': 'tc'}

#: The four-operator connections, as chains of operator indices: each operator
#: modulates the next, and each chain's last one reaches the mix.  The YMF262's
#: published figure keyed by the two halves' CNT bits.
CHAINS_FOUR_OP = {
    (0, 0): [[0, 1, 2, 3]],
    (0, 1): [[0, 1, 2], [3]],
    (1, 0): [[0], [1, 2, 3]],
    (1, 1): [[0], [1, 2], [3]],
}

ROLE_KIND = {'melodic': OPL_KIND_2OP, 'bd': OPL_KIND_BD, 'sd': OPL_KIND_SD,
             'tom': OPL_KIND_TOM, 'tc': OPL_KIND_TC, 'hh': OPL_KIND_HH}


def partner_multiple(patch) -> int:
    """The multiplier a noise drum borrows from the patch on its partner drum's
    channel: that patch's modulator, as for every single-slot drum."""
    return (patch.mod['multiple'] & 15) if patch is not None else 1


# ── Records ──────────────────────────────────────────────────────────────────

NNA_NOTE_CUT = 1          # the next note on the channel keys the same channel on


def _flag(v) -> int:
    """A bank's booleans are bytes the driver tests for truth."""
    return 1 if v else 0


def operator_registers(op: dict, wave: int) -> tuple:
    """A bank operator's thirteen parameters (and its wave select) as the five
    register bytes the driver would write: 0x20, 0x40, 0x60, 0x80, 0xE0.  The
    numeric fields are masked, because real banks carry values up to 255."""
    return (
        (_flag(op['am']) << 7) | (_flag(op['vib']) << 6) | (_flag(op['eg']) << 5)
        | (_flag(op['ksr']) << 4) | (op['multiple'] & 15),
        ((op['ksl'] & 3) << 6) | (op['totalLevel'] & 63),
        ((op['attack'] & 15) << 4) | (op['decay'] & 15),
        ((op['sustain'] & 15) << 4) | (op['release'] & 15),
        wave & 7,
    )


def patch_block(patch, role: str, *, partner_mult: int = 0, partner_detune: int = 0,
                low_fnum: bool = False) -> bytes:
    """One patch played as `role` ('melodic' — four operators when it carries a
    second pair — 'bd', 'sd', 'tom', 'tc' or 'hh') as a type-8 patch block."""
    kind = ROLE_KIND.get(role, OPL_KIND_2OP)
    mod = operator_registers(patch.mod, patch.mod_wave)
    car = operator_registers(patch.car, patch.car_wave)
    if kind == OPL_KIND_2OP and patch.pair is not None:
        return opl_block(OPL_KIND_4OP, [
            mod, car,
            operator_registers(patch.pair.mod, patch.pair.mod_wave),
            operator_registers(patch.pair.car, patch.pair.car_wave)],
            feedback=patch.feedback, cnt_a=_flag(patch.additive),
            cnt_b=_flag(patch.pair.additive), low_fnum=low_fnum)
    if kind in (OPL_KIND_2OP, OPL_KIND_BD):
        return opl_block(kind, [mod, car], feedback=patch.feedback,
                         cnt_a=_flag(patch.additive), low_fnum=low_fnum)
    # A single-slot drum: the patch's modulator, whichever slot the chip has it
    # in.  The snare and the cymbal have no feedback on the chip, and the hi-hat
    # and the tom none in rhythm mode, so it is not written.
    return opl_block(kind, [mod], partner_mult=partner_mult,
                     partner_detune=partner_detune, low_fnum=low_fnum)


# ── Bank assembly ────────────────────────────────────────────────────────────

MAIN_SLOTS = 255            # $01…$FF — what a pattern cell can name
AUX_BASE = 256              # $100…$3FF — reachable from a Metainstrument only


class BankBuilder:
    """The instruments of one conversion: OPL instruments, and — for a version-0.2
    `.sop` — the recorded samples of its sample tracks."""

    def __init__(self, share: bool = True):
        self.pool = bytearray()
        self.sample_names = []
        self.main_records = []
        self.main_names = []
        self._main_index = {}
        self.share = share

    def _add_main(self, record: bytes, name: str) -> int:
        hit = self._main_index.get(record) if self.share else None
        if hit is not None:
            return hit
        if len(self.main_records) >= MAIN_SLOTS:
            sys.exit(f"error: more than {MAIN_SLOTS} instruments")
        self.main_records.append(record)
        self.main_names.append(name)
        slot = len(self.main_records)            # $01…
        self._main_index[record] = slot
        return slot

    def add_patch(self, patch, role: str = 'melodic', name: str = '', *,
                  partner_mult: int = 0, partner_detune: int = 0,
                  low_fnum: bool = False) -> int:
        """One patch as an OPL instrument, and the slot that plays it; 0 for a patch
        nobody could find.  Drums are marked percussion, so a retuner or a
        transposer leaves their notes alone."""
        if patch is None:
            return 0
        block = patch_block(patch, role, partner_mult=partner_mult,
                            partner_detune=partner_detune, low_fnum=low_fnum)
        return self._add_main(build_opl_record(
            block, rate=OPL_C4_RATE, nna=NNA_NOTE_CUT,
            percussion=role in RHYTHM_KINDS), name or patch.name)

    def add_sample(self, data: bytes, rate: int, name: str, detune: int = 0) -> int:
        """A recorded sample beside the OPL instruments, as one ordinary instrument,
        and the directly-addressable slot that plays it.

        Not every voice of an OPL-era song is the chip's: a version-0.2 `.sop`
        plays four of its tracks on a Sound Blaster's sample voices (SOP_FORMAT
        §10), and its samples have to share this pool and this slot numbering
        with the chip's.  `data` is unsigned 8-bit, Taud's own pool format;
        `rate` is what the instrument plays at on C4, nudged by `detune`.

        One-shot and no fadeout: a sample stops at its last byte or when the
        pattern cuts it.  NNA = Note Cut — the voice it stands for is monophonic."""
        if not 0 < len(data) <= 0xFFFF:
            sys.exit(f"error: sample {name!r} is {len(data)} bytes; "
                     f"an instrument holds 1…65535")
        off = len(self.pool)
        if off + len(data) > SAMPLEBIN_SIZE:
            sys.exit("error: sample pool overflowed 8 MB")
        self.pool += data
        self.sample_names.append(name)
        r = bytearray(INST_RECORD_SIZE)
        struct.pack_into('<I', r, 0, off)
        struct.pack_into('<H', r, 4, len(data))
        struct.pack_into('<H', r, 6, rate & 0xFFFF)
        for i in range(25):
            r[21 + 2 * i] = 0x3F
        r[171] = 0xFF
        r[177] = 0x80
        r[182] = 0xFF
        r[183] = 0xFF
        struct.pack_into('<h', r, 184, max(-32768, min(32767, detune)))
        r[186] = NNA_NOTE_CUT
        r[196] = 0xFF
        return self._add_main(bytes(r), name)

    def finish(self):
        sample_bin = bytes(self.pool) + b'\x00' * (SAMPLEBIN_SIZE - len(self.pool))
        inst_bin = bytearray(INSTBIN_SIZE)
        names = [''] * 1024
        for i, rec in enumerate(self.main_records):
            inst_bin[(1 + i) * 256:(2 + i) * 256] = rec
            names[1 + i] = self.main_names[i]
        return {'sample_bin': sample_bin, 'inst_bin': bytes(inst_bin),
                'instrument_names': names, 'sample_names': list(self.sample_names),
                'pool_bytes': len(self.pool)}


SIGNATURE = b"opl2taud/TSVM "     # 14 bytes


def escape_non_ascii(text: str) -> str:
    """Stored NAMES carry non-ASCII as literal `\\uHHHH` escapes, because the
    TSVM-side string reader is ASCII-only (Microtone.js src/ui/names.js resolves
    them for display and re-escapes on save).  Titles in this family are Korean
    by nature, so this is not an edge case."""
    return ''.join(c if ord(c) < 0x80 else '\\u%04X' % ord(c) for c in text)


def build_bank(entries, *, share: bool = True):
    """Write OPL patches as Taud OPL instruments.

    `entries` is a list of dicts: `patch` (an OplPatch, or None for an
    unresolved name), `kind` ('melodic', 'bd', 'sd', 'tom', 'tc' or 'hh'), `name`,
    and for the noise drums `partner_mult` and `partner_detune`; `low_fnum` puts
    the patch on Note's F-number range.  An entry may carry `sample` instead of
    `patch` — {'data', 'rate', 'detune'}, see `BankBuilder.add_sample` — for a
    voice that was never the chip's.  Identical records share a slot unless
    `share` is false, when every entry gets its own, in order.

    Returns the sample bin, the instrument bin, the name tables, and `slots` —
    the directly-addressable instrument index of each entry, in order."""
    b = BankBuilder(share=share)
    slots = []
    for e in entries:
        if e.get('sample'):
            slots.append(b.add_sample(name=e.get('name') or 'sample', **e['sample']))
        else:
            slots.append(b.add_patch(
                e.get('patch'), e.get('kind', 'melodic'), e.get('name') or '',
                partner_mult=e.get('partner_mult', 0),
                partner_detune=e.get('partner_detune', 0),
                low_fnum=e.get('low_fnum', False)))
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
    out = build_bank(entries)
    vprint(f"  {len(set(s for s in out['slots'] if s))} OPL instruments")
    data = assemble_tsii(out)
    with open(args.output, 'wb') as f:
        f.write(data)
    print(f"wrote {len(data)} bytes to '{args.output}'")


if __name__ == '__main__':
    main()
