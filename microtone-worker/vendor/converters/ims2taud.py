#!/usr/bin/env python3
"""ims2taud.py — Iyagi Music Sound (.IMS) to TSVM Taud (.taud)

Usage:
    python3 ims2taud.py input.ims output.taud [-b song.BNK] [-b STANDARD.BNK] [-v]

IMS is the music format of "Iyagi", the Korean BBS terminal of the early 1990s:
an AdLib ROL score converted to a MIDI-shaped event stream at 240 ticks per beat,
with the instrument patches named — not stored — so a companion `.BNK` bank has
to supply them.  Its titles are 2-byte Johab Korean.

What this converter does:

    - recovers the composer's ROW GRID from the delta times.  ROL was a
      step sequencer, so the greatest common divisor of every delta IS the
      original tick, and `240 ÷ gcd` the rows per beat.  Every observed GCD
      divides 240, so no event is ever quantised away.
    - compiles each patch the song names into a Taud FM operator rack
      (opl2taud), fitted to the notes that song actually plays it at
    - writes eleven channels, one per OPL voice — channel IS voice in this
      format, so there is no allocation to do — with notes, pitch bends,
      volumes and tempo changes on the grid
    - declares the song's tuning as the chip's own middle C, so a converted
      note sounds at the frequency the AdLib card would have given it

Bends are the hard part and the biggest source of loss: IMS uses 2.6 million of
them across the reference corpus — they are not an ornament, they are how the
format writes portamento and vibrato — and they are followed here at ROW
resolution with fine pitch slides, which is exact at every row boundary and
loses the shape in between.

See TAUD_CONVERSION_NOTES.md for what else does not survive.
"""

import argparse
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEINST_SIZE, PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX,
    NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF,
    TOP_NONE, TOP_A, TOP_E, TOP_F, TOP_T,
    SEL_SET, SEL_FINE,
    encode_cue, finalize_cue_sheet, set_cue_instruction,
    cue_instruction_len, cue_instruction_halt_at,
    deduplicate_patterns, encode_song_entry, compress_blob, build_project_data,
)
import opl2taud as opl
from opl2taud import escape_non_ascii, volume_column

try:
    from johab2unicode import decode_johab_field
except ImportError:                                   # decoder not installed
    def decode_johab_field(b, **kw):
        return b.decode('latin-1')


SIGNATURE = b"ims2taud/TSVM "     # 14 bytes

IMS_HEADER_SIZE = 70
IMS_PATCH_NAME_LEN = 9

#: Event kinds the row builder understands.
NOTE_ON, NOTE_OFF, VOLUME, PATCH, BEND, TEMPO, END = range(7)

#: What the AdLib driver leaves every channel at before a song touches it.
DEFAULT_VOLUME = 127
MID_PITCH = 0x2000

#: What IMPLAY loads when a song names a patch its bank does not have, or when
#: there is no bank at all: the AdLib driver's own built-in timbres, one per
#: voice role, rather than silence (FILE_FORMATS §1.4).  Each is 13 modulator
#: bytes, 13 carrier bytes and two wave selects, in BNK operator order, exactly
#: as IMPLAY.EXE 3.1 holds them.  Bytes the driver ignores -- a carrier's
#: feedback and connection, a single-slot drum's whole carrier -- are left as
#: found.  The piano is ADLIB.C's but for its carrier attack, 13 against 15.
IMPLAY_DEFAULT_PATCH = {
    'melodic': bytes.fromhex('01 01 03 0f 05 00 01 03 0f 00 00 00 01'
                             '00 01 f6 0d 07 00 02 04 00 00 00 01 01 00 00'),
    'bd':  bytes.fromhex('00 00 00 0a 04 00 08 0c 0b 00 00 00 01'
                         '00 00 2f 0d 04 00 06 0f 00 00 00 00 01 00 00'),
    'sd':  bytes.fromhex('00 0c 00 0f 0b 00 08 05 00 00 00 00 00'
                         '00 00 2f 0d 04 00 06 0f 00 00 00 00 00 00 00'),
    'tom': bytes.fromhex('00 04 00 0f 0b 00 07 05 00 00 00 00 00'
                         '00 00 2f 0d 04 00 06 0f 00 00 00 00 00 00 00'),
    'tc':  bytes.fromhex('00 01 00 0f 0b 00 05 05 00 00 00 00 00'
                         '00 00 2f 0d 04 00 06 0f 00 00 00 00 00 00 00'),
    'hh':  bytes.fromhex('00 01 00 0f 0b 00 07 05 00 00 00 00 00'
                         '00 2e 04 11 00 00 00 00 00 2e 17 3c 00 00 00'),
}


