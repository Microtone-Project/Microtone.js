#!/usr/bin/env python3
"""it2taud.py — Convert ImpulseTracker (.it) to TSVM Taud (.taud)

Usage:
    python3 it2taud.py input.it output.taud [-v] [--no-decompress]

Limits:
    - Up to 20 IT channels (excess dropped; hard error if chunk count
      × channel count > 4095).
    - IT patterns with >64 rows are split into ⌈rows/64⌉ consecutive
      Taud patterns. Pattern-loop (SBx) crossing a chunk boundary is
      warned; B/C effects are remapped to new cue indices.
    - IT2.14/IT2.15 compressed samples are decoded unless --no-decompress.
    - IT instrument volume/pan/pitch-or-filter envelopes (up to 25 nodes,
      sustain & env loops) are converted directly to the new Taud 192-byte
      instrument format, NNA included. Each IT instrument resolves to
      its C-5 canonical sample; a sample-mode file (no "use instruments"
      flag) gets one instrument per sample, with NNA = cut.
    - Pitch and filter envelopes are emitted natively (engine-evaluated);
      auto-vibrato, fadeout, PPS/PPC, default pan, volume/pan swing, and
      initial filter cutoff/resonance are forwarded to the engine via
      the new instrument fields.
    - AdLib / OPL instruments are skipped.

Effect support:
    A-Z dispatch per TAUD_NOTE_EFFECTS.md. IT-specific: Cxx is binary
    (not BCD like ST3). V scales by ×2 (IT 0-128 → Taud 0-255). X is
    the full 8-bit IT pan. Y panbrello nibble-repeats. Z (MIDI macro)
    dropped. S6x fine-pattern-delay forwarded directly to Taud S$6x. SAx
    high-offset dropped. S7x NNA /
    past-note / envelope toggles forwarded directly (IT sub-codes match
    Taud one-to-one). Vol-column pitch-slide / tone-porta / vibrato sub-
    commands forwarded to main effect slot when empty; dropped otherwise.
    Per-effect private memory cohorts resolved eagerly (D/K/L share;
    E/F optionally linked with G per flag bit 5).

    A note tied by tone portamento (G / L, main or vol column) that names
    the instrument the channel already holds is emitted WITHOUT the
    instrument byte — see drop_porta_retriggers for the IT bug that makes
    this the faithful conversion rather than a liberty.
"""

import argparse
import copy
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, SAMPLE_LEN_LIMIT,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    MAX_VOICES, CUE_SIZE_64, NUM_CUES_64, XHDR_FLAG,
    NOTE_NOP, NOTE_KEYOFF, NOTE_CUT, NOTE_NOTEFADE, TAUD_C4,
    TOP_NONE, TOP_A, TOP_B, TOP_C, TOP_D, TOP_E, TOP_F, TOP_G, TOP_H, TOP_I,
    TOP_J, TOP_K, TOP_L, TOP_M, TOP_N, TOP_O, TOP_P, TOP_Q, TOP_R, TOP_S, TOP_T, TOP_U, TOP_V, TOP_W, TOP_Y,
    SEL_SET, SEL_UP, SEL_DOWN, SEL_FINE,
    EFF_A, EFF_B, EFF_C, EFF_D, EFF_E, EFF_F, EFF_G, EFF_H, EFF_I, EFF_J,
    EFF_K, EFF_L, EFF_M, EFF_N, EFF_O, EFF_P, EFF_Q, EFF_R, EFF_S, EFF_T,
    EFF_U, EFF_V, EFF_W, EFF_X, EFF_Y, EFF_Z,
    J_SEMI_TABLE,
    d_arg_to_col, resample_linear, rescale_offset_effects_per_slot,
    loop_resample_ratio, scale_loop,
    encode_cue, deduplicate_patterns, finalize_cue_sheet, set_cue_instruction,
    normalise_sample, normalise_sample_channels,
    encode_song_entry, nearest_minifloat, compress_blob,
    CUE_INST_NOP, CUE_INST_HALT, cue_instruction_len,
    cue_instruction_halt_at,
    build_project_data, detect_subsongs,
    IXMP_PAN_NO_OVERRIDE, IXMP_CHAN_DISCRETE,
)


# ── IT constants ─────────────────────────────────────────────────────────────

IT_MAGIC      = b'IMPM'
IT_SMP_MAGIC  = b'IMPS'
IT_INST_MAGIC = b'IMPI'

IT_NOTE_OFF   = 255
IT_NOTE_CUT   = 254
IT_NOTE_FADE  = 246   # → Taud Note Fade (0x0003): fade by instrument fadeout, sustain kept

IT_ORD_END    = 255
IT_ORD_SKIP   = 254

IT_FLAG_STEREO        = 0x01
IT_FLAG_USE_INST      = 0x04
IT_FLAG_LINEAR        = 0x08
IT_FLAG_OLD_EFFECTS   = 0x10
IT_FLAG_LINK_GEF      = 0x20   # link G memory with E/F

IT_SPECIAL_MESSAGE    = 0x01   # Special word bit 0: a song message is attached

# Sample flags (Flg byte at IMPS+0x12)
IT_SMP_ASSOC      = 0x01
IT_SMP_16BIT      = 0x02
IT_SMP_STEREO     = 0x04
IT_SMP_COMPRESSED = 0x08
IT_SMP_LOOP       = 0x10
IT_SMP_SUS_LOOP   = 0x20
IT_SMP_PINGPONG   = 0x40
IT_SMP_PINGPONG_SUS = 0x80

# Vol-column byte ranges (inclusive lower, inclusive upper)
VC_VOL_LO,    VC_VOL_HI    =   0,  64
VC_FVUP_LO,   VC_FVUP_HI   =  65,  74   # fine vol up  A (value = vc-64, 1..10)
VC_FVDN_LO,   VC_FVDN_HI   =  75,  84   # fine vol down B (value = vc-74, 1..10)
VC_VUP_LO,    VC_VUP_HI    =  85,  94   # vol slide up  C (value = vc-84, 1..10)
VC_VDN_LO,    VC_VDN_HI    =  95, 104   # vol slide dn  D (value = vc-94, 1..10)
VC_PDN_LO,    VC_PDN_HI    = 105, 114   # pitch dn      E (value = vc-104, 1..10)
VC_PUP_LO,    VC_PUP_HI    = 115, 124   # pitch up      F (value = vc-114, 1..10)
VC_PAN_LO,    VC_PAN_HI    = 128, 192   # set pan 0..64 (value = vc-128)
VC_TPORTA_LO, VC_TPORTA_HI = 193, 202   # tone porta    G
VC_VIB_LO,    VC_VIB_HI    = 203, 212   # vibrato       H (depth 1..10)

VC_TPORTA_TABLE = (0, 1, 4, 8, 16, 32, 64, 96, 128, 255)

# IT effects that recall last non-zero arg (per-effect-private, with cohort exceptions).
# V (Set Global Volume) recalls in IT compat mode — the first V $00 resolves to the
# header's global_vol, not literal 0. Without this, songs starting with V $00 silence.
IT_MEM_EFFECTS = frozenset({
    EFF_D, EFF_E, EFF_F, EFF_G, EFF_H, EFF_I, EFF_J,
    EFF_K, EFF_L, EFF_N, EFF_O, EFF_P, EFF_Q, EFF_R,
    EFF_S, EFF_T, EFF_U, EFF_X, EFF_Y,
    # EFF_V excluded: V00 means literal 0 in IT, not recall.
    # EFF_W excluded: Taud engine handles W recall natively (same private-slot semantics).
})


# ── Taud constants (it-specific) ──────────────────────────────────────────────

SIGNATURE        = b'it2taud/TSVM  '   # 14 bytes


# ── IT header parser ──────────────────────────────────────────────────────────

class ITHeader:
    __slots__ = ('title', 'ord_count', 'ins_count', 'smp_count', 'pat_count',
                 'cwt', 'cmwt', 'flags', 'special',
                 'msg_length', 'msg_offset', 'message',
                 'global_vol', 'mix_vol', 'initial_speed', 'initial_tempo',
                 'pan_sep', 'linear_slides', 'use_instruments',
                 'link_gef', 'old_effects',
                 'chnl_pan', 'chnl_vol',
                 'order_list', 'ins_ptrs', 'smp_ptrs', 'pat_ptrs')

def parse_it_header(data: bytes) -> ITHeader:
    if len(data) < 0xC0:
        sys.exit("error: file too short to be IT")
    if data[0:4] != IT_MAGIC:
        sys.exit("error: not an IT file (bad magic)")

    h = ITHeader()
    h.title         = data[0x04:0x1E].rstrip(b'\x00').decode('latin-1', errors='replace')
    h.ord_count     = struct.unpack_from('<H', data, 0x20)[0]
    h.ins_count     = struct.unpack_from('<H', data, 0x22)[0]
    h.smp_count     = struct.unpack_from('<H', data, 0x24)[0]
    h.pat_count     = struct.unpack_from('<H', data, 0x26)[0]
    h.cwt           = struct.unpack_from('<H', data, 0x28)[0]
    h.cmwt          = struct.unpack_from('<H', data, 0x2A)[0]
    h.flags         = struct.unpack_from('<H', data, 0x2C)[0]
    h.special       = struct.unpack_from('<H', data, 0x2E)[0]
    h.global_vol    = data[0x30]
    h.mix_vol       = data[0x31]
    h.initial_speed = data[0x32]
    h.initial_tempo = data[0x33]
    h.pan_sep       = data[0x34]
    h.msg_length    = struct.unpack_from('<H', data, 0x36)[0]
    h.msg_offset    = struct.unpack_from('<I', data, 0x38)[0]
    h.linear_slides    = bool(h.flags & IT_FLAG_LINEAR)
    h.use_instruments  = bool(h.flags & IT_FLAG_USE_INST)
    h.link_gef         = bool(h.flags & IT_FLAG_LINK_GEF)
    h.old_effects      = bool(h.flags & IT_FLAG_OLD_EFFECTS)

    h.chnl_pan = list(data[0x40:0x80])
    h.chnl_vol = list(data[0x80:0xC0])

    off = 0xC0
    h.order_list = list(data[off:off + h.ord_count])
    off += h.ord_count

    h.ins_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.ins_count)]
    off += h.ins_count * 4

    h.smp_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.smp_count)]
    off += h.smp_count * 4

    h.pat_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.pat_count)]
    # The song message is read HERE because this is the last place that holds the
    # whole file; assemble_taud only ever sees the parsed header.
    h.message = read_it_message(data, h)
    return h


def read_it_message(data: bytes, h: ITHeader) -> str:
    """The IT song message, as Taud PMsg text (item 115.2).

    ITTECH: Special bit 0 says a message is attached; MsgLgth/MsgOffset (header
    0x36 / 0x38) locate it. IT separates lines with a bare CR and pads the block
    out with NULs (and, in the wild, with trailing blanks the editor's fixed
    74x-line grid leaves behind) — TAUD_FILE_FORMAT §9.2 wants LF and no
    padding, so translate and trim. Returns '' when there is no message.
    """
    if not (h.special & IT_SPECIAL_MESSAGE) or h.msg_length == 0:
        return ''
    start, end = h.msg_offset, h.msg_offset + h.msg_length
    if start <= 0 or start >= len(data):
        return ''
    raw = data[start:min(end, len(data))]
    nul = raw.find(b'\x00')
    if nul >= 0:
        raw = raw[:nul]
    text = raw.decode('latin-1', errors='replace').replace('\r\n', '\n').replace('\r', '\n')
    # Drop the trailing space padding on each line, then the trailing blank lines.
    return '\n'.join(line.rstrip() for line in text.split('\n')).rstrip('\n')


# ── IT2.14 / IT2.15 sample decompressor ──────────────────────────────────────

def _wrap8(v: int) -> int:
    """Wrap to signed int8 range (C int8 overflow behaviour)."""
    v &= 0xFF
    return v if v < 128 else v - 256

def _wrap16(v: int) -> int:
    """Wrap to signed int16 range."""
    v &= 0xFFFF
    return v if v < 32768 else v - 65536

def _sign_extend(val: int, bits: int) -> int:
    sign_bit = 1 << (bits - 1)
    return (val & (sign_bit - 1)) - (val & sign_bit)

def _it214_decompress_block(payload: bytes, num_samples: int,
                             is_16bit: bool, is_it215: bool) -> list:
    """Decode one compressed block payload. Returns list of signed int output samples.

    Algorithm from libxmp / schism source:
      8-bit:  init_width=9,  short escape reads 3 bits, mid border=(1<<w)-8
      16-bit: init_width=17, short escape reads 4 bits, mid border=(1<<w)-16
    """
    bit_buf  = 0
    bit_cnt  = 0
    byte_pos = 0

    def read_bits(n):
        nonlocal bit_buf, bit_cnt, byte_pos
        while bit_cnt < n:
            b = payload[byte_pos] if byte_pos < len(payload) else 0
            bit_buf |= b << bit_cnt
            byte_pos += 1
            bit_cnt  += 8
        val      = bit_buf & ((1 << n) - 1)
        bit_buf >>= n
        bit_cnt  -= n
        return val

    if is_16bit:
        init_width   = 17
        range_count  = 16    # escape range size in mid form
        border_sub   = 8     # = range_count / 2; centres escape range on signed midpoint
        escape_bits  = 4     # bits to read in short-form escape
    else:
        init_width   = 9
        range_count  = 8
        border_sub   = 4
        escape_bits  = 3

    width = init_width
    d1 = d2 = 0
    out = []
    n = 0

    mask = (1 << (init_width - 1)) - 1   # 0xFF (8-bit) or 0xFFFF (16-bit)

    while n < num_samples:
        v = read_bits(width)

        is_data = False
        if width < 7:
            # Mode A (short): single escape code at v == 1<<(width-1).
            if v == (1 << (width - 1)):
                new_w = read_bits(escape_bits) + 1
                width = new_w if new_w < width else new_w + 1   # skip-self
                continue
            # Else: data, sign-extend from `width` bits.
            delta = _sign_extend(v, width)
            is_data = True
        elif width < init_width:
            # Mode B (mid): `range_count` escape codes occupy values (border, border+range_count].
            # The encoder simply does NOT emit data values that would collide with this slot —
            # it widens first. So values *above* the escape range are sign-extended verbatim,
            # not collapsed. Reference: schismtracker fmt/compression.c:103-127 and
            # MilkyTracker XModule.cpp:629-640.
            # border = (mask >> (init_width-width)) - border_sub, where border_sub
            # = range_count / 2.
            # 8-bit:  width=7 → border=63-4=59, width=8 → border=127-4=123
            # 16-bit: width=7..16 with border_sub=8.
            border = (mask >> (init_width - width)) - border_sub
            if border < v <= border + range_count:
                new_w = v - border
                width = new_w if new_w < width else new_w + 1   # skip-self
                continue
            delta = _sign_extend(v, width)
            is_data = True
        else:
            # Mode C (full): top bit (bit init_width-1) signals width change.
            top_bit = 1 << (init_width - 1)
            if v & top_bit:
                width = (v & (top_bit - 1)) + 1
                continue
            # Else: data is (init_width-1) bits wide, sign-extend from there.
            delta = _sign_extend(v, init_width - 1)
            is_data = True

        if is_data:
            if is_16bit:
                d1 = _wrap16(d1 + delta)
                if is_it215:
                    d2 = _wrap16(d2 + d1)
                    out.append(d2)
                else:
                    out.append(d1)
            else:
                d1 = _wrap8(d1 + delta)
                if is_it215:
                    d2 = _wrap8(d2 + d1)
                    out.append(d2)
                else:
                    out.append(d1)
            n += 1

    return out

