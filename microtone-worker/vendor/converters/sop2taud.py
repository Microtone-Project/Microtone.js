#!/usr/bin/env python3
"""sop2taud.py — SOP (a Korean OPL3 tracker) to TSVM Taud (.taud)

Usage:
    python3 sop2taud.py input.sop output.taud [-v]

`.sop` is the song format of a Korean OPL3 tracker of the mid-to-late 1990s,
found in the same BBS collections as the `.ims` files ims2taud reads and sharing
nothing with them but the chip family.  Three things make it the easier of the
two to convert:

    - it CARRIES its instruments, so there is no bank file to resolve names
      against and no patch can go missing
    - its tick grid is the composer's own, so there is no row grid to recover
      from the delta times
    - a note carries its own LENGTH, so there is no note-off to pair up

and one thing makes it harder: it is a YMF262 format.  Twenty tracks, stereo
panning, eight wave shapes, and instruments that may be four operators rather
than two.  Taud has room for all of it — twenty of its thirty-two lanes, a
panning axis of its own, and an FM rack that holds sixteen operator entries — so
none of it is the reduction that playing the same file on an OPL2 would be.

What this converter does:

    - writes one Taud lane per SOP track, which is exact: track IS voice in this
      format, so there is no allocation to do
    - compiles each instrument the song selects into a Taud FM operator rack
      (opl2taud), fitted to the notes that song actually plays it at, four
      operators wide where the instrument is
    - carries notes, note lengths, pitch, volume, panning, tempo and global
      volume onto the grid the file was written on
    - declares the song's tuning as concert pitch, so a converted note sounds
      where the tracker put it and stays in tune with anything remixed alongside
    - plays the song the way the editor that wrote it did: NOTE.EXE, whose own
      player is the reference (SOP_FORMAT §8).  That means overlapping notes
      slur instead of re-striking, a track starts at volume 96, mode-0 tracks
      are silent, only a mode-1 track is four operators wide, a pan value Note
      did not know silences its lane, pitch is Note's own 25-step table, and
      tempo is what Note's timer made of it.  The one departure is bit 7 of the
      channel mode, the editor's disable switch, which is ignored (§8.1).

See SOP_FORMAT.en.md in the iyagimusic-js repository for the format — every
structural claim below cites it — and TAUD_CONVERSION_NOTES.md for what does not
survive the crossing.
"""

import argparse
import copy
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEINST_SIZE, PATTERN_ROWS, NUM_PATTERNS_MAX,
    NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF,
    TOP_NONE, TOP_A, TOP_E, TOP_F, TOP_G, TOP_S, TOP_T, TOP_V,
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


SIGNATURE = b"sop2taud/TSVM "     # 14 bytes

SOP_MAGIC = b"sopepos"
SOP_HEADER_SIZE = 76
SOP_INST_NAME_SIZE = 28
#: §3.1.  An unknown instType has to be fatal: the record length is the only
#: thing that finds the next record, so a guess would misread the whole file.
#: These are exactly the types NOTE.EXE's own reader and writer size; type 2
#: ("1OP") is in no corpus file, but the editor round-trips it.
SOP_INST_DATA_SIZE = {0: 22, 1: 11, 2: 11, 6: 11, 7: 11, 8: 11, 9: 11, 10: 11, 12: 0}
#: §4.2 and §5: the two code spaces are disjoint, and neither ever appears in
#: the other's track.
SOP_TRACK_VALUE_SIZE = {1: 1, 2: 3, 4: 1, 5: 1, 6: 1, 7: 1}
SOP_CTRL_VALUE_SIZE = {3: 1, 8: 1}
#: §6: an instrument record of this type is an empty slot of the editor's
#: instrument box — often renamed into one 19-column line of the credits.
SOP_COMMENT_TYPE = 12

#: Event kinds the row builder understands.
NOTE_ON, VOLUME, PATCH, BEND, PAN, TEMPO, GVOL = range(7)

#: §4.2: what a track is at before it says otherwise, as NOTE.EXE's player
#: assumes it.  Volume is 96, not the driver's full 127 — 12 dB down on the
#: operator's own level — and 254 tracks in 46 corpus files play notes before
#: their first volume event.  Pitch is the centre of the ±100 range.
DEFAULT_VOLUME = 96
CENTRE_PITCH = 100
#: §1, §5: Note starts every song at 120 bpm and never reads `basicTempo`.
NOTE_START_TEMPO = 120


# ── The file ─────────────────────────────────────────────────────────────────

def _text(b: bytes) -> str:
    """A fixed-size name field, read to the first NUL.  §3.1: both name fields
    are buffers the editor reused without clearing, so stale text routinely runs
    on past the terminator and everything after it is rubbish."""
    return decode_johab_field(b.split(b'\x00')[0]).rstrip()