def default_patch(role: str) -> 'opl.OplPatch':
    """IMPLAY's stand-in for a patch the banks do not have, for a voice of
    `role`: the piano for any melodic voice, the matching drum otherwise."""
    b = IMPLAY_DEFAULT_PATCH.get(role, IMPLAY_DEFAULT_PATCH['melodic'])
    ops = opl.OPERATOR_FIELDS
    return opl.OplPatch(f'default {role}',
                        {f: b[i] for i, f in enumerate(ops)},
                        {f: b[13 + i] for i, f in enumerate(ops)}, b[26], b[27])


# ── The file ─────────────────────────────────────────────────────────────────

def parse_ims(data: bytes) -> dict:
    """Header, raw event stream and patch-name table.  §1 of the format doc."""
    if len(data) < IMS_HEADER_SIZE:
        sys.exit("error: IMS file too short")
    data_size = struct.unpack_from('<i', data, 42)[0]
    end = IMS_HEADER_SIZE + data_size
    if data_size < 0 or end + 4 > len(data):
        sys.exit("error: IMS data size out of range")
    song = {
        'version': (data[0], data[1]),
        'title_raw': data[6:36].split(b'\x00')[0],
        'tick_beat': data[36] or 240,
        'beat_measure': data[37] or 4,
        'total_tick': struct.unpack_from('<i', data, 38)[0],
        'command_count': struct.unpack_from('<i', data, 46)[0],
        'src_tick_beat': data[50],
        'percussive': data[58] != 0,
        # Three corpus files claim 60 semitones; the driver clamps, so we do.
        'pitch_range': min(12, max(1, data[59])),
        'tempo': struct.unpack_from('<H', data, 60)[0] or 120,
        'events': data[IMS_HEADER_SIZE:end],
        'patch_names': [],
    }
    if data[end] != 0x77 or data[end + 1] != 0x77:
        sys.exit("error: IMS patch table missing (no 'ww' signature)")
    count = struct.unpack_from('<H', data, end + 2)[0]
    for i in range(count):
        o = end + 4 + i * IMS_PATCH_NAME_LEN
        if o + IMS_PATCH_NAME_LEN > len(data):
            break
        song['patch_names'].append(
            data[o:o + IMS_PATCH_NAME_LEN].split(b'\x00')[0].decode('latin-1'))
    return song


def ims_events(song: dict):
    """Walk the raw stream, yielding (tick, status, a, b) with ABSOLUTE ticks.

    A delta of `0xF8` is an overflow marker worth 240 ticks and may repeat, so
    the byte count and the event count are not the same thing.  Running status
    is MIDI's; `F0` and `FC` neither set nor are trusted to preserve it, because
    the two reference players disagree about that and no corpus file decides
    it — every tempo event is followed by an explicit status byte."""
    d = song['events']
    i = 0
    running = 0
    tick = 0
    n = len(d)
    while i < n:
        delay = 0
        byte = d[i]; i += 1
        while byte == 0xF8:
            delay += 240
            if i >= n:
                return
            byte = d[i]; i += 1
        delay += byte
        tick += delay
        if i >= n:
            return
        status = d[i]
        if status & 0x80:
            i += 1
            if status < 0xF0:
                running = status
        else:
            status = running
            if not status:
                return
        if status == 0xFC:
            yield (tick, status, 0, 0)
            return
        if status == 0xF0:
            start = i
            while i < n and d[i] != 0xF7:
                i += 1
            body = d[start:i]
            i += 1                                    # consume the F7
            if len(body) == 4 and body[0] == 0x7F and body[1] == 0x00:
                yield (tick, status, body[2], body[3])
            continue
        high = status & 0xF0
        wide = high in (0x80, 0x90, 0xB0, 0xE0)
        if i >= n:
            return
        a = d[i]; i += 1
        b = 0
        if wide:
            if i >= n:
                return
            b = d[i]; i += 1
        yield (tick, status, a, b)