def _it214_decompress_channel(blob: bytes, pos: int, num_samples: int,
                              is_16bit: bool, is_it215: bool) -> tuple:
    """Decode one channel of IT2.14/IT2.15 compressed data. Returns
    (raw PCM bytes, next position after consumed blocks)."""
    block_size = 0x4000 if is_16bit else 0x8000
    out_samples = []

    while len(out_samples) < num_samples:
        if pos + 2 > len(blob):
            break
        block_len = struct.unpack_from('<H', blob, pos)[0]
        pos += 2
        payload   = blob[pos:pos + block_len]
        pos      += block_len

        remaining = num_samples - len(out_samples)
        chunk_n   = min(remaining, block_size)
        chunk = _it214_decompress_block(payload, chunk_n, is_16bit, is_it215)
        out_samples.extend(chunk)

    if is_16bit:
        result = bytearray(len(out_samples) * 2)
        for i, s in enumerate(out_samples):
            struct.pack_into('<h', result, i * 2, max(-32768, min(32767, s)))
        return bytes(result), pos
    else:
        return bytes(s & 0xFF for s in out_samples), pos


def it214_decompress(blob: bytes, smp_offset: int, num_samples: int,
                     is_16bit: bool, is_it215: bool,
                     is_stereo: bool = False) -> bytes:
    """Decode IT2.14/IT2.15 compressed sample data. Returns raw PCM bytes
    (signed). For stereo samples, returns the left channel block followed
    by the right channel block (matching IT's on-disk SF_SS layout)."""
    left, pos = _it214_decompress_channel(blob, smp_offset, num_samples,
                                           is_16bit, is_it215)
    if not is_stereo:
        return left
    right, _ = _it214_decompress_channel(blob, pos, num_samples,
                                          is_16bit, is_it215)
    return left + right


# ── IT sample parser ──────────────────────────────────────────────────────────

class ITSample:
    __slots__ = ('name', 'filename', 'gv', 'vol', 'flags', 'cvt', 'dfp',
                 'c5_speed', 'length', 'loop_beg', 'loop_end',
                 'sus_beg', 'sus_end', 'smp_point',
                 'has_loop', 'is_16bit', 'is_stereo', 'is_compressed',
                 'is_signed', 'sample_data', 'sample_data_r',
                 'av_speed', 'av_depth', 'av_sweep', 'av_wave')

def parse_samples(data: bytes, h: ITHeader, decompress: bool,
                  keep_stereo: bool = True) -> list:
    """`keep_stereo` (the default) keeps an IT stereo sample's two channels
    apart in `sample_data` / `sample_data_r`; the Taud side pools them as two
    spans joined by an Ixmp 's' patch. With it off they are downmixed to mono
    the way every pre-2026-07 conversion did."""
    samples = []
    # IT2.15 compression is signaled PER-SAMPLE via cvt bit 2 (0x04), not globally
    # via the file's cwt. Reference: OpenMPT ITTools.cpp, libxmp it_load.c.
    for i, ptr in enumerate(h.smp_ptrs):
        if ptr == 0 or ptr + 0x50 > len(data):
            vprint(f"  warning: sample {i+1} pointer {ptr:#x} out of range, skipping")
            samples.append(None)
            continue
        if data[ptr:ptr+4] != IT_SMP_MAGIC:
            vprint(f"  warning: sample {i+1} at {ptr:#x} has bad magic, skipping")
            samples.append(None)
            continue

        s = ITSample()
        s.filename    = data[ptr+0x04:ptr+0x10].rstrip(b'\x00').decode('latin-1', errors='replace')
        s.gv          = data[ptr+0x11]
        s.flags       = data[ptr+0x12]
        s.vol         = data[ptr+0x13]
        s.name        = data[ptr+0x14:ptr+0x2E].rstrip(b'\x00').decode('latin-1', errors='replace')
        s.cvt         = data[ptr+0x2E]
        s.dfp         = data[ptr+0x2F]
        s.length      = struct.unpack_from('<I', data, ptr+0x30)[0]
        s.loop_beg    = struct.unpack_from('<I', data, ptr+0x34)[0]
        s.loop_end    = struct.unpack_from('<I', data, ptr+0x38)[0]
        s.c5_speed    = struct.unpack_from('<I', data, ptr+0x3C)[0] or 8363
        s.sus_beg     = struct.unpack_from('<I', data, ptr+0x40)[0]
        s.sus_end     = struct.unpack_from('<I', data, ptr+0x44)[0]
        s.smp_point   = struct.unpack_from('<I', data, ptr+0x48)[0]
        # Auto-vibrato (per-sample): IMPS+0x4C..0x4F.
        s.av_speed   = data[ptr + 0x4C]
        s.av_depth   = data[ptr + 0x4D]
        s.av_sweep   = data[ptr + 0x4E]
        s.av_wave    = data[ptr + 0x4F]

        s.has_loop     = bool(s.flags & IT_SMP_LOOP)
        s.is_16bit     = bool(s.flags & IT_SMP_16BIT)
        s.is_stereo    = bool(s.flags & IT_SMP_STEREO)
        s.is_compressed = bool(s.flags & IT_SMP_COMPRESSED)
        s.is_signed    = bool(s.cvt & 0x01)
        s.sample_data  = b''
        s.sample_data_r = b''

        has_data = bool(s.flags & IT_SMP_ASSOC) and s.length > 0
        if has_data:
            if s.is_compressed:
                if not decompress:
                    vprint(f"  warning: '{s.name}' is IT2.14 compressed, --no-decompress → silent")
                else:
                    try:
                        is_it215 = bool(s.cvt & 0x04)
                        raw = it214_decompress(data, s.smp_point, s.length,
                                               s.is_16bit, is_it215, s.is_stereo)
                        chans = normalise_sample_channels(raw, True, s.is_16bit,
                                                          s.is_stereo and keep_stereo, s.name)
                        if not keep_stereo and s.is_stereo:
                            chans = [normalise_sample(raw, True, s.is_16bit, True, s.name)]
                        s.sample_data = chans[0]
                        s.sample_data_r = chans[1] if len(chans) > 1 else b''
                        s.length = len(s.sample_data)
                        s.loop_beg = min(s.loop_beg, s.length)
                        s.loop_end = min(s.loop_end, s.length)
                        s.sus_beg = min(s.sus_beg, s.length)
                        s.sus_end = min(s.sus_end, s.length)
                    except Exception as e:
                        vprint(f"  warning: '{s.name}' decompression failed ({e}), silent")
            else:
                byte_len = s.length * (2 if s.is_16bit else 1) * (2 if s.is_stereo else 1)
                if s.smp_point + byte_len > len(data):
                    vprint(f"  warning: '{s.name}' sample data out of range, zeroing")
                    s.sample_data = bytes(min(s.length, 256))
                else:
                    raw = data[s.smp_point : s.smp_point + byte_len]
                    if s.is_stereo and not keep_stereo:
                        s.sample_data = normalise_sample(raw, s.is_signed,
                                                          s.is_16bit, True, s.name)
                        s.sample_data_r = b''
                    else:
                        chans = normalise_sample_channels(raw, s.is_signed,
                                                          s.is_16bit, s.is_stereo, s.name)
                        s.sample_data = chans[0]
                        s.sample_data_r = chans[1] if len(chans) > 1 else b''
                    s.length    = len(s.sample_data)
                    s.loop_beg  = min(s.loop_beg, s.length)
                    s.loop_end  = min(s.loop_end,  s.length)
                    s.sus_beg   = min(s.sus_beg,  s.length)
                    s.sus_end   = min(s.sus_end,  s.length)
        samples.append(s)
    return samples


# ── IT instrument parser ──────────────────────────────────────────────────────

class ITInstrument:
    __slots__ = ('name', 'dfp', 'gv', 'canonical_sample', 'canonical_volume',
                 'vol_envelope', 'pan_envelope', 'pf_envelope', 'pf_is_filter',
                 'vol_env_loop', 'pan_env_loop', 'pf_env_loop',
                 'vol_env_sus', 'pan_env_sus', 'pf_env_sus',
                 'ifc', 'ifr', 'fadeout', 'pps', 'ppc', 'rv', 'rp', 'nna',
                 'dct', 'dca', 'keyboard')
    # keyboard: list[int], 120 entries — keyboard[it_note] = sample_1based (0 = none).
    # Carried verbatim from the IT file so the Ixmp emitter can build patches that
    # cover non-canonical-sample note ranges. terranmon.txt "Ixmp" + Schism iti.c:80.
    # vol_envelope / pan_envelope / pf_envelope: list of 25 (value, minifloat_idx) tuples, or None
    # *_env_sustain: int (16-bit, 0b 0ut sssss pcb eeeee), 0 = no envelope
    # pf_is_filter: bool — pf envelope mode (False = pitch, True = filter)
    # ifc / ifr  : initial filter cutoff / resonance (0..127, 0 if not set)
    # fadeout    : 0..1024 (IT FadeOut field; doubled to 0..2048 when written to Taud's 12-bit field)
    # pps / ppc  : pitch-pan separation (signed -32..+32) and centre note (0..119)
    # rv / rp    : random volume swing (0..100) / random pan swing (0..64)
    # nna        : new note action (IT 0=cut, 1=continue, 2=note off, 3=note fade)

def parse_instruments(data: bytes, h: ITHeader) -> list:
    insts = []
    for i, ptr in enumerate(h.ins_ptrs):
        if ptr == 0 or ptr + 0x48 > len(data):
            insts.append(None); continue
        if data[ptr:ptr+4] != IT_INST_MAGIC:
            insts.append(None); continue

        inst = ITInstrument()
        inst.name = data[ptr+0x20:ptr+0x3A].rstrip(b'\x00').decode('latin-1', errors='replace')
        # NNA at IMPI+0x11 (new format). 0=cut, 1=continue, 2=note off, 3=note fade.
        inst.nna  = data[ptr + 0x11] & 0x03
        # DCT (Duplicate Check Type) and DCA (Duplicate Check Action), per Schism iti.c:80-94.
        # DCT: 0=off, 1=note, 2=sample, 3=instrument.
        # DCA: 0=note cut, 1=note off, 2=note fade.
        inst.dct  = data[ptr + 0x12] & 0x03
        inst.dca  = data[ptr + 0x13] & 0x03
        inst.fadeout = struct.unpack_from('<H', data, ptr + 0x14)[0]   # 0..1024
        # PPS is signed -32..+32; PPC is the centre note (IT note number 0..119, C-5=60).
        inst.pps  = struct.unpack_from('b', data, ptr + 0x16)[0]
        inst.ppc  = data[ptr + 0x17]
        inst.gv   = data[ptr+0x18]
        dfp_raw   = data[ptr+0x19]
        inst.dfp  = dfp_raw & 0x7F if (dfp_raw & 0x80) else None  # None = don't use
        inst.rv   = data[ptr + 0x1A]   # 0..100
        inst.rp   = data[ptr + 0x1B]   # 0..64

        # Keyboard table: 240 bytes at ptr+0x44, 120 pairs of (note, sample_1based)
        keyboard = []
        for n in range(120):
            kb_note = data[ptr + 0x44 + n*2]
            kb_smp  = data[ptr + 0x44 + n*2 + 1]
            keyboard.append(kb_smp)  # 0 = no sample
        inst.keyboard = keyboard

        # Pick C-5 (note 60) sample; fall back to most-frequent non-zero
        c5_smp = keyboard[60] if 60 < len(keyboard) else 0
        if c5_smp == 0:
            from collections import Counter
            freq = Counter(s for s in keyboard if s != 0)
            c5_smp = freq.most_common(1)[0][0] if freq else 0

        inst.canonical_sample = c5_smp   # 1-based sample index, 0 = none
        inst.canonical_volume  = min(inst.gv, 64)

        # Initial filter cutoff/resonance (high bit = enabled, low 7 bits = value).
        # Per Schism iti.c struct it_instrument: name[26] occupies 0x20..0x39,
        # ifc is at 0x3A, ifr at 0x3B. Off-by-one would silently disable filters
        # on every IT instrument because name's last byte is always NUL.
        ifc_raw = data[ptr + 0x3A]
        ifr_raw = data[ptr + 0x3B]
        # Taud uses full 0..255 range (double IT's resolution): IT 0..127 → Taud 0..254,
        # IT "off" (high bit clear) → Taud 255.
        inst.ifc = (ifc_raw & 0x7F) * 2 if (ifc_raw & 0x80) else 255
        inst.ifr = (ifr_raw & 0x7F) * 2 if (ifr_raw & 0x80) else 255

        # Parse IT envelopes (new-format only, ≥cmwt 0x200)
        # Vol envelope at ptr+0x130; pan envelope at ptr+0x182; pf envelope at ptr+0x1D4
        ticks_per_sec = max(h.initial_tempo * 2.0 / 5.0, 1.0)
        inst.vol_envelope, inst.vol_env_loop, inst.vol_env_sus = _parse_it_envelope(
            data, ptr + 0x130, kind='vol', ticks_per_sec=ticks_per_sec)
        inst.pan_envelope, inst.pan_env_loop, inst.pan_env_sus = _parse_it_envelope(
            data, ptr + 0x182, kind='pan', ticks_per_sec=ticks_per_sec)
        # pf envelope: byte 0 bit 7 distinguishes filter (1) from pitch (0).
        pf_flag_byte = data[ptr + 0x1D4] if ptr + 0x1D4 < len(data) else 0
        inst.pf_is_filter = bool(pf_flag_byte & 0x80)
        inst.pf_envelope, inst.pf_env_loop, inst.pf_env_sus = _parse_it_envelope(
            data, ptr + 0x1D4, kind=('filter' if inst.pf_is_filter else 'pitch'),
            ticks_per_sec=ticks_per_sec)
        insts.append(inst)
    return insts


