#!/usr/bin/env python3
"""xm2taud.py — Convert FastTracker 2 (.xm) to TSVM Taud (.taud)

Usage:
    python3 xm2taud.py input.xm output.taud [-v]

Limits:
    - Up to 20 XM channels (excess unused).
    - Sample bin is 8 MB (8388608 bytes); if all samples together exceed
      this, every sample is globally resampled down (with c2spd adjusted)
      so pitch is preserved, mirroring it2taud / mod2taud. Any individual
      sample whose 8-bit-mono form still exceeds the u16 length cap
      (SAMPLE_LEN_LIMIT bytes) is then resampled selectively to fit, and
      TOP_O sample-offset args on the affected channel are rescaled
      per-slot.
    - Multi-sample instruments use the sample selected by the *current
      note's* keymap entry; the converter materialises one Taud
      instrument slot per (XM instrument, sample-in-instrument) pair.
      (Note: it2taud uses the alternate Ixmp project-data extension
      instead — one Taud instrument per IT instrument, plus an Ixmp
      patch list for the keyboard mapping. XM could be retrofitted the
      same way to conserve Taud instrument slots; deferred until any
      real XM file actually hits the 255-slot cap.)

Pattern length policy:
    - XM patterns ≤ 64 rows → 1 Taud cue with the LEN ($02xx)
      cuesheet instruction (rows < 64) or no instruction (rows == 64).
    - XM patterns > 64 rows → split into ⌊rows/64⌋ full 64-row cues
      plus, if rows % 64 != 0, a final cue holding the remainder rows
      with the LEN instruction. Full 64-row cues emit no instruction.
    - The cuesheet LEN instruction is decoded by AudioAdapter.kt — the
      engine wraps to the next cue after `rows` rows instead of always
      waiting for row 64.

Effect support:
    Full XM effect dispatch per TAUD_NOTE_EFFECTS.md (FastTracker 2 →
    Taud conversion table). Volume column commands fold into either
    the Taud volume column directly or as an aux effect on the main
    effect slot when free, dropped otherwise (same policy as
    it2taud's decode_volcol). Position-jump (Bxx) and pattern-break
    (Dxx) are remapped to Taud cue indices.

Reference:
    XM format spec — reference_materials/MilkyTracker/resources/reference/xm-form.txt
    Parser  — reference_materials/MilkyTracker/src/milkyplay/LoaderXM.cpp
"""

import argparse
import copy
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, SAMPLE_LEN_LIMIT,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF, NOTE_CUT, TAUD_C4,
    TOP_NONE, TOP_A, TOP_B, TOP_C, TOP_D, TOP_E, TOP_F, TOP_G, TOP_H, TOP_I,
    TOP_J, TOP_K, TOP_L, TOP_O, TOP_Q, TOP_R, TOP_S, TOP_T, TOP_U, TOP_V, TOP_W, TOP_Y,
    SEL_SET, SEL_UP, SEL_DOWN, SEL_FINE,
    J_SEMI_TABLE,
    d_arg_to_col, resample_linear, rescale_offset_effects_per_slot,
    loop_resample_ratio, scale_loop,
    encode_cue, deduplicate_patterns, finalize_cue_sheet, set_cue_instruction,
    normalise_sample, encode_song_entry, nearest_minifloat, compress_blob,
    CUE_INST_NOP, CUE_INST_HALT, cue_instruction_len,
    cue_instruction_halt_at,
    build_project_data, detect_subsongs,
)


# ── XM constants ─────────────────────────────────────────────────────────────

XM_MAGIC      = b'Extended Module: '   # 17 bytes
XM_NOTE_OFF   = 97                     # XM raw note value for key-off
XM_RELNOTE_C4 = 49                     # XM note 49 (after relnote applied) = C-4

# Sample type flags
XM_SMP_LOOP_FWD      = 0x01
XM_SMP_LOOP_PINGPONG = 0x02
XM_SMP_LOOP_MASK     = 0x03
XM_SMP_16BIT         = 0x10

# Envelope type flags
XM_ENV_ON       = 0x01
XM_ENV_SUSTAIN  = 0x02
XM_ENV_LOOP     = 0x04

SIGNATURE = b"xm2taud/TSVM  "          # 14 bytes


# ── Data classes ─────────────────────────────────────────────────────────────

class XMHeader:
    __slots__ = ('title', 'tracker', 'version', 'header_size',
                 'order_count', 'restart_pos', 'channels', 'pattern_count',
                 'instrument_count', 'flags', 'default_speed', 'default_bpm',
                 'order_list', 'linear_freq')


class XMSample:
    __slots__ = ('name', 'length', 'loop_start', 'loop_length',
                 'volume', 'finetune', 'flags', 'panning', 'rel_note',
                 'sample_data', 'is_16bit', 'pingpong')


class XMInstrument:
    __slots__ = ('name', 'sample_count', 'keymap',
                 'vol_env_pts', 'pan_env_pts',
                 'vol_env_count', 'pan_env_count',
                 'vol_sustain', 'vol_loop_start', 'vol_loop_end',
                 'pan_sustain', 'pan_loop_start', 'pan_loop_end',
                 'vol_env_type', 'pan_env_type',
                 'vib_type', 'vib_sweep', 'vib_depth', 'vib_rate',
                 'fadeout', 'samples')


class XMRow:
    __slots__ = ('note', 'inst', 'volcol', 'effect', 'effect_arg')
    def __init__(self):
        self.note       = 0    # 0=empty, 1..96=pitch, 97=key off
        self.inst       = 0    # 1-based; 0=none
        self.volcol     = 0    # 0=none; otherwise raw vol-col byte
        self.effect     = 0
        self.effect_arg = 0


# ── Header parser ─────────────────────────────────────────────────────────────

def _read_u8(data, off):  return data[off]
def _read_u16(data, off): return struct.unpack_from('<H', data, off)[0]
def _read_u32(data, off): return struct.unpack_from('<I', data, off)[0]


def parse_xm_header(data: bytes) -> XMHeader:
    if data[:17] != XM_MAGIC:
        sys.exit(f"error: not an XM file (bad magic: {data[:17]!r})")
    if data[37] != 0x1A:
        vprint(f"  warning: expected 0x1A marker at offset 37, got 0x{data[37]:02X}")

    h = XMHeader()
    h.title         = data[17:37].rstrip(b'\x00 ').decode('latin-1', errors='replace')
    h.tracker       = data[38:58].rstrip(b'\x00 ').decode('latin-1', errors='replace')
    h.version       = _read_u16(data, 58)
    h.header_size   = _read_u32(data, 60)
    h.order_count   = _read_u16(data, 64)
    h.restart_pos   = _read_u16(data, 66)
    h.channels      = _read_u16(data, 68)
    h.pattern_count = _read_u16(data, 70)
    h.instrument_count = _read_u16(data, 72)
    h.flags         = _read_u16(data, 74)
    h.linear_freq   = bool(h.flags & 0x01)
    h.default_speed = _read_u16(data, 76)
    h.default_bpm   = _read_u16(data, 78)
    h.order_list    = list(data[80:80 + 256])

    if h.version not in (0x0102, 0x0103, 0x0104):
        vprint(f"  warning: unusual XM version 0x{h.version:04X}")
    if h.channels < 2 or h.channels > 32:
        vprint(f"  warning: unusual channel count {h.channels}")

    return h


# ── Pattern parser ────────────────────────────────────────────────────────────

def parse_patterns(data: bytes, h: XMHeader, patterns_offset: int):
    """Returns (patterns_rows, next_offset).

    patterns_rows: list of (grid, rows) where grid is a list of `channels`
    arrays, each `rows` long, of XMRow.
    """
    patterns = []
    off = patterns_offset
    for pi in range(h.pattern_count):
        if off + 9 > len(data):
            sys.exit(f"error: truncated pattern {pi} header at offset {off}")
        hdr_len    = _read_u32(data, off)
        # packing_type = data[off + 4]   # always 0
        rows       = _read_u16(data, off + 5)
        packed_sz  = _read_u16(data, off + 7)
        body_off   = off + hdr_len
        if body_off + packed_sz > len(data):
            sys.exit(f"error: truncated pattern {pi} body")

        grid = [[XMRow() for _ in range(rows)] for _ in range(h.channels)]
        if packed_sz == 0:
            patterns.append((grid, rows))
            off = body_off + packed_sz
            continue

        p = body_off
        end = body_off + packed_sz
        for r in range(rows):
            for c in range(h.channels):
                if p >= end:
                    break
                first = data[p]; p += 1
                cell = grid[c][r]
                if first & 0x80:
                    if first & 0x01:
                        cell.note = data[p]; p += 1
                    if first & 0x02:
                        cell.inst = data[p]; p += 1
                    if first & 0x04:
                        cell.volcol = data[p]; p += 1
                    if first & 0x08:
                        cell.effect = data[p]; p += 1
                    if first & 0x10:
                        cell.effect_arg = data[p]; p += 1
                else:
                    # Uncompressed — `first` is the note byte; 4 more follow
                    cell.note       = first
                    cell.inst       = data[p];     p += 1
                    cell.volcol     = data[p];     p += 1
                    cell.effect     = data[p];     p += 1
                    cell.effect_arg = data[p];     p += 1

        patterns.append((grid, rows))
        off = body_off + packed_sz
    return patterns, off