def parse_sop(data: bytes) -> dict:
    """Header, channel modes, instruments, twenty tracks, control track.

    Everything after the 76-byte header is positional — there is no offset table
    anywhere — so the file has to be read strictly in order.  The compensation is
    that it must end exactly where the control track does, which is a strong
    check that nothing was misread, and this reader makes it (§1)."""
    if len(data) < SOP_HEADER_SIZE or data[0:7] != SOP_MAGIC:
        sys.exit("error: not a SOP file (bad 'sopepos' signature)")
    n_tracks = data[73]
    song = {
        'version': (data[7], data[8]),
        'title_raw': data[23:54].split(b'\x00')[0],
        'percussive': data[54] != 0,
        # §1: tickBeat is 4…16 in every corpus file, and it is already what a
        # tracker calls rows a beat.  Bytes 61…72 were never written by the
        # editor — they are whatever its uncleared header buffer held — and
        # `basicTempo` is written as 120 and never read (§1), so neither is used.
        'tick_beat': data[56] or 8,
        'beat_measure': data[58] or 4,
        'basic_tempo': data[59] or 120,
        'instruments': [],
        'comments': [],
        'tracks': [],
        'control': [],
    }

    o = SOP_HEADER_SIZE
    if o + n_tracks > len(data):
        sys.exit("error: SOP channel-mode table truncated")
    modes = data[o:o + n_tracks]
    o += n_tracks

    for i in range(data[74]):
        if o + SOP_INST_NAME_SIZE > len(data):
            sys.exit(f"error: SOP instrument {i} truncated")
        inst_type = data[o]
        size = SOP_INST_DATA_SIZE.get(inst_type)
        if size is None:
            sys.exit(f"error: SOP instrument {i}: unknown instType {inst_type}")
        inst = {
            'type': inst_type,
            'short_name': _text(data[o + 1:o + 9]),
            'long_name': _text(data[o + 9:o + 28]),
            'data': data[o + SOP_INST_NAME_SIZE:o + SOP_INST_NAME_SIZE + size],
        }
        if inst_type == SOP_COMMENT_TYPE:
            song['comments'].append(inst['long_name'])
        song['instruments'].append(inst)
        o += SOP_INST_NAME_SIZE + size

    def read_track(sizes, what):
        """§4.1 and §5 share a layout: u16 event count, u32 byte count, events.

        Both counts are redundant with walking the events, which is exactly why
        they are worth checking: either one disagreeing means the walk lost
        alignment somewhere earlier."""
        nonlocal o
        if o + 6 > len(data):
            sys.exit(f"error: SOP {what} header truncated")
        count, size = struct.unpack_from('<HI', data, o)
        o += 6
        end = o + size
        if end > len(data):
            sys.exit(f"error: SOP {what} runs past the end of the file")
        events = []
        tick = 0
        while o < end:
            delta, code = struct.unpack_from('<HB', data, o)
            value_size = sizes.get(code)
            if value_size is None:
                sys.exit(f"error: SOP {what}: unknown event {code}")
            tick += delta
            ev = {'tick': tick, 'delta': delta, 'code': code, 'value': data[o + 3],
                  'length': 0}
            if code == 2:                             # §4.2: the only wide event
                ev['length'] = struct.unpack_from('<H', data, o + 4)[0]
            events.append(ev)
            o += 3 + value_size
        if o != end:
            sys.exit(f"error: SOP {what}: events overran dataSize")
        if len(events) != count:
            sys.exit(f"error: SOP {what}: numEvents says {count}, "
                     f"walked {len(events)}")
        return events

    for t in range(n_tracks):
        song['tracks'].append({
            # §2: bit 7 is the editor's channel-disable switch — screen state,
            # and two files were saved with solo on — so it is masked off and
            # the track played, the one place this does not follow Note (§8.1).
            'mode': modes[t] & 0x7F,
            'events': read_track(SOP_TRACK_VALUE_SIZE, f'track {t}'),
        })
    song['control'] = read_track(SOP_CTRL_VALUE_SIZE, 'control track')
    if o != len(data):
        vprint(f"  warning: {len(data) - o} bytes after the control track")
    return song


# ── Instruments ──────────────────────────────────────────────────────────────

def _operator(char: int, scale: int, attack_decay: int, sustain_release: int,
              feedback: int) -> dict:
    """One operator's five register bytes, unpacked into a bank operator (§3.2).

    A `.bnk` stores thirteen unpacked parameters per operator; a `.sop` stores
    the register values the chip actually takes, so this is the packing the AdLib
    driver would have done, run backwards."""
    return {
        'ksl': (scale >> 6) & 3,
        'multiple': char & 0x0F,
        'feedback': (feedback >> 1) & 7,
        'attack': (attack_decay >> 4) & 0x0F,
        'sustain': (sustain_release >> 4) & 0x0F,
        'eg': (char >> 5) & 1,
        'decay': attack_decay & 0x0F,
        'release': sustain_release & 0x0F,
        'totalLevel': scale & 0x3F,
        'am': (char >> 7) & 1,
        'vib': (char >> 6) & 1,
        'ksr': (char >> 4) & 1,
        # A bank's `connection` is register 0xC0's bit read the other way up:
        # the driver writes `connection ? 0 : 1`, so an additive patch — one
        # whose CNT bit is set — stores 0 here.
        'connection': 0 if feedback & 1 else 1,
    }


def _pair(name: str, d: bytes, at: int, single_op: bool) -> 'opl.OplPatch':
    """One eleven-byte operator pair, as an OplPatch (§3.2).

    `single_op` is the rhythm-voice reading: instTypes 7…10 are the chip's
    one-operator rhythm voices, and bytes 6…10 are never used for them, so the
    carrier is zeroed.  Byte 5 is kept: NOTE.EXE writes its low nibble to 0xC7
    on the hi-hat track and 0xC8 on the tom track (§3.2), and `_operator` reads
    only those four bits, so the junk above them does not matter."""
    feedback = d[at + 5]
    car = (_operator(0, 0, 0, 0, 0) if single_op
           else _operator(d[at + 6], d[at + 7], d[at + 8], d[at + 9], feedback))
    return opl.OplPatch(
        name,
        _operator(d[at], d[at + 1], d[at + 2], d[at + 3], feedback),
        car,
        d[at + 4], 0 if single_op else d[at + 10],
        # §3.2: wave selects use the OPL3's range 0…7, and all eight of them are
        # shapes the compiler can build, so nothing is masked away here.
        wave_mask=7)