def _parse_it_envelope(data: bytes, env_ptr: int, kind: str,
                       ticks_per_sec: float) -> tuple:
    """Parse one IT envelope block (vol / pan / pitch / filter) into up to 25
    Taud (value, minifloat_idx) points + LOOP word + SUSTAIN word.

    Returns (points_list, loop_word, sustain_word).
    points_list has 25 entries (padded with hold) or None if the envelope is
    disabled. loop_word and sustain_word are zero when the corresponding
    region is not enabled.

    kind:
      'vol'    — IT 0..64    →  Taud 0..63
      'pan'    — IT -32..+32 →  Taud 0..255 (0x80 = centre)
      'pitch'  — IT -32..+32 →  Taud 0..255 (0x80 = unity)
      'filter' — IT -32..+32 →  Taud 0..255 (0x80 = unity cutoff)

    Word layout (terranmon.txt:2049+ / 2114+):
      LOOP    word: 0b 00P0_0sss_ssXcb_eeeee  (X = 'p'/'m' for pan/pf, 0 for vol)
      SUSTAIN word: 0b 0000_0sss_ss00b_eeeee
        bits 12..8 = start index, bits 4..0 = end index
        bit  13 = P (envelope present; gates pan/pf evaluation in the engine)
        bit  7 = p (pan: use default pan) / m (pf: pitch=0/filter=1) / 0 (vol)
        bit  6 = c (envelope carry — placed in the LOOP word)
        bit  5 = b (enable that region)
    """
    if env_ptr + 82 > len(data):
        return None, 0, 0
    flags = data[env_ptr]
    if not (flags & 0x01):
        return None, 0, 0       # envelope not enabled

    num_nodes  = max(1, min(data[env_ptr + 1], 25))
    it_lpb     = data[env_ptr + 2]
    it_lpe     = data[env_ptr + 3]
    it_slb     = data[env_ptr + 4]
    it_sle     = data[env_ptr + 5]
    has_env_loop = bool(flags & 0x02)
    has_sus_loop = bool(flags & 0x04)
    carry        = bool(flags & 0x08)
    is_filter    = bool(flags & 0x80) and kind in ('pitch', 'filter')

    # Read IT nodes: (int8 value, uint16 tick_pos LE)
    nodes = []
    for n in range(num_nodes):
        nptr = env_ptr + 6 + n * 3
        if nptr + 2 >= len(data):
            break
        val  = struct.unpack_from('b', data, nptr)[0]
        tick = struct.unpack_from('<H', data, nptr + 1)[0]
        nodes.append((val, tick))
    if not nodes:
        return None, 0, 0

    def _to_taud_val(it_val: int) -> int:
        if kind == 'vol':
            return min(63, max(0, round(it_val * 63 / 64)))
        if kind == 'pan':
            return min(255, max(0, round((it_val + 32) * 255 / 64)))
        return min(255, max(0, round((it_val + 32) * 255 / 64)))

    pad_value = (63 if kind == 'vol' else 0x80)

    # Build Taud envelope points with delta-time minifloats. We keep all
    # IT nodes verbatim (up to 25), so loop indices stay valid.
    points = []
    for k in range(25):
        if k < len(nodes):
            val, tick = nodes[k]
            taud_val = _to_taud_val(val)
            if k < len(nodes) - 1:
                _, next_tick = nodes[k + 1]
                delta_sec    = max(0.0, (next_tick - tick) / ticks_per_sec)
                mf_idx       = nearest_minifloat(delta_sec)
            else:
                mf_idx = 0
        else:
            taud_val = points[-1][0] if points else pad_value
            mf_idx   = 0
        points.append((taud_val, mf_idx))

    # Build LOOP word (offsets 15/17/19) and SUSTAIN word (offsets 189/191/193).
    # IT distinguishes envelope loop and sustain loop natively; map both
    # directly. Bits: 5=b enable, 6=c carry, 7=p (pan default-pan flag) /
    # m (pf filter mode); 12..8=start, 4..0=end. SUSTAIN word never carries
    # c/p/m — those live in the LOOP word.
    # P (bit 13) marks the envelope as present in source, regardless of LOOP/
    # SUSTAIN enable. We reach this point only when the IT envelope flag bit 0
    # is set (handled at function top), so P is unconditionally set here.
    loop_word = 0x2000                                   # P: envelope present
    if has_env_loop and 0 <= it_lpb < 25 and 0 <= it_lpe < 25:
        loop_word |= 0x0020                              # b: enable LOOP
        loop_word |= (it_lpb & 0x1F) << 8
        loop_word |= (it_lpe & 0x1F)
    if carry:
        loop_word |= 0x0040                              # c carry — kept in LOOP word
    if is_filter:
        loop_word |= 0x0080                              # m filter-mode (pf only)

    sus_word = 0
    if has_sus_loop and 0 <= it_slb < 25 and 0 <= it_sle < 25:
        sus_word |= 0x0020                               # b: enable SUSTAIN
        sus_word |= (it_slb & 0x1F) << 8
        sus_word |= (it_sle & 0x1F)

    return points, loop_word, sus_word


# ── IT pattern parser ─────────────────────────────────────────────────────────

class ITRow:
    __slots__ = ('note', 'inst', 'vol', 'effect', 'effect_arg', 'volcol',
                 'pan_set', 'aux_effect')
    def __init__(self):
        self.note       = -1        # -1=empty, 0-119=pitch, IT_NOTE_*
        self.inst       = 0         # 1-based
        self.vol        = -1        # -1=not set
        self.effect     = 0
        self.effect_arg = 0
        self.volcol     = -1        # raw IT vol-col byte, -1 = not set
        self.pan_set    = None      # 0..63 from vol-col, or None
        self.aux_effect = None      # (cmd,arg) from vol-col, or None

def _parse_one_pattern(data: bytes, ptr: int) -> tuple:
    """Returns (grid: list[64_channels][rows], row_count: int)."""
    if ptr == 0 or ptr + 8 > len(data):
        return [[ITRow() for _ in range(PATTERN_ROWS)] for _ in range(64)], PATTERN_ROWS

    data_len  = struct.unpack_from('<H', data, ptr)[0]
    row_count = struct.unpack_from('<H', data, ptr+2)[0]
    end = ptr + 8 + data_len
    pos = ptr + 8

    grid = [[ITRow() for _ in range(row_count)] for _ in range(64)]

    # Per-channel last-data memory
    last_mask    = [0]   * 64
    last_note    = [0]   * 64
    last_inst    = [0]   * 64
    last_volcol  = [0]   * 64
    last_cmd     = [0]   * 64
    last_arg     = [0]   * 64

    row = 0
    while row < row_count and pos < end:
        chan_byte = data[pos]; pos += 1
        if chan_byte == 0:
            row += 1
            continue
        ch = (chan_byte - 1) & 63
        if chan_byte & 0x80:
            if pos >= end: break
            last_mask[ch] = data[pos]; pos += 1
        mask = last_mask[ch]

        cell = grid[ch][row]

        if mask & 0x01:
            last_note[ch] = data[pos]; pos += 1
        if mask & 0x02:
            last_inst[ch] = data[pos]; pos += 1
        if mask & 0x04:
            last_volcol[ch] = data[pos]; pos += 1
        if mask & 0x08:
            last_cmd[ch] = data[pos]; pos += 1
            last_arg[ch] = data[pos]; pos += 1

        if mask & 0x11:   cell.note       = last_note[ch]
        if mask & 0x22:   cell.inst       = last_inst[ch]
        if mask & 0x44:   cell.volcol     = last_volcol[ch]
        if mask & 0x88:
            cell.effect     = last_cmd[ch]
            cell.effect_arg = last_arg[ch]

    return grid, row_count

def parse_patterns(data: bytes, h: ITHeader) -> list:
    """Returns list of (grid, row_count) tuples."""
    patterns = []
    for ptr in h.pat_ptrs:
        grid, rows = _parse_one_pattern(data, ptr)
        patterns.append((grid, rows))
    return patterns


# ── Note encoding (IT linear 0-119 → Taud pitch units) ───────────────────────

def encode_note_it(it_note: int) -> int:
    if it_note == IT_NOTE_OFF:
        return NOTE_KEYOFF
    if it_note == IT_NOTE_FADE:
        # IT "~~~" Note Fade: CHN_NOTEFADE — begins the instrument's volume fadeout
        # without releasing the sustain loop (Schism effects.c:1505-1509). Distinct from
        # key-off (0x0001), which lifts sustain. Engine handles it via voice.noteFading.
        return NOTE_NOTEFADE
    if it_note == IT_NOTE_CUT:
        return NOTE_CUT
    if 0 <= it_note <= 119:
        # IT middle C is C-5 (note 60); Taud reference is C-4 (TAUD_C4 = 0x5000).
        # IT C-5 anchors to Taud C-4, so offset = it_note - 60.
        semis = it_note - 60
        val = round(TAUD_C4 + semis * 4096 / 12)
        return max(0x20, min(0xFFFF, val))
    return NOTE_NOP


# ── Vol-column decoder ────────────────────────────────────────────────────────

def decode_volcol(vc: int, recall_volslide: int = 0):
    """Return (vol_sel, vol_value, pan_set, aux_effect) or None for each field.

    IT vol-col x=0 means "recall last value" for the relevant memory cohort
    (Schism player/effects.c:2097-2137 — Ax/Bx/Cx/Dx share `mem_vc_volslide`,
    a per-channel slot separate from the main column's D memory; Ex/Fx share
    `mem_pitchslide` with the main effect column; Gx shares `mem_portanote`
    with main G; Hx uses the channel's vibrato state). For pitch/porta/
    vibrato we emit Taud E/F/G/H with arg=0 so Taud's own private (E/F-cohort,
    G, H/U-cohort) memory recalls naturally. For volume slides Taud has no
    recall in the volume column, so the converter passes `recall_volslide`
    (the per-channel A/B/C/D shared memory tracked by build_pattern_it) and
    substitutes it when x=0.
    """
    if vc < 0:   # not set
        return SEL_FINE, 0, None, None
    if vc <= VC_VOL_HI:
        return SEL_SET, min(vc, 0x3F), None, None
    if VC_FVUP_LO <= vc <= VC_FVUP_HI:
        mag = vc - VC_FVUP_LO            # 0..9 — Schism fmt/it.c:234
        if mag == 0:
            mag = recall_volslide
        if mag == 0:
            return SEL_FINE, 0, None, None
        return SEL_FINE, (mag & 0x1F) | 0x20, None, None   # fine up
    if VC_FVDN_LO <= vc <= VC_FVDN_HI:
        mag = vc - VC_FVDN_LO
        if mag == 0:
            mag = recall_volslide
        if mag == 0:
            return SEL_FINE, 0, None, None
        return SEL_FINE, mag & 0x1F, None, None              # fine down
    if VC_VUP_LO <= vc <= VC_VUP_HI:
        mag = vc - VC_VUP_LO
        if mag == 0:
            mag = recall_volslide
        if mag == 0:
            return SEL_FINE, 0, None, None
        return SEL_UP, mag, None, None
    if VC_VDN_LO <= vc <= VC_VDN_HI:
        mag = vc - VC_VDN_LO
        if mag == 0:
            mag = recall_volslide
        if mag == 0:
            return SEL_FINE, 0, None, None
        return SEL_DOWN, mag, None, None
    if VC_PDN_LO <= vc <= VC_PDN_HI:
        # IT vol-col Ex slides pitch down by 4×e raw IT period units (Schism
        # player/effects.c:294-298). e=0 recalls mem_pitchslide; emit
        # E $0000 so Taud's E/F-cohort memory supplies the value.
        e = vc - VC_PDN_LO
        units = e * 4
        return SEL_FINE, 0, None, (EFF_E, units & 0xFF)
    if VC_PUP_LO <= vc <= VC_PUP_HI:
        f = vc - VC_PUP_LO
        units = f * 4
        return SEL_FINE, 0, None, (EFF_F, units & 0xFF)
    if VC_PAN_LO <= vc <= VC_PAN_HI:
        pan64 = vc - VC_PAN_LO   # 0..64
        pan6  = min(0x3F, round(pan64 * 63 / 64))
        return SEL_FINE, 0, pan6, None
    if VC_TPORTA_LO <= vc <= VC_TPORTA_HI:
        # IT Gg tone-porta speed: VC_TPORTA_TABLE[0]=0 → g=0 recalls
        # mem_portanote. Emit G $0000; Taud's private G memory recalls.
        g = vc - VC_TPORTA_LO
        spd = VC_TPORTA_TABLE[g]
        return SEL_FINE, 0, None, (EFF_G, spd & 0xFF)
    if VC_VIB_LO <= vc <= VC_VIB_HI:
        # IT Hh sets vibrato depth (low nybble only) and runs vibrato with
        # the channel's current vibrato_speed (Schism player/effects.c:391-398
        # via fx_vibrato). h=0 keeps the existing depth; emit H $0000 so
        # Taud's H/U cohort memory supplies both speed and depth.
        h = vc - VC_VIB_LO
        return SEL_FINE, 0, None, (EFF_H, h & 0x0F)
    return SEL_FINE, 0, None, None


# ── Effect translator ─────────────────────────────────────────────────────────