# ── Instrument / sample parser ────────────────────────────────────────────────

def parse_instruments(data: bytes, h: XMHeader, off_start: int) -> list:
    insts = []
    off = off_start
    for ii in range(h.instrument_count):
        if off + 29 > len(data):
            vprint(f"  warning: truncated instrument {ii} at offset {off}")
            break
        hdr_size = _read_u32(data, off)
        name = data[off + 4:off + 26].rstrip(b'\x00 ').decode('latin-1', errors='replace')
        # type byte at +26 ignored (almost always 0)
        n_samples = _read_u16(data, off + 27)

        inst = XMInstrument()
        inst.name = name
        inst.sample_count = n_samples
        inst.keymap = [0] * 96
        inst.vol_env_pts = []
        inst.pan_env_pts = []
        inst.vol_env_count = 0
        inst.pan_env_count = 0
        inst.vol_sustain = 0
        inst.vol_loop_start = 0
        inst.vol_loop_end = 0
        inst.pan_sustain = 0
        inst.pan_loop_start = 0
        inst.pan_loop_end = 0
        inst.vol_env_type = 0
        inst.pan_env_type = 0
        inst.vib_type = 0
        inst.vib_sweep = 0
        inst.vib_depth = 0
        inst.vib_rate = 0
        inst.fadeout = 0
        inst.samples = []

        if n_samples == 0:
            insts.append(inst)
            off += hdr_size
            continue

        # Extended header begins at off + 29 (per LoaderXM.cpp:162)
        ext = off + 29
        if ext + 214 > len(data):
            vprint(f"  warning: truncated extended header for inst {ii}")
            insts.append(inst)
            off += hdr_size
            continue

        sample_hdr_size = _read_u32(data, ext)        # 4 bytes
        inst.keymap     = list(data[ext + 4:ext + 100])  # 96 bytes
        # Volume envelope: 12 × (frame:u16, value:u16) = 48 bytes at ext+100
        for k in range(12):
            fr  = _read_u16(data, ext + 100 + k * 4)
            val = _read_u16(data, ext + 100 + k * 4 + 2)
            inst.vol_env_pts.append((fr, val))
        # Panning envelope at ext+148
        for k in range(12):
            fr  = _read_u16(data, ext + 148 + k * 4)
            val = _read_u16(data, ext + 148 + k * 4 + 2)
            inst.pan_env_pts.append((fr, val))
        inst.vol_env_count  = data[ext + 196]
        inst.pan_env_count  = data[ext + 197]
        inst.vol_sustain    = data[ext + 198]
        inst.vol_loop_start = data[ext + 199]
        inst.vol_loop_end   = data[ext + 200]
        inst.pan_sustain    = data[ext + 201]
        inst.pan_loop_start = data[ext + 202]
        inst.pan_loop_end   = data[ext + 203]
        inst.vol_env_type   = data[ext + 204]
        inst.pan_env_type   = data[ext + 205]
        inst.vib_type       = data[ext + 206]
        inst.vib_sweep      = data[ext + 207]
        inst.vib_depth      = data[ext + 208]
        inst.vib_rate       = data[ext + 209]
        inst.fadeout        = _read_u16(data, ext + 210)
        # 2 reserved bytes at ext+212

        off += hdr_size

        # Sample headers (40 bytes each per xm-form.txt:262-283)
        sample_hdrs_off = off
        sample_hdrs = []
        for si in range(n_samples):
            sh = sample_hdrs_off + si * sample_hdr_size
            if sh + 40 > len(data):
                vprint(f"  warning: truncated sample header inst {ii} sample {si}")
                break
            s = XMSample()
            s.length      = _read_u32(data, sh + 0)
            s.loop_start  = _read_u32(data, sh + 4)
            s.loop_length = _read_u32(data, sh + 8)
            s.volume      = data[sh + 12]
            s.finetune    = struct.unpack_from('b', data, sh + 13)[0]   # signed
            s.flags       = data[sh + 14]
            s.panning     = data[sh + 15]
            s.rel_note    = struct.unpack_from('b', data, sh + 16)[0]   # signed
            # reserved byte at +17
            s.name        = data[sh + 18:sh + 40].rstrip(b'\x00 ').decode('latin-1', errors='replace')
            s.is_16bit    = bool(s.flags & XM_SMP_16BIT)
            loop_type     = s.flags & XM_SMP_LOOP_MASK
            s.pingpong    = (loop_type == XM_SMP_LOOP_PINGPONG)
            s.sample_data = b''
            sample_hdrs.append(s)
        off = sample_hdrs_off + n_samples * sample_hdr_size

        # Sample data follows immediately after all sample headers
        for s in sample_hdrs:
            if s.length == 0:
                continue
            raw = data[off:off + s.length]
            off += s.length
            # Integrate delta encoding
            if s.is_16bit:
                pcm = bytearray(s.length)
                last = 0
                for i in range(0, s.length, 2):
                    if i + 2 > s.length:
                        break
                    delta = struct.unpack_from('<h', raw, i)[0]
                    last = (last + delta) & 0xFFFF
                    if last >= 0x8000:
                        signed = last - 0x10000
                    else:
                        signed = last
                    struct.pack_into('<h', pcm, i, signed)
                # Update length / loop fields to be in sample units (not byte units)
                s.length      //= 2
                s.loop_start  //= 2
                s.loop_length //= 2
                s.sample_data = bytes(pcm)
            else:
                pcm = bytearray(s.length)
                last = 0
                for i in range(s.length):
                    delta = raw[i]
                    if delta >= 0x80:
                        delta -= 0x100
                    last = (last + delta) & 0xFF
                    pcm[i] = last  # signed-stored, will be flipped by normalise_sample
                s.sample_data = bytes(pcm)

            # Normalise to unsigned 8-bit mono
            s.sample_data = normalise_sample(
                s.sample_data, signed=True, is_16bit=s.is_16bit,
                is_stereo=False, name=s.name or '<unnamed>'
            )
            # length is now in 8-bit mono samples
            s.length = len(s.sample_data)
            s.loop_start  = min(s.loop_start, s.length)
            s.loop_length = max(0, min(s.loop_length, s.length - s.loop_start))

        inst.samples = sample_hdrs
        insts.append(inst)

    return insts, off


# ── Note / volume column / effect translation ────────────────────────────────

def encode_note_xm(xm_note: int) -> int:
    """XM raw note (1..96) → Taud 4096-TET pitch.

    XM note 1 = C-0; note 49 = C-4 (matches Taud TAUD_C4 anchor).
    """
    if xm_note == XM_NOTE_OFF:
        return NOTE_KEYOFF
    if 1 <= xm_note <= 96:
        semis = xm_note - XM_RELNOTE_C4
        val = round(TAUD_C4 + semis * 4096 / 12)
        return max(0x20, min(0xFFFF, val))
    return NOTE_NOP


def decode_volcol_xm(vc: int):
    """Decode XM volume column byte.

    Returns (vol_sel, vol_value, pan_set, aux_effect):
      vol_sel/vol_value : Taud volume column override (or SEL_FINE/0)
      pan_set           : 0..63 pan-column override, or None
      aux_effect        : (Taud op, arg) folded into main effect slot if
                          unoccupied, dropped otherwise

    XM vol-col byte ranges (xm-form.txt:958-1030):
      0x10..0x50  Set volume value-0x10 (0..64)
      0x60..0x6F  Volume slide down (nybble = speed)
      0x70..0x7F  Volume slide up
      0x80..0x8F  Fine volume slide down
      0x90..0x9F  Fine volume slide up
      0xA0..0xAF  Set vibrato speed (nybble)
      0xB0..0xBF  Vibrato with depth (nybble)
      0xC0..0xCF  Set panning (nybble × 17)
      0xD0..0xDF  Panning slide left
      0xE0..0xEF  Panning slide right
      0xF0..0xFF  Tone portamento (nybble × 16)
    """
    if vc == 0:
        return SEL_FINE, 0, None, None
    if 0x10 <= vc <= 0x50:
        # Set volume 0..64 → 0..63 (clamp)
        return SEL_SET, min(vc - 0x10, 0x3F), None, None
    nybble = vc & 0xF
    if 0x60 <= vc <= 0x6F:
        return SEL_DOWN, nybble, None, None
    if 0x70 <= vc <= 0x7F:
        return SEL_UP, nybble, None, None
    if 0x80 <= vc <= 0x8F:
        # Fine slide down: dir bit 0 = down; magnitude in low 5 bits.
        return SEL_FINE, (nybble & 0x1F), None, None
    if 0x90 <= vc <= 0x9F:
        # Fine slide up: dir bit 5 set.
        return SEL_FINE, (nybble & 0x1F) | 0x20, None, None
    if 0xA0 <= vc <= 0xAF:
        # Set vibrato speed → fold as TOP_H with speed in high byte.
        return SEL_FINE, 0, None, (TOP_H, (nybble * 0x11) << 8)
    if 0xB0 <= vc <= 0xBF:
        # Vibrato with depth → TOP_H with depth in low byte.
        return SEL_FINE, 0, None, (TOP_H, nybble * 0x11)
    if 0xC0 <= vc <= 0xCF:
        # Set panning: nybble × 17 = 0..255; convert to 6-bit.
        pan8 = nybble * 17
        pan6 = min(0x3F, round(pan8 * 63 / 255))
        return SEL_FINE, 0, pan6, None
    if 0xD0 <= vc <= 0xDF:
        # Pan slide left: SEL_DOWN on pan column.
        return SEL_FINE, 0, None, None  # consumed via pan_override below
    if 0xE0 <= vc <= 0xEF:
        return SEL_FINE, 0, None, None
    if 0xF0 <= vc <= 0xFF:
        # Tone portamento: nybble × 16 → TOP_G argument in linear units.
        spd_period = nybble * 16
        return SEL_FINE, 0, None, (TOP_G, round(spd_period * 64 / 3) & 0xFFFF)
    return SEL_FINE, 0, None, None