def sop_patch(inst: dict) -> 'opl.OplPatch|None':
    """One instrument record as a patch, or None for a comment line (§6) or a
    record whose data the file cut short.

    §3.3: a four-operator instrument is the same eleven-byte layout twice, at
    register offsets 0x08/0x0B, and comes back as a patch carrying its second
    pair — which is what routes it to `opl2taud`'s four-operator rack."""
    d = inst['data']
    if inst['type'] == SOP_COMMENT_TYPE or len(d) < 11:
        return None
    single_op = 7 <= inst['type'] <= 10
    patch = _pair(inst['short_name'] or inst['long_name'], d, 0, single_op)
    if inst['type'] == 0 and len(d) >= 22:
        patch.pair = _pair(patch.name, d, 11, False)
    return patch


def track_plays(song: dict, track: int) -> bool:
    """Whether NOTE.EXE's player sounds this track at all.

    §2: a mode-0 track is the silent upper half of a four-operator pair — its
    events are kept from before the pair was joined, and Note skips them — and
    §4.1: without rhythm mode tracks 9 and 10 are no channel at all."""
    if song['tracks'][track]['mode'] == 0:
        return False
    return song['percussive'] or track not in (9, 10)


def track_role(song: dict, track: int) -> str:
    """What a track IS in this song's mode.

    §4.1: the twenty tracks are not a flat list — in a percussive file, slots
    6…10 are the bass drum, snare, tom, cymbal and hi-hat, which the corpus
    confirms directly, and three of those are not oscillators at all.  §2: a
    mode-1 track is a four-operator channel, 'melodic4'; every other melodic
    track is two operators, whatever instrument it selects."""
    if song['percussive'] and track in opl.RHYTHM_KIND:
        return opl.RHYTHM_KIND[track]
    return 'melodic4' if song['tracks'][track]['mode'] == 1 else 'melodic'


def rack_kind(role: str) -> str:
    """The `opl2taud` kind a role is built as: a four-operator channel is still
    a melodic one, and whether it gets four operators is the patch's business."""
    return 'melodic' if role == 'melodic4' else role


def patch_for(inst, role: str):
    """The patch an instrument is played as on a track of `role`, or None.

    §3.3: Note joins a channel pair because the channel-mode table says so and
    never because of the instrument, so a four-operator instrument on any other
    track plays its first operator pair alone — 30 tracks in 7 corpus files do
    that.  The reverse, a two-operator instrument on a joined pair, leaves the
    pair's second half holding the last instrument's operators in Note; a Taud
    rack cannot carry that over, so it plays as two operators (§8.1)."""
    patch = sop_patch(inst) if inst else None
    if patch is not None and patch.pair is not None and role != 'melodic4':
        patch = copy.copy(patch)
        patch.pair = None
    return patch


def output_level(patch, role: str) -> int:
    """The total level channel volume scales — what `volume_column` needs to put
    a 0…127 volume on the right decibel curve.

    The driver scales the amplitude of every operator that reaches the output:
    the carrier of an ordinary two-operator voice, the modulator of the
    single-slot rhythm ones (that is the operator their one slot is loaded with),
    and for a four-operator voice whichever of the four the connection sends
    straight to the mix.  Several outputs are scaled by one factor, so the curve
    belongs to the loudest of them — the one with the least attenuation."""
    if patch is None:
        return 0
    if role in ('sd', 'tom', 'tc', 'hh'):
        return patch.mod['totalLevel'] & 63
    if patch.pair is None:
        return patch.car['totalLevel'] & 63
    ops = [patch.mod, patch.car, patch.pair.mod, patch.pair.car]
    chains = opl.CHAINS_FOUR_OP[(int(bool(patch.additive)),
                                 int(bool(patch.pair.additive)))]
    return min(ops[c[-1]]['totalLevel'] & 63 for c in chains)




def default_instrument(song: dict):
    """§4.2: a track that plays notes before selecting an instrument gets slot
    0, which is Note's default.  `ST-BGM.SOP` needs it — 4878 notes and not a
    single event 6.  In every corpus track that relies on it slot 0 holds an
    instrument; where it did not, Note would play on reset registers, and this
    stands in the first instrument that yields a patch instead."""
    insts = song['instruments']
    if insts and sop_patch(insts[0]) is not None:
        return 0
    return next((i for i, inst in enumerate(insts) if sop_patch(inst) is not None), None)


def collect_usage(song: dict, seq):
    """{(instrument index, role): set of chip notes} — what the song actually
    plays, which is what the key banding is fitted to."""
    n_tracks = len(song['tracks'])
    fallback = default_instrument(song)
    current = [fallback] * n_tracks
    usage = {}
    for _tick, kind, track, a, _b in seq:
        if kind == PATCH:
            current[track] = a
        elif kind == NOTE_ON:
            idx = current[track]
            if idx is None:
                continue
            usage.setdefault((idx, track_role(song, track)), set()).add(
                max(0, min(CHIP_TOP_NOTE, a - opl.MIDI_TO_CHIP)))
    return usage, fallback


# ── The event stream ─────────────────────────────────────────────────────────