def encode_effect_it(cmd: int, arg: int, ch: int = 0, row: int = 0,
                     amiga_mode: bool = False) -> tuple:
    """Return (taud_op, taud_arg16, vol_override, pan_override).

    Differs from s3m2taud.encode_effect in:
      - Cxx: binary row number, not BCD
      - V: IT global vol 0-128 scaled ×2
      - X: IT full 8-bit pan → 6-bit
      - S6x: fine pattern delay forwarded; S7x forwarded; SAx/SFx dropped

    amiga_mode mirrors the inverse of the IT ``linear_slides`` flag.  When
    set, E/F coarse pitch-slide arguments are emitted as raw IT period units
    (the engine applies them directly in period space); when clear they are
    quantised to 4096-TET units via ``round(× 64/3)``.  Fine/extra-fine
    slides and tone portamento (G) are always linear regardless of mode.
    """
    if cmd == 0:
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_A:
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        return (TOP_A, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_B:
        return (TOP_B, arg & 0xFF, None, None)

    if cmd == EFF_C:
        # IT stores binary (not BCD like ST3)
        row_num = arg & 0xFF
        if row_num >= PATTERN_ROWS:
            row_num = 0
        return (TOP_C, row_num & 0xFF, None, None)

    if cmd == EFF_D:
        return (TOP_D, (arg & 0xFF) << 8, None, None)

    if cmd in (EFF_E, EFF_F):
        # Coarse: 1/16 semitone = 64/3 Taud units in linear mode; raw IT period
        # units in Amiga mode (engine consumes them in period space).
        # Fine/extra-fine (Exx with hi ∈ {E,F}): 1/64 semitone = 16/3 Taud units
        # in linear mode; raw IT period units in Amiga mode (engine consumes
        # them in period space, applied once per row at tick 0).
        op = TOP_E if cmd == EFF_E else TOP_F
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        if hi in (0xE, 0xF) and lo > 0:
            if amiga_mode:
                return (op, 0xF000 | (lo & 0xFFF), None, None)
            return (op, 0xF000 | (round(lo * 16 / 3) & 0xFFF), None, None)
        if amiga_mode:
            return (op, arg & 0xFFFF, None, None)
        return (op, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == EFF_G:
        return (TOP_G, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd in (EFF_H, EFF_I, EFF_R, EFF_U):
        op = {EFF_H: TOP_H, EFF_I: TOP_I, EFF_R: TOP_R, EFF_U: TOP_U}[cmd]
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (op, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_J:
        hi_semi = (arg >> 4) & 0xF
        lo_semi = arg & 0xF
        return (TOP_J, (J_SEMI_TABLE[hi_semi] << 8) | J_SEMI_TABLE[lo_semi], None, None)

    if cmd == EFF_K:
        # K = vibrato continuation + vol slide; emitted verbatim. IT's D/K/L
        # shared cohort is already resolved upstream by resolve_it_recalls.
        return (TOP_K, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_L:
        # L = tone-porta continuation + vol slide; emitted verbatim.
        return (TOP_L, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_M:
        # M = set channel volume; literal byte (no recall). Clamp IT $40 → $3F.
        return (TOP_M, (min(arg, 0x3F) & 0xFF) << 8, None, None)

    if cmd == EFF_N:
        # N = channel volume slide; D-style encoding.
        return (TOP_N, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_O:
        return (TOP_O, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_P:
        # P = channel panning slide; D-style encoding (low nib = right, high nib = left).
        return (TOP_P, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_Q:
        return (TOP_Q, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_S:
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        if sub in (0x1, 0x2, 0x3, 0x4, 0xB, 0xC, 0xD, 0xE):
            return (TOP_S, (sub << 12) | (val << 8), None, None)
        if sub == 0x5:
            return (TOP_S, 0x5000 | (val << 8), None, None)
        if sub == 0x8:
            # IT S8x: 4-bit → nibble-repeat into 8-bit SEL_SET pan
            pan8 = (val << 4) | val
            return (TOP_S, 0x8000 | pan8, None, None)
        if sub == 0x6:
            # IT S6x = fine pattern delay (extends row by x ticks) — maps directly.
            return (TOP_S, 0x6000 | (val << 8), None, None)
        if sub == 0x7:
            # NNA / past-note / envelope on-off — IT S7x maps directly to Taud S $7x00
            # (same sub-code table). No payload to translate.
            return (TOP_S, 0x7000 | (val << 8), None, None)
        if sub == 0x9:
            return (TOP_NONE, 0, None, None)  # sound control — drop silently
        if sub == 0xA:
            vprint(f"    dropped SA{val:X} (high offset) at ch{ch} row{row}")
            return (TOP_NONE, 0, None, None)
        if sub == 0xF:
            vprint(f"    dropped SF{val:X} (MIDI macro) at ch{ch} row{row}")
            return (TOP_NONE, 0, None, None)
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_T:
        if arg >= 0x20:
            return (TOP_T, ((arg - 0x19) & 0xFF) << 8, None, None)
        return (TOP_T, arg & 0xFF, None, None)

    if cmd == EFF_V:
        # IT global vol is 0-128; Taud uses 0-255 → ×2
        taud_v = min(arg * 2, 0xFF)
        return (TOP_V, (taud_v & 0xFF) << 8, None, None)

    if cmd == EFF_W:
        # W$xy: same nibble-pair layout as D, passed in the high byte.
        return (TOP_W, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_X:
        return (TOP_S, 0x8000 | (arg & 0xFF), None, None)

    if cmd == EFF_Y:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_Y, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_Z:
        vprint(f"    dropped Z{arg:02X} (MIDI macro) at ch{ch} row{row}")
        return (TOP_NONE, 0, None, None)

    return (TOP_NONE, 0, None, None)


# ── IT recall resolution ──────────────────────────────────────────────────────

def resolve_it_recalls(patterns_rows: list, order_list: list,
                       num_channels: int, link_gef: bool,
                       old_effects: bool = False) -> None:
    """Walk in order, resolve zero-arg recalls per-effect-per-channel.

    IT effect memory groups:
      - D / K / L: shared vol-slide cohort
      - E / F (/ G when link_gef): shared pitch-slide cohort
      - G: own slot (or part of EF cohort when link_gef)
      - All others: private slots

    old_effects=True (IT_FLAG_OLD_EFFECTS): E00/F00 are ST3-style stops —
    they do NOT recall and are suppressed to TOP_NONE. All other effects
    still recall normally even in old_effects mode.

    V and W are excluded from IT_MEM_EFFECTS and are not resolved here:
    V00 in IT means literal 0 (not recall); W recall is handled natively
    by the Taud engine's private W memory slot.
    """
    # last_mem[ch][eff_key] = last_non_zero_arg
    # eff_key: integer 1-26 for most effects; we merge cohorts by normalising.
    last_mem = [{} for _ in range(num_channels)]

    # Effects that stop rather than recall when arg=0 in old_effects mode (ST3 compat).
    # E/F: pitch slide stop. J: arpeggio stop (J00 = return to normal pitch in ST3).
    OLD_EFF_STOPS = frozenset({EFF_E, EFF_F, EFF_J})

    def cohort_key(cmd):
        if cmd in (EFF_D, EFF_K, EFF_L):
            return EFF_D   # vol-slide cohort
        if link_gef and cmd in (EFF_E, EFF_F, EFF_G):
            return EFF_E   # EFG cohort
        if not link_gef and cmd in (EFF_E, EFF_F):
            return EFF_E   # EF cohort
        return cmd

    for order in order_list:
        if order >= IT_ORD_END:
            break
        if order >= len(patterns_rows):
            continue
        grid, rows = patterns_rows[order]
        for r in range(rows):
            for ch in range(num_channels):
                if ch >= len(grid):
                    continue
                cell = grid[ch][r]
                if cell.effect not in IT_MEM_EFFECTS:
                    continue
                key = cohort_key(cell.effect)
                if cell.effect_arg == 0:
                    if old_effects and cell.effect in OLD_EFF_STOPS:
                        # E00/F00 in old_effects = stop slide — suppress entirely.
                        # Taud's E $0000 also recalls, so convert to no-op here.
                        cell.effect = 0
                    else:
                        cell.effect_arg = last_mem[ch].get(key, 0)
                else:
                    last_mem[ch][key] = cell.effect_arg


def _row_carries_tone_porta(cell: 'ITRow') -> bool:
    """Does this IT cell reach the Taud pattern carrying a tone portamento?

    Main-column G and L always do. A vol-column Gx does only when
    build_pattern_it can find it a slot: the main column is empty (the aux
    becomes the effect) or holds a non-zero D (the pair folds into L). Anywhere
    else the vol-column porta is dropped for want of a slot, so the row is NOT
    "connected" in the output and must keep its instrument byte.
    """
    if cell.effect in (EFF_G, EFF_L):
        return True
    if VC_TPORTA_LO <= cell.volcol <= VC_TPORTA_HI:
        return cell.effect == 0 or (cell.effect == EFF_D and cell.effect_arg != 0)
    return False


def drop_porta_retriggers(patterns_rows: list, order_list: list,
                          num_channels: int) -> int:
    """Strip the instrument byte from note rows tied by tone portamento.

    THE IMPULSE TRACKER BUG THIS WORKS AROUND. In IT, a row carrying a note, an
    instrument number AND a tone portamento does not reset the instrument's
    envelopes — the envelopes carry on from wherever the previous note left
    them, whether or not the instrument's Carry flag is set. Schism's
    csf_instrument_change says so outright (player/effects.c):

        reset_env = (!chan->length)
                 || (inst_column && porta && (csf->flags & SONG_COMPATGXX))
                 || (inst_column && !porta && (NOTEFADE|KEYOFF) && ITOLDEFFECTS);

    — with Compatible Gxx off, which is the ordinary case, an instrument next
    to a porta simply never reaches env_reset. The comment above it in Schism
    ("Conditions experimentally determined... Seems like it's just a total mess
    though") is the state of the art on WHY. OpenMPT carries the same quirk as
    kITPortamentoInstrument / kITEnvelopeReset and was still fixing corners of
    it in 1.32.11 ("Envelope Carry may not resume the envelope from the correct
    position when there is both an instrument number and tone portamento next
    to a note").

    The Taud engine deliberately does NOT reproduce it: an instrument byte on a
    porta row re-attacks the four envelope playheads (TAUD_ENGINE_SPEC §5.4,
    item 124), which is FastTracker's rule and the one a tracker musician can
    predict. Envelope carry is spelled out instead, in the LOOP word's `c` bit,
    where it is a property of the instrument rather than an accident of the row.

    So the conversion happens HERE: a note tied by G or L that names the
    instrument the channel already holds loses the instrument byte, which is
    what an IT author's ear expects and what the same passage would be written
    as by hand. The byte is dropped ONLY when it names the SAME instrument —
    that is the case where IT reloads nothing at all (Schism returns early at
    `psmp == chan->ptr_sample`, clearing KEYOFF only when the instrument
    changed), so nothing else is lost with it. A porta row naming a DIFFERENT
    instrument keeps its byte: there IT does swap the sample and clear the
    key-off, and Taud's re-attack is much the closer of the two readings.

    Walks in play order, so "the instrument the channel already holds" is the
    real one — same walk, and the same across-visits caveat, as
    resolve_it_recalls. Returns the number of instrument bytes dropped.
    """
    current = [0] * num_channels      # instrument each channel has loaded
    dropped = 0
    for order in order_list:
        if order >= IT_ORD_END:
            break
        if order >= len(patterns_rows):
            continue
        grid, rows = patterns_rows[order]
        for r in range(rows):
            for ch in range(num_channels):
                if ch >= len(grid):
                    continue
                cell = grid[ch][r]
                if cell.inst == 0:
                    continue
                if (0 <= cell.note <= 119 and cell.inst == current[ch]
                        and _row_carries_tone_porta(cell)):
                    cell.inst = 0
                    dropped += 1
                else:
                    current[ch] = cell.inst
    return dropped


# ── Pattern row-chunk splitter ────────────────────────────────────────────────

def split_patterns(patterns_rows: list):
    """
    Returns (chunks, chunk_map, chunk_lens).
      chunks: flat list of 64-row grids (list of 64 × 64-channel ITRow arrays)
      chunk_map: list per source pattern of [chunk_idx_0, chunk_idx_1, ...]
      chunk_lens: list parallel to chunks giving the real row count of each
                  chunk (64 for full chunks, < 64 for partial-tail chunks).
                  The cue builder emits a Taud LEN ($02xx) instruction for
                  any chunk whose length is < 64.

    Patterns ≤ 64 rows produce one chunk of `rows` rows (LEN if rows < 64).
    Patterns > 64 rows split into ⌊rows/64⌋ full 64-row chunks plus, if
    `rows % 64 != 0`, a final chunk holding the remainder (which gets LEN).
    """
    chunks     = []
    chunk_map  = []
    chunk_lens = []

    for pi, (grid, rows) in enumerate(patterns_rows):
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
            # Build a 64-row grid for this chunk (rows past chunk_len are
            # silent padding; the engine will stop early via LEN when
            # chunk_len < 64).
            chunk_grid = []
            for ch in range(64):
                ch_rows = []
                src = grid[ch] if ch < len(grid) else []
                for ri in range(PATTERN_ROWS):
                    sr = r0 + ri
                    if sr < r1 and ri < len(src):
                        ch_rows.append(src[sr])
                    else:
                        ch_rows.append(ITRow())
                chunk_grid.append(ch_rows)

            idx = len(chunks)
            chunks.append(chunk_grid)
            chunk_lens.append(chunk_len)
            pat_chunks.append(idx)

        chunk_map.append(pat_chunks)
    return chunks, chunk_map, chunk_lens


def _remap_bc_effects(chunks: list, chunk_map: list,
                      order_list: list, it_ord_to_taud_cue: dict,
                      num_channels: int,
                      *, default_target: int = None,
                      warn_label: str = '',
                      chunk_indices=None) -> None:
    """Rewrite B (position-jump) effects using remapped order indices.

    B effects are rewritten to point to the first chunk of the target IT
    order. C effects (pattern break) need no special handling: each
    Taud cue carries its own LEN instruction, so a non-final chunk of a
    split source pattern simply terminates after its real row count
    when LEN < 64 — but full 64-row non-final chunks rely on the C
    being emitted by the engine when the source pattern's row pointer
    naturally hits a chunk boundary. Since splits at exact multiples of
    64 have no LEN gap, no C-skip injection is required.

    `default_target` (multi-song): when a Bxx points to an order outside
    `it_ord_to_taud_cue` (a cross-subsong jump), rewrite to this cue
    index instead of preserving the literal target. Set to 0 to make
    cross-song jumps loop the subsong; leave None for legacy behaviour.

    `chunk_indices`: optional iterable; when provided, only these chunks
    are visited. Used by multi-song to skip unreferenced chunks (avoids
    spurious cross-song warnings on chunks that won't be emitted).
    """
    crossings = 0
    iter_indices = (chunk_indices if chunk_indices is not None
                    else range(len(chunks)))
    for ci in iter_indices:
        chunk_grid = chunks[ci]
        for ch in range(num_channels):
            if ch >= len(chunk_grid): continue
            for row in chunk_grid[ch]:
                if row.effect == EFF_B:
                    it_tgt = row.effect_arg
                    if it_tgt in it_ord_to_taud_cue:
                        row.effect_arg = it_ord_to_taud_cue[it_tgt] & 0xFF
                    elif default_target is not None:
                        crossings += 1
                        row.effect_arg = default_target & 0xFF
                    else:
                        row.effect_arg = it_tgt & 0xFF
    if crossings and warn_label:
        vprint(f"  warning: {warn_label}: {crossings} Bxx target(s) cross "
               f"subsong boundary; clamped to cue {default_target}")


# ── Ixmp patch builder (multi-sample IT instruments) ─────────────────────────

def _it_note_to_taud(note: int, clamp_low: bool = False, clamp_high: bool = False) -> int:
    """IT note (0..119, C-5 = 60) → Taud 4096-TET noteVal anchored at TAUD_C4.
    `clamp_low`/`clamp_high` expand the bottom/top of the keyboard to cover the
    full Taud playable range, so patches at the keyboard's edges don't leave
    notes outside the trigger rectangle unmatched."""
    if clamp_low:  return 0x0000
    if clamp_high: return 0xFFFF
    val = round(TAUD_C4 + (note - 60) * 4096 / 12)
    return max(0x0020, min(0xFFFF, val))


def _it_patch_fields(s):
    """Per-sample Ixmp patch fields for IT sample `s` — loop/sustain encoding
    and the default volume / pan / auto-vibrato that mirror what the
    use_instruments inst-record path (build_sample_inst_bin_it) would store, so
    a patch on this sample behaves exactly like the base record would.
    Returns (loop_start, loop_end, loop_mode, default_pan, dnv,
             vib_speed, vib_depth, vib_rate, vib_wave)."""
    if s.flags & IT_SMP_SUS_LOOP:
        ls = min(s.sus_beg, 65535); le = min(s.sus_end, 65535)
        sustain_bit = 0x4
        pingpong = bool(s.flags & IT_SMP_PINGPONG_SUS)
        has_loop = True
    elif s.has_loop:
        ls = min(s.loop_beg, 65535); le = min(s.loop_end, 65535)
        sustain_bit = 0x0
        pingpong = bool(s.flags & IT_SMP_PINGPONG)
        has_loop = True
    else:
        ls = 0; le = 0
        sustain_bit = 0x0
        pingpong = False
        has_loop = False
    loop_mode = (2 if (has_loop and pingpong) else (1 if has_loop else 0)) | sustain_bit

    smp_vol  = min(getattr(s, 'vol', 64), 64)
    dnv      = min(255, round(smp_vol * 255 / 64))
    smp_dfp  = getattr(s, 'dfp', 0)
    default_pan = (min(255, max(0, round((smp_dfp & 0x7F) * 255 / 64)))
                   if (smp_dfp & 0x80) else IXMP_PAN_NO_OVERRIDE)
    # Vir 0 = IT never ramps the depth in, i.e. no vibrato at all (see the
    # base-record branch); Taud reads a zero ramp field as full depth at once.
    av_sweep = getattr(s, 'av_sweep', 0) & 0xFF
    return (ls, le, loop_mode, default_pan, dnv,
            min(255, round(getattr(s, 'av_speed', 0) * 255 / 64)),
            0 if av_sweep == 0 else min(255, round(getattr(s, 'av_depth', 0) * 255 / 64)),
            av_sweep,
            getattr(s, 'av_wave',  0) & 0x07)


def _build_it_stereo_patch(s, sample_ptr, sample_ptr_r) -> list:
    """One full-range stereo patch for a sample the base record can only play as
    its left channel (sample mode, where no keyboard table exists). Covers the
    whole pitch/velocity space, so it always wins the trigger lookup."""
    (ls, le, loop_mode, default_pan, dnv,
     vs, vd, vr, vw) = _it_patch_fields(s)
    patches = []
    _emit_patch(patches, 0, 119, sample_ptr, s, ls, le, loop_mode, default_pan, dnv,
                vs, vd, vr, vw, sample_ptr_r)
    return patches


def _build_it_ixmp_patches(inst, samples, extras_offsets, extras_offsets_r=None) -> list:
    """For one IT instrument, return a list of Ixmp patch dicts covering every
    keyboard cell that maps to a NON-canonical sample. The canonical sample is
    served by the base instrument record so no patch is emitted for it (the
    engine falls through to the base inst when no patch matches).

    Note ranges are contiguous runs of keyboard cells that point at the same
    sample. Per the Ixmp spec each (pitch_start..pitch_end, volume_start..end)
    rectangle MUST NOT overlap any other patch on the same instrument; this is
    guaranteed here because the keyboard mapping itself is a partition."""
    canonical = inst.canonical_sample
    kbd = getattr(inst, 'keyboard', None)
    if not kbd:
        return []
    extras_offsets_r = extras_offsets_r or {}
    # A STEREO canonical sample cannot be expressed by the base record (only an
    # Ixmp patch carries the 's' block), so it is treated as non-canonical here
    # and gets patches over its own keyboard runs.
    canon_stereo = (1 <= canonical <= len(samples)
                    and samples[canonical - 1] is not None
                    and ('it_smp', canonical - 1) in extras_offsets_r)
    # Distinct non-canonical samples referenced.
    distinct = []
    seen = set()
    for kb_smp in kbd:
        if kb_smp == 0 or (kb_smp == canonical and not canon_stereo):
            continue
        if kb_smp not in seen and 1 <= kb_smp <= len(samples) and samples[kb_smp - 1] is not None:
            seen.add(kb_smp); distinct.append(kb_smp)
    if not distinct:
        return []

    patches = []
    for smp_1based in distinct:
        si = smp_1based - 1
        s = samples[si]
        if not s.sample_data:
            continue
        sample_ptr = extras_offsets.get(('it_smp', si))
        if sample_ptr is None:
            continue   # not in the pool — bin overflow or corrupt source
        sample_ptr_r = extras_offsets_r.get(('it_smp', si))

        (ls, le, loop_mode, default_pan, dnv,
         vib_speed_taud, vib_depth_taud, vib_rate_taud, vib_wave_taud) = _it_patch_fields(s)

        # Find contiguous IT-note ranges where the keyboard points at this sample.
        run_start = None
        for n in range(120):
            if kbd[n] == smp_1based:
                if run_start is None:
                    run_start = n
            else:
                if run_start is not None:
                    _emit_patch(patches, run_start, n - 1, sample_ptr, s,
                                ls, le, loop_mode, default_pan, dnv,
                                vib_speed_taud, vib_depth_taud, vib_rate_taud, vib_wave_taud,
                                sample_ptr_r)
                    run_start = None
        if run_start is not None:
            _emit_patch(patches, run_start, 119, sample_ptr, s,
                        ls, le, loop_mode, default_pan, dnv,
                        vib_speed_taud, vib_depth_taud, vib_rate_taud, vib_wave_taud,
                        sample_ptr_r)
    return patches


def _emit_patch(patches, it_lo, it_hi, sample_ptr, s,
                ls, le, loop_mode, default_pan, dnv,
                vib_speed, vib_depth, vib_rate, vib_wave, sample_ptr_r=None):
    """Append one patch dict covering IT-note range [it_lo, it_hi] inclusive.
    `sample_ptr_r` makes it a STEREO patch (Ixmp 's'): channel 2's pool span,
    same length and geometry as channel 1."""
    taud_lo = _it_note_to_taud(it_lo, clamp_low=(it_lo == 0))
    taud_hi = _it_note_to_taud(it_hi, clamp_high=(it_hi == 119))
    patches.append({
        'pitch_start':         taud_lo,
        'pitch_end':           taud_hi,
        'volume_start':        0,
        'volume_end':          63,
        'sample_ptr':          sample_ptr,
        'sample_length':       min(s.length, 65535),
        'play_start':          0,
        'loop_start':          ls,
        'loop_end':            le,
        'sampling_rate':       min(getattr(s, 'c5_speed', 8363), 65535),
        'sample_detune':       0,
        'loop_mode':           loop_mode,
        'default_pan':         default_pan,
        'default_note_volume': dnv,
        'vibrato_speed':       vib_speed,
        'vibrato_sweep':       0,                  # IT-side; FT2 sweep stays 0
        'vibrato_depth':       vib_depth,
        'vibrato_rate':        vib_rate,
        'vibrato_waveform':    vib_wave,
        **({'channels': {'mode': IXMP_CHAN_DISCRETE, 'flags': 0,
                         'ptrs': [sample_ptr_r]}} if sample_ptr_r is not None else {}),
    })


# ── Sample / instrument bin (same as s3m2taud) ────────────────────────────────

def build_sample_inst_bin_it(samples_or_proxy: list,
                              instr_data_by_slot: dict = None) -> tuple:
    """samples_or_proxy: list of ITSample | None, indexed 1-based (index 0 unused).

    instr_data_by_slot: optional dict mapping taud_slot → dict with keys:
        vol_env, vol_sus, pan_env, pan_sus, pf_env, pf_sus, pf_is_filter,
        inst_gv, fadeout, vib_speed, vib_depth, vib_sweep, vib_rate, vib_wave,
        default_pan, pps, ppc_taud, pan_swing, vol_swing, ifc, ifr,
        sample_detune, nna, dct, dca.
    All optional; missing keys default to neutral values.

    Returns (bin_bytes[SAMPLEINST_SIZE], offsets_dict, slot_ratios) where
    slot_ratios maps Taud slot index → effective TOP_O scale (combined
    global × per-sample resample ratio).
    """
    pcm_list = [(i, s) for i, s in enumerate(samples_or_proxy)
                if s is not None and s.sample_data]

    def _scale_sample(s, r):
        """Resample `s` by about `r` — exactly the ratio that keeps its shorter
        active loop a whole number of frames (taud_common.loop_resample_ratio),
        the other within half a frame — and return the ratio actually used,
        which the rate and TOP_O offsets follow."""
        loops = []
        if s.has_loop:
            loops.append((s.loop_beg, s.loop_end))
        if s.flags & IT_SMP_SUS_LOOP:
            loops.append((s.sus_beg, s.sus_end))
        r = loop_resample_ratio(r, loops)
        s.sample_data = resample_linear(s.sample_data, r)
        if getattr(s, 'sample_data_r', b''):
            # The pair must stay frame-aligned: resample channel 2 by the same
            # ratio and clamp it to channel 1's length (rounding can differ by 1).
            r2 = resample_linear(s.sample_data_r, r)
            n = len(s.sample_data)
            s.sample_data_r = (r2[:n] if len(r2) >= n
                               else r2 + bytes([0x80]) * (n - len(r2)))
        s.length      = len(s.sample_data)
        s.loop_beg, s.loop_end = scale_loop(s.loop_beg, s.loop_end, r, s.length)
        s.sus_beg, s.sus_end   = scale_loop(s.sus_beg, s.sus_end, r, s.length)
        s.c5_speed    = max(1, round(s.c5_speed * r))
        return r

    # ── Pass 1: global pool-overflow resample (8 MB cap) ────────────────────
    total = sum(len(s.sample_data) + len(getattr(s, 'sample_data_r', b''))
                for _, s in pcm_list)
    global_ratio = 1.0
    global_eff = {}           # id(s) → the ratio pass 1 actually applied to s
    if total > SAMPLEBIN_SIZE:
        global_ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); resampling all by {global_ratio:.4f}")
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

    # Effective slot → ratio for TOP_O rescaling. Slots sharing a sample
    # object (IT use_instruments mode) get the same ratio.
    slot_ratios = {}
    for slot_idx, s in pcm_list:
        slot_ratios[slot_idx] = global_eff.get(id(s), 1.0) * per_sample_ratio.get(id(s), 1.0)
    ratio = slot_ratios

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets    = {}
    pos        = 0
    # IT use_instruments mode points many Taud instrument slots at the same
    # underlying sample object (e.g. seven "ChipBass.*" instruments all play
    # "ChipBass.looped"). Write each distinct sample's PCM into the pool once and
    # let every referencing slot share the offset, rather than emitting one
    # identical copy per slot. `pool_order` records the distinct samples in
    # ascending-offset order — the order taut.js's sample viewer expects SNam to
    # follow (it dedupes instrument records by (ptr,len), sorts by ptr, and
    # matches SNam[i+1] positionally — see taut.js buildSampleIndex).
    written    = {}     # id(sample) -> pool offset already written
    written_r  = {}     # id(sample) -> channel-2 pool offset (stereo samples only)
    offsets_r  = {}     # slot idx -> channel-2 pool offset
    pool_order = []     # distinct sample objects, in pool (ascending-offset) order
    for idx, s in pcm_list:
        shared = written.get(id(s))
        if shared is not None:
            offsets[idx] = shared
            if id(s) in written_r:
                offsets_r[idx] = written_r[id(s)]
            continue
        n = min(len(s.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{s.name}'")
            offsets[idx] = 0; s.length = 0; continue
        sample_bin[pos:pos+n] = s.sample_data[:n]
        offsets[idx] = pos
        written[id(s)] = pos
        pool_order.append(s)
        if n < len(s.sample_data):
            vprint(f"  warning: '{s.name}' truncated {len(s.sample_data)} → {n}")
            s.length = n
            s.loop_end = min(s.loop_end, n)
            s.sus_end  = min(s.sus_end,  n)
        pos += n
        # Channel 2 of a stereo sample: its own span, same length, written
        # right after channel 1 so the pair stays adjacent in the pool. If it
        # cannot fit, the sample degrades to mono rather than to garbage.
        right = getattr(s, 'sample_data_r', b'')
        if right:
            nr = min(n, SAMPLEBIN_SIZE - pos)
            if nr < n:
                vprint(f"  warning: sample bin full, '{s.name}' falls back to mono")
                s.sample_data_r = b''
            else:
                sample_bin[pos:pos+nr] = right[:nr]
                written_r[id(s)] = pos
                offsets_r[idx] = pos
                pos += nr

    # 256-byte instrument layout (terranmon.txt:2001+).
    INST_STRIDE = 256
    USE_ENV_BIT     = 0x0020   # b — LOOP wrap enable (legacy; engine still honours)
    ENV_PRESENT_BIT = 0x2000   # P — envelope present in source (terranmon.txt byte 16/18/20 bit 5)

    def _write_env(buf: bytearray, base: int, env_pts):
        """Write 25 (value, minifloat) pairs starting at `buf[base]`. Pads
        with the previous value (or 0/0x80) and offset=0 if shorter than 25."""
        for k in range(25):
            if env_pts and k < len(env_pts):
                val, mf = env_pts[k]
            else:
                val = (env_pts[-1][0] if env_pts else 0)
                mf  = 0
            buf[base + k*2]     = val & 0xFF
            buf[base + k*2 + 1] = mf  & 0xFF

    inst_bin = bytearray(INSTBIN_SIZE)
    for i, s in enumerate(samples_or_proxy):
        taud_idx = i  # samples_or_proxy is 0-based here; slot 0 unused
        if i == 0 or i >= 256 or s is None:
            continue
        ptr      = offsets.get(i, 0) & 0xFFFFFFFF
        s_len    = min(s.length, 65535)
        c2spd    = min(s.c5_speed, 65535)
        # Sustain loop wins over the regular loop because Taud carries one loop
        # region. After key-off the engine drops the loop entirely (terranmon.txt:2007).
        if s.flags & IT_SMP_SUS_LOOP:
            ls = min(s.sus_beg, 65535)
            le = min(s.sus_end, 65535)
            sustain_bit = 0x4
            pingpong_active = bool(s.flags & IT_SMP_PINGPONG_SUS)
            has_active_loop = True
        elif s.has_loop:
            ls = min(s.loop_beg, 65535)
            le = min(s.loop_end, 65535)
            sustain_bit = 0x0
            pingpong_active = bool(s.flags & IT_SMP_PINGPONG)
            has_active_loop = True
        else:
            ls = min(s.loop_beg, 65535)
            le = min(s.loop_end, 65535)
            sustain_bit = 0x0
            pingpong_active = False
            has_active_loop = False
        if has_active_loop and pingpong_active:
            loop_mode = 2   # backandforth
        elif has_active_loop:
            loop_mode = 1   # forward loop
        else:
            loop_mode = 0   # no loop
        flags_byte = (loop_mode & 0x3) | sustain_bit

        base = taud_idx * INST_STRIDE
        struct.pack_into('<I', inst_bin, base + 0,  ptr)
        struct.pack_into('<H', inst_bin, base + 4,  s_len)
        struct.pack_into('<H', inst_bin, base + 6,  c2spd)
        struct.pack_into('<H', inst_bin, base + 8,  0) # play start. IT samples always start playing from zero
        struct.pack_into('<H', inst_bin, base + 10, ls)
        struct.pack_into('<H', inst_bin, base + 12, le)
        inst_bin[base + 14] = flags_byte

        idata = (instr_data_by_slot or {}).get(taud_idx) or {}
        vol_env       = idata.get('vol_env')
        pan_env       = idata.get('pan_env')
        pf_env        = idata.get('pf_env')
        # LOOP words live at offsets 15/17/19. SUSTAIN words at 189/191/193.
        # When the source has neither loop nor sustain on the volume envelope
        # the engine still needs the b flag so the single-point unit envelope
        # is evaluated — synthesise USE_ENV_BIT into the LOOP word as a fallback.
        # The P bit is informational for vol but set for consistency.
        vol_env_loop  = idata.get('vol_env_loop', USE_ENV_BIT | ENV_PRESENT_BIT)
        vol_env_sus   = idata.get('vol_env_sus',  0)
        pan_env_loop  = idata.get('pan_env_loop', 0)
        pan_env_sus   = idata.get('pan_env_sus',  0)
        pf_env_loop   = idata.get('pf_env_loop',  0)
        pf_env_sus    = idata.get('pf_env_sus',   0)
        # Sample-mode default IGV is now a pure continuous multiplier
        # (sample.gv only — there is no inst.gv in IT sample mode). The
        # samplewise default vol (Sv) is carried separately by byte 196.
        # Instrument-mode supplies both inst_gv and default_note_vol pre-
        # computed in the upstream proxy walk.
        if 'inst_gv' in idata:
            inst_gv = idata['inst_gv']
        else:
            smp_gv_default  = min(getattr(s, 'gv', 64), 64)
            inst_gv = min(255, round(smp_gv_default * 255 / 64))
        if 'default_note_vol' in idata:
            default_note_vol = idata['default_note_vol']
        else:
            smp_vol_default = min(getattr(s, 'vol', 64), 64)
            default_note_vol = min(255, round(smp_vol_default * 255 / 64))
        # IT fadeout (file-stored 0..1024 per ITTECH; some loaders accept up to 2048) maps
        # verbatim to Taud's 12-bit fadeStep. Schism's per-tick decrement is stored / 1024 of
        # unit volume (sndmix.c:331-339, effects.c:1261: accumulator 65536, decrement
        # = (stored<<5)<<1 = stored*64) — identical to Taud's engine divisor of 1024. Clamp
        # defensively to 4095. See terranmon.txt byte 172/173 and TAUD_NOTE_EFFECTS.md §1
        # "Volume Fadeout".
        fadeout = min(0xFFF, idata.get('fadeout', 0) & 0xFFFF)

        # LOOP words at offsets 15/17/19.
        struct.pack_into('<H', inst_bin, base + 15, vol_env_loop & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 17, pan_env_loop & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 19, pf_env_loop  & 0xFFFF)

        if vol_env:
            _write_env(inst_bin, base + 21,  vol_env)
        else:
            # Single-point envelope held at full-scale; the per-sample level is
            # carried by IGV (byte 171), so the envelope must be a unit multiplier.
            inst_bin[base + 21] = 63
            inst_bin[base + 22] = 0
            # Force engine to use this single point — set the b bit on the LOOP
            # word so the envelope is evaluated even though no wrap region exists.
            # P is also set for consistency (vol-env presence is informational
            # but converters mark it whenever they emit any node data).
            cur_loop = struct.unpack_from('<H', inst_bin, base + 15)[0]
            struct.pack_into('<H', inst_bin, base + 15, cur_loop | USE_ENV_BIT | ENV_PRESENT_BIT)

        if pan_env:
            _write_env(inst_bin, base + 71, pan_env)
        else:
            for k in range(25):
                inst_bin[base + 71 + k*2]     = 0x80
                inst_bin[base + 71 + k*2 + 1] = 0x00

        if pf_env:
            _write_env(inst_bin, base + 121, pf_env)
        else:
            for k in range(25):
                inst_bin[base + 121 + k*2]     = 0x80
                inst_bin[base + 121 + k*2 + 1] = 0x00

        inst_bin[base + 171] = inst_gv & 0xFF
        inst_bin[base + 172] = fadeout & 0xFF                                # low 8 bits
        # Byte 173: low nibble = fadeout high bits (0b 0000 ffff).
        inst_bin[base + 173] = (fadeout >> 8) & 0x0F
        inst_bin[base + 174] = idata.get('vol_swing',   0) & 0xFF
        inst_bin[base + 175] = idata.get('vib_speed',   0) & 0xFF
        inst_bin[base + 176] = idata.get('vib_sweep',   0) & 0xFF
        inst_bin[base + 177] = idata.get('default_pan', 0x80) & 0xFF
        struct.pack_into('<H', inst_bin, base + 178,
                         idata.get('ppc_taud', 0x5000) & 0xFFFF)
        # PPS is signed (-128..+127); struct 'b' handles the conversion.
        struct.pack_into('b', inst_bin, base + 180,
                         max(-128, min(127, idata.get('pps', 0))))
        inst_bin[base + 181] = idata.get('pan_swing', 0) & 0xFF
        inst_bin[base + 182] = idata.get('ifc',     255) & 0xFF
        inst_bin[base + 183] = idata.get('ifr',     255) & 0xFF
        # Bytes 184-185: sample detune (4096-TET, signed stored as u16).
        struct.pack_into('<H', inst_bin, base + 184,
                         idata.get('sample_detune', 0) & 0xFFFF)
        # Byte 186: instrument flag — 0b 000 www nn
        #     nn = NNA (Taud encoding: 00=note off, 01=cut, 10=continue, 11=fade)
        #     www = vibrato waveform (0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up FT2)
        # The default is CUT, not the 00 the field happens to encode: the only
        # caller that omits 'nna' is the sample-mode branch, and IT sample mode
        # has no NNA at all — a new note replaces the channel's voice outright.
        # Defaulting to 00 (note off) spawned a ghost per trigger that, with no
        # volume envelope and fadeout 0, never stopped ringing. Same choice the
        # mod/s3m/xm/mon converters make for their own NNA-less sources.
        nna = idata.get('nna', 0b01) & 0x03
        vib_wave = idata.get('vib_wave', 0) & 0x07
        inst_bin[base + 186] = (vib_wave << 2) | nna
        # Byte 187: vibrato depth (0..255 full range).
        inst_bin[base + 187] = idata.get('vib_depth', 0) & 0xFF
        # Byte 188: vibrato rate (0..255 full range, IT samplewise Vir).
        inst_bin[base + 188] = idata.get('vib_rate', 0) & 0xFF
        # SUSTAIN words at offsets 189/191/193.
        struct.pack_into('<H', inst_bin, base + 189, vol_env_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 191, pan_env_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 193, pf_env_sus  & 0xFFFF)
        # Byte 195: duplicate-check / action (IT-only — bits 0-1 = DCT, bits 2-3 = DCA).
        # Relocated 2026-05-06 from old offset 189 (now part of the vol sustain word).
        dct = idata.get('dct', 0) & 0x03
        dca = idata.get('dca', 0) & 0x03
        inst_bin[base + 195] = (dca << 2) | dct
        # Byte 196: default note volume (per-trigger seed for the engine's
        # noteVolume axis when no V column accompanies a fresh trigger).
        # Replaces the old "fold sample.vol into IGV" trick — see terranmon
        # byte 196 / TODO §2350.
        inst_bin[base + 196] = default_note_vol & 0xFF
        # Bytes 197..255: reserved (already zeroed).

        vprint(f"  instrument[{taud_idx}] '{s.name}' ptr:{ptr} c5spd:{s.c5_speed}")

    return bytes(sample_bin) + bytes(inst_bin), offsets, ratio, pool_order, offsets_r


# ── Pattern builder ───────────────────────────────────────────────────────────

def _it_default_pan(raw_pan: int) -> int:
    """Convert raw IT channel-pan byte to Taud 0..63."""
    if raw_pan == 100:   # surround → centre
        return 31
    p = raw_pan & 0x7F
    return min(0x3F, round(p * 63 / 64))

def build_pattern_it(chunk_grid: list, ch_idx: int, default_pan: int,
                     inst_vols: dict, amiga_mode: bool = False) -> bytes:
    """Build a 512-byte Taud pattern for one IT channel from a 64-row chunk grid."""
    out = bytearray(PATTERN_BYTES)
    rows = chunk_grid[ch_idx] if ch_idx < len(chunk_grid) else [ITRow()] * PATTERN_ROWS
    last_note_it = -1
    # IT shares one mem_vc_volslide across A/B/C/D vol-col commands (Schism
    # player/effects.c:2099-2131). Track it locally so x=0 resolves to the
    # last explicit value within the chunk.
    mem_vc_volslide = 0

    for r, cell in enumerate(rows[:PATTERN_ROWS]):
        # ── Resolve vol-col into overrides ──────────────────────────────────
        # Update mem_vc_volslide before decode so a fresh non-zero on this
        # row stays visible for any later x=0 in the same channel.
        if (VC_FVUP_LO <= cell.volcol <= VC_VDN_HI):
            raw_mag = (cell.volcol - VC_FVUP_LO) % 10
            if raw_mag != 0:
                mem_vc_volslide = raw_mag
        vs, vv, pan_from_vc, aux_eff = decode_volcol(cell.volcol, mem_vc_volslide)

        # ── Slot juggling: combine D + G/H into L/K when both are present ──
        # When the main effect is a pure vol-slide (D) and the vol-col aux is
        # tone-porta (G) or vibrato depth (H), Taud has dedicated combined
        # opcodes that capture both: L $xy00 (porta + vol slide) and K $xy00
        # (vibrato + vol slide). Without this swap the vol-col aux would be
        # dropped because the main slot is occupied.
        if aux_eff is not None and cell.effect == EFF_D and cell.effect_arg != 0:
            aux_op, aux_arg = aux_eff
            d_arg = cell.effect_arg & 0xFF
            if aux_op == EFF_G:
                cell.effect, cell.effect_arg = EFF_L, d_arg
                aux_eff = None
            elif aux_op == EFF_H:
                # K runs vibrato with current memory_HU; vol-col Hh's depth
                # update is lost (warn so the trade-off is visible).
                cell.effect, cell.effect_arg = EFF_K, d_arg
                aux_eff = None
                if (aux_arg & 0xF) != 0:
                    vprint(f"    ch{ch_idx} row{r}: D+Hh→K, depth update "
                           f"{aux_arg & 0xF} folded into K vibrato recall")

        # If vol-col provides an aux effect and cell has no main effect, use it
        if aux_eff is not None and cell.effect == 0:
            cell.effect, cell.effect_arg = aux_eff
            aux_eff = None
        elif aux_eff is not None:
            vprint(f"    ch{ch_idx} row{r}: dropped vol-col aux effect "
                   f"(main effect slot occupied: cmd={cell.effect:02X} arg={cell.effect_arg:02X})")
            aux_eff = None

        # If vol-col has a pan override
        if pan_from_vc is not None:
            cell.pan_set = pan_from_vc

        # Encode main effect
        op, arg16, vol_override, pan_override = encode_effect_it(
            cell.effect, cell.effect_arg, ch_idx, r, amiga_mode=amiga_mode)

        # ── Note ────────────────────────────────────────────────────────────
        note_taud = NOTE_NOP
        if cell.note >= 0:
            note_taud = encode_note_it(cell.note)

        note_triggers = (0 <= (cell.note if cell.note >= 0 else -1) <= 119)

        # ── Volume column ────────────────────────────────────────────────────
        # Priority: explicit cell vol (vol-col 0-64) > vol-col slide > main-
        # effect vol override > nop. Per-trigger default volume now lives
        # in byte 196 of the instrument record (DNV); the engine seeds
        # noteVolume from it when this row has no V column, so the converter
        # still doesn't need to emit SEL_SET=Sv on plain trigger rows.
        if cell.volcol >= 0 and cell.volcol <= VC_VOL_HI:
            vol_sel, vol_value = SEL_SET, min(cell.volcol, 0x3F)
        elif vs != SEL_FINE or vv != 0:
            vol_sel, vol_value = vs, vv
        elif vol_override is not None:
            vol_sel, vol_value = vol_override
        else:
            vol_sel, vol_value = SEL_FINE, 0

        if cell.note is not None and 0 <= (cell.note if cell.note >= 0 else -1) <= 119:
            last_note_it = cell.note

        # ── Pan column ───────────────────────────────────────────────────────
        if cell.pan_set is not None:
            pan_sel, pan_value = SEL_SET, cell.pan_set
        elif pan_override is not None:
            pan_sel, pan_value = pan_override
        elif r == 0:
            pan_sel, pan_value = SEL_SET, default_pan & 0x3F
        else:
            pan_sel, pan_value = SEL_FINE, 0

        vol_byte = (vol_value & 0x3F) | ((vol_sel & 0x3) << 6)
        pan_byte = (pan_value & 0x3F) | ((pan_sel & 0x3) << 6)

        # Preserve cell.inst==0 verbatim — IT semantics: a note row with no
        # explicit instrument byte retriggers the channel's currently-loaded
        # instrument. Filling in last_inst converts that into an explicit
        # instrument-change, which can break NNA / envelope-reset behaviour.
        base = r * 8
        struct.pack_into('<H', out, base + 0, note_taud)
        out[base + 2] = cell.inst & 0xFF
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg16 & 0xFFFF)

    return bytes(out)


# ── Main assembly ─────────────────────────────────────────────────────────────

def relocate_late_note_delays(patterns_rows: list, order_list: list,
                              num_channels: int, initial_speed: int) -> None:
    """Move SDx-delayed notes to the next row when x ≥ tick speed.

    IT triggers a Note Delay during the current row; if x reaches the tick
    speed, the trigger never lands. When the next row in the same channel is
    empty, relocate the note (with delay = x − speed) so it actually plays.
    """
    visited = set()
    for order in order_list:
        if order >= IT_ORD_END:
            break
        if order >= len(patterns_rows) or order in visited:
            continue
        visited.add(order)
        grid, rows = patterns_rows[order]
        speed = initial_speed
        for r in range(rows):
            for ch in range(min(num_channels, len(grid))):
                cell = grid[ch][r]
                if cell.effect == EFF_A and cell.effect_arg > 0:
                    speed = cell.effect_arg
                    break
            if r + 1 >= rows or speed <= 0:
                continue
            for ch in range(min(num_channels, len(grid))):
                cell = grid[ch][r]
                if cell.effect != EFF_S or cell.note < 0:
                    continue
                if ((cell.effect_arg >> 4) & 0xF) != 0xD:
                    continue
                x = cell.effect_arg & 0xF
                if x < speed:
                    continue
                nxt = grid[ch][r + 1]
                if (nxt.note >= 0 or nxt.inst or nxt.effect or nxt.effect_arg
                        or nxt.vol != -1 or nxt.volcol != -1
                        or nxt.pan_set is not None or nxt.aux_effect is not None):
                    continue
                new_delay = x - speed
                nxt.note       = cell.note
                nxt.inst       = cell.inst
                nxt.vol        = cell.vol
                nxt.volcol     = cell.volcol
                nxt.pan_set    = cell.pan_set
                nxt.aux_effect = cell.aux_effect
                if new_delay > 0:
                    nxt.effect     = EFF_S
                    nxt.effect_arg = 0xD0 | (new_delay & 0xF)
                cell.note       = -1
                cell.inst       = 0
                cell.vol        = -1
                cell.volcol     = -1
                cell.pan_set    = None
                cell.aux_effect = None
                cell.effect     = 0
                cell.effect_arg = 0
                vprint(f"  fix: pat{order} ch{ch} row{r}: SD{x:X} ≥ speed{speed}, "
                       f"moved note to row{r+1}"
                       + (f" with SD{new_delay:X}" if new_delay > 0 else ""))


def find_initial_bpm_speed(patterns_rows: list, order_list: list,
                            default_speed: int, default_tempo: int) -> tuple:
    speed = default_speed or 6
    tempo = default_tempo or 125
    for order in order_list:
        if order >= IT_ORD_END: break
        if order >= len(patterns_rows): continue
        grid, _rows = patterns_rows[order]
        for ch_rows in grid:
            if not ch_rows: continue
            cell = ch_rows[0]
            if cell.effect == EFF_A and cell.effect_arg > 0:
                speed = cell.effect_arg
            if cell.effect == EFF_T and cell.effect_arg > 0:
                tempo = cell.effect_arg
        break
    return speed, tempo

def _active_channels(h: ITHeader, patterns_rows: list) -> list:
    """Return the non-muted, in-use channel indices (up to MAX_VOICES = 64).

    A song using 33..64 channels triggers 64-channel Taud mode (see assemble_taud);
    32 or fewer stays in the default 32-channel layout. Only a song exceeding 64
    active channels is capped."""
    # Muted = bit 7 of chnl_pan set, or == 0xC0
    muted = set()
    for i, p in enumerate(h.chnl_pan):
        if p & 0x80 or p == 0xC0:
            muted.add(i)

    # In-use = any non-empty cell appears on this channel
    in_use = set()
    for grid, rows in patterns_rows:
        for ch in range(64):
            if ch >= len(grid): continue
            for cell in grid[ch]:
                if cell.note >= 0 or cell.inst > 0 or cell.effect != 0:
                    in_use.add(ch)
                    break

    active = [i for i in range(64) if i in in_use and i not in muted]
    if len(active) > MAX_VOICES:
        vprint(f"  warning: {len(active)} active channels; capping at {MAX_VOICES}")
        active = active[:MAX_VOICES]
    return active

def _per_pattern_bxx_it(patterns_rows: list):
    """Return callable(pat_idx) → (set_of_bxx_target_orders, kills_fallthrough)
    for use by `detect_subsongs`. `kills_fallthrough` is True iff the pattern
    carries a Bxx on its absolute last row — the unconditional terminating
    jump idiom every tracker uses for "song ends here, loop back".
    """
    def fn(pat_idx: int):
        if pat_idx < 0 or pat_idx >= len(patterns_rows):
            return set(), False
        grid, rows = patterns_rows[pat_idx]
        targets = set()
        last_row_has_b = False
        for ch in range(64):
            if ch >= len(grid): continue
            ch_rows = grid[ch]
            for r in range(min(rows, len(ch_rows))):
                cell = ch_rows[r]
                if cell.effect == EFF_B:
                    targets.add(cell.effect_arg)
                    if r == rows - 1:
                        last_row_has_b = True
        return targets, last_row_has_b
    return fn


def _build_song_payload(h: ITHeader, patterns_rows_template: list,
                        positions: list, sample_ratio: dict,
                        inst_vols: dict, active_channels: list,
                        *, song_label: str = 'song') -> tuple:
    """Build pattern bin + cue sheet + song-entry kwargs for one subsong.

    Returns (pat_comp, cue_comp, entry_kwargs). The caller fills in
    `song_offset` from the global layout before calling encode_song_entry.

    `patterns_rows_template` is deep-copied so per-song stateful walks
    (recall resolution, late-note-delay relocation, Bxx remap on chunks)
    don't leak into the next subsong.
    """
    pats = copy.deepcopy(patterns_rows_template)
    virtual_orders = [h.order_list[pos] for pos in positions]

    vprint(f"  [{song_label}] resolving IT recalls…")
    resolve_it_recalls(pats, virtual_orders, 64, h.link_gef,
                       old_effects=h.old_effects)

    n_dropped = drop_porta_retriggers(pats, virtual_orders, 64)
    if n_dropped:
        vprint(f"  [{song_label}] dropped {n_dropped} instrument byte(s) from "
               f"porta-tied rows (IT envelope-retrigger bug)")

    init_speed, _ = find_initial_bpm_speed(pats, virtual_orders,
                                           h.initial_speed, h.initial_tempo)
    relocate_late_note_delays(pats, virtual_orders, 64, init_speed)

    chunks, chunk_map, chunk_lens = split_patterns(pats)

    C = len(active_channels)

    # 64-channel Taud mode when the song uses 33+ channels (terranmon.txt §xHDR).
    # Cue width follows: 128 bytes / 64 channels vs the default 64 bytes / 32 channels.
    cue_voices = MAX_VOICES if C > NUM_VOICES else NUM_VOICES
    cue_size   = cue_voices * 2
    cue_cap    = NUM_CUES_64 if cue_voices > NUM_VOICES else NUM_CUES

    # Cue list = expand each subsong position into chunk indices for its pattern.
    # pos_to_cue maps the original order-list position → first cue in this song.
    cue_list = []
    pos_to_cue = {}
    for pos in positions:
        order = h.order_list[pos]
        if order >= IT_ORD_END or order >= len(chunk_map):
            continue
        pos_to_cue[pos] = len(cue_list)
        for ci in chunk_map[order]:
            cue_list.append(ci)

    # Bxx remap: source-position → cue-index. Cross-subsong Bxx targets clamp
    # to cue 0 (loop the subsong rather than jump out of bounds). Only walk
    # chunks that this song actually emits — avoids spurious warnings on
    # patterns owned by other subsongs.
    _remap_bc_effects(chunks, chunk_map, virtual_orders, pos_to_cue, C,
                      default_target=0, warn_label=song_label,
                      chunk_indices=set(cue_list))

    speed, tempo = find_initial_bpm_speed(pats, virtual_orders,
                                          h.initial_speed, h.initial_tempo)
    tempo = max(25, min(280, tempo))
    bpm_stored = (tempo - 25) & 0xFF
    vprint(f"  [{song_label}] initial speed={speed}, tempo={tempo} BPM")

    default_pans = [_it_default_pan(h.chnl_pan[ch]) for ch in active_channels]
    total_taud_pats = len(cue_list) * C
    if total_taud_pats > NUM_PATTERNS_MAX:
        sys.exit(
            f"error: [{song_label}] {len(cue_list)} cues × {C} channels = "
            f"{total_taud_pats} > {NUM_PATTERNS_MAX} Taud pattern limit."
        )

    pat_bin = bytearray()
    for ci in cue_list:
        cg = chunks[ci]
        for vi, ch in enumerate(active_channels):
            pat_bin += build_pattern_it(cg, ch, default_pans[vi], inst_vols,
                                          amiga_mode=not h.linear_slides)

    pat_bin = rescale_offset_effects_per_slot(
        bytes(pat_bin), len(cue_list), C, sample_ratio)

    orig_count = len(cue_list) * C
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(pat_bin, orig_count)
    vprint(f"  [{song_label}] patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    empty_cue = encode_cue([], 0, num_voices=cue_voices)
    sheet = bytearray(cue_cap * cue_size)
    for c in range(cue_cap):
        sheet[c*cue_size:(c+1)*cue_size] = empty_cue

    n_emit = min(len(cue_list), cue_cap)
    len_cue_count = 0
    for cue_idx in range(n_emit):
        ci = cue_list[cue_idx]
        base_pat = cue_idx * C
        pat_idx_list = [pat_remap[base_pat + vi] for vi in range(C)]
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
        sheet[cue_idx*cue_size:(cue_idx+1)*cue_size] = encode_cue(pat_idx_list, instr, num_voices=cue_voices)

    if n_emit == 0:
        set_cue_instruction(sheet, 0, CUE_INST_HALT, num_voices=cue_voices)
    if len_cue_count:
        vprint(f"  [{song_label}] emitted {len_cue_count} LEN cue instruction(s) "
               f"for partial-length patterns")

    cue_bytes, num_cues = finalize_cue_sheet(sheet, num_voices=cue_voices)
    pat_comp = compress_blob(bytes(pat_bin), f"[{song_label}] pattern bin")
    cue_comp = compress_blob(cue_bytes,      f"[{song_label}] cue sheet")

    flags_byte = 0x00 if h.linear_slides else 0x01
    global_vol_taud = min(0xFF, round(h.global_vol * 255 / 128))
    mixing_vol_taud = min(0xFF, round(h.mix_vol    * 255 / 128))

    entry_kwargs = dict(
        num_voices=C,
        num_patterns=num_taud_pats,
        bpm_stored=bpm_stored,
        tick_rate=speed,
        base_note=0xA000,   # C9
        base_freq=8363.0,
        flags_byte=flags_byte,
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        global_vol=global_vol_taud,
        mixing_vol=mixing_vol_taud,
        num_cues=num_cues,
    )
    return pat_comp, cue_comp, entry_kwargs


def assemble_taud(h: ITHeader, samples: list, instruments: list,
                  patterns_rows: list, decompress: bool,
                  with_project_data: bool = True) -> bytes:
    # ── Active channels (shared across subsongs) ─────────────────────────────
    active_channels = _active_channels(h, patterns_rows)
    C = len(active_channels)
    if C == 0:
        sys.exit("error: no active channels found")
    # 64-channel Taud mode when the song uses 33+ channels (terranmon.txt §xHDR).
    is_64ch = C > NUM_VOICES
    if is_64ch:
        vprint(f"  64-channel mode: {C} active channels (>32)")

    # ── SBx chunk-crossing warning (informational only; pattern data is read,
    #    not modified, so this is safe to do once over the shared template) ──
    for pi, (grid, rows) in enumerate(patterns_rows):
        if rows <= PATTERN_ROWS: continue
        for ch in range(64):
            if ch >= len(grid): continue
            loop_start_chunk = None
            for r, cell in enumerate(grid[ch]):
                if cell.effect == EFF_S:
                    sub = (cell.effect_arg >> 4) & 0xF
                    val = cell.effect_arg & 0xF
                    k = r // PATTERN_ROWS
                    if sub == 0xB and val == 0:
                        loop_start_chunk = k
                    elif sub == 0xB and val > 0:
                        if loop_start_chunk is not None and k != loop_start_chunk:
                            vprint(f"  warning: pattern {pi} ch{ch}: SBx crosses "
                                   f"chunk boundary (loops may misbehave)")
                            break

    # ── Build sample proxy list (0-indexed, slot 0 unused) ──────────────────
    # When use_instruments: map Taud instrument slots to samples via canonical_sample.
    # Pattern cells carry IT instrument numbers; for use_instruments mode, those
    # are instrument indices; we remap to samples below.
    # Taud only knows "instrument" slots (1-based, 8-bit). We lay samples in order.
    # Map IT sample (0-based) → IXMP patch dict template used when building the
    # per-instrument patch list. Populated by the use_instruments branch below.
    it_sample_patch_meta = {}

    if h.use_instruments:
        # Build a proxy sample list where Taud inst slot = IT inst index,
        # resolved to the canonical sample. Slot 0 unused.
        proxy = [None] * (max(len(instruments), 256) + 1)
        inst_vols = {}
        instr_data_by_slot = {}
        for ii, inst in enumerate(instruments):
            taud_slot = ii + 1
            if taud_slot >= 256: break
            if inst is None: continue
            si = inst.canonical_sample - 1   # 0-based sample index
            if si < 0 or si >= len(samples) or samples[si] is None:
                continue
            src_smp = samples[si]
            proxy[taud_slot] = src_smp
            # IT splits per-sample volume into TWO concepts that Taud now
            # carries in two separate bytes:
            #   * inst.gv (0..128) * sample.gv (0..64) — continuous multiplier
            #     on every output sample (matches Schism's
            #     `chan->instrument_volume = (psmp->global_volume * penv->global_volume) >> 7`,
            #     csndfile.c:1317). Goes to byte 171 (IGV).
            #   * sample.vol (Sv, 0..64) — per-trigger seed for chan->volume,
            #     replaceable by an explicit V column on the same row (Schism
            #     effects.c:1302, :1432, :1819). Goes to byte 196 (DNV).
            # Folding sample.vol into IGV (the pre-2026-05-09 layout) caused
            # any V-column override on a sample with default vol < 64 to be
            # attenuated a second time — see terranmon §2350.
            smp_default_vol = min(getattr(src_smp, 'vol', 64), 64)
            inst_vols[taud_slot] = min(smp_default_vol, 0x3F)
            smp_gv = min(getattr(src_smp, 'gv', 64), 64)
            inst_gv_255 = min(255, round(inst.gv * smp_gv * 255 / (128 * 64)))
            default_note_vol_255 = min(255, round(smp_default_vol * 255 / 64))

            # IT pitch-pan centre: note number 0..119 (C-5 = 60). The Taud
            # representation is the absolute 4096-TET note value used in patterns
            # (anchored to TAUD_C4 at IT note 60).
            ppc_taud = TAUD_C4 + (max(0, min(119, inst.ppc)) - 60) * 4096 // 12

            # IT default pan: instrumentwise (IMPI+0x19) takes precedence when
            # its "use" bit is set; otherwise samplewise (IMPS+0x2F) wins when
            # its "use" bit is set; otherwise centre (0x80). Both fields encode
            # 0..64 → rescale to Taud's 0..255 range.
            smp_dfp_raw = getattr(src_smp, 'dfp', 0)
            if inst.dfp is not None:
                default_pan = min(255, max(0, round(inst.dfp * 255 / 64)))
            elif smp_dfp_raw & 0x80:
                default_pan = min(255, max(0, round((smp_dfp_raw & 0x7F) * 255 / 64)))
            else:
                default_pan = 0x80

            # Auto-vibrato lives on the canonical sample (not the IT instrument).
            # IT samplewise auto-vibrato: Vis (speed 0..64), Vid (depth 0..64),
            # Vir (rate 0..255 — IT-style ramp-in), Vit (waveform 0..3).
            # Taud byte 175 (Vibrato Speed) follows FT2 0..255 scale: rescale Vis.
            # Taud byte 187 (Vibrato Depth) is full 0..255: rescale Vid 0..64 → 0..255.
            # Taud byte 188 (Vibrato Rate) is IT Vir verbatim.
            # Taud byte 176 (Vibrato Sweep) is FT2-only — leave 0 for IT.
            #
            # Vir 0 means the depth accumulator never leaves zero, so IT plays
            # NO auto-vibrato however deep Vid is (openmpt123 renders such a
            # sample dead flat). Taud reads a zero ramp field as "full depth at
            # once" — the FT2 sweep convention, and the one the instrument
            # editor needs — so the silence has to be carried as depth 0.
            vib_speed_taud = min(255, round(src_smp.av_speed * 255 / 64))
            vib_depth_taud = (0 if (src_smp.av_sweep & 0xFF) == 0
                              else min(255, round(src_smp.av_depth * 255 / 64)))
            # IT NNA (0=cut, 1=continue, 2=note off, 3=note fade) →
            # Taud NNA  (00=note off, 01=cut, 10=continue, 11=fade).
            it_to_taud_nna = (0b01, 0b10, 0b00, 0b11)
            nna_taud = it_to_taud_nna[inst.nna & 0x03]

            instr_data_by_slot[taud_slot] = {
                'vol_env':       inst.vol_envelope,
                'vol_env_loop':  inst.vol_env_loop,
                'vol_env_sus':   inst.vol_env_sus,
                'pan_env':       inst.pan_envelope,
                'pan_env_loop':  inst.pan_env_loop,
                'pan_env_sus':   inst.pan_env_sus,
                'pf_env':        inst.pf_envelope,
                'pf_env_loop':   inst.pf_env_loop,
                'pf_env_sus':    inst.pf_env_sus,
                'inst_gv': inst_gv_255,
                'default_note_vol': default_note_vol_255,
                'fadeout': inst.fadeout,
                'vib_speed':  vib_speed_taud,
                'vib_depth':  vib_depth_taud,
                'vib_sweep':  0,                       # FT2-only; IT uses vib_rate
                'vib_rate':   src_smp.av_sweep & 0xFF, # IT Vir (samplewise sweep)
                'vib_wave':   src_smp.av_wave & 0x07,  # IT vib type (0..3)
                'default_pan': default_pan,
                'pps':        inst.pps,
                'ppc_taud':   ppc_taud & 0xFFFF,
                'pan_swing':  min(255, round(inst.rp * 255 / 64)) if inst.rp else 0,
                'vol_swing':  min(255, round(inst.rv * 255 / 100)) if inst.rv else 0,
                'ifc':        inst.ifc,
                'ifr':        inst.ifr,
                'sample_detune': 0,                    # IT samples have no finetune
                'nna':        nna_taud,
                'dct':        inst.dct,
                'dca':        inst.dca,
            }
        # ── Ixmp: pool keyboard-referenced extra samples beyond slot 255 ───────
        # IT instruments can map different IT notes to different samples via the
        # keyboard table (IMPI+0x44). The canonical sample is already in the proxy
        # at the instrument's Taud slot; extras (any other sample referenced in
        # the keyboard) get appended past index 256 so build_sample_inst_bin_it
        # pools them (its inst-record loop skips i >= 256 — see the same file).
        # We then look up their bin offsets via the returned offsets dict and
        # emit one Ixmp patch per (sample, contiguous-note-range) pair.
        extras_keys = []   # ordered list of ('it_smp', si) — index into the proxy is 256 + position
        for ii, inst in enumerate(instruments):
            if inst is None: continue
            canonical = inst.canonical_sample
            kbd = getattr(inst, 'keyboard', None) or []
            for kb_smp in kbd:
                if kb_smp == 0 or kb_smp == canonical:
                    continue
                si = kb_smp - 1
                if 0 <= si < len(samples) and samples[si] is not None and samples[si].sample_data:
                    key = ('it_smp', si)
                    if key not in extras_keys:
                        extras_keys.append(key)
        extras_base = len(proxy)
        for key in extras_keys:
            proxy.append(samples[key[1]])

        sampleinst_raw, bin_offsets, sample_ratio, pool_order, bin_offsets_r = build_sample_inst_bin_it(proxy, instr_data_by_slot)
        # Map ('it_smp', si) → sample-bin offset (and channel 2's, when the
        # sample is stereo — the Ixmp patch needs both pointers).
        extras_offsets = {key: bin_offsets.get(extras_base + j, 0)
                          for j, key in enumerate(extras_keys)}
        extras_offsets_r = {key: bin_offsets_r[extras_base + j]
                            for j, key in enumerate(extras_keys)
                            if (extras_base + j) in bin_offsets_r}
        # Also include each canonical sample at its taud-slot offset so the patch
        # builder can reuse them when an instrument's keyboard cell references the
        # canonical sample at a non-canonical note range.
        for ii, inst in enumerate(instruments):
            if inst is None: continue
            taud_slot = ii + 1
            if taud_slot >= 256: continue
            canon = inst.canonical_sample
            if canon == 0: continue
            si = canon - 1
            if 0 <= si < len(samples) and samples[si] is not None and ('it_smp', si) not in extras_offsets:
                # Look up the pool offset for the canonical via the proxy slot.
                if taud_slot in bin_offsets:
                    extras_offsets[('it_smp', si)] = bin_offsets[taud_slot]
                    if taud_slot in bin_offsets_r:
                        extras_offsets_r[('it_smp', si)] = bin_offsets_r[taud_slot]
    else:
        # Samples referenced directly; proxy is samples list (0-based, slot 0 unused).
        # No instruments in the file → no multi-sample mapping → no Ixmp patches.
        proxy = [None] + list(samples)
        inst_vols = {
            i+1: min(s.vol, 0x3F)
            for i, s in enumerate(samples)
            if s is not None
        }
        # An IT sample still carries three things the base record has fields for,
        # and leaving them at their neutral defaults loses them: its own default
        # pan (IMPS+0x2F), its auto-vibrato (Vis/Vid/Vir/Vit at IMPS+0x4C), and
        # its New Note Action — which sample mode does not have at all, so a new
        # note replaces the voice outright and the record must say Note Cut.
        # The Ixmp patch builder (_it_patch_fields) already forwards the first
        # two for the stereo-sample patches it emits from this same branch; the
        # base record was the odd one out.
        instr_data_by_slot = {}
        for i, s in enumerate(samples):
            if s is None:
                continue
            smp_dfp = getattr(s, 'dfp', 0)
            instr_data_by_slot[i + 1] = {
                'nna':        0b01,                    # Note Cut
                'default_pan': (min(255, max(0, round((smp_dfp & 0x7F) * 255 / 64)))
                                if (smp_dfp & 0x80) else 0x80),
                'vib_speed':  min(255, round(getattr(s, 'av_speed', 0) * 255 / 64)),
                # Vir 0 = IT never ramps the depth in, i.e. no vibrato at all.
                'vib_depth':  (0 if (getattr(s, 'av_sweep', 0) & 0xFF) == 0
                               else min(255, round(getattr(s, 'av_depth', 0) * 255 / 64))),
                'vib_sweep':  0,                       # FT2-only; IT uses vib_rate
                'vib_rate':   getattr(s, 'av_sweep', 0) & 0xFF,   # IT Vir
                'vib_wave':   getattr(s, 'av_wave',  0) & 0x07,
            }
        sampleinst_raw, bin_offsets, sample_ratio, pool_order, bin_offsets_r = build_sample_inst_bin_it(proxy, instr_data_by_slot)
        extras_offsets = {}
        extras_offsets_r = {}

    assert len(sampleinst_raw) == SAMPLEINST_SIZE

    compressed   = compress_blob(sampleinst_raw, "sample+inst bin")
    comp_size    = len(compressed)

    # ── Detect subsongs ──────────────────────────────────────────────────────
    subsongs = detect_subsongs(h.order_list, _per_pattern_bxx_it(patterns_rows),
                               terminators=(IT_ORD_END,),
                               skip_marker=IT_ORD_SKIP)
    if not subsongs:
        # Degenerate file: every order is a terminator. Emit one empty subsong.
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
    song_payloads = []   # list of (pat_comp, cue_comp, entry_kwargs)
    for i, ss in enumerate(subsongs):
        label = f"song {i}" if n_songs > 1 else "song"
        song_payloads.append(_build_song_payload(
            h, patterns_rows, ss['positions'],
            sample_ratio, inst_vols, active_channels,
            song_label=label))

    # ── Compute layout offsets and assemble song table ───────────────────────
    song_table_off = TAUD_HEADER_SIZE + comp_size
    first_song_off = song_table_off + TAUD_SONG_ENTRY * n_songs

    song_table = bytearray()
    cur_off = first_song_off
    for pat_comp, cue_comp, entry_kwargs in song_payloads:
        entry = encode_song_entry(song_offset=cur_off, **entry_kwargs)
        assert len(entry) == TAUD_SONG_ENTRY
        song_table += entry
        cur_off += len(pat_comp) + len(cue_comp)

    # ── Project Data (optional) ──────────────────────────────────────────────
    # IT distinguishes instruments from samples, so both INam and SNam can carry
    # distinct content. Slot 0 is unused, so the tables are 1-indexed with an
    # empty slot-0 entry.
    proj_data = b''
    proj_off  = 0
    # 64-channel mode REQUIRES an xHDR section (else the version bit-5 file is invalid),
    # so emit project data even when --no-project-data would otherwise skip it — in that
    # case only the xHDR block is written, no names/Ixmp.
    if with_project_data or is_64ch:
        pd_kwargs = dict(is_64channel=is_64ch)
        if with_project_data:
            inst_names = [''] + [(inst.name if inst is not None else '')
                                 for inst in instruments[:255]]
            # SNam mirrors the deduplicated sample pool: one entry per distinct
            # sample, in pool order (0-based), named after the sample itself. The
            # reader dedupes instrument records by (ptr,len), sorts ascending by
            # ptr, and matches SNam[i] positionally to that list, so this ordering
            # labels every sample correctly and a shared sample (e.g.
            # "ChipBass.looped") appears exactly once instead of once per
            # referencing instrument slot.
            smp_names  = [(getattr(s, 'name', '') or '')
                          for s in pool_order[:255]]

            # Ixmp patches — only the use_instruments branch maps IT notes to multiple
            # samples; the sample-mode branch has nothing to emit because there's no
            # keyboard table on a raw IT sample.
            ixmp_patches = {}
            if h.use_instruments and extras_offsets:
                for ii, inst in enumerate(instruments):
                    if inst is None: continue
                    taud_slot = ii + 1
                    if taud_slot >= 256: continue
                    patches = _build_it_ixmp_patches(inst, samples, extras_offsets,
                                                     extras_offsets_r)
                    if patches:
                        ixmp_patches[taud_slot] = patches
            elif bin_offsets_r:
                # Sample mode: no keyboard table, so the only patches needed are
                # the ones that carry a STEREO sample's second channel — one
                # full-range patch per stereo slot (item 90).
                for slot, ptr_r in bin_offsets_r.items():
                    if not (1 <= slot < 256):
                        continue
                    smp = samples[slot - 1] if slot - 1 < len(samples) else None
                    if smp is None or not smp.sample_data:
                        continue
                    ixmp_patches[slot] = _build_it_stereo_patch(
                        smp, bin_offsets.get(slot, 0), ptr_r)
            if ixmp_patches:
                vprint(f"  ixmp: {sum(len(p) for p in ixmp_patches.values())} "
                       f"patches across {len(ixmp_patches)} instruments")

            # IT's song message becomes PMsg (item 115.2) — the only project
            # string IT carries beyond the title.
            it_message = h.message
            if it_message:
                vprint(f"  message: {len(it_message)} chars, "
                       f"{it_message.count(chr(10)) + 1} lines -> PMsg")
            pd_kwargs.update(project_name=h.title,
                             message=it_message,
                             instrument_names=inst_names,
                             sample_names=smp_names,
                             ixmp_patches=ixmp_patches or None)

        proj_data = build_project_data(**pd_kwargs)
        if proj_data:
            proj_off = cur_off
            vprint(f"  project data: {len(proj_data)} bytes @ offset {proj_off}")

    # ── Header ───────────────────────────────────────────────────────────────
    # Version byte carries the xHDR bit (0x20) in 64-channel mode (terranmon.txt §xHDR).
    sig = (SIGNATURE + b' ' * 14)[:14]
    version_byte = TAUD_VERSION | (XHDR_FLAG if is_64ch else 0)
    header = (
        TAUD_MAGIC +
        bytes([version_byte, n_songs & 0xFF]) +
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
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .it file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--no-decompress', action='store_true',
                    help='Treat compressed IT samples as silent (debug)')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the optional Project Data section '
                         '(song / instrument / sample names)')
    ap.add_argument('--mono-samples', action='store_true',
                    help='Downmix stereo IT samples to mono instead of keeping '
                         'both channels (a stereo sample costs twice the pool '
                         'bytes and needs an Ixmp stereo patch)')
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    h = parse_it_header(data)
    vprint(f"  title: '{h.title}'")
    vprint(f"  orders={h.ord_count} insts={h.ins_count} "
           f"samples={h.smp_count} patterns={h.pat_count}")
    vprint(f"  flags: linear={h.linear_slides} use_inst={h.use_instruments} "
           f"link_gef={h.link_gef}")

    samples     = parse_samples(data, h, decompress=not args.no_decompress,
                                keep_stereo=not args.mono_samples)
    instruments = parse_instruments(data, h) if h.use_instruments else []
    patterns_rows = parse_patterns(data, h)

    taud = assemble_taud(h, samples, instruments, patterns_rows,
                         decompress=not args.no_decompress,
                         with_project_data=not args.no_project_data)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)
        sig_off = TAUD_HEADER_SIZE - 14
        print(f"  signature: {taud[sig_off:sig_off+14]}", file=sys.stderr)

if __name__ == '__main__':
    main()