def _xm_volcol_pan_override(vc: int):
    """Returns (pan_sel, pan_value) for vol-col D/E pan slides, or None."""
    if 0xD0 <= vc <= 0xDF:
        return (SEL_DOWN, vc & 0xF)    # left
    if 0xE0 <= vc <= 0xEF:
        return (SEL_UP, vc & 0xF)      # right
    return None


def encode_effect_xm(cmd: int, arg: int, ch: int = 0, row: int = 0,
                     amiga_mode: bool = False) -> tuple:
    """Map an XM effect (cmd, arg) → (taud_op, taud_arg16, vol_override, pan_override).

    XM effect numbers per XModule.cpp:1303 / xm-form.txt:690-743.
    """
    # 0 with arg=0 = true no-op; 0 with arg!=0 = arpeggio.
    if cmd == 0x00:
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_J, (J_SEMI_TABLE[hi] << 8) | J_SEMI_TABLE[lo], None, None)

    if cmd == 0x01:
        # Porta up: arg in period units (Amiga) or 4096-TET-equivalent.
        if amiga_mode:
            return (TOP_F, arg & 0xFFFF, None, None)
        return (TOP_F, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == 0x02:
        if amiga_mode:
            return (TOP_E, arg & 0xFFFF, None, None)
        return (TOP_E, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == 0x03:
        # Tone portamento: always linear regardless of mode.
        return (TOP_G, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == 0x04:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_H, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == 0x05:
        # Tone porta + vol slide → Taud L verbatim. The XM source byte goes
        # straight into L's high byte; the engine handles the combined
        # porta-continuation + vol-slide semantics natively (see
        # TAUD_NOTE_EFFECTS.md §L). XM's 500 (arg = 0) recall is honoured by
        # Taud's L $0000 recall against L's own private memory, so a 500 row
        # plays the previously emitted slide rate. This avoids the volume-
        # column collision that the H+vol-col split form caused on rows
        # already carrying a vol-column SET.
        return (TOP_L, (arg & 0xFF) << 8, None, None)

    if cmd == 0x06:
        # Vibrato + vol slide → Taud K verbatim (same rationale as 0x05).
        return (TOP_K, (arg & 0xFF) << 8, None, None)

    if cmd == 0x07:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_R, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == 0x08:
        # Set panning 0..255 → Taud pan column 0..63.
        pan6 = min(0x3F, round((arg & 0xFF) * 63 / 255))
        return (TOP_NONE, 0, None, (SEL_SET, pan6))

    if cmd == 0x09:
        return (TOP_O, (arg & 0xFF) << 8, None, None)

    if cmd == 0x0A:
        # Volume slide: high nybble = up, low nybble = down. Taud TOP_D
        # uses the same nybble-pair layout in the high byte.
        return (TOP_D, (arg & 0xFF) << 8, None, None)

    if cmd == 0x0B:
        # Position jump — order index translated to Taud cue at remap time.
        return (TOP_B, arg & 0xFF, None, None)

    if cmd == 0x0C:
        # Set volume 0..64 → vol column SEL_SET.
        return (TOP_NONE, 0, (SEL_SET, min(arg, 0x3F)), None)

    if cmd == 0x0D:
        # Pattern break: XM stores BCD row number.
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        row_num = (hi * 10 + lo) & 0xFF
        if row_num >= PATTERN_ROWS:
            row_num = 0
        return (TOP_C, row_num & 0xFF, None, None)

    if cmd == 0x0E:
        # Extended commands E0x..EFx — fold into Taud TOP_S sub-codes
        # where possible.
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        # Fine porta up E1x / down E2x:
        if sub == 0x1:
            # Fine porta up: TOP_F with $Fx layout (engine treats this as fine).
            if amiga_mode:
                return (TOP_F, 0xF000 | (val & 0xFFF), None, None)
            return (TOP_F, 0xF000 | (round(val * 16 / 3) & 0xFFF), None, None)
        if sub == 0x2:
            if amiga_mode:
                return (TOP_E, 0xF000 | (val & 0xFFF), None, None)
            return (TOP_E, 0xF000 | (round(val * 16 / 3) & 0xFFF), None, None)
        # E3x glissando control / E4x vibrato wave / E5x finetune /
        # E7x tremolo wave / E9x retrigger / EAx fine vol up / EBx fine
        # vol down / ECx note cut / EDx note delay / EEx pattern delay.
        if sub in (0x3, 0x4, 0x7, 0xC, 0xD, 0xE):
            return (TOP_S, (sub << 12) | (val << 8), None, None)
        if sub == 0x5:
            # Set finetune — convert to S5x sub-effect (4-bit signed nibble).
            return (TOP_S, 0x5000 | (val << 8), None, None)
        if sub == 0x6:
            # XM E6x = pattern loop (E60 sets loop start, E6x with x>0 loops
            # x times). Maps directly onto Taud SBx, which has identical
            # semantics — the engine handles per-voice loopStartRow /
            # loopCount in applySEffect (sub 0xB).
            return (TOP_S, 0xB000 | (val << 8), None, None)
        if sub == 0x8:
            # Pan position 0..15 → set pan column (XM nybble × 17 → 8-bit).
            pan8 = (val << 4) | val
            pan6 = min(0x3F, round(pan8 * 63 / 255))
            return (TOP_NONE, 0, None, (SEL_SET, pan6))
        if sub == 0x9:
            # Retrig with vol 0 → multi-retrig speed; map to TOP_Q.
            return (TOP_Q, (val & 0xF) << 8, None, None)
        if sub == 0xA:
            # Fine vol up: vol col fine slide
            return (TOP_NONE, 0, (SEL_FINE, (val & 0x1F) | 0x20), None)
        if sub == 0xB:
            # Fine vol down
            return (TOP_NONE, 0, (SEL_FINE, val & 0x1F), None)
        if sub == 0xF:
            # E$Fx in XM is unused (or "Funk repeat" in old PT) — drop.
            vprint(f"    dropped EF{val:X} (unused / funk) at ch{ch} row{row}")
            return (TOP_NONE, 0, None, None)
        return (TOP_NONE, 0, None, None)

    if cmd == 0x0F:
        # Set speed if arg < 0x20, else set tempo (BPM).
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        if arg < 0x20:
            return (TOP_A, (arg & 0xFF) << 8, None, None)
        # Tempo: Taud T uses bias of -25 in stored form; mirror it2taud:
        return (TOP_T, ((arg - 0x19) & 0xFF) << 8, None, None)

    if cmd == 0x10:
        # Set global volume 0..64 → Taud V (×4 to fit 0..255).
        taud_v = min(arg * 4, 0xFF)
        return (TOP_V, (taud_v & 0xFF) << 8, None, None)

    if cmd == 0x11:
        # Global volume slide: high nyb up, low nyb down → TOP_W.
        return (TOP_W, (arg & 0xFF) << 8, None, None)

    if cmd == 0x14:
        # Key off (delayed): TAUD_NOTE_EFFECTS.md "S $Dxny" compat note —
        # FastTracker Kxx maps to S $D00xx (x=0 no delay-to-trigger, n=0 note
        # off, y=xx ticks after row start). The row keeps its own empty note
        # column — the engine's $n follow-up action applies to whichever note
        # is already sounding on the channel (see row.js's note===0 branch).
        # K00 (arg=0) has no follow-up window at all (y=0 disables the S$D
        # action per the "$y is zero" case), so it forces an immediate
        # key-off note instead, same as before.
        if arg == 0:
            return (TOP_NONE, 0, None, None)   # caller forces note=NOTE_KEYOFF
        y = min(arg, 0xF)
        if arg > 0xF:
            vprint(f"    K{arg:02X} clamped to y={y:X} (S $D range) at ch{ch} row{row}")
        return (TOP_S, 0xD000 | y, None, None)

    if cmd == 0x15:
        vprint(f"    dropped L{arg:02X} (set envelope position) at ch{ch} row{row}")
        return (TOP_NONE, 0, None, None)

    if cmd == 0x19:
        # Pan slide → TOP_S not appropriate; use pan-column slide via
        # d_arg_to_col interpreted as pan.
        return (TOP_NONE, 0, None, d_arg_to_col(arg))

    if cmd == 0x1B:
        # Multi retrig with volume change → TOP_Q.
        return (TOP_Q, (arg & 0xFF) << 8, None, None)

    if cmd == 0x1D:
        # Tremor → TOP_I.
        return (TOP_I, (arg & 0xFF) << 8, None, None)

    if cmd == 0x21:
        # Extra-fine porta X1x / X2x.
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        if sub == 1:
            if amiga_mode:
                return (TOP_F, 0xE000 | (val & 0xFFF), None, None)
            return (TOP_F, 0xE000 | (round(val * 4 / 3) & 0xFFF), None, None)
        if sub == 2:
            if amiga_mode:
                return (TOP_E, 0xE000 | (val & 0xFFF), None, None)
            return (TOP_E, 0xE000 | (round(val * 4 / 3) & 0xFFF), None, None)
        return (TOP_NONE, 0, None, None)

    return (TOP_NONE, 0, None, None)


# ── Pattern splitting (XM-specific; mirrors it2taud's $02xx policy) ──────────

def split_patterns_xm(patterns: list):
    """Returns (chunks, chunk_map, chunk_lens) as in it2taud.split_patterns."""
    chunks     = []
    chunk_map  = []
    chunk_lens = []

    for pi, (grid, rows) in enumerate(patterns):
        if rows == 0:
            chunk_map.append([])
            continue
        n_chunks = (rows + PATTERN_ROWS - 1) // PATTERN_ROWS
        if n_chunks > 1:
            vprint(f"  pattern {pi}: {rows} rows → {n_chunks} chunks")
        pat_chunks = []
        for k in range(n_chunks):
            r0 = k * PATTERN_ROWS
            r1 = min(r0 + PATTERN_ROWS, rows)
            chunk_len = r1 - r0
            chunk_grid = []
            for ch in range(len(grid)):
                ch_rows = []
                src = grid[ch]
                for ri in range(PATTERN_ROWS):
                    sr = r0 + ri
                    if sr < r1 and sr < len(src):
                        ch_rows.append(src[sr])
                    else:
                        ch_rows.append(XMRow())
                chunk_grid.append(ch_rows)
            idx = len(chunks)
            chunks.append(chunk_grid)
            chunk_lens.append(chunk_len)
            pat_chunks.append(idx)
        chunk_map.append(pat_chunks)
    return chunks, chunk_map, chunk_lens


def remap_b_effects_xm(chunks: list, chunk_map: list,
                       order_list: list, xm_ord_to_taud_cue: dict,
                       num_channels: int,
                       *, default_target: int = None,
                       warn_label: str = '',
                       chunk_indices=None) -> None:
    """Rewrite XM B (position jump) effects so the argument indexes Taud cues
    rather than XM order positions. (Pattern break Dxx already targets a row,
    no remap needed — the post-break behaviour is "advance to next order",
    which Taud emulates correctly when the cue ends.)

    `default_target`: when a Bxx target isn't in `xm_ord_to_taud_cue` (a
    cross-subsong jump), rewrite to this cue index instead of preserving
    the literal target. Use 0 to make cross-song jumps loop the subsong.

    `chunk_indices`: optional iterable; when provided, only these chunks are
    visited. Used by multi-song to skip unreferenced chunks (avoids spurious
    cross-song warnings on chunks not emitted in this song).
    """
    crossings = 0
    iter_indices = (chunk_indices if chunk_indices is not None
                    else range(len(chunks)))
    for ci in iter_indices:
        chunk_grid = chunks[ci]
        for ch in range(min(num_channels, len(chunk_grid))):
            for row in chunk_grid[ch]:
                if row.effect == 0x0B:
                    xm_ord = row.effect_arg & 0xFF
                    if xm_ord in xm_ord_to_taud_cue:
                        row.effect_arg = xm_ord_to_taud_cue[xm_ord] & 0xFF
                    elif default_target is not None:
                        crossings += 1
                        row.effect_arg = default_target & 0xFF
                    else:
                        row.effect_arg = xm_ord & 0xFF
    if crossings and warn_label:
        vprint(f"  warning: {warn_label}: {crossings} Bxx target(s) cross "
               f"subsong boundary; clamped to cue {default_target}")


def compute_keyoff_zero_marks_xm(taud_cue_list: list, chunks: list,
                                 num_xm_channels: int, instruments: list,
                                 active_channels: list) -> dict:
    """Identify key-off cells whose bound XM instrument has the volume envelope
    DISABLED. FT2's keyOff() (ft2_replayer.c:411-435) zeroes realVol/outVol on
    such key-offs; IT/Schism does not, and the Taud engine follows IT semantics.
    To preserve XM gating without diverging engine behaviour, the converter pairs
    each flagged key-off with `SEL_SET vol=0` in the same row's volume column —
    a later vol-col SET on the channel restores audibility, exactly mirroring
    the FT2 outVol/realVol path.

    Walks taud_cue_list in playback order so per-channel instrument bindings
    carry across cues. When the same chunk is visited under conflicting
    bindings, the union of all flags is kept (conservatively prefers gating).

    Returns: dict mapping chunk_idx → set of (active_voice_idx, row_idx) tuples.
    The voice_idx matches build_pattern_xm's `ch_idx` (the index into
    `active_channels`).
    """
    xm_to_vi = {ch: vi for vi, ch in enumerate(active_channels)}
    marks = {}
    bound = [0] * num_xm_channels   # 1-based XM instrument id; 0 = none

    for ci in taud_cue_list:
        cg = chunks[ci]
        chunk_marks = marks.setdefault(ci, set())
        max_ch = min(num_xm_channels, len(cg))
        max_rows = max((len(cg[ch]) for ch in range(max_ch)), default=0)
        for r in range(max_rows):
            for xm_ch in range(max_ch):
                if r >= len(cg[xm_ch]):
                    continue
                cell = cg[xm_ch][r]
                # FT2 keyOff() reads ch->instrPtr — the latest binding wins, even
                # when the inst byte is on the same row as the key-off.
                if cell.inst > 0:
                    bound[xm_ch] = cell.inst
                is_keyoff = (cell.note == XM_NOTE_OFF) or (cell.effect == 0x14)
                if not is_keyoff:
                    continue
                ii = bound[xm_ch]
                if ii == 0 or ii - 1 >= len(instruments):
                    continue
                inst = instruments[ii - 1]
                if inst.vol_env_type & XM_ENV_ON:
                    continue
                vi = xm_to_vi.get(xm_ch)
                if vi is not None:
                    chunk_marks.add((vi, r))
    return marks


# ── Sample / instrument bin ───────────────────────────────────────────────────

class _XMSampleProxy:
    """Adapter object passed to the inst-bin builder. One per
    (xm_instrument, sample-in-instrument) pair. Envelopes / fadeout /
    NNA / vibrato are filled from the parent XM instrument."""
    __slots__ = ('name', 'length', 'loop_begin', 'loop_end', 'volume',
                 'finetune', 'rel_note', 'panning', 'pingpong',
                 'sample_data', 'c2spd', 'flags',
                 'fadeout', 'vib_speed', 'vib_depth', 'vib_sweep', 'vib_wave',
                 'vol_env_pts', 'vol_env_loop_word', 'vol_env_sus_word',
                 'pan_env_pts', 'pan_env_loop_word', 'pan_env_sus_word',
                 'has_pan_env', 'nna')


def _xm_envelope_to_taud(env_pts: list, num_pts: int, env_type: int,
                         sustain: int, loop_start: int, loop_end: int,
                         kind: str, ticks_per_sec: float) -> tuple:
    """Translate one XM envelope (frame, value) list → 25 (val, mf) Taud
    points + LOOP word + SUSTAIN word.

    Returns (points, loop_word, sus_word).

    XM envelope value ranges:
      'vol' — 0..64  → Taud 0..63
      'pan' — 0..64  → Taud 0..255 (32 = centre → 0x80)

    XM single-point sustain becomes the SUSTAIN word with start == end.
    XM envelope loop becomes the LOOP word. The two are independent in XM
    and remain independent in Taud (matches FT2 + IT semantics described
    in terranmon.txt:2049+). Returns (None, 0, 0) when the envelope is
    disabled (XM_ENV_ON not set).
    """
    if not (env_type & XM_ENV_ON) or num_pts < 1:
        return None, 0, 0
    nodes = env_pts[:max(1, min(num_pts, 12))]

    has_sus  = bool(env_type & XM_ENV_SUSTAIN) and 0 <= sustain < len(nodes)
    has_loop = (bool(env_type & XM_ENV_LOOP)
                and 0 <= loop_start < len(nodes)
                and loop_start <= loop_end < len(nodes))

    def _to_taud_val(xm_val: int) -> int:
        v = max(0, min(64, xm_val))
        if kind == 'vol':
            return min(63, round(v * 63 / 64))
        return min(255, max(0, round(v * 255 / 64)))

    pad_value = (63 if kind == 'vol' else 0x80)

    points = []
    for k in range(25):
        if k < len(nodes):
            frame, val = nodes[k]
            taud_val = _to_taud_val(val)
            if k < len(nodes) - 1:
                next_frame, _ = nodes[k + 1]
                delta_sec = max(0.0, (next_frame - frame) / ticks_per_sec)
                mf_idx    = nearest_minifloat(delta_sec)
            else:
                mf_idx = 0
        else:
            taud_val = points[-1][0] if points else pad_value
            mf_idx   = 0
        points.append((taud_val, mf_idx))

    # LOOP word (offsets 15/17/19): b=enable, bits 12..8=start, 4..0=end.
    # SUSTAIN word (offsets 189/191/193): same bit layout; FT2 single-point
    # sustain is encoded with start == end (engine wraps that index → itself).
    # P (bit 13) marks the envelope as present in source — this branch is only
    # reached when XM_ENV_ON is set, so P is unconditionally 1 here. P gates
    # whether the engine evaluates pan envelope at all (terranmon.txt byte
    # 16/18/20 bit 5); for vol it is informational.
    loop_word = 0x2020   # P (bit 13) | b (bit 5)
    if has_loop:
        loop_word |= (loop_start & 0x1F) << 8
        loop_word |= (loop_end   & 0x1F)
    else:
        # Disable LOOP wrap — leave start/end zero so the engine treats it as
        # "no loop". The b bit still keeps the envelope active.
        pass

    sus_word = 0
    if has_sus:
        sus_word |= 0x0020             # b: enable SUSTAIN
        sus_word |= (sustain & 0x1F) << 8
        sus_word |= (sustain & 0x1F)   # FT2 single-point: start == end

    return points, loop_word, sus_word


def _xm_sample_to_proxy(inst: XMInstrument, samp: XMSample,
                        ticks_per_sec: float) -> _XMSampleProxy:
    p = _XMSampleProxy()
    p.name        = samp.name
    p.length      = samp.length
    p.loop_begin  = samp.loop_start
    p.loop_end    = samp.loop_start + samp.loop_length
    p.volume      = min(samp.volume, 64)   # XM 0..64
    p.finetune    = samp.finetune          # signed -128..+127
    p.rel_note    = samp.rel_note          # signed semitones
    p.panning     = samp.panning           # 0..255
    p.pingpong    = samp.pingpong
    p.sample_data = samp.sample_data
    # c2spd: XM uses a per-sample finetune (1/128 semitone units) plus a
    # rel_note offset. We bake both into c2spd so the engine plays the
    # XM "C-4 row" at the correct audible pitch when the Taud note is
    # also C-4.
    semis = samp.rel_note + samp.finetune / 128.0
    p.c2spd       = max(1, round(8363.0 * (2.0 ** (semis / 12.0))))
    loop_type     = samp.flags & XM_SMP_LOOP_MASK
    p.flags       = 1 if loop_type != 0 else 0   # 1=loop on, 0=off
    # Fadeout: XM file value (16-bit, spec range 0..0xFFF; MilkyTracker writes up to 32767
    # to encode the "cut" UI slider position — SectionInstruments.cpp:499-500). FT2's per-tick
    # decrement is stored / 32768 of unit volume; Taud's engine uses stored / 1024. Divide
    # source by 32 (round-to-nearest) to match the per-tick rate. XM stored 1..15 round to
    # Taud 0 — those originals were >11 min at 50 Hz, effectively no-fade. Stored 32 → Taud 1
    # (~20 s). Stored 32767 (Milky cut sentinel) → Taud 1024 (1-tick cut). See terranmon.txt
    # byte 172/173 and TAUD_NOTE_EFFECTS.md §1 "Volume Fadeout".
    p.fadeout     = min(0xFFF, (int(inst.fadeout & 0xFFFF) + 16) // 32)
    # Auto-vibrato. XM's rate (0..63) is the LFO speed and its depth (0..15)
    # measures the same as IT's Vid unit for unit — openmpt123 renders XM
    # depth 15 and IT Vid 15 at the same ±25 cents — so both fields take the
    # same ×4 into Taud's 0..255 bytes that it2taud gives Vis / Vid. XM has no
    # IT-style ramp acceleration: byte 188 stays 0 and the ramp-in comes from
    # the FT2 sweep (byte 176) alone.
    p.vib_speed   = min(255, (inst.vib_rate & 0xFF) * 4)
    p.vib_depth   = min(255, (inst.vib_depth & 0xFF) * 4)
    p.vib_sweep   = inst.vib_sweep & 0xFF
    p.vib_wave    = inst.vib_type & 0x07

    # Envelopes (volume + panning).
    p.vol_env_pts, p.vol_env_loop_word, p.vol_env_sus_word = _xm_envelope_to_taud(
        inst.vol_env_pts, inst.vol_env_count, inst.vol_env_type,
        inst.vol_sustain, inst.vol_loop_start, inst.vol_loop_end,
        kind='vol', ticks_per_sec=ticks_per_sec)
    p.pan_env_pts, p.pan_env_loop_word, p.pan_env_sus_word = _xm_envelope_to_taud(
        inst.pan_env_pts, inst.pan_env_count, inst.pan_env_type,
        inst.pan_sustain, inst.pan_loop_start, inst.pan_loop_end,
        kind='pan', ticks_per_sec=ticks_per_sec)
    p.has_pan_env = p.pan_env_pts is not None

    # XM has no NNA: every new note unconditionally retriggers the
    # channel, completely replacing whatever was playing. Use Taud
    # NNA=1 (cut) to suppress the engine's NNA-ghosting path entirely,
    # otherwise the previous voice keeps running in the background pool
    # while the new note plays — IT semantics, not FT2.
    p.nna = 1
    return p


def build_sample_inst_bin_xm(proxies: list) -> tuple:
    """proxies: list (1-indexed; slot 0 unused) of _XMSampleProxy | None.

    Returns (sampleinst_bin, offsets_dict, slot_ratios) where slot_ratios
    maps Taud slot index → effective TOP_O scale (combined global ×
    per-sample resample ratio).
    """
    pcm_list = [(i, s) for i, s in enumerate(proxies)
                if s is not None and s.sample_data]

    def _scale_sample(s, r):
        """Resample `s` by about `r` — exactly the ratio that keeps its loop a
        whole number of frames (taud_common.loop_resample_ratio) — and return
        the ratio actually used, which the rate and TOP_O offsets follow."""
        r = loop_resample_ratio(r, [(s.loop_begin, s.loop_end)] if (s.flags & 1) else [])
        s.sample_data = resample_linear(s.sample_data, r)
        s.length      = len(s.sample_data)
        s.loop_begin, s.loop_end = scale_loop(s.loop_begin, s.loop_end, r, s.length)
        s.c2spd       = max(1, round(s.c2spd * r))
        return r

    # ── Pass 1: global pool-overflow resample (8 MB cap) ────────────────────
    total = sum(len(s.sample_data) for _, s in pcm_list)
    global_ratio = 1.0
    global_eff = {}           # id(s) → the ratio pass 1 actually applied to s
    if total > SAMPLEBIN_SIZE:
        global_ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); "
               f"resampling all by {global_ratio:.4f}")
        for _, s in pcm_list:
            if id(s) in global_eff:
                continue
            global_eff[id(s)] = _scale_sample(s, global_ratio)

    # ── Pass 2: per-sample u16 cap (each sample must fit in 65535 bytes) ────
    # The Taud instrument record stores the sample length as u16, and TOP_O
    # offsets address up to 0xFF00 bytes — anything longer would silently
    # truncate at load time and over-shoot O-jumps. Resample only the
    # over-long samples and remember each one's individual ratio so the
    # caller can rescale TOP_O args per channel rather than globally.
    per_sample_ratio = {}     # id(s) → per-sample ratio (after global)
    seen_p = set()
    for _, s in pcm_list:
        if id(s) in seen_p:
            continue
        seen_p.add(id(s))
        if len(s.sample_data) > SAMPLE_LEN_LIMIT:
            r = SAMPLE_LEN_LIMIT / len(s.sample_data)
            vprint(f"  info: '{s.name}' exceeds {SAMPLE_LEN_LIMIT}-byte cap "
                   f"({len(s.sample_data)}); resampling by {r:.4f}")
            per_sample_ratio[id(s)] = _scale_sample(s, r)

    # Effective slot → ratio for TOP_O rescaling. XM keymaps can route
    # several Taud slots to the same _XMSampleProxy (one slot per XM
    # sample-in-instrument), so they share the same per-sample ratio.
    slot_ratios = {}
    for slot_idx, s in pcm_list:
        slot_ratios[slot_idx] = global_eff.get(id(s), 1.0) * per_sample_ratio.get(id(s), 1.0)
    ratio = slot_ratios

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets = {}
    pos = 0
    for idx, s in pcm_list:
        n = min(len(s.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{s.name}'")
            offsets[idx] = 0
            s.length = 0
            continue
        sample_bin[pos:pos + n] = s.sample_data[:n]
        offsets[idx] = pos
        if n < len(s.sample_data):
            vprint(f"  warning: '{s.name}' truncated {len(s.sample_data)} → {n}")
            s.length = n
            s.loop_end = min(s.loop_end, n)
        pos += n

    USE_ENV_BIT     = 0x0020   # b: engine should evaluate the envelope (LOOP wrap enable)
    ENV_PRESENT_BIT = 0x2000   # P: envelope present in source (terranmon.txt byte 16/18/20 bit 5)
    INST_STRIDE = 256

    def _write_env(buf: bytearray, base: int, env_pts, pad_value: int) -> None:
        """Write 25 (value, minifloat) pairs. Pads with the previous value
        (or pad_value) and offset=0 if shorter than 25."""
        for k in range(25):
            if env_pts and k < len(env_pts):
                val, mf = env_pts[k]
            else:
                val = (env_pts[-1][0] if env_pts else pad_value)
                mf  = 0
            buf[base + k * 2]     = val & 0xFF
            buf[base + k * 2 + 1] = mf  & 0xFF

    inst_bin = bytearray(INSTBIN_SIZE)
    for i, s in enumerate(proxies):
        if i == 0 or i >= 256 or s is None or not s.sample_data:
            continue
        ptr   = offsets.get(i, 0) & 0xFFFFFFFF
        s_len = min(s.length, 65535)
        c2spd = min(s.c2spd, 65535)
        ls    = min(s.loop_begin, 65535)
        le    = min(s.loop_end,   65535)
        loop_mode = 0
        if s.flags & 1:
            loop_mode = 2 if s.pingpong else 1
        flags_byte = loop_mode & 0x3

        # Resolve envelope LOOP / SUSTAIN words from the proxy. When XM has no
        # envelope, fall back to a single-point unit envelope (vol LOOP word
        # b=1 plus P=1 for consistency) and rely on DNV (byte 196) for the
        # per-trigger initial level. Pan stays zero so the engine sees P=0
        # there and skips envelope-driven pan.
        if s.vol_env_pts is not None:
            vol_env_loop = s.vol_env_loop_word
            vol_env_sus  = s.vol_env_sus_word
            vol_env      = s.vol_env_pts
        else:
            vol_env_loop = USE_ENV_BIT | ENV_PRESENT_BIT
            vol_env_sus  = 0
            vol_env      = None
        if s.pan_env_pts is not None:
            pan_env_loop = s.pan_env_loop_word
            pan_env_sus  = s.pan_env_sus_word
            pan_env      = s.pan_env_pts
        else:
            pan_env_loop = 0
            pan_env_sus  = 0
            pan_env      = None

        base = i * INST_STRIDE
        struct.pack_into('<I', inst_bin, base + 0,  ptr)
        struct.pack_into('<H', inst_bin, base + 4,  s_len)
        struct.pack_into('<H', inst_bin, base + 6,  c2spd)
        struct.pack_into('<H', inst_bin, base + 8,  0)         # play start
        struct.pack_into('<H', inst_bin, base + 10, ls)
        struct.pack_into('<H', inst_bin, base + 12, le)
        inst_bin[base + 14] = flags_byte
        # LOOP words at 15/17/19.
        struct.pack_into('<H', inst_bin, base + 15, vol_env_loop & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 17, pan_env_loop & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 19, 0)         # pf envelope: off

        if vol_env:
            _write_env(inst_bin, base + 21, vol_env, pad_value=63)
        else:
            inst_bin[base + 21] = 63
            inst_bin[base + 22] = 0

        if pan_env:
            _write_env(inst_bin, base + 71, pan_env, pad_value=0x80)
        else:
            for k in range(25):
                inst_bin[base + 71 + k * 2]     = 0x80
                inst_bin[base + 71 + k * 2 + 1] = 0x00

        # pf envelope (pitch/filter): unused — keep at unity centre.
        for k in range(25):
            inst_bin[base + 121 + k * 2]     = 0x80
            inst_bin[base + 121 + k * 2 + 1] = 0x00

        # XM has no continuous instrumentwise volume scaler — `s.volume` (0..64)
        # is purely the per-trigger initial value (FT2 ft2_replayer.c handles
        # this exactly the same as IT does with sample.vol). So byte 171 (IGV)
        # stays at full unity and byte 196 (DNV) carries the per-instrument
        # default. Pre-2026-05-09 layout folded s.volume into IGV — see
        # terranmon §2350.
        inst_bin[base + 171] = 0xFF                                                  # IGV: continuous unity
        inst_bin[base + 196] = min(0xFF, round(s.volume * 255 / 64))                 # DNV
        # Fadeout: 12-bit. Low 8 bits at +172, high 4 bits at +173.
        inst_bin[base + 172] = s.fadeout & 0xFF
        inst_bin[base + 173] = (s.fadeout >> 8) & 0x0F
        # Default pan (XM sample panning 0..255 → Taud direct 0..255)
        inst_bin[base + 177] = s.panning & 0xFF
        # Filter cutoff/resonance: XM has no filters → off.
        inst_bin[base + 182] = 0xFF
        inst_bin[base + 183] = 0xFF
        # Auto-vibrato (XM instrument-level; already scaled ×4 at parse time).
        # Byte 188 is IT's ramp ACCELERATION and XM has no such field — writing
        # the speed there turned FT2's "sweep 0 = full depth at once" into a
        # ramp thousands of ticks long.
        inst_bin[base + 175] = s.vib_speed & 0xFF
        inst_bin[base + 176] = s.vib_sweep & 0xFF
        inst_bin[base + 187] = s.vib_depth & 0xFF
        inst_bin[base + 188] = 0
        # Inst flag byte: 0bb wwwnn — wwww=vib waveform, nn=NNA
        inst_bin[base + 186] = ((s.vib_wave & 0x07) << 2) | (s.nna & 0x03)
        # SUSTAIN words at 189/191/193.
        struct.pack_into('<H', inst_bin, base + 189, vol_env_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 191, pan_env_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 193, 0)        # pf sustain: off
        # Byte 195 (DCT/DCA) — XM has no NNA / duplicate-check, leave 0.

        env_tag = ''
        if vol_env: env_tag += 'V'
        if pan_env: env_tag += 'P'
        vprint(f"  instrument[{i}] '{s.name}' ptr={ptr} c2spd={s.c2spd} "
               f"vol={s.volume} loop=({ls},{le},{'on' if loop_mode else 'off'}) "
               f"fade={s.fadeout} nna={s.nna} env=[{env_tag or '-'}]")

    return bytes(sample_bin) + bytes(inst_bin), offsets, ratio


# ── Pattern bin builder ───────────────────────────────────────────────────────

def build_pattern_xm(chunk_grid: list, ch_idx: int, default_pan: int,
                     inst_to_taud_slot: dict, amiga_mode: bool = False,
                     keyoff_zero_rows: set = None) -> bytes:
    """Render one Taud channel's 512-byte pattern from a 64-row chunk grid.

    `keyoff_zero_rows`: optional set of row indices on this channel whose key-off
    cells should be paired with `SEL_SET vol=0` (FT2 vol-env-off gating — see
    compute_keyoff_zero_marks_xm).
    """
    if keyoff_zero_rows is None:
        keyoff_zero_rows = frozenset()
    out = bytearray(PATTERN_BYTES)
    if ch_idx >= len(chunk_grid):
        rows = [XMRow()] * PATTERN_ROWS
    else:
        rows = chunk_grid[ch_idx]

    for r, cell in enumerate(rows[:PATTERN_ROWS]):
        # ── Volume column → vol/pan/aux-effect overrides ────────────────────
        vs, vv, pan_from_vc, aux_eff = decode_volcol_xm(cell.volcol)
        # Pan slide via vol-col D/E (encoded as pan_override below)
        vc_pan_override = _xm_volcol_pan_override(cell.volcol)

        # ── Slot juggling for combined effects ──────────────────────────────
        # XM main 0x0A (vol slide → TOP_D) + vol-col Mx (porta → TOP_G aux)
        # combine cleanly into Taud L (porta + vol slide). Same for
        # vol-col Bx/Ax (vibrato → TOP_H aux) → Taud K (vibrato + vol slide).
        # Without this swap the vol-col aux would be dropped because the main
        # slot is already occupied by D. The combined K/L take their slide
        # nibbles directly from the source D arg (high byte of XM 0x0A),
        # matching the encoding used by main XM effects 5 (→ L) and 6 (→ K).
        if (aux_eff is not None and cell.effect == 0x0A
                and cell.effect_arg != 0):
            aux_op, aux_arg = aux_eff
            d_arg = cell.effect_arg & 0xFF
            if aux_op == TOP_G:
                # XM A + vol-col M → Taud L verbatim. Porta speed already
                # lives in Taud's private G memory (vol-col aux → G $00xx).
                cell.effect, cell.effect_arg = 0x05, d_arg
                aux_eff = None
            elif aux_op == TOP_H:
                # XM A + vol-col B (vibrato depth) → Taud K. K reuses
                # memory_HU; the vol-col Bx depth update is lost.
                cell.effect, cell.effect_arg = 0x06, d_arg
                aux_eff = None
                if (aux_arg & 0xFF) != 0:
                    vprint(f"    ch{ch_idx} row{r}: A+Bx→K, depth update "
                           f"{aux_arg & 0xFF:02X} folded into K vibrato recall")

        # ── Main effect translation ─────────────────────────────────────────
        op, arg16, vol_override, pan_override = encode_effect_xm(
            cell.effect, cell.effect_arg, ch_idx, r, amiga_mode=amiga_mode)

        # XM K00 (0x14, arg==0) = immediate key off — force note to
        # NOTE_KEYOFF. Kxx with arg>0 is deferred via the S $D00xx effect
        # encode_effect_xm already returned; leave the note column alone so
        # that path (not this immediate one) does the work.
        if cell.effect == 0x14 and cell.effect_arg == 0:
            cell.note = XM_NOTE_OFF

        # Fold vol-col aux into main slot if free
        if aux_eff is not None:
            if op == TOP_NONE:
                op, arg16 = aux_eff
                aux_eff = None
            else:
                vprint(f"    ch{ch_idx} row{r}: dropped vol-col aux effect "
                       f"(main effect slot occupied: cmd={cell.effect:02X} arg={cell.effect_arg:02X})")

        # ── Note ────────────────────────────────────────────────────────────
        note_taud = NOTE_NOP
        if cell.note > 0:
            note_taud = encode_note_xm(cell.note)

        # XM cell.inst==0 means "no instrument change" — preserve verbatim
        # so the engine retriggers whatever sample slot is currently loaded.
        # When cell.inst > 0, look up the Taud slot via the keymap (using
        # the row's own note if present, else the first sample of the
        # instrument).
        if cell.inst > 0:
            note_for_lookup = cell.note if cell.note > 0 else None
            taud_slot = inst_to_taud_slot(cell.inst, note_for_lookup) or 0
        else:
            taud_slot = 0

        note_triggers = (1 <= cell.note <= 96)

        # ── Volume column resolution ────────────────────────────────────────
        if vs != SEL_FINE or vv != 0:
            vol_sel, vol_value = vs, vv
        elif vol_override is not None:
            vol_sel, vol_value = vol_override
        else:
            vol_sel, vol_value = SEL_FINE, 0

        # ── Pan column resolution ───────────────────────────────────────────
        if pan_from_vc is not None:
            pan_sel, pan_value = SEL_SET, pan_from_vc
        elif vc_pan_override is not None:
            pan_sel, pan_value = vc_pan_override
        elif pan_override is not None:
            pan_sel, pan_value = pan_override
        elif r == 0:
            pan_sel, pan_value = SEL_SET, default_pan & 0x3F
        else:
            pan_sel, pan_value = SEL_FINE, 0

        # FT2 vol-env-off key-off gating: pair the key-off with SEL_SET vol=0
        # so a later vol-col SET on the channel restores audibility (see
        # compute_keyoff_zero_marks_xm). Override any vol-col content the row
        # already has — FT2 zeros realVol/outVol after vol-col is applied
        # (ft2_replayer.c:411-428), so a SET on the same row would be clobbered.
        if r in keyoff_zero_rows and note_taud == NOTE_KEYOFF:
            if not (vol_sel == SEL_FINE and vol_value == 0):
                vprint(f"    ch{ch_idx} row{r}: FT2 key-off zero overrides "
                       f"vol-col (sel={vol_sel}, val={vol_value})")
            vol_sel, vol_value = SEL_SET, 0
        elif r in keyoff_zero_rows and cell.effect == 0x14:
            # Delayed Kxx (arg>0) on a vol-env-off instrument: the row-start
            # zero pairing above can't apply without also zeroing the delay
            # away, so this narrow FT2 quirk (silence right after key-off
            # with no volume envelope) isn't replicated for the deferred
            # case — only the S $D00xx note-off itself fires, at the right
            # tick, without the extra hard mute.
            vprint(f"    ch{ch_idx} row{r}: delayed K{cell.effect_arg:02X} on "
                   f"vol-env-off instrument — FT2 zero-on-keyoff quirk not "
                   f"replicated for the deferred case")

        vol_byte = (vol_value & 0x3F) | ((vol_sel & 0x3) << 6)
        pan_byte = (pan_value & 0x3F) | ((pan_sel & 0x3) << 6)

        base = r * 8
        struct.pack_into('<H', out, base + 0, note_taud)
        out[base + 2] = taud_slot & 0xFF
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg16 & 0xFFFF)

    return bytes(out)


# ── Channel selection ─────────────────────────────────────────────────────────

def _active_channels_xm(h: XMHeader, patterns: list) -> list:
    in_use = set()
    for grid, _rows in patterns:
        for ch in range(len(grid)):
            for cell in grid[ch]:
                if cell.note != 0 or cell.inst != 0 or cell.effect != 0 or cell.volcol != 0:
                    in_use.add(ch)
                    break
    active = sorted(in_use)
    if len(active) > NUM_VOICES:
        vprint(f"  warning: {len(active)} active channels; capping at {NUM_VOICES}")
        active = active[:NUM_VOICES]
    return active


# ── Main assembly ─────────────────────────────────────────────────────────────

def _per_pattern_bxx_xm(patterns: list):
    """Return callable(pat_idx) → (set_of_bxx_target_orders, kills_fallthrough)
    for `detect_subsongs`. XM patterns vary in length; `kills_fallthrough` is
    True when a Bxx (effect 0x0B) appears on the absolute last row.
    `patterns[pi]` is `(grid, rows)`; `grid` is `[channel][row]`.
    """
    def fn(pat_idx: int):
        if pat_idx < 0 or pat_idx >= len(patterns):
            return set(), False
        grid, rows = patterns[pat_idx]
        targets = set()
        last_row_has_b = False
        for ch_rows in grid:
            n = min(rows, len(ch_rows))
            for r in range(n):
                cell = ch_rows[r]
                if cell.effect == 0x0B:
                    targets.add(cell.effect_arg & 0xFF)
                    if r == rows - 1:
                        last_row_has_b = True
        return targets, last_row_has_b
    return fn


def _build_song_payload_xm(h: XMHeader, patterns_template: list,
                           instruments: list, positions: list,
                           sample_ratio: dict, active_channels: list,
                           default_pans: list, resolve_inst_slot,
                           *, song_label: str = 'song') -> tuple:
    """Build pattern bin + cue sheet + (subset of) song-entry kwargs for
    one subsong. The caller fills in song_offset, flags_byte, and shared
    globals.

    Patterns aren't mutated by per-order walks in XM (no recall resolution),
    but `remap_b_effects_xm` mutates chunk grids — so we deep-copy chunks
    per song. (`compute_keyoff_zero_marks_xm` only reads.)
    """
    chunks, chunk_map, chunk_lens = split_patterns_xm(patterns_template)

    C = len(active_channels)

    cue_list = []
    pos_to_cue = {}
    for pos in positions:
        order = h.order_list[pos]
        if order >= h.pattern_count or order >= len(chunk_map):
            continue
        pos_to_cue[pos] = len(cue_list)
        for ci in chunk_map[order]:
            cue_list.append(ci)

    if not cue_list:
        # Degenerate subsong (e.g. all orders point to invalid patterns).
        vprint(f"  warning: [{song_label}] no playable cues; emitting halt-only song")

    remap_b_effects_xm(chunks, chunk_map, h.order_list, pos_to_cue, C,
                       default_target=0, warn_label=song_label,
                       chunk_indices=set(cue_list))

    keyoff_zero_marks = compute_keyoff_zero_marks_xm(
        cue_list, chunks, h.channels, instruments, active_channels)
    if any(keyoff_zero_marks.values()):
        flagged = sum(len(s) for s in keyoff_zero_marks.values())
        vprint(f"  [{song_label}] FT2 keyoff-gate: {flagged} key-off cell(s) "
               f"paired with vol=0 (vol-env-off instruments)")

    total_taud_pats = len(cue_list) * C
    if total_taud_pats > NUM_PATTERNS_MAX:
        sys.exit(f"error: [{song_label}] {len(cue_list)} cues × {C} channels = "
                 f"{total_taud_pats} > {NUM_PATTERNS_MAX} Taud pattern limit.")

    pat_bin = bytearray()
    for ci in cue_list:
        cg = chunks[ci]
        chunk_marks = keyoff_zero_marks.get(ci, frozenset())
        for vi, ch in enumerate(active_channels):
            row_marks = {r for (mvi, r) in chunk_marks if mvi == vi}
            pat_bin += build_pattern_xm(cg, ch, default_pans[vi],
                                        resolve_inst_slot,
                                        amiga_mode=not h.linear_freq,
                                        keyoff_zero_rows=row_marks)
    pat_bin = rescale_offset_effects_per_slot(
        bytes(pat_bin), len(cue_list), C, sample_ratio)

    orig_count = len(cue_list) * C
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(pat_bin, orig_count)
    vprint(f"  [{song_label}] patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c * CUE_SIZE:c * CUE_SIZE + CUE_SIZE] = encode_cue([], 0)

    n_emit = min(len(cue_list), NUM_CUES)
    len_cue_count = 0
    for cue_idx in range(n_emit):
        ci = cue_list[cue_idx]
        base_pat = cue_idx * C
        pats = [pat_remap[base_pat + vi] for vi in range(C)]
        clen = chunk_lens[ci] if ci < len(chunk_lens) else PATTERN_ROWS
        if cue_idx == n_emit - 1:
            # Final cue: play its own length then HALT. "Halt at x" preserves the
            # partial length (a short terminal pattern halts at `clen` instead of
            # running the full 64-row padding); a full-length cue emits a plain HALT.
            instr = cue_instruction_halt_at(clen)
        elif clen < PATTERN_ROWS:
            instr = cue_instruction_len(clen)
            len_cue_count += 1
        else:
            instr = CUE_INST_NOP
        sheet[cue_idx * CUE_SIZE:(cue_idx + 1) * CUE_SIZE] = encode_cue(pats, instr)

    if n_emit == 0:
        set_cue_instruction(sheet, 0, CUE_INST_HALT)
    if len_cue_count:
        vprint(f"  [{song_label}] emitted {len_cue_count} LEN cue instruction(s) "
               f"for partial-length patterns")

    cue_bytes, num_cues = finalize_cue_sheet(sheet)
    pat_comp = compress_blob(bytes(pat_bin), f"[{song_label}] pattern bin")
    cue_comp = compress_blob(cue_bytes,      f"[{song_label}] cue sheet")

    # Speed/tempo are file-wide for XM; pass them through the kwargs so the
    # outer function fills in shared header fields uniformly.
    speed = h.default_speed if h.default_speed > 0 else 6
    tempo = h.default_bpm  if h.default_bpm  > 0 else 125
    tempo = max(25, min(280, tempo))
    bpm_stored = (tempo - 25) & 0xFF

    entry_kwargs = dict(
        num_voices=C,
        num_patterns=num_taud_pats,
        bpm_stored=bpm_stored,
        tick_rate=speed,
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        num_cues=num_cues,
    )
    return pat_comp, cue_comp, entry_kwargs


def assemble_taud(h: XMHeader, patterns: list, instruments: list,
                  with_project_data: bool = True) -> bytes:
    # XM envelope frames advance once per row tick. Tick rate is derived
    # from BPM the same way ProTracker derives it: ticks_per_sec = BPM × 2/5
    # (matches MilkyTracker's tick clock and it2taud's ticks_per_sec).
    tempo_for_envs = max(25, min(280, h.default_bpm if h.default_bpm > 0 else 125))
    ticks_per_sec  = max(1.0, tempo_for_envs * 2.0 / 5.0)

    # ── Build XM-instrument → list of Taud slot proxies ─────────────────────
    # One Taud slot per (xm_inst, sample-in-inst). Slot 0 unused.
    proxies = [None]
    inst_to_slots = {}      # xm_inst (1-based) → list of taud slots, one per sample index
    for ii, inst in enumerate(instruments, start=1):
        if not inst.samples:
            inst_to_slots[ii] = []
            continue
        slots = []
        for samp in inst.samples:
            if not samp.sample_data:
                slots.append(0)
                continue
            taud_slot = len(proxies)
            if taud_slot >= 256:
                vprint(f"  warning: >255 sample slots; clipping at instrument {ii}")
                slots.append(0)
                continue
            proxies.append(_xm_sample_to_proxy(inst, samp, ticks_per_sec))
            slots.append(taud_slot)
        inst_to_slots[ii] = slots

    # Closure resolving (xm_inst, note) → taud slot via per-instrument keymap.
    def resolve_inst_slot(xm_inst: int, note: int):
        slots = inst_to_slots.get(xm_inst, [])
        if not slots:
            return None
        if note is None or note < 1 or note > 96:
            # No note context; fall back to first sample of the instrument.
            for s in slots:
                if s != 0:
                    return s
            return None
        inst = instruments[xm_inst - 1] if xm_inst - 1 < len(instruments) else None
        if inst is None:
            return slots[0] if slots[0] else None
        sample_idx = inst.keymap[(note - 1) % 96] if inst.keymap else 0
        if 0 <= sample_idx < len(slots) and slots[sample_idx]:
            return slots[sample_idx]
        return slots[0] if slots[0] else None

    # ── Sample / instrument bin ─────────────────────────────────────────────
    vprint(f"  building sample/inst bin… ({len(proxies) - 1} sample slots used)")
    sampleinst_raw, _, sample_ratio = build_sample_inst_bin_xm(proxies)
    compressed = compress_blob(sampleinst_raw, "sample+inst bin")
    comp_size  = len(compressed)

    # ── Tempo / speed ───────────────────────────────────────────────────────
    speed = h.default_speed if h.default_speed > 0 else 6
    tempo = h.default_bpm  if h.default_bpm  > 0 else 125
    tempo = max(25, min(280, tempo))
    bpm_stored = (tempo - 25) & 0xFF
    vprint(f"  initial speed={speed}, tempo={tempo} BPM")

    # ── Channels / pattern split (shared) ───────────────────────────────────
    active_channels = _active_channels_xm(h, patterns)
    C = len(active_channels)
    if C == 0:
        sys.exit("error: no active channels found")

    # Default pan per active channel: alternate L/R FT2-style (0,12,12,0,...).
    def _xm_default_pan(idx: int) -> int:
        side = idx % 4
        return 16 if side in (0, 3) else 47
    default_pans = [_xm_default_pan(i) for i in range(C)]

    # ── Detect subsongs ──────────────────────────────────────────────────────
    # XM has no terminator marker; `order_count` bounds the live order list.
    # Out-of-range pattern refs (≥ pattern_count) are skipped during playback,
    # so we feed the detector a slice of length `order_count` and treat
    # everything ≥ pattern_count as a skip.
    orders_view = list(h.order_list[:h.order_count])
    skip_set = set(range(h.pattern_count, 256))
    subsongs = detect_subsongs(orders_view, _per_pattern_bxx_xm(patterns),
                               terminators=(),
                               skip_marker=skip_set)
    if not subsongs:
        vprint("  warning: no traversable orders in source; emitting empty song")
        subsongs = [{'entry': 0, 'positions': []}]
    n_songs = len(subsongs)
    if n_songs == 1:
        vprint(f"  detected 1 song ({len(subsongs[0]['positions'])} orders)")
    else:
        vprint(f"  detected {n_songs} subsongs:")
        for i, ss in enumerate(subsongs):
            vprint(f"    song {i}: entry@{ss['entry']}, {len(ss['positions'])} orders")

    # ── Build per-song payloads ──────────────────────────────────────────────
    song_payloads = []
    for i, ss in enumerate(subsongs):
        label = f"song {i}" if n_songs > 1 else "song"
        song_payloads.append(_build_song_payload_xm(
            h, patterns, instruments, ss['positions'],
            sample_ratio, active_channels, default_pans,
            resolve_inst_slot,
            song_label=label))

    # ── Layout offsets and song table ────────────────────────────────────────
    song_table_off = TAUD_HEADER_SIZE + comp_size
    first_song_off = song_table_off + TAUD_SONG_ENTRY * n_songs

    flags_byte = (0x00 if h.linear_freq else 0x01)
    song_table = bytearray()
    cur_off = first_song_off
    for pat_comp, cue_comp, entry_kwargs in song_payloads:
        # Header BPM/speed go into per-song; flags is shared (XM doesn't switch
        # period mode mid-file).
        entry = encode_song_entry(song_offset=cur_off,
                                  flags_byte=flags_byte,
                                  global_vol=0xFF,
                                  mixing_vol=0x80,
                                  base_note=0xA000,
                                  base_freq=8363.0,
                                  **entry_kwargs)
        assert len(entry) == TAUD_SONG_ENTRY
        song_table += entry
        cur_off += len(pat_comp) + len(cue_comp)

    # Project Data (optional). XM nests samples under instruments and the
    # converter creates one Taud slot per (xm_inst, sample) pair, so SNam is
    # populated from the per-Taud-slot proxies and INam carries the parent
    # XM-level instrument names (1-based; slot 0 empty).
    proj_data = b''
    proj_off  = 0
    if with_project_data:
        inst_names = [''] + [(inst.name if inst is not None else '')
                             for inst in instruments[:255]]
        # SNam is pool-ordered and 0-based (proxies[0] is the reserved null
        # proxy, so the real pool starts at proxies[1] = SNam[0]).
        smp_names = [(p.name if p is not None else '')
                     for p in proxies[1:256]]
        proj_data = build_project_data(
            project_name=h.title,
            instrument_names=inst_names,
            sample_names=smp_names,
        )
        if proj_data:
            proj_off = cur_off
            vprint(f"  project data: {len(proj_data)} bytes @ offset {proj_off}")

    sig = (SIGNATURE + b' ' * 14)[:14]
    header = (
        TAUD_MAGIC +
        bytes([TAUD_VERSION, n_songs & 0xFF]) +
        struct.pack('<I', comp_size) +
        struct.pack('<I', proj_off) +
        sig
    )
    assert len(header) == TAUD_HEADER_SIZE

    out = bytearray()
    out += header
    out += compressed
    out += song_table
    for pat_comp, cue_comp, _ in song_payloads:
        out += pat_comp
        out += cue_comp
    out += proj_data
    return bytes(out)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .xm file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the optional Project Data section '
                         '(song / instrument / sample names)')
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    h = parse_xm_header(data)
    vprint(f"  title:    '{h.title}'")
    vprint(f"  tracker:  '{h.tracker}'  version=0x{h.version:04X}")
    vprint(f"  channels={h.channels} patterns={h.pattern_count} "
           f"insts={h.instrument_count} orders={h.order_count}")
    vprint(f"  freq table: {'linear' if h.linear_freq else 'Amiga'}")

    patterns_off = 60 + h.header_size
    patterns, after_patterns = parse_patterns(data, h, patterns_off)
    instruments, _after = parse_instruments(data, h, after_patterns)

    taud = assemble_taud(h, patterns, instruments,
                         with_project_data=not args.no_project_data)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)
        sig_off = TAUD_HEADER_SIZE - 14
        print(f"  signature: {taud[sig_off:sig_off + 14]}", file=sys.stderr)


if __name__ == '__main__':
    main()