def sop_sequence(song: dict):
    """Every track Note plays merged with the control track, as
    (tick, kind, track, a, b).

    Inside one tick a track's own events keep file order, because a SOP sets the
    instrument, the volume and the pitch of a note in the events just before
    it — a stable sort on the tick alone is what preserves that."""
    insts = song['instruments']
    merged = []
    for ev in song['control']:
        merged.append((ev['tick'], 0, -1, ev))
    for t, track in enumerate(song['tracks']):
        if not track_plays(song, t):
            continue
        for ev in track['events']:
            merged.append((ev['tick'], 1, t, ev))
    merged.sort(key=lambda m: (m[0], m[1]))

    for tick, _source, t, ev in merged:
        code, value = ev['code'], ev['value']
        if t < 0:
            # A control event at tick 0 is the song's opening state, and that
            # belongs in the Taud song header rather than in a cell — see
            # `initial_tempo` and `initial_global_volume`.  Emitting it as well
            # would only fight the twenty panning commands the tracks
            # themselves put on row 0 for a free effect column.
            if tick == 0:
                continue
            if code == 3:
                yield (tick, TEMPO, -1, value, 0)
            elif code == 8:
                yield (tick, GVOL, -1, value, 0)
            continue
        if code == 2:
            yield (tick, NOTE_ON, t, value, ev['length'])
        elif code == 4:
            yield (tick, VOLUME, t, value, 0)
        elif code == 5:
            yield (tick, BEND, t, value, 0)
        elif code == 6:
            # §4.2: selecting a slot that holds no instrument — a comment line,
            # or past the end of the table — loads nothing in Note, so the
            # instrument already on the track keeps sounding.
            if value < len(insts) and sop_patch(insts[value]) is not None:
                yield (tick, PATCH, t, value, 0)
        elif code == 7:
            yield (tick, PAN, t, value, 0)
        # §4.2's code 1, the special event, is a sync marker for other programs,
        # and Note's own player ignores it; so does this.


# ── Pitch ────────────────────────────────────────────────────────────────────

#: §4.2: Note's bend resolution, in steps per semitone.
SOP_PITCH_STEPS = 25
#: The highest chip note Note can sound; SOP pitch 107.
CHIP_TOP_NOTE = 95


def _sop_fnum_table():
    """The F-number table NOTE.EXE plays a `.sop` with: 25 rows of one octave,
    row r sounding r/25 of a semitone sharp.  It is the Ad Lib driver's integer
    recipe run at 25 steps — each row's C scaled by (1 + 0.06 r / 25) in fixed
    point, each semitone after it the one before times 106/100, truncated — and
    that recipe reproduces all 300 entries of the table inside NOTE.EXE exactly.
    The library's `SOP_FNUM_TABLE` is the same computation."""
    table = []
    d100 = SOP_PITCH_STEPS * 100
    for r in range(SOP_PITCH_STEPS):
        f8 = ((d100 + 6 * r) * 26044 * 2) // (d100 * 25)
        v = (f8 * 16384 * 9) // (179 * 625)
        for _s in range(12):
            table.append((v + 4) >> 3)
            v = (v * 106) // 100
    return table


SOP_FNUM_TABLE = _sop_fnum_table()
#: Middle C, where the song's concert tuning is anchored: chip note 48, row 0.
_C4_WORD = opl.note_word(48)
_C4_FREQ = SOP_FNUM_TABLE[0] * (1 << 4)