def ims_sequence(song: dict):
    """The event stream as (tick, kind, voice, x, y) the row builder can use."""
    melodic_only = not song['percussive']
    for tick, status, a, b in ims_events(song):
        if status == 0xFC:
            yield (tick, END, 0, 0, 0)
            return
        if status == 0xF0:
            # A tempo event MULTIPLIES the header tempo; multipliers do not
            # compound, so this is always relative to `tempo`, never to the
            # tempo in force.
            yield (tick, TEMPO, 0, a, b)
            continue
        voice = status & 0x0F
        # Channels the current mode does not have are discarded outright: 92
        # melodic-mode corpus files address 9 or 10 anyway.
        if voice > (8 if melodic_only else 10):
            continue
        high = status & 0xF0
        if high in (0x80, 0x90):
            # `vv` non-zero is a trigger even under 8n: the two reference
            # players disagree about bare 8n, and `vv` is non-zero in all
            # 3 131 803 corpus 8n events, so nothing turns on the reading.
            if b > 0:
                yield (tick, NOTE_ON, voice, a, b)
            else:
                yield (tick, NOTE_OFF, voice, 0, 0)
        elif high == 0xA0:
            yield (tick, VOLUME, voice, a, 0)
        elif high == 0xC0:
            yield (tick, PATCH, voice, a, 0)
        elif high == 0xE0:
            yield (tick, BEND, voice, a | (b << 7), 0)
        # B0 and D0 carry nothing the AdLib driver reads.


def implay_end(song: dict, seq: list) -> list:
    """The sequence cut where IMPLAY stops playing it.

    IMPLAY ends a song when its tick counter reaches the header's `totalTick`,
    whether or not `FC` has come (FILE_FORMATS §1.5), so no event at or past
    `totalTick` is ever played.  In 316 of 1725 corpus files that removes a
    tail that is silence or damage -- MM-RAIN.IMS's runs about three hours --
    which would otherwise become cue after empty cue.  D-PRODC#.IMS is cut
    like the rest: past its `totalTick` one held note on channel 5 sounds
    alone for almost seven minutes, and a 31-second closing passage follows
    that IMPLAY never reached.  A song whose `totalTick` is not positive (no corpus file) would be
    silent in IMPLAY, and plays to `FC` instead."""
    end = song['total_tick']
    if end <= 0:
        return seq
    kept = [e for e in seq if e[0] < end]
    if len(kept) < len(seq):
        vprint(f"  ending at totalTick {end}, as IMPLAY does "
               f"({len(seq) - len(kept)} events after it dropped)")
    # Stopping silences the chip, and the note-offs that would have done it may
    # be among the events dropped, so release whatever is still sounding.
    sounding = set()
    for _t, kind, voice, *_ in kept:
        if kind == NOTE_ON:
            sounding.add(voice)
        elif kind == NOTE_OFF:
            sounding.discard(voice)
    return kept + [(end, NOTE_OFF, v, 0, 0) for v in sorted(sounding)] \
        + [(end, END, 0, 0, 0)]


def delta_gcd(song: dict) -> int:
    """The composer's own tick: the GCD of every delta in the stream."""
    g = 0
    prev = 0
    for tick, _status, _a, _b in ims_events(song):
        g = math.gcd(g, tick - prev)
        prev = tick
    return g


# ── Grid ─────────────────────────────────────────────────────────────────────