def sop_note_word(chip_note: int, pitch: int = CENTRE_PITCH) -> int:
    """A chip note at a SOP pitch (0…200 about 100) as a Taud note word, the
    way NOTE.EXE works it out (§4.2): the pitch, shifted right by two, picks a
    semitone either way and one of the 25 rows, and the note plus that semitone
    is clamped to the chip's eight octaves — so notes above SOP pitch 107 sound
    as 107.

    Middle C is anchored at concert C4, as every OPL converter here does, and
    everything else keeps its distance from it on Note's own table: its
    semitones are a shade wider than equal temperament and its bends move in
    1/25 of a semitone, and a converted note lands where Note put it."""
    t = max(0, min(200, pitch)) >> 2
    semitone, row = 0, t - SOP_PITCH_STEPS
    if row < 0:
        semitone, row = -1, t
    elif row >= SOP_PITCH_STEPS:
        semitone, row = 1, row - SOP_PITCH_STEPS
    n = max(0, min(CHIP_TOP_NOTE, chip_note + semitone))
    freq = SOP_FNUM_TABLE[row * 12 + n % 12] * (1 << (n // 12))
    return round(_C4_WORD + 4096 * math.log2(freq / _C4_FREQ))


# ── Tempo ────────────────────────────────────────────────────────────────────

#: The PC's programmable interval timer counts at this, in Hz.
PIT_HZ = 1193182


def sop_tempo(bpm: int, tick_beat: int) -> float:
    """§5: the tempo NOTE.EXE really plays a SOP tempo of `bpm` at.

    Note runs the timer at 4 × bpm interrupts a second, 240 to the beat, and
    steps the song one tick every 240 ÷ tickBeat of them, in integers.  The
    divisor rounds down, so 120 comes out at 120.04; a rate under 19 Hz cannot
    be set and leaves the timer at 18.2 Hz, so tempos 2…4 play at about 4.55;
    and a tickBeat that does not divide 240 runs slightly fast.  The library's
    `sopTempo` is the same arithmetic."""
    rate = bpm * 4
    divisor = 65536 if rate < 19 else PIT_HZ // rate
    per_tick = max(1, 240 // max(1, tick_beat))
    return (PIT_HZ / divisor) / per_tick * 60.0 / max(1, tick_beat)


# ── Grid ─────────────────────────────────────────────────────────────────────

#: Taud's tick rate is the resolution of every envelope and every per-tick
#: effect, so the converter buys as many ticks a row as the tempo range allows:
#: at 500 BPM a tick is 5 ms, against 20 ms at a tracker-ordinary 125.
MAX_BPM = 535
MIN_BPM = 25
MAX_TICK_RATE = 127


def row_seconds(song: dict, tempo: float) -> float:
    """How long one row lasts at `tempo`, in seconds.  §1: ticks become seconds
    by `ticks per second = bpm × tickBeat ÷ 60`."""
    if tempo <= 0:
        tempo = 120
    return 60.0 / (song['tick_beat'] * tempo)


def speed_bpm_for(seconds: float):
    """(ticks per row, BPM) realising a row of `seconds`.

    A Taud row lasts `speed × 2.5 ÷ BPM` seconds, so the pair is one equation
    with a free parameter — and the parameter is spent on the shortest TICK the
    535 BPM ceiling allows, because the tick is the resolution of every envelope
    and every per-tick effect the engine has.  An OPL percussive attack is the
    thing that depends on it: at 500 BPM a tick is 5 ms and the attack survives,
    at 125 it is 20 ms and the attack is smeared over one."""
    if seconds <= 0:
        return 6, 125
    speed = max(1, min(MAX_TICK_RATE, int(MAX_BPM * seconds / 2.5)))
    bpm = int(round(speed * 2.5 / seconds))
    return speed, max(MIN_BPM, min(MAX_BPM, bpm))


def tempo_effect(bpm: int):
    """(opcode, argument) for `T`, using the extended form above 280 BPM."""
    if bpm <= 280:
        return TOP_T, ((bpm - 25) & 0xFF) << 8
    return TOP_T, 0xFF00 | ((bpm - 280) & 0xFF)


# ── Panning ──────────────────────────────────────────────────────────────────

#: §4.2: 0 is right, 1 is middle, 2 is left.  Taud's lane pan is the IT
#: convention — $00 left, $80 centre, $FF right — and the chip's stereo
#: switches really are hard, so the ends of the range are the honest reading.
SOP_PAN_TO_TAUD = {0: 0xFF, 1: 0x80, 2: 0x00}


def pan_value(value: int):
    """The Taud pan for a SOP pan value, or None for one that silences the lane.

    §4.2: NOTE.EXE writes any value but 0, 1 and 2 into register 0xC0 as it
    stands, which clears both stereo switches — every such value in the corpus
    does — so the channel is silent until the next pan event.  (It also ORs
    the value's low nibble into feedback and connection until the next
    instrument, which a Taud rack cannot follow.)  Five corpus events do it;
    in `V_1.SOP` that is the whole of track 19."""
    return SOP_PAN_TO_TAUD.get(value)


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


#: Roles whose pitch the SOP's pitch events move: every melodic voice and the
#: bass drum.  §4.2: in rhythm mode Note ignores pitch on the snare, tom,
#: cymbal and hi-hat tracks.
PITCH_ROLES = frozenset(('melodic', 'melodic4', 'bd'))
#: Drums whose note number means nothing: the chip builds them out of bits of
#: two accumulators.
PITCHLESS_ROLES = frozenset(('sd', 'tc', 'hh'))
#: The largest pitch change a fine slide can make in one row, in note-word
#: units — just under an octave.
FINE_SLIDE_MAX = 0xFFF


def build_cells(song, seq, speed, slot_of, level_of, fallback, num_voices):
    """The whole song as {(lane, row): Cell}, plus the row count.

    ONE FILE TICK IS ONE ROW.  An `.ims` is a ROL score rescaled onto a 240-tick
    MIDI grid and has to have the composer's row grid recovered from the greatest
    common divisor of its delta times; a SOP was written on a tracker's own grid
    and `tickBeat` — 4 to 16 — already IS its rows a beat.  Reducing by the GCD
    as well would be wrong twice over: it is 1 in 335 of the 336 corpus files, so
    it buys nothing, and in the one file where it is not it would flatten a
    twelve-rows-a-beat grid to four and leave nowhere to write between the notes.

    One SOP track is likewise one Taud lane, which needs saying only because it
    is the part that takes no work: track IS voice in NOTE.EXE, twenty of them,
    and Taud has thirty-two lanes.  Nothing is allocated, shared or stolen.

    §4.2: a note that starts while the track's last note is still sounding is a
    SLUR in Note — the pitch moves and the note is not struck again — so it is
    written as a pitch slide on the sounding note, not as a note: a fine slide,
    which lands on tick 0 as Note's does, or for a leap of an octave or more a
    tone portamento, which does not re-trigger either.  On a drum an overlapping
    hit makes no sound at all.  A note that starts exactly where the last one
    ends is struck, as in Note."""
    cells = {}
    rows_of_events = {}
    for row, kind, track, a, b in seq:
        rows_of_events.setdefault(row, []).append((kind, track, a, b))

    patch = [fallback] * num_voices
    volume = [DEFAULT_VOLUME] * num_voices
    bend = [CENTRE_PITCH] * num_voices
    pan = [None] * num_voices
    muted = [False] * num_voices
    note = [None] * num_voices
    note_patch = [None] * num_voices
    sounding = [False] * num_voices
    cur_pitch = [0] * num_voices
    written_vol = [None] * num_voices
    written_pan = [None] * num_voices
    #: Where each lane's sounding note runs out, from the length it carried.
    off_row = [None] * num_voices
    tempo_rows = {}
    gvol_rows = {}
    last_row = 0
    roles = [track_role(song, v) for v in range(num_voices)]

    def want_pitch(v):
        """The note word the lane's sounding note should be at now."""
        role = roles[v]
        return sop_note_word(note[v], bend[v] if role in PITCH_ROLES else CENTRE_PITCH)

    def retire(v, before_row):
        """Spend the pending note-off, unless a fresh note has overtaken it.

        §4.2: a note carries its own length, so nothing has to be paired up —
        but a track may trigger again before the length runs out, and then the
        key-off would land after the note that replaced it."""
        nonlocal last_row
        row = off_row[v]
        if row is None:
            return
        off_row[v] = None
        if row > before_row:
            return                                # cut short by the new note
        cell = cells.setdefault((v, row), Cell())
        # The release itself is the instrument's Volume Fadeout, not anything
        # written here — see opl2taud.release_fadeout.
        cell.note = NOTE_KEYOFF
        sounding[v] = False
        last_row = max(last_row, row)

    rows = sorted(rows_of_events)
    i = 0
    while i < len(rows):
        row = rows[i]
        i += 1
        events = rows_of_events[row]
        trigger = [None] * num_voices          # (chip note, instrument index, length)
        vol_changed = [False] * num_voices
        bend_changed = [False] * num_voices
        pan_changed = [False] * num_voices
        for kind, track, a, b in events:
            if kind == TEMPO:
                tempo_rows[row] = a
                continue
            if kind == GVOL:
                gvol_rows[row] = a
                continue
            if track >= num_voices:
                continue
            if kind == PATCH:
                patch[track] = a
            elif kind == VOLUME:
                volume[track] = a
                vol_changed[track] = True
            elif kind == BEND:
                bend[track] = a
                bend_changed[track] = True
            elif kind == PAN:
                p = pan_value(a)
                if (p is None) != muted[track]:
                    muted[track] = p is None
                    vol_changed[track] = True
                if p is not None:
                    pan[track] = p
                pan_changed[track] = True
            elif kind == NOTE_ON:
                trigger[track] = (max(0, a - opl.MIDI_TO_CHIP), patch[track], b)

        for v in range(num_voices):
            role = roles[v]
            slur = False
            if trigger[v] is not None:
                chip_note, idx, length = trigger[v]
                # §4.2: this track's own note still sounding makes the new one a
                # slur.  A change of instrument between the two is struck
                # instead: Note would load the new instrument under the held key,
                # and a Taud rack cannot be swapped without striking it.
                slur = (sounding[v] and off_row[v] is not None and off_row[v] > row
                        and idx == note_patch[v])
                if slur:
                    off_row[v] = row + max(1, length)
                    if role not in PITCHLESS_ROLES:
                        note[v] = chip_note
                else:
                    retire(v, row)
            pitch_due = (sounding[v] and note[v] is not None and role not in PITCHLESS_ROLES
                         and want_pitch(v) != cur_pitch[v])
            pan_due = pan[v] is not None and written_pan[v] != pan[v]
            if trigger[v] is None and not vol_changed[v] and not bend_changed[v] \
                    and not pan_changed[v] and off_row[v] != row \
                    and not pitch_due and not pan_due:
                continue
            cell = cells.setdefault((v, row), Cell())
            if trigger[v] is not None and not slur:
                chip_note, idx, length = trigger[v]
                slot = slot_of.get((idx, role), 0)
                if slot:
                    if role in PITCHLESS_ROLES:
                        cell.note = opl.TAUD_C4
                        note[v] = None
                    else:
                        note[v] = chip_note
                        cell.note = want_pitch(v)
                    cell.inst = slot
                    cur_pitch[v] = cell.note
                    note_patch[v] = idx
                    sounding[v] = True
                    off_row[v] = row + max(1, length)
                else:
                    # No instrument at all on this track yet: nothing sounds,
                    # and nothing should go on sliding the note before it.
                    sounding[v] = False
                    note[v] = None
            elif off_row[v] == row:
                retire(v, row)

            level = level_of.get((patch[v], role), 0)
            vol = 0 if muted[v] else volume_column(volume[v], level)
            if vol_changed[v] or (trigger[v] is not None and not slur):
                if written_vol[v] != vol or trigger[v] is not None:
                    cell.vol_sel = SEL_SET
                    cell.vol_val = vol
                    written_vol[v] = vol

            # §4.2's pitch is a ±100 offset about 100, one semitone either way,
            # and a slur moves it a whole interval.  Both are followed with FINE
            # pitch slides, which fire once on tick 0 — so the pitch is exact at
            # every row boundary, and what is lost is only the shape between two
            # rows.  A leap too wide for one fine slide is a tone portamento to
            # the new note, which reaches it on the next tick without striking.
            # Pitch has the effect column ahead of panning, because a late pitch
            # is heard and a late pan barely is; whichever loses is retried on
            # the lane's next row.
            if sounding[v] and note[v] is not None and role not in PITCHLESS_ROLES \
                    and cell.note in (NOTE_NOP, NOTE_KEYOFF) and cell.eff == TOP_NONE:
                want = want_pitch(v)
                delta = want - cur_pitch[v]
                if cell.note == NOTE_NOP and abs(delta) > FINE_SLIDE_MAX:
                    cell.note = want
                    cell.eff, cell.arg = TOP_G, 0xFFFF
                    cur_pitch[v] = want
                elif delta:
                    step = min(FINE_SLIDE_MAX, abs(delta))
                    cell.eff = TOP_F if delta > 0 else TOP_E
                    cell.arg = 0xF000 | step
                    cur_pitch[v] += step if delta > 0 else -step

            # Panning is the LANE's, not the note's: a SOP sets it per track and
            # it survives every note after it, which is exactly what `S $80xx`
            # means and what the panning column does not.
            if pan[v] is not None and written_pan[v] != pan[v] and cell.eff == TOP_NONE:
                written_pan[v] = pan[v]
                cell.eff, cell.arg = TOP_S, 0x8000 | pan[v]
        last_row = max(last_row, row)

        # A slide or a pan that lost its row for want of an effect column is
        # retried on the next row, whether or not that row has events of its own.
        nxt = row + 1
        if nxt not in rows_of_events and any(
                (pan[v] is not None and written_pan[v] != pan[v]) or
                (sounding[v] and note[v] is not None and roles[v] not in PITCHLESS_ROLES
                 and want_pitch(v) != cur_pitch[v])
                for v in range(num_voices)):
            rows_of_events[nxt] = []
            rows.insert(i, nxt)

    for v in range(num_voices):                       # the last note still rings
        retire(v, math.inf)

    # Tempo and global volume are playhead-scope, so which lane carries them does
    # not matter — only that each gets a cell whose effect column is free.
    cur_speed, cur_bpm = speed
    for row in sorted(set(tempo_rows) | set(gvol_rows)):
        writes = []
        if row in tempo_rows:
            new_speed, new_bpm = speed_bpm_for(
                row_seconds(song, sop_tempo(tempo_rows[row], song['tick_beat'])))
            if new_speed != cur_speed:
                writes.append((TOP_A, (new_speed & 0xFF) << 8))
            if new_bpm != cur_bpm:
                writes.append(tempo_effect(new_bpm))
            cur_speed, cur_bpm = new_speed, new_bpm
        if row in gvol_rows:
            writes.append((TOP_V, (global_volume(gvol_rows[row]) & 0xFF) << 8))
        for v in range(num_voices):
            if not writes:
                break
            cell = cells.setdefault((v, row), Cell())
            if cell.eff == TOP_NONE:
                cell.eff, cell.arg = writes.pop(0)
        if writes:
            vprint(f"  warning: row {row} had no free effect column for "
                   f"{len(writes)} playhead command(s)")
        last_row = max(last_row, row)
    return cells, last_row + 1


def global_volume(value: int) -> int:
    """§5's 0…127 global volume onto Taud's 0…$FF one.  Both are a scale on the
    summed output rather than on any one lane, so this is the whole conversion."""
    return max(0, min(0xFF, round(max(0, min(127, value)) * 255.0 / 127.0)))


# ── Assembly ─────────────────────────────────────────────────────────────────

#: The chip sums its voices into one 16-bit DAC, where a single full-scale
#: operator reaches 4084/16384 = 0.249.  A Taud voice at full note and channel
#: volume reaches 0.707 at mixing volume 255, so 90 would put ONE converted
#: voice at exactly the level the card gave it — which is `ims2taud`'s number,
#: and is right for eleven voices.
#:
#: A SOP has TWENTY, and each is exactly as loud, so 90 clips.  The player has
#: already solved the same problem and measured the answer: it backs a YMF262 off
#: to 0.42 of full scale against a YM3812's 0.7, a figure arrived at by counting
#: clamped samples over all 336 `.sop` files rather than by derivation — the
#: uncorrelated-voices derivation says 0.47, and real songs put their loudest
#: voices on the same beat.  Carrying that same ratio across is 90 × 0.42 ÷ 0.7.
#:
#: Measured, 20 seconds each of twelve corpus files, against the library's own
#: YMF262 rendering of the same file: at 90 the conversion runs a median 7.1 dB
#: hot and SEVEN of the twelve clip, the worst at 1.45% of its samples; at 54 it
#: runs a median 3.0 dB hot and the worst clips 0.005%, which is inside the
#: 0.1% the player's own figure was chosen to hold.  The 3 dB that remains is
#: not chased: it is not one number across the corpus (−0.3 dB to +6.1 dB), and
#: the two renderings genuinely differ — approximated envelopes, rendered rhythm
#: drums at unit envelope, no KSL between bands.  Clipping is the part that
#: matters and the part that is fixed.
DEFAULT_MIXING_VOL = 54
#: How long the song is given to ring out after its last event.
TAIL_ROWS = 8


def cue_rows_for(rows_per_bar: int) -> int:
    """How many rows a cue should play, given the song's bar length.

    A cue is the unit anyone editing the song moves around, so it wants to be a
    whole number of BARS.  A pattern holds 64 rows, and a SOP's bar is
    `tickBeat × beatMeasure` rows — 16 × 4 is exactly 64, 12 × 4 is 48, which
    would leave every cue straddling a bar line and the whole song unusable to
    remix.  So a cue plays the largest power-of-two count of bars that fits, and
    the LEN instruction says where it stops."""
    if rows_per_bar <= 0 or rows_per_bar > PATTERN_ROWS:
        return PATTERN_ROWS
    bars = 1
    while rows_per_bar * bars * 2 <= PATTERN_ROWS:
        bars *= 2
    return rows_per_bar * bars


def used_tracks(song: dict) -> int:
    """How many lanes the song needs: one past the last track Note plays that
    carries events.  §2: a mode-0 track can hold events and still be silent in
    Note, so both the mode and the events have to be asked."""
    last = -1
    for t, track in enumerate(song['tracks']):
        if track['events'] and track_plays(song, t):
            last = t
    return max(1, min(NUM_VOICES, last + 1))


def initial_tempo(song: dict) -> float:
    """§1, §5: `basicTempo` is not the tempo — Note writes 120 into it and never
    reads it back, and starts every song at 120.  The control track sets
    anything else.  A tempo already in force at tick 0 belongs in the song header
    rather than in a cell, so it is taken out of the stream here.  What comes
    back is what Note's timer makes of it (`sop_tempo`)."""
    tempo = NOTE_START_TEMPO
    for ev in song['control']:
        if ev['tick'] > 0:
            break
        if ev['code'] == 3:
            tempo = ev['value']               # a later one at tick 0 still wins
    return sop_tempo(tempo, song['tick_beat'])


def initial_global_volume(song: dict) -> int:
    """§5: the first control event is a global volume at tick 0 in 228 files.
    Like the tempo, one already in force belongs in the song header."""
    vol = 0xFF
    for ev in song['control']:
        if ev['tick'] > 0:
            break
        if ev['code'] == 8:
            vol = global_volume(ev['value'])
    return vol


def assemble_taud(song, *, mixing_vol=DEFAULT_MIXING_VOL, max_bands=4,
                  feedback_scale=1.0, with_project_data=True):
    seq = list(sop_sequence(song))
    if not seq:
        sys.exit("error: no events in this SOP file")

    rows_per_beat = song['tick_beat']
    tempo = initial_tempo(song)
    speed, bpm = speed_bpm_for(row_seconds(song, tempo))
    vprint(f"  grid: {rows_per_beat} rows a beat, tempo {tempo:g} → speed {speed}, "
           f"{bpm} BPM ({2500.0 / bpm:.1f} ms a tick)")

    num_voices = used_tracks(song)

    # ── Instruments ──────────────────────────────────────────────────────────
    usage, fallback = collect_usage(song, seq)
    if fallback is None:
        vprint("  warning: no instrument in this file yields a patch")
    entries, keys, silent = [], [], set()
    for key in sorted(usage):
        idx, role = key
        inst = song['instruments'][idx] if idx < len(song['instruments']) else None
        patch = patch_for(inst, role)
        if patch is None and idx not in silent:
            # `sop_sequence` has already dropped selections of empty slots
            # (§4.2), so this is only reachable through a default instrument
            # that is not one — kept as a guard rather than relied on.
            silent.add(idx)
            what = 'a comment line' if inst else 'past the end of the table'
            vprint(f"  warning: instrument {idx} is {what}; silent slot")
        entries.append({'patch': patch, 'kind': rack_kind(role), 'notes': sorted(usage[key]),
                        'name': (patch.name if patch else '') or f'inst {idx}'})
        keys.append(key)
    if len(entries) > opl.MAIN_SLOTS:
        vprint(f"  warning: {len(entries)} instrument/role pairs > "
               f"{opl.MAIN_SLOTS} slots; dropping the least used")
        order = sorted(range(len(entries)), key=lambda i: -len(usage[keys[i]]))
        keep = set(order[:opl.MAIN_SLOTS])
        entries = [e for i, e in enumerate(entries) if i in keep]
        keys = [k for i, k in enumerate(keys) if i in keep]

    bank = opl.build_bank(entries, bpm=bpm, max_bands=max_bands,
                          feedback_scale=feedback_scale)
    slot_of = dict(zip(keys, bank['slots']))
    level_of = {k: output_level(e['patch'], e['kind'])
                for k, e in zip(keys, entries)}
    wide = sum(1 for e in entries if e['patch'] and e['patch'].pair)
    vprint(f"  instruments: {len(entries)} racks ({wide} four-operator), "
           f"{sum(1 for n in bank['instrument_names'][opl.AUX_BASE:] if n)} operators, "
           f"{bank['pool_bytes']} bytes of samples")

    # ── Patterns ─────────────────────────────────────────────────────────────
    cells, num_rows = build_cells(song, seq, (speed, bpm), slot_of,
                                  level_of, fallback, num_voices)
    num_rows += TAIL_ROWS
    rows_per_bar = rows_per_beat * song['beat_measure']
    cue_rows = cue_rows_for(rows_per_bar)
    num_cues = max(1, -(-num_rows // cue_rows))
    vprint(f"  {num_rows} rows → {num_cues} cues of {cue_rows} rows "
           f"({rows_per_bar} a bar) × {num_voices} lanes")
    if num_cues > NUM_CUES:
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
        global_vol=initial_global_volume(song), mixing_vol=mixing_vol,
        num_cues=stored_cues)

    title = decode_johab_field(song['title_raw']).strip()
    proj = b''
    proj_off = 0
    if with_project_data:
        # §6: the credits are the composer's own, nineteen columns a line, and
        # they are the only attribution these files carry beyond the title — so
        # unlike an .iss's four name fields, which hold tool defaults far more
        # often than people, they are worth keeping whole.
        credits = '\n'.join(song['comments']).strip()
        proj = build_project_data(
            project_name=escape_non_ascii(title),
            message=escape_non_ascii(credits),
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
    ap.add_argument('input', help='Input .SOP song')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--mixingvol', type=int, default=DEFAULT_MIXING_VOL,
                    dest='mixing_vol', help='Song mixing volume, 0…255')
    ap.add_argument('--ksl-bands', type=int, default=4,
                    help='Key bands per operator for KSL/KSR (1 disables banding)')
    ap.add_argument('--feedback-scale', type=float, default=1.0,
                    help='Fudge factor on OPL feedback depth (1.0 = as the chip)')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the title / credits / instrument / sample names')
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()
    song = parse_sop(data)
    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    vprint(f"  title: {decode_johab_field(song['title_raw']).strip()!r}")
    playable = sum(1 for i in song['instruments'] if i['type'] != SOP_COMMENT_TYPE)
    vprint(f"  {'percussive' if song['percussive'] else 'melodic'} mode, "
           f"{len(song['tracks'])} tracks, {playable} instruments, "
           f"{len(song['comments'])} comment lines")

    taud = assemble_taud(song, mixing_vol=args.mixing_vol,
                         max_bands=args.ksl_bands,
                         feedback_scale=args.feedback_scale,
                         with_project_data=not args.no_project_data)
    with open(args.output, 'wb') as f:
        f.write(taud)
    print(f"wrote {len(taud)} bytes to '{args.output}'")


if __name__ == '__main__':
    main()