#: Rows a beat above this are not worth a pattern grid — 48 already makes a
#: 24-bar section a 1152-row song — so a finer source tick is quantised.
MAX_ROWS_PER_BEAT = 48
#: Taud's tick rate is the resolution of every envelope and every per-tick
#: effect, so the converter buys as many ticks a row as the tempo range allows:
#: at 500 BPM a tick is 5 ms, against 20 ms at a tracker-ordinary 125.
MAX_BPM = 535
MIN_BPM = 25
MAX_TICK_RATE = 127


def row_seconds(song: dict, tempo: float, row_ticks: int) -> float:
    """How long one row lasts at `tempo`, in seconds."""
    return 60.0 * row_ticks / (song['tick_beat'] * tempo)


def speed_bpm_for(seconds: float):
    """(ticks per row, BPM) realising a row of `seconds`.

    A Taud row lasts `speed × 2.5 ÷ BPM` seconds, so the pair is one equation
    with a free parameter — and the parameter is spent on the shortest TICK the
    535 BPM ceiling allows, because the tick is the resolution of every envelope
    and every per-tick effect the engine has.  At 500 BPM a tick is 5 ms against
    20 ms at a tracker-ordinary 125, which is the difference between an OPL
    percussive attack surviving the conversion and being smeared over a row."""
    if seconds <= 0:
        return 6, 125
    speed = min(MAX_TICK_RATE, int(MAX_BPM * seconds / 2.5))
    speed = max(1, speed)
    bpm = int(round(speed * 2.5 / seconds))
    return speed, max(MIN_BPM, min(MAX_BPM, bpm))


def tempo_effect(bpm: int):
    """(opcode, argument) for `T`, using the extended form above 280 BPM."""
    if bpm <= 280:
        return TOP_T, ((bpm - 25) & 0xFF) << 8
    return TOP_T, 0xFF00 | ((bpm - 280) & 0xFF)


# ── Instrument pass ──────────────────────────────────────────────────────────

def collect_patch_usage(song: dict, seq):
    """{(patch index, kind): set of chip notes} — what the song actually plays,
    which is what the key banding is fitted to."""
    melodic_only = not song['percussive']
    current = [None] * 11
    usage = {}
    for _tick, kind, voice, a, _b in seq:
        if kind == PATCH:
            current[voice] = a
        elif kind == NOTE_ON:
            idx = current[voice]
            if idx is None:
                continue
            usage.setdefault((idx, voice_role(song, voice)), set()).add(
                max(0, a - opl.MIDI_TO_CHIP))
    return usage


def voice_role(song: dict, voice: int) -> str:
    """What an OPL voice IS in this song's mode.  In rhythm mode the last five
    channels are drums, and three of them are not oscillators at all."""
    if not song['percussive']:
        return 'melodic'
    return opl.RHYTHM_KIND.get(voice, 'melodic')


# ── Cells ────────────────────────────────────────────────────────────────────

class Cell:
    __slots__ = ('note', 'inst', 'vol_sel', 'vol_val', 'eff', 'arg')

    def __init__(self):
        self.note = NOTE_NOP
        self.inst = 0
        self.vol_sel = SEL_FINE       # a permanent no-op
        self.vol_val = 0
        self.eff = TOP_NONE
        self.arg = 0

    def pack(self) -> bytes:
        return struct.pack('<HBBBBH', self.note, self.inst,
                           (self.vol_sel << 6) | (self.vol_val & 0x3F),
                           (SEL_FINE << 6), self.eff, self.arg)


def build_cells(song, seq, row_ticks, speed, slot_of, level_of, num_voices):
    """The whole song as {(voice, row): Cell}, plus the row count.

    Every event in a row shares one tick — the grid IS the delta GCD, so a
    later event cannot land inside a row — which is what makes "the last event
    wins" the exact reading rather than an approximation."""
    cells = {}
    rows_of_events = {}
    for tick, kind, voice, a, b in seq:
        row = (tick + row_ticks // 2) // row_ticks
        rows_of_events.setdefault(row, []).append((kind, voice, a, b))

    patch = [None] * num_voices
    volume = [DEFAULT_VOLUME] * num_voices
    bend = [MID_PITCH] * num_voices
    note = [None] * num_voices
    sounding = [False] * num_voices
    cur_pitch = [0] * num_voices
    written_vol = [None] * num_voices
    tempo_rows = {}
    last_row = 0
    ended = False

    for row in sorted(rows_of_events):
        if ended:
            break
        events = rows_of_events[row]
        trigger = [None] * num_voices          # (chip note, patch index)
        released = [False] * num_voices
        vol_changed = [False] * num_voices
        bend_changed = [False] * num_voices
        for kind, voice, a, b in events:
            if kind == END:
                ended = True
                continue
            if kind == TEMPO:
                tempo_rows[row] = song['tempo'] * (a + b / 128.0)
                continue
            if kind == PATCH:
                patch[voice] = a
            elif kind == VOLUME:
                volume[voice] = a
                vol_changed[voice] = True
            elif kind == BEND:
                bend[voice] = a
                bend_changed[voice] = True
            elif kind == NOTE_OFF:
                trigger[voice] = None
                released[voice] = True
            elif kind == NOTE_ON:
                # A note-on carries a volume change AND a trigger in one event.
                volume[voice] = b
                vol_changed[voice] = True
                trigger[voice] = (max(0, a - opl.MIDI_TO_CHIP), patch[voice])
                released[voice] = False

        for v in range(num_voices):
            if trigger[v] is None and not released[v] and not vol_changed[v] \
                    and not bend_changed[v]:
                continue
            cell = cells.setdefault((v, row), Cell())
            role = voice_role(song, v)
            if trigger[v] is not None:
                chip_note, idx = trigger[v]
                slot = slot_of.get((idx, role), 0)
                if slot:
                    if role in ('sd', 'tc', 'hh'):
                        # Pitchless: the chip builds these three out of bits of
                        # two accumulators, so their note number means nothing.
                        cell.note = opl.TAUD_C4
                    else:
                        cell.note = opl.note_word_bent(chip_note, bend_offset(song, bend[v]))
                    cell.inst = slot
                    cur_pitch[v] = cell.note
                    note[v] = chip_note
                    sounding[v] = True
            elif released[v]:
                cell.note = NOTE_KEYOFF
                # The release itself is the instrument's Volume Fadeout, not
                # anything written here — see opl2taud.release_fadeout.  An
                # earlier version of this converter forced a key lift from the
                # pattern (`S $D041`) instead; the fadeout models the chip
                # better, needs no effect column, and works the same when a
                # bank instrument is played by hand rather than from a row.
                sounding[v] = False

            level = level_of.get((patch[v], role), 0)
            vol = volume_column(volume[v], level)
            if vol_changed[v] or trigger[v] is not None:
                if written_vol[v] != vol or trigger[v] is not None:
                    cell.vol_sel = SEL_SET
                    cell.vol_val = vol
                    written_vol[v] = vol

            # Bends are followed with FINE pitch slides, which fire once on
            # tick 0 — so the pitch is exact at every row boundary, and what is
            # lost is only the shape between two rows.
            if trigger[v] is None and sounding[v] and note[v] is not None \
                    and role not in ('sd', 'tc', 'hh'):
                want = opl.note_word_bent(note[v], bend_offset(song, bend[v]))
                delta = want - cur_pitch[v]
                if delta and cell.eff == TOP_NONE:
                    step = min(0xFFF, abs(delta))
                    cell.eff = TOP_F if delta > 0 else TOP_E
                    cell.arg = 0xF000 | step
                    cur_pitch[v] += step if delta > 0 else -step
        last_row = row

    # Tempo goes wherever a channel has its effect column free that row; it is
    # a playhead-wide command, so which channel carries it does not matter.
    cur_speed, cur_bpm = speed
    for row, tempo in sorted(tempo_rows.items()):
        new_speed, new_bpm = speed_bpm_for(row_seconds(song, tempo, row_ticks))
        writes = []
        if new_speed != cur_speed:
            writes.append((TOP_A, (new_speed & 0xFF) << 8))
        if new_bpm != cur_bpm:
            writes.append(tempo_effect(new_bpm))
        cur_speed, cur_bpm = new_speed, new_bpm
        # A and T are both playhead-scope, so which channel carries them does
        # not matter — only that each gets a cell whose effect column is free.
        for v in range(num_voices):
            if not writes:
                break
            cell = cells.setdefault((v, row), Cell())
            if cell.eff == TOP_NONE:
                cell.eff, cell.arg = writes.pop(0)
        if writes:
            vprint(f"  warning: row {row} had no free effect column for a "
                   f"tempo change")
    return cells, last_row + 1


def bend_offset(song: dict, bend: int) -> int:
    """The driver's own bend arithmetic, in 1/256 semitones."""
    return ((max(0, min(0x3FFF, bend)) - MID_PITCH) >> 5) * song['pitch_range']


# ── Assembly ─────────────────────────────────────────────────────────────────

#: The chip sums nine to eleven voices into one 16-bit DAC, where a single
#: full-scale operator reaches 4084/16384 = 0.249.  A Taud voice at full note and
#: channel volume reaches 0.707 at mixing volume 255, so 90 puts a converted
#: voice at exactly the level the AdLib card gave it — which is what keeps a
#: song's dynamics where they were instead of clipping the loud passages flat.
DEFAULT_MIXING_VOL = 90
#: How long the song is given to ring out after its last event.
TAIL_ROWS = 8


def cue_rows_for(rows_per_bar: int) -> int:
    """How many rows a cue should play, given the song's bar length.

    A cue is the unit anyone editing the song moves around, so it wants to be a
    whole number of BARS. A pattern holds 64 rows and 64 is not a multiple of
    every bar length this format produces — 12 rows a beat in 4/4 is 48, which
    would leave every cue straddling a bar line and the whole song unusable to
    remix. So a cue plays the largest power-of-two count of bars that fits, and
    the LEN instruction says where it stops; only a bar longer than a pattern
    falls back to the full 64."""
    if rows_per_bar <= 0 or rows_per_bar > PATTERN_ROWS:
        return PATTERN_ROWS
    bars = 1
    while rows_per_bar * bars * 2 <= PATTERN_ROWS:
        bars *= 2
    return rows_per_bar * bars


def carrier_level(patch, role: str) -> int:
    """The total level the channel volume scales — the carrier's for an ordinary
    two-operator voice, the modulator's for the single-slot rhythm ones, since
    that is the operator the driver loads into their one slot."""
    if patch is None:
        return 0
    if role in ('sd', 'tom', 'tc', 'hh'):
        return patch.mod['totalLevel'] & 63
    return patch.car['totalLevel'] & 63


def assemble_taud(song, banks, *, mixing_vol=DEFAULT_MIXING_VOL, max_bands=4,
                  feedback_scale=1.0, with_project_data=True):
    seq = implay_end(song, list(ims_sequence(song)))
    if not seq:
        sys.exit("error: no events in this IMS file")

    row_ticks = delta_gcd(song) or 30
    tick_beat = song['tick_beat']
    if tick_beat / row_ticks > MAX_ROWS_PER_BEAT:
        coarse = max(1, round(tick_beat / MAX_ROWS_PER_BEAT))
        vprint(f"  warning: {tick_beat // row_ticks} rows a beat is too fine; "
               f"quantising to {tick_beat // coarse}")
        row_ticks = coarse
    speed, bpm = speed_bpm_for(row_seconds(song, song['tempo'], row_ticks))
    vprint(f"  grid: {row_ticks} ticks a row ({tick_beat / row_ticks:g} rows a beat), "
           f"speed {speed}, {bpm} BPM ({2500.0 / bpm:.1f} ms a tick)")

    num_voices = 11 if song['percussive'] else 9

    # ── Instruments ──────────────────────────────────────────────────────────
    usage = collect_patch_usage(song, seq)
    entries, keys = [], []
    for key in sorted(usage):
        idx, role = key
        name = song['patch_names'][idx] if idx < len(song['patch_names']) else ''
        patch = opl.resolve_patch(name, *banks) if name else None
        if patch is None:
            # FILE_FORMATS §1.4: IMPLAY plays the driver's built-in timbre.
            vprint(f"  warning: patch '{name or idx}' is in no bank; "
                   f"using IMPLAY's built-in {role} default")
            patch = default_patch(role)
        entries.append({'patch': patch, 'kind': role, 'notes': sorted(usage[key]),
                        'name': name or f'patch {idx}'})
        keys.append(key)
    if len(entries) > opl.MAIN_SLOTS:
        vprint(f"  warning: {len(entries)} patch/role pairs > {opl.MAIN_SLOTS} "
               f"instrument slots; dropping the least used")
        order = sorted(range(len(entries)), key=lambda i: -len(usage[keys[i]]))
        keep = set(order[:opl.MAIN_SLOTS])
        entries = [e for i, e in enumerate(entries) if i in keep]
        keys = [k for i, k in enumerate(keys) if i in keep]

    bank = opl.build_bank(entries, bpm=bpm, max_bands=max_bands,
                          feedback_scale=feedback_scale)
    slot_of = dict(zip(keys, bank['slots']))
    level_of = {k: carrier_level(e['patch'], e['kind'])
                for k, e in zip(keys, entries)}
    resolved = sum(1 for e in entries if e['patch'] is not None)
    vprint(f"  instruments: {resolved}/{len(entries)} patches resolved, "
           f"{sum(1 for n in bank['instrument_names'][opl.AUX_BASE:] if n)} operators, "
           f"{bank['pool_bytes']} bytes of samples")

    # ── Patterns ─────────────────────────────────────────────────────────────
    cells, num_rows = build_cells(song, seq, row_ticks, (speed, bpm), slot_of,
                                  level_of, num_voices)
    num_rows += TAIL_ROWS
    rows_per_beat = tick_beat // row_ticks if tick_beat % row_ticks == 0 else 0
    rows_per_bar = rows_per_beat * song['beat_measure']
    cue_rows = cue_rows_for(rows_per_bar)
    num_cues = max(1, -(-num_rows // cue_rows))
    vprint(f"  {num_rows} rows → {num_cues} cues of {cue_rows} rows "
           f"({rows_per_bar} a bar) × {num_voices} channels")
    if num_cues > NUM_CUES:
        # A handful of corpus files carry a bogus tail — one puts its last event
        # three hours in — and a song longer than the cue sheet is better
        # truncated than refused.  The grid stays where the composer put it.
        vprint(f"  warning: {num_cues} cues is past the {NUM_CUES} the cue "
               f"sheet holds; truncating the song")
        num_cues = NUM_CUES

    blank = Cell().pack()
    while True:
        pat_bin = bytearray()
        for c in range(num_cues):
            for v in range(num_voices):
                for r in range(PATTERN_ROWS):
                    # A pattern is always 64 rows on disk; the rows past the
                    # cue's length are simply never reached.
                    cell = cells.get((v, c * cue_rows + r)) if r < cue_rows else None
                    pat_bin += cell.pack() if cell is not None else blank
        orig = num_cues * num_voices
        pat_bin, remap, num_patterns = deduplicate_patterns(bytes(pat_bin), orig)
        if num_patterns <= NUM_PATTERNS_MAX:
            break
        # Deduplication is what usually brings a long song inside the pattern
        # limit; when even that is not enough there is nothing left but to keep
        # less of it.
        num_cues = max(1, num_cues // 2)
        vprint(f"  warning: {num_patterns} distinct patterns is past the "
               f"{NUM_PATTERNS_MAX} limit; keeping {num_cues} cues")
    vprint(f"  patterns: {orig} → {num_patterns} unique")

    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c * CUE_SIZE:(c + 1) * CUE_SIZE] = encode_cue([], 0)
    length = cue_instruction_len(cue_rows) if cue_rows < PATTERN_ROWS else 0
    for c in range(num_cues):
        sheet[c * CUE_SIZE:(c + 1) * CUE_SIZE] = encode_cue(
            [remap[c * num_voices + v] for v in range(num_voices)], length)
    # "Halt at x" is one instruction that both shortens the last cue and ends
    # the song there, so the two never have to share a cue's two words.
    set_cue_instruction(sheet, num_cues - 1, cue_instruction_halt_at(cue_rows))
    cue_bytes, stored_cues = finalize_cue_sheet(sheet)

    # ── Container ────────────────────────────────────────────────────────────
    raw = bank['sample_bin'] + bank['inst_bin']
    assert len(raw) == SAMPLEINST_SIZE
    compressed = compress_blob(raw, "sample+inst bin")
    pat_comp = compress_blob(bytes(pat_bin), "pattern bin")
    cue_comp = compress_blob(cue_bytes, "cue sheet")

    song_table_off = TAUD_HEADER_SIZE + len(compressed)
    song_off = song_table_off + TAUD_SONG_ENTRY
    entry = encode_song_entry(
        song_offset=song_off, num_voices=num_voices, num_patterns=num_patterns,
        bpm_stored=bpm - 25, tick_rate=speed,
        base_note=opl.TUNING_BASE_NOTE, base_freq=opl.TUNING_BASE_FREQ,
        # Interpolation OFF: an OPL operator reads a 1024-point phase table with
        # no filtering at all, and its aliasing is part of the sound.
        flags_byte=0b00100,
        pat_bin_comp_size=len(pat_comp), cue_sheet_comp_size=len(cue_comp),
        global_vol=0xFF, mixing_vol=mixing_vol, num_cues=stored_cues)

    title = decode_johab_field(song['title_raw']).strip()
    proj = b''
    proj_off = 0
    if with_project_data:
        proj = build_project_data(
            project_name=escape_non_ascii(title),
            instrument_names=[escape_non_ascii(n) for n in bank['instrument_names']],
            sample_names=[escape_non_ascii(n) for n in bank['sample_names']],
            song_metadata=[{'index': 0, 'name': escape_non_ascii(title),
                            'notation': opl.NOTATION_12TET,
                            'beat_pri': min(255, rows_per_beat or 4),
                            'beat_sec': min(255, rows_per_bar or 16)}])
        if proj:
            proj_off = song_off + len(pat_comp) + len(cue_comp)

    header = (TAUD_MAGIC + bytes([TAUD_VERSION, 1])
              + struct.pack('<I', len(compressed))
              + struct.pack('<I', proj_off)
              + (SIGNATURE + b' ' * 14)[:14])
    assert len(header) == TAUD_HEADER_SIZE
    return header + compressed + entry + pat_comp + cue_comp + proj


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='Input .IMS song')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-b', '--bank', action='append', default=[],
                    help='AdLib .BNK to resolve patch names against, most '
                         'specific first (the song\'s own bank, then a general one)')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--mixingvol', type=int, default=DEFAULT_MIXING_VOL,
                    dest='mixing_vol', help='Song mixing volume, 0…255')
    ap.add_argument('--ksl-bands', type=int, default=4,
                    help='Key bands per operator for KSL/KSR (1 disables banding)')
    ap.add_argument('--feedback-scale', type=float, default=1.0,
                    help='Fudge factor on OPL feedback depth (1.0 = as the chip)')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the title / instrument / sample name section')
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()
    song = parse_ims(data)
    title = decode_johab_field(song['title_raw']).strip()
    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    vprint(f"  title: {title!r}")
    vprint(f"  {'percussive' if song['percussive'] else 'melodic'} mode, "
           f"tempo {song['tempo']}, {len(song['patch_names'])} patch names")

    banks = []
    for path in args.bank:
        with open(path, 'rb') as f:
            banks.append(opl.parse_bnk(f.read()))
        vprint(f"  bank '{path}': {len(banks[-1]['patches'])} patches")
    if not banks:
        vprint("  warning: no bank given; every patch will be silent")

    taud = assemble_taud(song, banks, mixing_vol=args.mixing_vol,
                         max_bands=args.ksl_bands,
                         feedback_scale=args.feedback_scale,
                         with_project_data=not args.no_project_data)
    with open(args.output, 'wb') as f:
        f.write(taud)
    print(f"wrote {len(taud)} bytes to '{args.output}'")


if __name__ == '__main__':
    main()
