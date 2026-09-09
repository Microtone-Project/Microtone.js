#!/usr/bin/env python3
"""midi2taud.py — Convert Standard MIDI (.mid) + SoundFont 2 (.sf2) to TSVM Taud (.taud)

Usage:
    python3 midi2taud.py song.mid soundfont.sf2 [output.taud]
                         [--perc-force-mapping BANK INST]
                         [--rpb N] [--speed N] [--fadeout N]
                         [--bend-epsilon CENTS] [--drum-keyoff]
                         [--loop] [--loop-at-eot] [--no-dedup-patterns]
                         [--realign-tempo BPM] [--quantise GRID]
                         [-v] [--no-project-data]

    # Batch / directory mode (terranmon.txt:3342-3401):
    python3 midi2taud.py midi_dir/ soundfont.sf2 [out_dir/]

  When the first argument is a DIRECTORY, every .mid/.midi inside it is compiled
  against the one SoundFont into the split Taud format: a single shared Sample and
  Instrument Image (<soundfont>.tsii) holding the instrument bank for all the songs,
  plus one Pattern Image (<song>.tpif) per MIDI carrying just that song's patterns.
  A .tpif is played by first loading its companion .tsii. The shared bank spans the
  UNION of every song's instruments, so the 8 MB sample / 255 slot budgets are shared
  too (overflow degrades exactly as in single-file mode). Instrument fadeouts encode
  SF2 release times in seconds but the engine fades per song-tick (rate ∝ BPM), so the
  shared image targets the mean of the songs' initial tempos; pass --fadeout for a
  tempo-independent step. Output directory defaults to the input directory.

Behaviour (per midi2taud.md):
  * Pitch bends are preserved as much as possible. A note starting under a
    non-zero bend triggers directly at the bent 4096-TET pitch (Taud notes
    are 4096-TET, so the trigger encodes the exact shifted pitch). Bend
    movement during a note is approximated as linear segments: each segment
    is one row carrying the exact 4096-TET target note plus tone portamento
    (G $xxxx, units/tick) sized to land on the target by row end. Jittery
    curves are simplified via --bend-epsilon (cents). RPN 0,0 pitch-bend
    range messages are honoured; bend values are computed as floats from
    the full 14-bit word (MIDIs that only drive the MSB work transparently).
  * Both MIDI key-off idioms — real note-off messages and note-on with
    velocity 0 — are translated into Taud KEY_OFF. Percussion-channel
    key-offs are dropped by default (GM percussion ignores note-off, and
    emitting them would chop one-shot drum tails); --drum-keyoff re-enables.
    A note only a handful of MIDI ticks long lands on the fine tick it started
    on and would be dropped as zero-length; anything the source gave a duration
    is held to MIN_NOTE_FT instead. This matters most for percussion, where a
    one-tick note-on is the ordinary idiom precisely because note-off is
    ignored. A note the source itself wrote as zero-length is still dropped.
  * The SF2 key/velocity sample-layering model is recreated faithfully. Each
    preset's zones are partitioned into the fewest mutually-DISJOINT layers
    (--max-layers cap, default 4); each layer becomes one normal Taud instrument
    with its zones as Ixmp patches (velocity axis round(vel × 63/127)). A preset
    needing >1 layer is emitted as a Metainstrument (terranmon.txt "Metainstrument
    definition"): the note references the meta slot and the engine fans out one
    voice per matching layer, so SF2's simultaneous layering (and detune-stacks)
    now sound — overlapping zones are no longer dropped. Single-layer presets stay
    plain instruments. Stereo SF2 samples are mixed to mono. Unused instruments and
    the samples nothing references are trimmed; each preset's full zone map is kept
    as Ixmp patches so the imported instruments stay playable beyond the notes this
    song happens to use (--trim-unused-patches restores the old trim-to-triggered
    behaviour for the smallest file).
  * The SF2 volume-envelope ADSR is preserved on the (instrument-scope) Taud
    volume envelope: delay/attack/hold/decay nodes and a sustain region held
    while the key is on. There is NO release leg — the SF2 *release segment*
    is the Volume Fadeout (with NNA Note Fade): on key-off the voice holds at
    the sustain node and fades to silence over the SF2 releaseVolEnv time
    (the full release, scaled to FluidSynth's PERCEIVED release length because
    the engine's fadeout is linear in amplitude, not dB — see _zone_fadeout).
    Per-layer Ixmp patches carry their own fadeout when their release differs.
    The canonical zone's ADSR represents the instrument.
  * Polyphony rides the engine's New Note Action (matching MIDI semantics):
    every instrument (drum kits included) gets NNA = Note Fade, so a voice
    column is reusable the moment its note releases — the release/fade tail
    moves to a background ghost on the next trigger and dies over its own
    release time. Voice budget defaults to 16 columns (--max-voices); overflow
    releases the oldest pedal-held or soonest-ending note early, not cut.
  * SF2 exclusiveClass (gen 57) is honoured on the percussion channel: a new note
    in a class chokes any ringing note of the same class (e.g. a closed hi-hat
    silences a ringing open hi-hat), matching FluidSynth's kill-by-exclusive-class.
    The choke is the new fast note-fade (note 0x0004, ~0.3 s) emitted at the next
    same-class onset; without it long percussion tails wash over the whole beat.
  * Sub-row timing is carried by S $Dx note delays (one row = `--speed`
    ticks; one beat = `--rpb` rows). The grid (Tickspeed + RPB) is auto-set by
    default from the tempo map, the MIDI time signatures and onset-subdivision
    analysis: rpb·speed fine-ticks per beat is chosen to represent the finest
    subdivision actually used, keep every tempo inside the Taud BPM register
    (25..535), and stay near the proven 24-fts/beat grid — so plain 4/4 @ 120
    BPM still reproduces the old speed 6 / rpb 4. Passing --rpb or --speed pins
    that axis and auto-fits the other; pass both to fully override. As a final
    step, a bend- or polyphony-heavy song with rpb < 8 has its rpb doubled (and
    speed halved, so F and the tempo are unchanged) up to 8: the extra rows give
    key-offs, exclusiveClass chokes, bend portamento (G) and channel-volume (M)
    effects more distinct rows to land on, so fewer are eaten by same-row / per-
    cell-slot collisions. Disabled by pinning --rpb or --speed.
    MIDI tempo changes map to T $xx00 set-tempo effects (or T $FFxx extended
    set-tempo above 280 BPM); channel volume /
    expression (CC7 × CC11) map to M $xx00 channel-volume effects so they
    never disturb the velocity-driven patch selection axis.
  * A MIDI whose declared tempo does not describe its own events — the beat is
    1.2 or 1.35 quarter notes long, so bar lines fall mid-phrase and rows per
    beat means nothing — can be put back on a sane grid with --realign-tempo.
    Every tick and every tempo is multiplied by one factor, so the performance
    is untouched in real time and the music's own beat becomes one quarter note;
    the file then declares the tempo it actually plays at. Pass the real tempo
    in BPM, or bare --realign-tempo to infer it from the onsets (an IOI comb
    for the grid period, a coherence sweep to sharpen it, then the metrical
    level from the accents and the plausibility of the tempo — it reports what
    it chose and the other readings of the same grid). Nothing is snapped by
    this: --quantise is a separate, later step, and the two compose.
  * Cues are broken at every time-signature change, and each section is packed
    into whole-bar cues (the largest multiple of its bar length that fits in 64
    rows) so the tracker's bar/beat highlighting (sMet beat divisions) lines up
    with the music.
  * Byte-identical patterns are pooled into one copy by default (a repeated bar,
    and every silent column, costs one pattern for the whole song). The cue sheet
    then references the same pattern from several cues, so an edit to one of them
    changes all of its occurrences; --no-dedup-patterns gives every cue×voice
    cell its own private pattern instead, which is what you want when the import
    is a starting point for editing rather than a finished song.
  * Looping. A MIDI that carries its own loop markers is ALWAYS made to loop at
    those points (regardless of --loop); --loop additionally loops a marker-less
    MIDI start-to-end. Recognised loop-marker conventions (case-insensitive,
    first occurrence wins; resolved in this priority):
      - FF 06 / FF 01 text STARTING with "loops" (loop start) / "loope" (end);
      - CC #116 (loop start) + CC #117 (loop end);
      - CC #110 (loop start) + CC #111 (loop end);
      - CC #111 alone = loop START, loop end = End-of-Track (FF 2F 00).
    A missing loop end defaults to End-of-Track. The loop is realised as a cue
    jump: when it spans complete full-length cues from a cue boundary, the final
    cue's HALT is replaced with a JMP back to the loop-start cue; otherwise an
    in-pattern order jump (effect B → loop-start cue, plus effect C → row when
    the loop start is mid-cue) is placed on the last looped row. Cues after the
    loop end are dropped.
    --loop (whole song) rounds its loop-end UP to the next bar line by default,
    so the loop seam stays on the beat grid (and usually lands on a full cue → a
    clean JMP); --loop-at-eot loops exactly at End-of-Track instead. Bar rounding
    never applies to explicit MIDI loop markers — those loop verbatim.
"""

import argparse
import array
import bisect
import cmath
import copy
import math
import os
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    TAUD_KIND_FULL, TAUD_KIND_SAMPLEINST, TAUD_KIND_PATTERN,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, SAMPLE_LEN_LIMIT,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    MAX_VOICES, CUE_SIZE_64, NUM_CUES_64, XHDR_FLAG, EMPTY_CUE_64,
    CUE_EMPTY, EMPTY_CUE, finalize_cue_sheet, set_cue_instruction,
    NOTE_NOP, NOTE_KEYOFF, NOTE_FASTFADE, TAUD_C4,
    TOP_B, TOP_C, TOP_G, TOP_M, TOP_S, TOP_T,
    SEL_SET, SEL_FINE,
    CUE_INST_NOP, CUE_INST_HALT,
    resample_linear, encode_cue, deduplicate_patterns, encode_song_entry,
    compress_blob, build_project_data, cue_instruction_len,
    cue_instruction_halt_at, cue_instruction_jump,
    last_note_cue_index, nearest_minifloat,
    IXMP_PAN_NO_OVERRIDE, IXMP_CHAN_DISCRETE, atten_cb_to_octet,
)

SIGNATURE = b'midi2taud/TSVM'   # 14 bytes

# Shortest length, in fine ticks, a note that HAD a duration in the MIDI is
# allowed to come out with. A note only a handful of MIDI ticks long lands on
# the same fine tick it started on — the Taud grid is coarser than the
# performance — and a zero-length note is dropped. That silently deleted
# PERCUSSION above all: GM drums ignore note-off, so sequencers write drum hits
# as the shortest note they can, one or two ticks, and a whole kit could vanish
# from a converted song. (Measured on flourish.mid: 50 notes lost, 49 of them on
# channel 10.) It was phase-dependent too — the same 10-tick note survived or
# died depending on which tick it started on, because the ft conversion rounds.
# One fine tick is the shortest length the grid can hold, and it is enough:
# a drum keeps its trigger and no key-off (so the sample rings out in full),
# and a melodic note's key-off rounds up to the next row through the sub-row
# path in emit_cells.
MIN_NOTE_FT = 1
UNITS_PER_SEMI = 4096.0 / 12.0  # 4096-TET units per 12-TET semitone

# Effect priorities for the shared per-cell effect slot. Higher wins when a
# later pass needs the slot: SD note delays carry trigger timing and are
# never overwritten; T tempo is global and may evict G/M; M only takes free
# slots.
PRIO_FREE  = 0
PRIO_M     = 1
PRIO_PORTA = 2
PRIO_DELAY = 3
PRIO_TEMPO = 4


def key_to_noteval(key: float) -> int:
    """MIDI key (float, 60 = middle C) → Taud 4096-TET noteVal (C4 = 0x5000)."""
    return max(0x20, min(0xFFFF, round(TAUD_C4 + (key - 60.0) * UNITS_PER_SEMI)))


# ── MIDI parser ───────────────────────────────────────────────────────────────

def _read_varlen(data: bytes, pos: int):
    val = 0
    while True:
        b = data[pos]; pos += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            return val, pos


def _parse_track(data: bytes, pos: int, end: int) -> list:
    """Parse one MTrk body → list of (abs_tick, event_tuple)."""
    evs = []
    tick = 0
    status = 0
    while pos < end:
        delta, pos = _read_varlen(data, pos)
        tick += delta
        if pos >= end:
            break
        b = data[pos]
        if b & 0x80:
            status = b
            pos += 1
        elif status < 0x80:
            vprint(f"  warning: corrupt track data at {pos:#x}, truncating track")
            break

        if status == 0xFF:                       # meta
            mtype = data[pos]; pos += 1
            ln, pos = _read_varlen(data, pos)
            payload = data[pos:pos+ln]; pos += ln
            if mtype == 0x51 and ln >= 3:
                uspq = int.from_bytes(payload[:3], 'big')
                if uspq > 0:
                    evs.append((tick, ('tempo', 60000000.0 / uspq)))
            elif mtype == 0x03:
                txt = payload.decode('latin-1', errors='replace').strip()
                if txt:
                    evs.append((tick, ('title', txt)))
            elif mtype in (0x01, 0x06):                # text (0x01) / marker (0x06)
                # Loop points by text convention: a marker/text whose ASCII
                # STARTS with "loops" / "loope" (case-insensitive) — see the
                # loop-convention list in the module docstring.
                tag = payload.decode('latin-1', errors='replace').strip().lower()
                if tag.startswith('loops'):
                    evs.append((tick, ('loopstart',)))
                elif tag.startswith('loope'):
                    evs.append((tick, ('loopend',)))
            elif mtype == 0x58 and ln >= 2:        # time signature (FF 58 04 nn dd cc bb)
                # nn = numerator, dd = denominator as a negative power of 2
                # (2 = quarter, 3 = eighth). cc/bb (clocks-per-click, 32nds-per-
                # quarter) carry no information the Taud grid needs.
                evs.append((tick, ('timesig', payload[0], payload[1])))
            elif mtype == 0x2F:
                evs.append((tick, ('eot',)))
                break
            status = 0                           # meta cancels running status
        elif status in (0xF0, 0xF7):             # sysex
            ln, pos = _read_varlen(data, pos)
            pos += ln
            status = 0
        else:
            hi = status & 0xF0
            ch = status & 0x0F
            if hi in (0xC0, 0xD0):
                d1 = data[pos]; pos += 1
                if hi == 0xC0:
                    evs.append((tick, ('prog', ch, d1)))
            else:
                d1 = data[pos]; d2 = data[pos+1]; pos += 2
                if hi == 0x90:
                    if d2 > 0:
                        evs.append((tick, ('on', ch, d1, d2)))
                    else:
                        evs.append((tick, ('off', ch, d1)))   # vel-0 idiom
                elif hi == 0x80:
                    evs.append((tick, ('off', ch, d1)))
                elif hi == 0xB0:
                    evs.append((tick, ('cc', ch, d1, d2)))
                elif hi == 0xE0:
                    evs.append((tick, ('bend', ch, (d2 << 7) | d1)))
                # 0xA0 polyphonic aftertouch: ignored
    return evs


def parse_midi(path: str):
    """Returns (division, merged_events). division: ('ppq', tpq) or
    ('smpte', fps, tpf). merged_events: [(tick, seq, event_tuple)] sorted."""
    with open(path, 'rb') as f:
        data = f.read()

    if data[:4] == b'RIFF':                      # RMID wrapper
        pos = 12
        while pos + 8 <= len(data):
            cid = data[pos:pos+4]
            sz  = struct.unpack_from('<I', data, pos+4)[0]
            if cid == b'data':
                data = data[pos+8 : pos+8+sz]
                break
            pos += 8 + sz + (sz & 1)

    if data[:4] != b'MThd':
        sys.exit("error: not a MIDI file (bad MThd magic)")
    hlen = struct.unpack_from('>I', data, 4)[0]
    fmt, ntrk, div = struct.unpack_from('>HHH', data, 8)
    if fmt == 2:
        vprint("  warning: SMF format 2 — tracks merged on a shared timeline")

    if div & 0x8000:
        fps = -struct.unpack_from('b', data, 12)[0]
        tpf = div & 0xFF
        division = ('smpte', fps, tpf)
    else:
        division = ('ppq', max(1, div))

    pos = 8 + hlen
    merged = []
    seq = 0
    tracks_found = 0
    # Per-channel display name. Each MIDI track's FF 03 name votes for the
    # channels it plays note-ons on, weighted by note count; a channel is named
    # after whichever named track drives it most (usually 1:1 in GM Format-1
    # files). The conductor track's name — no note-ons — votes for nothing and
    # stays the song title. Falls back downstream to the preset name, then "Ch{n}".
    chan_name_votes = {}
    while pos + 8 <= len(data) and tracks_found < ntrk:
        cid = data[pos:pos+4]
        sz  = struct.unpack_from('>I', data, pos+4)[0]
        body_start = pos + 8
        pos = body_start + sz
        if cid != b'MTrk':
            continue
        tracks_found += 1
        track_name = None
        on_counts = {}
        for tick, ev in _parse_track(data, body_start, min(pos, len(data))):
            if ev[0] == 'title' and track_name is None:
                track_name = ev[1]
            elif ev[0] == 'on':
                on_counts[ev[1]] = on_counts.get(ev[1], 0) + 1
            merged.append((tick, seq, ev))
            seq += 1
        if track_name:
            for ch, cnt in on_counts.items():
                votes = chan_name_votes.setdefault(ch, {})
                votes[track_name] = votes.get(track_name, 0) + cnt
    merged.sort(key=lambda e: (e[0], e[1]))
    channel_names = {ch: max(votes.items(), key=lambda kv: kv[1])[0]
                     for ch, votes in chan_name_votes.items()}
    return division, merged, channel_names


# ── Note / controller extraction ──────────────────────────────────────────────

class Note:
    __slots__ = ('ch', 'key', 'vel', 'start_ft', 'end_ft', 'inst_key',
                 'bend0', 'slot', 'voice', 'drum', 'pedal_ft', 'excl_cut_ft',
                 'start_tick')
    def __init__(self, ch, key, vel, start_ft, inst_key, bend0, start_tick=0):
        self.ch       = ch
        self.key      = key
        self.vel      = vel
        self.start_ft = start_ft
        # The SOURCE tick the note-on sat on. Kept only so end_note can tell a
        # note the source itself wrote as zero-length from one the fine-tick
        # grid collapsed (MIN_NOTE_FT).
        self.start_tick = start_tick
        self.end_ft   = None
        self.inst_key = inst_key
        self.bend0    = bend0
        self.slot     = 0
        self.voice    = -1
        self.drum     = (inst_key[0] == 'd')
        self.pedal_ft = None     # physical key-up time when only the pedal holds it
        self.excl_cut_ft = None  # ft at which a same-exclusiveClass note chokes this one


class _ChState:
    __slots__ = ('bank', 'prog', 'rpn_msb', 'rpn_lsb', 'range_semi',
                 'range_cents', 'cur_bend', 'bend_ft', 'bend_val',
                 'cc7_ft', 'cc7_val', 'cc11_ft', 'cc11_val',
                 'cc10_ft', 'cc10_val', 'sus', 'pending', 'active')
    def __init__(self):
        self.bank = 0
        self.prog = 0
        self.rpn_msb = 0x7F
        self.rpn_lsb = 0x7F
        self.range_semi  = 2
        self.range_cents = 0
        self.cur_bend = 0.0
        self.bend_ft  = [0];   self.bend_val = [0.0]
        self.cc7_ft   = [0];   self.cc7_val  = [100]    # GM default
        self.cc11_ft  = [0];   self.cc11_val = [127]
        self.cc10_ft  = [];    self.cc10_val = []       # empty = never set
        self.sus = False
        self.pending = []        # notes held by the sustain pedal
        self.active  = {}        # key → Note


def _curve_at(fts: list, vals: list, ft: int, default):
    i = bisect.bisect_right(fts, ft) - 1
    return vals[i] if i >= 0 else default


def _curve_push(fts: list, vals: list, ft: int, val):
    if fts and fts[-1] == ft:
        vals[-1] = val
    else:
        fts.append(ft); vals.append(val)


class Song:
    __slots__ = ('notes', 'channels', 'tempo_ft', 'tempo_bpm', 'title', 'end_ft',
                 'timesig_ft', 'timesig', 'loop_start_ft', 'loop_end_ft', 'eot_ft',
                 'track_names')


# CC numbers used as loop start / end markers by various sequencers (see the
# loop-convention list in the module docstring). Values are ignored — only the
# tick matters.
CC_LOOP_START_A = 110    # 0x6E  (paired with CC 111 as end)
CC_LOOP_END_A   = 111    # 0x6F  (also a loop-START when 110 is absent → end = EoT)
CC_LOOP_START_B = 116    # 0x74
CC_LOOP_END_B   = 117    # 0x75


def _resolve_loop(text_start, text_end, cc, eot_ft, max_ft):
    """Resolve the song's loop region (start_ft, end_ft) from the collected loop
    markers, or (None, None) when the MIDI defines none. `cc` maps each loop CC
    number to its first occurrence ft. Priority: text markers > CC 116/117 >
    CC 110/111 > CC 111-only (RPG-Maker style; loop-end = End-of-Track). An
    absent end falls back to End-of-Track (or the last event when no EoT)."""
    end_default = eot_ft if eot_ft is not None else max_ft
    if text_start is not None or text_end is not None:
        return (text_start if text_start is not None else 0,
                text_end   if text_end   is not None else end_default)
    if CC_LOOP_START_B in cc:
        return cc[CC_LOOP_START_B], cc.get(CC_LOOP_END_B, end_default)
    if CC_LOOP_START_A in cc:                       # 110 present ⇒ 111 is the end
        return cc[CC_LOOP_START_A], cc.get(CC_LOOP_END_A, end_default)
    if CC_LOOP_END_A in cc:                          # 111 alone ⇒ it is the start
        return cc[CC_LOOP_END_A], end_default
    return None, None


def extract_song(division, merged, rpb: int, speed: int) -> Song:
    """Walk merged MIDI events, producing note instances (with both key-off
    idioms resolved to a definite end time), per-channel bend/CC curves, and
    the tempo map — all on the Taud fine-tick (ft) grid where one row =
    `speed` fts and one beat = `rpb` rows."""
    if division[0] == 'ppq':
        tpq = division[1]
        def to_ft(tick):
            return round(tick * rpb * speed / tpq)
    else:
        _, fps, tpf = division
        tps = max(1.0, float(fps * tpf))         # ticks per second
        # SMPTE timing has no musical beats: pin a 120 BPM equivalent grid.
        def to_ft(tick):
            return round((tick / tps) * 2.0 * rpb * speed)
        vprint("  info: SMPTE division — pinned to a 120 BPM-equivalent grid")

    chs = [_ChState() for _ in range(16)]
    notes = []
    tempo_ft, tempo_bpm = [], []
    timesig_ft, timesig = [], []          # ft → (numerator, denom_power)
    title = None
    max_ft = 0
    max_tick = 0
    loop_text_start = loop_text_end = None    # FF 06/01 "loops"/"loope" ft
    loop_cc = {}                              # loop CC number → first occurrence ft
    eot_ft = None                             # latest End-of-Track ft (loop-end fallback)

    extended = [0]      # notes rescued by the MIN_NOTE_FT floor, for the log

    def end_note(n: Note, ft: int, tick: int, floor: bool = True):
        """Close `n` at fine tick `ft` (source tick `tick`).

        A note the SOURCE gave a duration keeps at least MIN_NOTE_FT, even when
        the ft conversion collapsed it onto its own start — see the constant.
        A note the source itself wrote as zero-length (note-on and note-off on
        the same tick) is left zero-length and dropped below, as before.

        `floor=False` is the RE-STRIKE case: the note is being closed because
        the same key sounds again, so the floor must not push its end past its
        own successor. Two hits of one key on one fine tick are a thing the
        grid cannot hold either way, and dropping the first is what happens to
        any two events that land on one cell.
        """
        if n.end_ft is not None:
            return
        end = max(ft, n.start_ft)
        if floor and tick > n.start_tick and end < n.start_ft + MIN_NOTE_FT:
            end = n.start_ft + MIN_NOTE_FT
            extended[0] += 1
        n.end_ft = end

    for tick, _seq, ev in merged:
        ft = to_ft(tick)
        if ft > max_ft:
            max_ft = ft
        if tick > max_tick:
            max_tick = tick
        kind = ev[0]

        if kind == 'on':
            _, ch, key, vel = ev
            st = chs[ch]
            prev = st.active.pop(key, None)
            if prev is not None:                 # re-strike: close the old one
                end_note(prev, ft, tick, floor=False)
            ik = ('d', st.prog) if ch == 9 else ('m', st.bank, st.prog)
            n = Note(ch, key, vel, ft, ik, st.cur_bend, tick)
            st.active[key] = n
            notes.append(n)

        elif kind == 'off':
            _, ch, key = ev
            st = chs[ch]
            n = st.active.pop(key, None)
            if n is not None:
                if st.sus:
                    n.pedal_ft = ft
                    st.pending.append(n)
                else:
                    end_note(n, ft, tick)

        elif kind == 'bend':
            _, ch, val14 = ev
            st = chs[ch]
            # MUST be float maths: 14-bit word (or MSB-only 7-bit source,
            # which simply leaves the low 7 bits zero) → ±range semitones.
            norm  = (float(val14) - 8192.0) / 8192.0
            semis = norm * (st.range_semi + st.range_cents / 100.0)
            st.cur_bend = semis
            _curve_push(st.bend_ft, st.bend_val, ft, semis)

        elif kind == 'cc':
            _, ch, num, val = ev
            st = chs[ch]
            if num in (CC_LOOP_START_A, CC_LOOP_END_A,
                       CC_LOOP_START_B, CC_LOOP_END_B):
                loop_cc.setdefault(num, ft)        # first occurrence wins
            if num == 0:
                st.bank = val
            elif num == 7:
                _curve_push(st.cc7_ft, st.cc7_val, ft, val)
            elif num == 10:
                _curve_push(st.cc10_ft, st.cc10_val, ft, val)
            elif num == 11:
                _curve_push(st.cc11_ft, st.cc11_val, ft, val)
            elif num == 64:
                if val >= 64:
                    st.sus = True
                else:
                    st.sus = False
                    for n in st.pending:
                        end_note(n, ft, tick)
                    st.pending.clear()
            elif num == 100:
                st.rpn_lsb = val
            elif num == 101:
                st.rpn_msb = val
            elif num in (98, 99):                # NRPN deselects RPN
                st.rpn_msb = st.rpn_lsb = 0x7F
            elif num == 6:
                if st.rpn_msb == 0 and st.rpn_lsb == 0:
                    st.range_semi = val
            elif num == 38:
                if st.rpn_msb == 0 and st.rpn_lsb == 0:
                    st.range_cents = val
            elif num in (120, 123):              # all sound / notes off
                for n in list(st.active.values()):
                    end_note(n, ft, tick)
                st.active.clear()
                for n in st.pending:
                    end_note(n, ft, tick)
                st.pending.clear()
            elif num == 121:                     # reset all controllers
                st.cur_bend = 0.0
                _curve_push(st.bend_ft, st.bend_val, ft, 0.0)
                _curve_push(st.cc11_ft, st.cc11_val, ft, 127)
                st.sus = False
                for n in st.pending:
                    end_note(n, ft, tick)
                st.pending.clear()
                st.rpn_msb = st.rpn_lsb = 0x7F

        elif kind == 'prog':
            _, ch, val = ev
            chs[ch].prog = val

        elif kind == 'tempo':
            tempo_ft.append(ft); tempo_bpm.append(ev[1])

        elif kind == 'timesig':
            sig = (ev[1], ev[2])
            if timesig_ft and timesig_ft[-1] == ft:
                timesig[-1] = sig             # last event at this ft wins
            elif not timesig or timesig[-1] != sig:
                timesig_ft.append(ft); timesig.append(sig)

        elif kind == 'title':
            if title is None:
                title = ev[1]

        elif kind == 'loopstart':
            if loop_text_start is None:
                loop_text_start = ft
        elif kind == 'loopend':
            if loop_text_end is None:
                loop_text_end = ft
        elif kind == 'eot':
            if eot_ft is None or ft > eot_ft:
                eot_ft = ft

    # Close anything still ringing at end-of-file. `max_tick` is the last event
    # in the file, so a note still held there is a note the source never ended —
    # it has a duration, and the MIN_NOTE_FT floor applies to it like any other.
    for st in chs:
        for n in list(st.active.values()):
            end_note(n, max_ft, max_tick)
        st.active.clear()
        for n in st.pending:
            end_note(n, max_ft, max_tick)
        st.pending.clear()

    if extended[0]:
        vprint(f"  info: {extended[0]} note(s) shorter than one fine tick held "
               f"to {MIN_NOTE_FT} (they would have been dropped)")
    # What is left here is genuinely zero-length IN THE SOURCE: a note-on and a
    # note-off on the same tick, or a key struck twice on one fine tick.
    dropped = [n for n in notes if n.end_ft <= n.start_ft]
    if dropped:
        vprint(f"  info: dropped {len(dropped)} zero-length note(s)")
    notes = [n for n in notes if n.end_ft > n.start_ft]
    notes.sort(key=lambda n: (n.start_ft, n.ch, n.key))

    song = Song()
    song.notes     = notes
    song.channels  = chs
    song.tempo_ft  = tempo_ft
    song.tempo_bpm = tempo_bpm
    song.timesig_ft = timesig_ft
    song.timesig    = timesig
    song.title     = title
    song.end_ft    = max_ft
    song.eot_ft = eot_ft
    song.track_names = {}    # channel → MIDI FF03 name; filled by load_midi_song
    song.loop_start_ft, song.loop_end_ft = _resolve_loop(
        loop_text_start, loop_text_end, loop_cc, eot_ft, max_ft)
    return song


# ── Quantisation (item 168; OFF unless --quantise is passed) ──────────────────

# Beat subdivisions --quantise accepts as a grid. 'auto' takes the subdivision
# the onset analyser detected — the grid the piece is actually written on —
# and 'row' takes the Taud row grid, which is the finest timing a tracker can
# spell without an S $Dx note delay.
QUANTISE_GRIDS = (1, 2, 3, 4, 6, 8, 12, 16, 24, 32)


def resolve_quantise_grid(spec, division, merged, rpb: int) -> int:
    """--quantise's GRID → a beat subdivision. 'row' is the row grid; 'auto' is
    the detected onset subdivision (the row grid for SMPTE timing, which has no
    musical beat to analyse)."""
    if spec == 'row':
        return max(1, rpb)
    if spec == 'auto':
        if division[0] != 'ppq':
            return max(1, rpb)
        onsets = [tick for (tick, _seq, ev) in merged if ev[0] == 'on']
        return max(1, _detect_subdivision(onsets, division[1]))
    return int(spec)


def quantise_notes(song: Song, rpb: int, speed: int, denom: int,
                   strength: float) -> tuple:
    """Snap notes onto a 1/`denom`-of-a-beat grid, `strength` (0..1) of the way.

    BOTH ENDS move: the onset and the key-off are each snapped, so a quantised
    note starts on the grid and lasts a whole number of grid steps. Moving only
    the onset would leave every release exactly as ragged as it was played,
    which is half a job — a phrase quantised that way still has its key-offs
    scattered across the ticks between rows.

    The floor is MIN_NOTE_FT, and it is what keeps the shortest notes short: a
    note under half a grid step has both ends land on the SAME grid point, and
    rather than lengthen it to a full step (which would turn a drum hit or a
    grace note into a sixteenth) it stays at the shortest length the grid can
    hold. So notes at or above half a step come out on the grid, and the ones
    below it come out as short as they can be — which is what they were.

    `strength` is the answer to the warning this option prints: at 100 the grid
    wins outright, and at (say) 50 everything moves half way to it, which
    tightens sloppy playing while leaving a deliberate push or drag audible.
    Both ends take the same strength, so a partly-quantised note keeps a
    proportionate amount of its own length.

    Runs before apply_exclusive_class, so percussion chokes are measured from
    the quantised onsets. Returns (moved, worst_shift, mean_shift) in fine
    ticks over the ENDS THAT MOVED (onsets and key-offs counted alike), plus the
    two accidental-overlap counts — notes shortened, and notes that collapsed
    onto another strike of the same key and were dropped — for the log line.
    """
    step = (rpb * speed) / denom
    if step <= 0.0 or not song.notes:
        return 0, 0, 0.0, 0, 0

    def snap(ft: int) -> int:
        """`ft` pulled `strength` of the way to its nearest grid point."""
        target = round(ft / step) * step
        return ft + int(round((target - ft) * strength))

    moved = 0
    total = 0
    worst = 0
    for n in song.notes:
        start = max(0, snap(n.start_ft))          # never before the song starts
        end = max(snap(n.end_ft), start + MIN_NOTE_FT)
        for was, now in ((n.start_ft, start), (n.end_ft, end)):
            if was != now:
                moved += 1
                total += abs(now - was)
                worst = max(worst, abs(now - was))
        if n.pedal_ft is not None:
            # The physical key-up rides between the two, wherever they land.
            n.pedal_ft = min(max(n.pedal_ft + (start - n.start_ft), start), end)
        n.start_ft, n.end_ft = start, end

    # ── accidental overlaps ──────────────────────────────────────────────────
    # Quantising puts every boundary on the grid, so an overlap it leaves is a
    # whole number of steps — a real chord, a real pedal, a real held bass.
    # The exception is the MIN_NOTE_FT floor: a note whose two ends collapsed
    # onto ONE grid point is held open off-grid, and that is the only way an
    # overlap SHORTER than a step can exist afterwards. (Measured on Temjin.mid
    # and Cuba Baion.mid: every single sub-step overlap has a floored note as
    # its earlier half — 1139 of 1139 and 55 of 55.) So "shorter than one step"
    # is an exact test for "this pass caused it", and this pass cleans it up.
    #
    # Only within one (channel, KEY): nothing can strike one key twice at once,
    # so an overlap there is impossible in the source and definitionally an
    # artefact. Same channel, DIFFERENT key is left alone — 1005 of Temjin's
    # 1139 are that, nearly all on channel 10, and they are a kick sounding
    # under a hi-hat. Shortening those would be cutting up a drum kit, and it
    # would buy nothing: _note_end_row frees a drum's column after ONE ROW
    # whatever its end_ft says, and a one-fine-tick overlap between two melodic
    # notes almost never crosses a row boundary either, so neither costs a
    # voice column in the first place.
    trimmed = collapsed = 0
    runs = {}
    for n in song.notes:
        runs.setdefault((n.ch, n.key), []).append(n)
    for run in runs.values():
        # Equal onsets sort SHORTEST first, so the note that loses is the one
        # with least to lose.
        run.sort(key=lambda n: (n.start_ft, n.end_ft))
        for a, b in zip(run, run[1:]):
            overlap = a.end_ft - b.start_ft
            if overlap <= 0 or overlap >= step:
                continue
            # Shorten the EARLIER note to where the later one begins. When the
            # two begin together — which is nearly every case in practice, the
            # floor having held a note open on the grid point its successor
            # also landed on — there is nothing left of it, and that is the
            # right answer too: one strike of a key is one strike, and `b` is
            # the half of the pair with a length to keep. The filter below
            # drops what came out empty.
            a.end_ft = max(b.start_ft, a.start_ft)
            if a.end_ft > a.start_ft:
                trimmed += 1
            else:
                collapsed += 1
    if collapsed:
        song.notes = [n for n in song.notes if n.end_ft > n.start_ft]

    if moved:
        # extract_song left the list sorted; a move can reorder it, and both the
        # voice allocator and the cell emitter walk it in onset order.
        song.notes.sort(key=lambda n: (n.start_ft, n.ch, n.key))
        song.end_ft = max(song.end_ft, max(n.end_ft for n in song.notes))
    return moved, worst, (total / moved if moved else 0.0), trimmed, collapsed


# ── Tempo realignment (OFF unless --realign-tempo is passed) ──────────────────
#
# The problem this solves: a MIDI whose tempo metadata does not describe the
# music in it. The events are internally consistent — the piece was written on
# SOME grid — but that grid is not the file's quarter note, so a beat is 1.2 or
# 1.35 quarters instead of one and NOTHING downstream lines up: rows per beat is
# meaningless, bar lines fall mid-phrase, and the tracker's beat highlighting
# lands wherever it lands. It is common in MIDIs whose ticks are really a fixed
# clock (a tempo of 60 at 240 PPQ is 240 ticks per SECOND, not a musical tempo)
# and in files typed in against the wrong project tempo.
#
# The fix is a rescale, not a rewrite of the performance: multiply every event
# tick AND every tempo by the same factor r. Wall-clock timing is then EXACTLY
# preserved (a tick is r times shorter and there are r times as many of them),
# and r is chosen so the music's own beat becomes one quarter note. The file
# then declares the tempo it actually plays at, and everything downstream — the
# fine-tick grid, rows per beat, the bar packing, --quantise — is measuring the
# right thing. Nothing is snapped and no note moves relative to any other; pass
# --quantise as well if the timing itself wants tightening.
#
# r comes from one of two places. --realign-tempo BPM takes the user's word for
# the real tempo (r = BPM / declared), which is the only thing that can help a
# file whose grid is fine and whose tempo NUMBER is simply wrong — that case
# leaves no evidence in the event positions at all. --realign-tempo auto infers
# the beat from the onsets, below.

_REALIGN_MIN_ONSETS   = 12      # fewer onset clusters than this: nothing to fit
_REALIGN_BPM_LO       = 30.0    # plausible range for the REAL beat, searched
_REALIGN_BPM_HI       = 400.0   #   both as the grid range and as the answer
_REALIGN_SUBDIV_MAX   = 8       # the grid unit may be this fine a division of a beat
_REALIGN_FINEST_MS    = 40.0    # ... but never finer than this in real time
_REALIGN_CLUSTER_MS   = 50.0    # cap on the near-simultaneous onset window
_REALIGN_LAG_BEATS    = 8.0     # widest inter-onset gap the histogram collects
_REALIGN_BINS_PER_BEAT = 96     # IOI histogram resolution
_REALIGN_PAIR_CAP     = 32      # successors each onset is paired with
_REALIGN_COMB_K       = 8       # harmonics summed by the comb
_REALIGN_SWEEP_STEPS  = 1500    # log-spaced comb candidates
_REALIGN_COARSE_BAND  = 0.02    # the comb locates a period to about this
_REALIGN_SPAN0        = 32      # periods in the first refinement stage...
_REALIGN_SPAN_GROWTH  = 4.0     # ... and how fast the span grows after it
# Beat = grid unit × one of these. A beat is a whole number of grid units, so
# the level is what turns "the onsets are 92 ms apart" into a tempo.
_REALIGN_LEVELS       = (1, 2, 3, 4, 6, 8, 12, 16)
# Straight subdivision is far commoner than triplet subdivision as a whole
# piece's finest grid, and the two readings are often close on every other
# count, so a binary level starts ahead...
_REALIGN_BINARY       = (1, 2, 4, 8, 16)
_REALIGN_TERNARY_PEN  = 0.8     # ... so a ternary one has to score 1.25x as well
# Tempo prior: the metrical level is genuinely ambiguous from timing alone
# (81 BPM in eighths and 162 BPM in sixteenths are the same event stream), so
# the level is scored against how ordinary its tempo is, in octaves from 120.
_REALIGN_PRIOR_BPM    = 120.0
_REALIGN_SIGMA_TEMPO  = 1.1
# ... and against how far it moves the file from what it claims. A wrong tempo
# is usually wrong by a modest factor: the author typed something plausible and
# the GRID is what came out wrong. This is also what keeps a healthy file still:
# when the beat already IS the quarter note, r = 1 wins outright.
_REALIGN_SIGMA_RATIO  = 0.75
# Beat-accent evidence: the share of onset weight landing on the level's own
# grid, over the 1/m a level-less stream would give. Square-rooted and capped
# because it is a tie-breaker, not the answer — dense music saturates it.
_REALIGN_EXCESS_CAP   = 4.0
_REALIGN_EXCESS_POW   = 0.5
# A ratio inside this many octaves of 1 is not worth rewriting the file for.
_REALIGN_NOOP_TOL     = 0.004
# Below this the onsets are not on any single grid (a rubato performance, or a
# file that really is that ragged) and auto has nothing to stand on.
_REALIGN_COHERENCE_MIN = 0.30
# Coherence difference below which two candidate grids are called equally good,
# and the COARSER one wins. Every grid is also a grid at half and a third of
# itself — a stream of quarter notes sits perfectly on an eighth-note grid too —
# so on a tie the finer reading is the same answer needing twice the metrical
# level to express, and the level search is finite.
_REALIGN_COHERENCE_TIE = 0.02


def _declared_bpm0(merged) -> float:
    """The tempo in force at the first note-on — the number the file claims to
    play at, and what auto_timing's own bpm0 reads."""
    tempos = sorted((tick, ev[1]) for (tick, _s, ev) in merged if ev[0] == 'tempo')
    if not tempos:
        return 120.0
    first_on = next((tick for (tick, _s, ev) in merged if ev[0] == 'on'), 0)
    i = bisect.bisect_right([t for t, _ in tempos], first_on) - 1
    return tempos[i][1] if i >= 0 else tempos[0][1]


def _onset_clusters(merged, window):
    """[(tick, weight)] — note-ons within `window` of each other are ONE
    musical onset, at their mean tick and carrying their count as weight.

    Two things need this. A chord written by a sequencer that spreads its notes
    over a few ticks would otherwise put a huge false peak at that spread in the
    IOI histogram (measured: 780 pairs at 4 ticks in Temjin.mid, more than any
    real interval). And the weight is the accent evidence the metrical level is
    chosen on: a downbeat carrying a kick, a bass note and a chord is worth more
    than a passing note, and deduplicating the tick would throw exactly that
    away."""
    ons = sorted(tick for (tick, _s, ev) in merged if ev[0] == 'on')
    out = []
    i, n = 0, len(ons)
    while i < n:
        j = i + 1
        while j < n and ons[j] - ons[i] <= window:
            j += 1
        grp = ons[i:j]
        out.append((sum(grp) / len(grp), float(len(grp))))
        i = j
    return out


def _ioi_histogram(times, lag_max, bin_w):
    """Smoothed histogram of inter-onset intervals up to `lag_max`.

    Pairs, not just adjacent onsets: a grid shows up at every multiple of
    itself, which is what makes the comb below work. Intervals are local, so
    unlike absolute positions this says nothing about phase and cannot be
    thrown off by a song that is thousands of beats long."""
    nbins = int(lag_max / bin_w) + 3
    hist = [0.0] * nbins
    n = len(times)
    for i in range(n):
        ti = times[i]
        for j in range(i + 1, min(n, i + 1 + _REALIGN_PAIR_CAP)):
            d = times[j] - ti
            if d > lag_max:
                break
            hist[int(d / bin_w + 0.5)] += 1.0
    sm = [0.0] * nbins                        # 1-2-3-2-1 taper over ±2 bins
    for i in range(nbins):
        acc = 3.0 * hist[i]
        if i >= 1:          acc += 2.0 * hist[i - 1]
        if i >= 2:          acc += 1.0 * hist[i - 2]
        if i + 1 < nbins:   acc += 2.0 * hist[i + 1]
        if i + 2 < nbins:   acc += 1.0 * hist[i + 2]
        sm[i] = acc / 9.0
    return sm


def _comb_periods(hist, bin_w, lag_max, p_lo, p_hi, keep=4):
    """Candidate grid periods: the best local maxima of a harmonic comb over the
    IOI histogram. Score is the 1/k-weighted MEAN of the histogram at k·p, not
    the sum — a sum would simply reward the smallest period for having the most
    harmonics to add up."""
    ratio = (p_hi / p_lo) ** (1.0 / _REALIGN_SWEEP_STEPS)
    nbins = len(hist)
    scored = []
    p = p_lo
    for _ in range(_REALIGN_SWEEP_STEPS + 1):
        kmax = min(_REALIGN_COMB_K, int(lag_max / p))
        if kmax >= 2:
            acc = wsum = 0.0
            for k in range(1, kmax + 1):
                b = int(k * p / bin_w + 0.5)
                if b < nbins:
                    acc += hist[b] / k
                    wsum += 1.0 / k
            scored.append((p, acc / wsum if wsum > 0.0 else 0.0))
        p *= ratio
    peaks = [scored[i] for i in range(1, len(scored) - 1)
             if scored[i][1] >= scored[i - 1][1] and scored[i][1] > scored[i + 1][1]]
    peaks.sort(key=lambda ps: -ps[1])
    out = []
    for p, _s in peaks:
        if all(abs(math.log(p / q, 2)) > 0.03 for q in out):
            out.append(p)
        if len(out) >= keep:
            break
    return out


def _grid_coherence(times, weights, period):
    """(|R|, phase) — how tightly the onsets sit on a grid of `period`.

    The Rayleigh statistic: every onset is a unit vector at the angle of its
    position within the period, and |R| is the length of their weighted mean.
    1.0 is a perfect grid, 0.0 is no grid at all, and the argument gives the
    grid's offset for free. It needs no tolerance and no phase guess, which is
    why the fit is done with this rather than by least squares — a least-squares
    fit over a long song locks onto a period a hundredth of a percent off and
    reports the resulting drift as if the music were ragged."""
    acc = 0j
    w = 0.0
    k = 2.0 * math.pi / period
    for t, wt in zip(times, weights):
        acc += wt * cmath.exp(1j * k * t)
        w += wt
    return abs(acc) / w, cmath.phase(acc) / (2.0 * math.pi) * period


def _refine_grid_period(times, weights, p, band):
    """Sharpen a coarse period into the exact one by maximising the coherence.

    The peak is one Rayleigh cell wide — a relative width of one period in the
    span being measured — so sweeping a whole song at that resolution would take
    hundreds of passes over every onset. Instead the span starts at a few dozen
    periods, where the peak is broad and the comb's ±2% band is only a couple of
    cells, and quadruples each round: each stage's estimate is what makes the
    next stage's band narrow enough to stay cheap. The parabolic vertex at the
    end of each sweep is what keeps the phase from walking: a quarter-cell error
    is invisible over 32 periods and half a beat by the end of 3000."""
    t0, t_end = times[0], times[-1]
    total = t_end - t0
    span = min(_REALIGN_SPAN0 * p, total)
    while True:
        m = 0
        while m < len(times) and times[m] - t0 <= span:
            m += 1
        sub, sw = times[:max(m, 8)], weights[:max(m, 8)]
        cell = p / max(4.0 * p, span)          # one Rayleigh cell, relative
        band = max(band, 3.0 * cell)
        half = min(200, max(16, int(3.0 * band / cell)))
        step = band / half
        rs = [_grid_coherence(sub, sw, p * (1.0 + step * j))[0]
              for j in range(-half, half + 1)]
        b = max(range(len(rs)), key=rs.__getitem__)
        off = 0.0
        if 0 < b < len(rs) - 1:
            y0, y1, y2 = rs[b - 1], rs[b], rs[b + 1]
            den = y0 - 2.0 * y1 + y2
            if den < 0.0:
                off = max(-0.5, min(0.5, 0.5 * (y0 - y2) / den))
        p *= 1.0 + step * (b - half + off)
        band = 2.0 * cell
        if span >= total:
            break
        span = min(span * _REALIGN_SPAN_GROWTH, total)
    r, phase = _grid_coherence(times, weights, p)
    return p, phase, r


def _grid_deviation(times, weights, period, phase):
    """Mean distance from a grid point, in grid steps (0 = exact, 0.25 = none)."""
    tot = w = 0.0
    for t, wt in zip(times, weights):
        x = (t - phase) / period
        tot += wt * abs(x - round(x))
        w += wt
    return tot / w


def _realign_axes(division, merged):
    """(q, bpm0) — the tick count the file calls a quarter note, and the tempo
    it claims at the first note. SMPTE division has no musical tick at all, so
    it borrows the 120 BPM-equivalent quarter extract_song pins its grid to."""
    if division[0] == 'ppq':
        return float(division[1]), _declared_bpm0(merged)
    _, fps, tpf = division
    return max(1.0, float(fps * tpf)) / 2.0, 120.0


def detect_musical_grid(division, merged):
    """Infer the beat the events are actually written on.

    Returns a dict (grid period and its coherence, the chosen beat, the tempo it
    implies, the rescale ratio that would make it a quarter note, and the runner-
    up readings) or None when there is nothing to measure. Three stages:

      1. cluster the note-ons, so a spread chord is one onset with weight;
      2. an IOI comb picks candidate grid periods, and the coherence sweep
         sharpens each into an exact one — the winner is the period the onsets
         sit on most tightly;
      3. the beat is a whole number of those grid units, and which number is
         chosen by how ordinary the resulting tempo is, how far it moves the
         file from what it declares, and whether the onsets are actually
         accented on that level.

    Stage 3 is a judgement, not a measurement — a stream of eighths at 162 BPM
    and one of sixteenths at 81 are the same set of onsets, and no amount of
    timing analysis separates them. `cands` carries the alternatives so the
    caller can print them; --realign-tempo BPM is how the user overrules it."""
    q, bpm0 = _realign_axes(division, merged)
    tick_ms = 60000.0 / max(1e-9, bpm0 * q)
    beat_lo = q * bpm0 / _REALIGN_BPM_HI
    beat_hi = q * bpm0 / _REALIGN_BPM_LO
    p_lo = max(beat_lo / _REALIGN_SUBDIV_MAX, _REALIGN_FINEST_MS / tick_ms)
    if p_lo >= beat_hi:
        return None
    clusters = _onset_clusters(merged, min(p_lo / 2.0,
                                           _REALIGN_CLUSTER_MS / tick_ms))
    if len(clusters) < _REALIGN_MIN_ONSETS:
        return None
    times = [t for t, _w in clusters]
    weights = [w for _t, w in clusters]

    lag_max = _REALIGN_LAG_BEATS * beat_hi
    bin_w = max(beat_lo / _REALIGN_BINS_PER_BEAT, 1e-6)
    hist = _ioi_histogram(times, lag_max, bin_w)
    fits = []
    tried = []
    for p0 in _comb_periods(hist, bin_w, lag_max, p_lo, beat_hi):
        # A comb peak can land on the second or third harmonic of the real
        # grid, so each one is tested divided down as well.
        for j in (1, 2, 3):
            g0 = p0 / j
            if g0 < p_lo * 0.6 or any(abs(math.log(g0 / t, 2)) < 0.015 for t in tried):
                continue
            tried.append(g0)
            fits.append(_refine_grid_period(times, weights, g0,
                                            _REALIGN_COARSE_BAND))
    if not fits:
        return None
    fits.sort(key=lambda f: (-int(f[2] / _REALIGN_COHERENCE_TIE), -f[0]))
    grid, phase, coherence = fits[0]
    dev = _grid_deviation(times, weights, grid, phase)

    ks = [round((t - phase) / grid) for t in times]
    wsum = sum(weights)
    cands = []
    for m in _REALIGN_LEVELS:
        beat = grid * m
        bpm = bpm0 * q / beat
        if not (_REALIGN_BPM_LO <= bpm <= _REALIGN_BPM_HI):
            continue
        counts = [0.0] * m
        for k, wt in zip(ks, weights):
            counts[k % m] += wt
        cover = max(counts) / wsum
        ratio = q / beat
        score = (math.exp(-0.5 * (math.log(bpm / _REALIGN_PRIOR_BPM, 2)
                                  / _REALIGN_SIGMA_TEMPO) ** 2)
                 * math.exp(-0.5 * (math.log(ratio, 2)
                                    / _REALIGN_SIGMA_RATIO) ** 2)
                 * min(cover * m, _REALIGN_EXCESS_CAP) ** _REALIGN_EXCESS_POW
                 * (1.0 if m in _REALIGN_BINARY else _REALIGN_TERNARY_PEN))
        cands.append((score, m, beat, bpm, cover, ratio))
    if not cands:
        return None
    cands.sort(reverse=True)
    _s, level, beat, bpm, cover, ratio = cands[0]
    return {'grid': grid, 'coherence': coherence, 'deviation': dev,
            'beat': beat, 'bpm': bpm, 'level': level, 'cover': cover,
            'ratio': ratio, 'bpm0': bpm0, 'quarter': q,
            'clusters': len(times), 'cands': cands}


def realign_tempo(division, merged, spec):
    """Rewrite `merged` onto the grid of the real tempo. Returns the new event
    list (the division is untouched — the rescale lives in the ticks, so the
    file's PPQ still means what it says).

    `spec` is 'auto' or a BPM. Every tick and every tempo is multiplied by the
    same ratio, which leaves the performance identical in real time and makes
    one quarter note one beat of the music. A file with no tempo event at all
    gets one, since 'the same as before' is now a different number."""
    q, bpm0 = _realign_axes(division, merged)
    if spec == 'auto':
        found = detect_musical_grid(division, merged)
        if found is None:
            vprint("  realign: too few onsets to infer a grid — left alone")
            return merged
        vprint(f"  realign: grid {found['grid']:.4f} tick(s) over "
               f"{found['clusters']} onset(s), coherence {found['coherence']:.2f}, "
               f"mean deviation {found['deviation'] * 100:.1f}% of a grid step")
        if found['coherence'] < _REALIGN_COHERENCE_MIN:
            print(f"warning: --realign-tempo auto found no consistent grid in this "
                  f"MIDI (coherence {found['coherence']:.2f}) — the timeline was "
                  f"left alone. Pass --realign-tempo BPM if you know the tempo.",
                  file=sys.stderr)
            return merged
        if abs(math.log(found['ratio'], 2)) <= _REALIGN_NOOP_TOL:
            vprint(f"  realign: the beat already IS the quarter note "
                   f"({found['bpm']:.2f} BPM) — nothing to realign")
            return merged
        ratio = found['ratio']
        alts = ", ".join(f"{c[3]:.2f}" for c in found['cands'][1:4])
        print(f"note: --realign-tempo auto read this MIDI as {found['bpm']:.2f} BPM "
              f"(it declares {bpm0:.2f}) and rewrote its timeline to match — the "
              f"beat was {found['beat'] / q:.3f} quarter notes. Other readings of "
              f"the same grid: {alts} BPM; pass --realign-tempo BPM to pick one.",
              file=sys.stderr)
        vprint(f"  realign: beat {found['beat']:.3f} tick(s) = {found['level']} "
               f"grid unit(s), {found['cover'] * 100:.0f}% of the onset weight on it")
    else:
        ratio = float(spec) / bpm0
        vprint(f"  realign: {bpm0:.2f} BPM declared, {float(spec):.2f} BPM asked for")

    # Ticks stay FRACTIONAL. Rounding them to integers would be tidier to look
    # at and would silently merge events a hair apart — which for a two-tick
    # drum note means a note-on and a note-off on one tick, i.e. the note
    # extract_song drops as zero-length in the source. Every consumer of these
    # ticks divides them into fine ticks and rounds once, at the end.
    out = []
    have_tempo = False
    for tick, seq, ev in merged:
        if ev[0] == 'tempo':
            ev = ('tempo', ev[1] * ratio)
            have_tempo = True
        out.append((tick * ratio, seq, ev))
    if not have_tempo:
        # The file was riding the 120 BPM default, which is no longer the
        # tempo this timeline plays at.
        out.append((0.0, -1, ('tempo', 120.0 * ratio)))
        out.sort(key=lambda e: (e[0], e[1]))
    vprint(f"  realign: ticks x{ratio:.5f}, tempo {bpm0:.2f} -> {bpm0 * ratio:.2f} BPM "
           f"(the performance keeps its real-time timing exactly)")
    return out


# ── Auto timing (Tickspeed + RPB) ──────────────────────────────────────────────

# Candidate beat subdivisions tested by the onset analyser (per quarter note).
_SUBDIV_CANDIDATES = (1, 2, 3, 4, 6, 8, 12, 16)
# Fraction-of-a-quarter tolerance for an onset to count as "on" a 1/D grid.
_SUBDIV_TOL = 0.04
# Coverage at which a subdivision is accepted as the finest one in use. 0.95
# keeps the picker from chasing the last few percent of ornament/swing onsets
# into a needlessly fine grid (those land on the sub-row S$Dx grid anyway).
_SUBDIV_THRESHOLD = 0.95
# The proven default resolution (rpb 4 × speed 6). The picker anchors F=rpb·speed
# at the smallest multiple of the detected subdivision that is >= this, so any
# subdivision dividing 24 (1/2..1/12 and triplets) reproduces the old 6/4 grid.
# NOTE: row/pattern count depends only on rpb (rows = beats×rpb); speed is "free"
# sub-row + tempo precision, so the picker spends it rather than minimising F.
_F_TARGET = 24
# Taud BPM register is bias-25 in [25, 535] (T $FFxx extends past 280); tick rate Hz = bpm·2/5.
_TAUD_BPM_LO, _TAUD_BPM_HI = 25, 535

# RPB bump: bend- or polyphony-heavy songs cram more triggers / key-offs / chokes
# / bend-G / channel-M into each beat than emit_cells can place on distinct rows,
# so events get eaten by same-row & per-cell-slot collisions. Raising rows-per-beat
# (doubling rpb, halving tickspeed so F=rpb·speed — hence the tempo — is unchanged)
# spreads them out. Applied only when both axes are auto and rpb < 8.
_BUMP_TARGET_RPB       = 8     # raise rpb up to (at least) this
_BUMP_BEND_MIN_EVENTS  = 24    # "significant pitch-bend": at least this many...
_BUMP_BEND_MIN_DENSITY = 0.25  # ... non-centre bend events, and >= this per note
_BUMP_POLY_PEAK        = 10    # "many polyphony": peak simultaneous notes >= this


def _peak_polyphony(merged) -> int:
    """Peak count of simultaneously-sounding (channel, key) notes across the song.
    Sustain pedal is ignored — this is a polyphony proxy, not exact voicing."""
    active = set()
    cur = peak = 0
    for _tick, _seq, ev in merged:
        if ev[0] == 'on':
            k = (ev[1], ev[2])
            if k not in active:
                active.add(k); cur += 1
                if cur > peak:
                    peak = cur
        elif ev[0] == 'off':
            k = (ev[1], ev[2])
            if k in active:
                active.discard(k); cur -= 1
    return peak


def _detect_subdivision(onsets, tpq: int) -> int:
    """Finest beat subdivision (per quarter) the onsets actually use.

    Returns the smallest D from _SUBDIV_CANDIDATES whose 1/D grid covers
    >= _SUBDIV_THRESHOLD of onsets within _SUBDIV_TOL; else the best-covering
    candidate (so heavily syncopated/swing material lands on a usable grid
    rather than forcing the maximum)."""
    if not onsets:
        return 1
    best_d, best_cov = 1, -1.0
    for d in _SUBDIV_CANDIDATES:
        hits = 0
        for t in onsets:
            frac = (t % tpq) / tpq
            if abs(frac - round(frac * d) / d) <= _SUBDIV_TOL:
                hits += 1
        cov = hits / len(onsets)
        if cov >= _SUBDIV_THRESHOLD:
            return d
        if cov > best_cov:
            best_d, best_cov = d, cov
    return best_d


def auto_timing(division, merged, rpb_fixed, speed_fixed, max_voices) -> tuple:
    """Choose (rpb, speed, info) for the Taud grid from the tempo map, the MIDI
    time signatures and onset-subdivision analysis. A non-None rpb_fixed /
    speed_fixed pins that axis (the user passed it); the other is auto-fit. Both
    pinned → returned verbatim. When both are auto, a final RPB bump raises
    rows-per-beat for bend/polyphony-heavy songs (see the _BUMP_* constants)."""
    # SMPTE has no musical beat grid; the ft mapping pins a 120 BPM equivalent,
    # so there is nothing to optimise — keep the proven default / pinned values.
    if division[0] != 'ppq':
        return (rpb_fixed or 4, speed_fixed or 6,
                "SMPTE division — auto timing skipped")
    tpq = division[1]

    onsets = [tick for (tick, _seq, ev) in merged if ev[0] == 'on']
    tempos = sorted((tick, ev[1]) for (tick, _seq, ev) in merged if ev[0] == 'tempo')
    first_onset = onsets[0] if onsets else 0
    last_tick = max((tick for tick, _s, _e in merged), default=0)

    def bpm_at(tick):
        i = bisect.bisect_right([t for t, _ in tempos], tick) - 1
        return tempos[i][1] if i >= 0 else 120.0

    bpm0 = bpm_at(first_onset)
    all_bpms = {b for _t, b in tempos} or {120.0}
    bend_events = sum(1 for (_t, _s, ev) in merged if ev[0] == 'bend' and ev[2] != 8192)
    bends_present = bend_events > 0
    peak_poly = _peak_polyphony(merged)

    subdiv = _detect_subdivision(onsets, tpq)
    # Anchor: smallest multiple of the subdivision that is >= the proven grid, so
    # it represents the rhythm exactly (F % subdiv == 0) without going below 24.
    f_want = -(-_F_TARGET // subdiv) * subdiv

    rpb_opts   = [rpb_fixed] if rpb_fixed else [4, 8, 2, 16, 32, 64]
    speed_lo   = 2 if bends_present else 1
    speed_opts = [speed_fixed] if speed_fixed else list(range(1, 16))

    def taud_bpm(bpm, F):
        return round(bpm * F / 24.0)

    best = None       # (sort_key, rpb, speed)
    for rpb in rpb_opts:
        for speed in speed_opts:
            if speed < speed_lo:
                continue
            F = rpb * speed
            init_ok   = _TAUD_BPM_LO <= taud_bpm(bpm0, F) <= _TAUD_BPM_HI
            rhythm_ok = (F % subdiv == 0)
            clamped   = sum(1 for b in all_bpms
                            if not _TAUD_BPM_LO <= taud_bpm(b, F) <= _TAUD_BPM_HI)
            key = (0 if init_ok else 1,        # initial tempo must fit the register
                   clamped,                    # fewest tempo changes forced to clamp
                   [4, 8, 2, 16, 32, 64].index(rpb),   # prefer the conventional rpb=4 (rows
                                               #   = beats×rpb, so this caps pattern
                                               #   count and keeps the highlight grid)
                   abs(F - f_want),            # spend speed to reach the subdiv grid
                   0 if rhythm_ok else 1,      # ... exactly, if a tie remains
                   abs(speed - 6))              # tie-break: near the proven speed 6
            if best is None or key < best[0]:
                best = (key, rpb, speed)

    _, rpb, speed = best

    # ── RPB bump for bend/polyphony-heavy songs (both axes auto only) ──
    # Double rpb / halve speed (F, hence tempo, unchanged) until rpb reaches the
    # target, while speed stays an integer >= the portamento floor and the bumped
    # grid is estimated to fit the cue / pattern budget (so a long dense song does
    # not flip a working conversion into a hard error — pin --rpb 4 to opt out).
    bend_heavy = (bend_events >= _BUMP_BEND_MIN_EVENTS and
                  bend_events >= _BUMP_BEND_MIN_DENSITY * max(1, len(onsets)))
    many_poly  = peak_poly >= _BUMP_POLY_PEAK
    bumped = False
    if rpb_fixed is None and speed_fixed is None and rpb < _BUMP_TARGET_RPB \
            and (bend_heavy or many_poly):
        total_quarters = max(0, last_tick - first_onset) / tpq
        nvoices_est = min(max_voices, peak_poly + 1)

        def fits(rpb_try):
            est_rows = math.ceil(total_quarters * rpb_try) + rpb_try
            est_cues = math.ceil(est_rows / 56) + 4   # /56 (not 64) + margin: odd meters
            return est_cues <= NUM_CUES and est_cues * nvoices_est <= NUM_PATTERNS_MAX

        while (rpb < _BUMP_TARGET_RPB and speed % 2 == 0
               and speed // 2 >= speed_lo and rpb * 2 <= 16 and fits(rpb * 2)):
            rpb *= 2; speed //= 2; bumped = True

    info = (f"bpm0 {bpm0:.1f}, finest 1/{subdiv}-quarter subdivision, "
            f"{'bends present, ' if bends_present else ''}"
            f"F={rpb * speed} fts/beat (want {f_want}) → Taud BPM "
            f"{taud_bpm(bpm0, rpb * speed)}")
    if bumped:
        why = " + ".join(w for w, on in
                         (("dense bends", bend_heavy), ("high polyphony", many_poly)) if on)
        info += (f"; RPB bumped to {rpb} / speed {speed} to spread events "
                 f"({why}; peak poly {peak_poly})")
    return rpb, speed, info


# ── SF2 parser ────────────────────────────────────────────────────────────────

GEN_START_OFF        = 0
GEN_END_OFF          = 1
GEN_STARTLOOP_OFF    = 2
GEN_ENDLOOP_OFF      = 3
GEN_START_COARSE     = 4
GEN_MODENV2PITCH     = 7      # modEnvToPitch (signed cents at full mod-env)
GEN_FILTERFC         = 8      # initialFilterFc (absolute cents; default 13500 = open)
GEN_FILTERQ          = 9      # initialFilterQ (cB of resonance; default 0)
GEN_MODENV2FILT      = 11     # modEnvToFilterFc (signed cents at full mod-env)
GEN_END_COARSE       = 12
GEN_EXCLUSIVECLASS   = 57     # drum mutual-exclusion group (instrument-level; 0 = none)
GEN_PAN              = 17
GEN_DELAY_MODENV     = 25
GEN_ATTACK_MODENV    = 26
GEN_HOLD_MODENV      = 27
GEN_DECAY_MODENV     = 28
GEN_SUSTAIN_MODENV   = 29     # 0.1% units of full-scale DECREASE (0..1000)
GEN_RELEASE_MODENV   = 30
GEN_DELAY_VOLENV     = 33
GEN_ATTACK_VOLENV    = 34
GEN_HOLD_VOLENV      = 35
GEN_DECAY_VOLENV     = 36
GEN_SUSTAIN_VOLENV   = 37     # centibels of attenuation, 0..1440
GEN_RELEASE_VOLENV   = 38
GEN_INSTRUMENT       = 41
GEN_KEYRANGE         = 43
GEN_VELRANGE         = 44
GEN_STARTLOOP_COARSE = 45
GEN_INITATTEN        = 48     # initialAttenuation (cB; per-zone static gain)
# EMU8k/10k hardware (and therefore FluidSynth) scales the initialAttenuation GENERATOR
# value set at preset and instrument level by 0.4 before using it — fluid_defsfont.c
# EMU_ATTENUATION_FACTOR / case GEN_ATTENUATION. Applying the full SF2 cB makes every
# attenuated instrument ~2.5× too quiet in cB vs FluidSynth (e.g. a 200 cB zone is
# −8 dB in FluidSynth but −20 dB raw), so instrument-to-instrument balance is wrong.
EMU_ATTENUATION_FACTOR = 0.4
GEN_ENDLOOP_COARSE   = 50
GEN_COARSETUNE       = 51
GEN_FINETUNE         = 52
GEN_SAMPLEID         = 53
GEN_SAMPLEMODES      = 54
GEN_SCALETUNING      = 56
GEN_ROOTKEY          = 58

_SIGNED_GENS = frozenset({GEN_START_OFF, GEN_END_OFF, GEN_STARTLOOP_OFF,
                          GEN_ENDLOOP_OFF, GEN_START_COARSE, GEN_END_COARSE,
                          GEN_STARTLOOP_COARSE, GEN_ENDLOOP_COARSE,
                          GEN_PAN, GEN_COARSETUNE, GEN_FINETUNE,
                          GEN_DELAY_VOLENV, GEN_ATTACK_VOLENV, GEN_HOLD_VOLENV,
                          GEN_DECAY_VOLENV, GEN_RELEASE_VOLENV,
                          GEN_MODENV2PITCH, GEN_MODENV2FILT,
                          GEN_DELAY_MODENV, GEN_ATTACK_MODENV, GEN_HOLD_MODENV,
                          GEN_DECAY_MODENV, GEN_RELEASE_MODENV,
                          # cB/cents value-generators that are ADDITIVE (and so may be
                          # NEGATIVE) at the preset level. Their instrument-level absolutes
                          # all sit well under 0x8000 (atten≤1440, filterFc≤13500, Q≤960,
                          # sustain≤1440/1000), so reading them signed is lossless there and
                          # correct for relative preset deltas. Without this a preset zone
                          # carrying e.g. initialAttenuation 0xFFFE (a −2 cB boost) was read
                          # as 65534 cB → ~−6575 dB → the whole instrument went silent
                          # (SGM 'Synth Strings 1' vol-env nodes stuck at 0).
                          GEN_INITATTEN, GEN_FILTERFC, GEN_FILTERQ,
                          GEN_SUSTAIN_VOLENV, GEN_SUSTAIN_MODENV})


def _timecents_to_sec(tc: int) -> float:
    """SF2 timecents → seconds (2^(tc/1200)); default -12000 ≈ 1 ms."""
    return 2.0 ** (max(-12000, min(8000, tc)) / 1200.0)


class SFSampleHdr:
    __slots__ = ('name', 'start', 'end', 'loopstart', 'loopend', 'rate',
                 'origkey', 'correction', 'link', 'stype')


class SFZone:
    """One effective preset×instrument zone (post combination)."""
    __slots__ = ('keylo', 'keyhi', 'vello', 'velhi', 'sample', 'rootkey',
                 'tune_cents', 'modes', 'pan', 'scale', 'a_start', 'a_end',
                 'loop_abs_start', 'loop_abs_end', 'pair', 'stereo', 'rate', 'name',
                 'env_delay', 'env_attack', 'env_hold', 'env_decay',
                 'env_sustain_cb', 'env_release',
                 # initialAttenuation (cB static per-zone gain) + static filter.
                 'atten_cb', 'filter_fc', 'filter_q',
                 # modulation envelope (drives pitch and/or filter) + its targets.
                 'm_delay', 'm_attack', 'm_hold', 'm_decay', 'm_sustain_pc',
                 'm_release', 'me2pitch', 'me2filt',
                 # exclusiveClass (gen 57): drum mutual-exclusion group (0 = none).
                 'excl_class',
                 # SF2 velocity→filter modulators (fc_mods, me2_mods); see
                 # _zone_velocity_filter_mods / _split_velocity_filter.
                 'vel_filter_mods')


class SF2:
    __slots__ = ('presets', 'shdrs', 'file', 'smpl_off', 'smpl_size')

    def read_frames(self, start_frame: int, n_frames: int) -> array.array:
        """Read n_frames of 16-bit PCM starting at absolute frame index."""
        n_avail = max(0, min(n_frames, self.smpl_size // 2 - start_frame))
        a = array.array('h')
        if n_avail <= 0:
            return a
        self.file.seek(self.smpl_off + start_frame * 2)
        a.frombytes(self.file.read(n_avail * 2))
        if sys.byteorder == 'big':
            a.byteswap()
        return a


def _gen_amount(oper: int, raw: int) -> int:
    if oper in _SIGNED_GENS:
        return raw - 0x10000 if raw >= 0x8000 else raw
    return raw


def _parse_bags(bag_data, gen_data, mod_data, start_bag, end_bag, terminal_gen):
    """Resolve bags [start_bag, end_bag) into (global_gens, global_mods,
    [(zone_gens, zone_mods)...]). Each zone_gens is {oper: amount}; each
    zone_mods is a list of (src, dest, amount, amtsrc, trans) modulator tuples
    (the 10-byte SFModList record). Zones lacking the terminal generator other
    than a leading global zone are discarded per the SF2 spec; a leading bag with
    no terminal gen is the global zone (its gens AND mods apply to every zone)."""
    glob_g, glob_m = {}, []
    zones = []
    n_bags = len(bag_data) // 4
    n_gen  = len(gen_data) // 4
    n_mod  = len(mod_data) // 10
    for bi in range(start_bag, end_bag):
        g0 = struct.unpack_from('<H', bag_data, bi*4)[0]
        m0 = struct.unpack_from('<H', bag_data, bi*4 + 2)[0]
        g1 = (struct.unpack_from('<H', bag_data, (bi+1)*4)[0]
              if bi + 1 < n_bags else n_gen)
        m1 = (struct.unpack_from('<H', bag_data, (bi+1)*4 + 2)[0]
              if bi + 1 < n_bags else n_mod)
        gens = {}
        for gi in range(g0, min(g1, n_gen)):
            oper, raw = struct.unpack_from('<HH', gen_data, gi*4)
            gens[oper] = _gen_amount(oper, raw)
        mods = []
        for mi in range(m0, min(m1, n_mod)):
            mods.append(struct.unpack_from('<HHhHH', mod_data, mi*10))
        if terminal_gen in gens:
            zones.append((gens, mods))
        elif bi == start_bag and not zones:
            glob_g, glob_m = gens, mods
    return glob_g, glob_m, zones


# ── SF2 modulators (velocity → filter) ────────────────────────────────────────
# Only the filter-cutoff destinations are modelled: GEN_FILTERFC (8) and
# GEN_MODENV2FILT (11). Other modulator destinations are either bare-generator
# defaults the converter already folds (attenuation, pan), or inaudible for the
# spectral problem these solve. Sources other than note-on velocity (key tracking,
# CC) are skipped — they would need a per-note / per-controller patch axis.

# FluidSynth's default vel→filterFc modulator is hard-disabled (fluid_mod.c:471 "S.
# Christian Collins' mod … return 0"); any soundfont modulator IDENTICAL to it must
# therefore contribute nothing. Identity = (src1, amtsrc, dest, trans).
_DEFAULT_VEL2FILTER_ID = (0x0102, 0x0C02, 8, 0)


def _fluid_convex(x: float) -> float:
    """FluidSynth fluid_convex over a 0..128 index (gentables/fluid_convex.cpp):
    convex(i) = 1 + (400/960)·log10(i/127), clamped to [0, 1]."""
    if x <= 0.0:
        return 0.0
    if x >= 127.0:
        return 1.0
    return 1.0 + (400.0 / 960.0) * math.log10(x / 127.0)


def _fluid_concave(x: float) -> float:
    """FluidSynth fluid_concave: the convex mirror, concave(i) = −(400/960)·log10((127−i)/127)."""
    if x <= 0.0:
        return 0.0
    if x >= 127.0:
        return 1.0
    return -(400.0 / 960.0) * math.log10((127.0 - x) / 127.0)


def _mod_src_transform(oper: int, vel: int) -> float:
    """Map a velocity-source modulator operator to its normalised value at MIDI
    note-on velocity `vel`, matching fluid_mod_transform_source_value (range 128,
    val_norm = vel/128, inv_norm = (127−vel)/128). Only velocity sources reach
    here. A NONE source (oper 0) returns 1.0 (the amount-source identity)."""
    if oper == 0:
        return 1.0
    direction = (oper >> 8) & 1          # D: 0 = positive, 1 = negative
    polarity  = (oper >> 9) & 1          # P: 0 = unipolar, 1 = bipolar
    typ       = (oper >> 10) & 0x3F      # 0 linear, 1 concave, 2 convex, 3 switch
    rng = 128.0
    val_norm = vel / rng
    inv_norm = 1.0 - 1.0 / rng - val_norm
    base = inv_norm if direction else val_norm
    if polarity == 0:                    # unipolar
        if typ == 3:                     # switch
            return 1.0 if base >= 0.5 else 0.0
        if typ == 1:
            return min(_fluid_concave(rng * base), (rng - 1) / rng)
        if typ == 2:
            return min(_fluid_convex(rng * base), (rng - 1) / rng)
        return base                      # linear
    # bipolar
    b = base if base == (rng - 1) / rng else -1.0 + 2.0 * base
    if typ == 3:
        return 1.0 if b >= 0.0 else -1.0
    if typ == 1:
        return min(_fluid_concave(rng * b), (rng - 1) / rng) if b >= 0 else -_fluid_concave(-rng * b)
    if typ == 2:
        return min(_fluid_convex(rng * b), (rng - 1) / rng) if b >= 0 else -_fluid_convex(-rng * b)
    return b


def _combine_mods(inst_glob, inst_local, pre_glob, pre_local):
    """Combine modulator lists into the effective per-voice set, following
    FluidSynth's load order (fluid_voice add-mod modes): instrument global then
    local OVERWRITE identical modulators (replace the amount); preset global then
    local ADD (sum the amount for identical, else append). Identity is
    (src1, dest, amtsrc, trans) — every field except the amount."""
    order = []
    final = {}
    def ident(m):  # m = (src, dest, amt, amtsrc, trans)
        return (m[0], m[1], m[3], m[4])
    def overwrite(m):
        k = ident(m)
        if k in final:
            final[k] = (m[0], m[1], m[2], m[3], m[4])
        else:
            final[k] = m; order.append(k)
    def add(m):
        k = ident(m)
        if k in final:
            p = final[k]
            final[k] = (p[0], p[1], p[2] + m[2], p[3], p[4])
        else:
            final[k] = m; order.append(k)
    for m in inst_glob:  overwrite(m)
    for m in inst_local: overwrite(m)
    for m in pre_glob:   add(m)
    for m in pre_local:  add(m)
    return [final[k] for k in order]


def _zone_velocity_filter_mods(inst_glob, inst_local, pre_glob, pre_local):
    """Resolve a zone's velocity→filter modulators into (fc_mods, me2_mods),
    each a list of (amount, src1, amtsrc) evaluated later per velocity. Keeps only
    note-on-velocity-sourced modulators targeting initialFilterFc (8) and
    modEnvToFilterFc (11), drops zero-amount and default-vel2filter-identity ones."""
    fc_mods, me2_mods = [], []
    for (src, dest, amt, amtsrc, trans) in _combine_mods(inst_glob, inst_local,
                                                         pre_glob, pre_local):
        if dest not in (8, 11) or amt == 0:
            continue
        if (src, amtsrc, dest, trans) == _DEFAULT_VEL2FILTER_ID:
            continue                      # FluidSynth disables this identity
        if (src & 0x80) or (src & 0x7F) != 2:
            continue                      # only note-on velocity (GC index 2)
        # amount source must be NONE or velocity to evaluate statically; skip CC/other.
        if amtsrc != 0 and ((amtsrc & 0x80) or (amtsrc & 0x7F) != 2):
            continue
        (fc_mods if dest == 8 else me2_mods).append((amt, src, amtsrc))
    return (fc_mods, me2_mods)


def _eval_zone_filter_at(z: 'SFZone', vel: int):
    """(filter_fc, me2filt) for zone `z` at MIDI velocity `vel`, with its
    velocity→filter modulators folded onto the base generators."""
    fc_mods, me2_mods = z.vel_filter_mods
    fc  = z.filter_fc + sum(amt * _mod_src_transform(src, vel)
                            * _mod_src_transform(asrc, vel) for amt, src, asrc in fc_mods)
    me2 = z.me2filt   + sum(amt * _mod_src_transform(src, vel)
                            * _mod_src_transform(asrc, vel) for amt, src, asrc in me2_mods)
    return fc, me2


def parse_sf2(path: str) -> SF2:
    f = open(path, 'rb')
    hdr = f.read(12)
    if hdr[:4] != b'RIFF' or hdr[8:12] != b'sfbk':
        sys.exit("error: not an SF2 file (bad RIFF/sfbk magic)")
    riff_end = 8 + struct.unpack_from('<I', hdr, 4)[0]

    pdta = {}
    smpl_off = smpl_size = 0
    pos = 12
    while pos + 8 <= riff_end:
        f.seek(pos)
        chdr = f.read(8)
        if len(chdr) < 8:
            break
        cid = chdr[:4]
        sz  = struct.unpack_from('<I', chdr, 4)[0]
        if cid == b'LIST':
            ltype = f.read(4)
            inner = pos + 12
            inner_end = pos + 8 + sz
            while inner + 8 <= inner_end:
                f.seek(inner)
                shdr_ = f.read(8)
                scid = shdr_[:4]
                ssz  = struct.unpack_from('<I', shdr_, 4)[0]
                if ltype == b'pdta':
                    pdta[scid.decode('latin-1')] = f.read(ssz)
                elif ltype == b'sdta' and scid == b'smpl':
                    smpl_off, smpl_size = inner + 8, ssz
                inner += 8 + ssz + (ssz & 1)
        pos += 8 + sz + (sz & 1)

    for need in ('phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'):
        if need not in pdta:
            sys.exit(f"error: SF2 missing required pdta sub-chunk '{need}'")
    if not smpl_size:
        sys.exit("error: SF2 has no smpl chunk (sample data)")

    sf = SF2()
    sf.file = f
    sf.smpl_off, sf.smpl_size = smpl_off, smpl_size

    shdr_data = pdta['shdr']
    sf.shdrs = []
    for i in range(len(shdr_data) // 46 - 1):    # last record is EOS sentinel
        s = SFSampleHdr()
        off = i * 46
        s.name = shdr_data[off:off+20].split(b'\x00')[0].decode('latin-1',
                                                                errors='replace')
        (s.start, s.end, s.loopstart, s.loopend, s.rate) = \
            struct.unpack_from('<IIIII', shdr_data, off+20)
        s.origkey    = shdr_data[off+40]
        s.correction = struct.unpack_from('b', shdr_data, off+41)[0]
        s.link, s.stype = struct.unpack_from('<HH', shdr_data, off+42)
        if s.rate == 0:
            s.rate = 8363
        sf.shdrs.append(s)

    # Modulators (imod/pmod) are optional per chunk presence; default to empty so
    # banks without them parse unchanged. Used for SF2 velocity→filter modulators
    # (see _zone_velocity_filter_mods) that FluidSynth applies but bare generators miss.
    imod = pdta.get('imod', b'')
    pmod = pdta.get('pmod', b'')

    # Instruments: index → (global_gens, global_mods, [(zone_gens, zone_mods)])
    inst_data, ibag, igen = pdta['inst'], pdta['ibag'], pdta['igen']
    n_inst = len(inst_data) // 22 - 1
    inst_zones = []
    for i in range(n_inst):
        b0 = struct.unpack_from('<H', inst_data, i*22 + 20)[0]
        b1 = struct.unpack_from('<H', inst_data, (i+1)*22 + 20)[0]
        inst_zones.append(_parse_bags(ibag, igen, imod, b0, b1, GEN_SAMPLEID))

    # Presets
    phdr, pbag, pgen = pdta['phdr'], pdta['pbag'], pdta['pgen']
    n_pre = len(phdr) // 38 - 1
    sf.presets = {}
    scale_warned = False
    for i in range(n_pre):
        off = i * 38
        pname = phdr[off:off+20].split(b'\x00')[0].decode('latin-1',
                                                          errors='replace')
        preset, bank, bag0 = struct.unpack_from('<HHH', phdr, off+20)
        bag1 = struct.unpack_from('<H', phdr, (i+1)*38 + 24)[0]
        pglob, pglob_m, pzones = _parse_bags(pbag, pgen, pmod, bag0, bag1, GEN_INSTRUMENT)

        zones = []
        for pz_raw, pz_mods in pzones:
            pz = dict(pglob); pz.update(pz_raw)
            ii = pz[GEN_INSTRUMENT]
            if not (0 <= ii < n_inst):
                continue
            iglob, iglob_m, izones = inst_zones[ii]
            pk = pz.get(GEN_KEYRANGE, 0x7F00)
            pv = pz.get(GEN_VELRANGE, 0x7F00)
            pklo, pkhi = pk & 0xFF, (pk >> 8) & 0xFF
            pvlo, pvhi = pv & 0xFF, (pv >> 8) & 0xFF
            for iz_raw, iz_mods in izones:
                iz = dict(iglob); iz.update(iz_raw)
                si = iz[GEN_SAMPLEID]
                if not (0 <= si < len(sf.shdrs)):
                    continue
                s = sf.shdrs[si]
                if s.stype & 0x8000:             # ROM sample
                    continue
                ik = iz.get(GEN_KEYRANGE, 0x7F00)
                iv = iz.get(GEN_VELRANGE, 0x7F00)
                klo = max(ik & 0xFF, pklo); khi = min((ik >> 8) & 0xFF, pkhi)
                vlo = max(iv & 0xFF, pvlo); vhi = min((iv >> 8) & 0xFF, pvhi)
                if klo > khi or vlo > vhi:
                    continue

                z = SFZone()
                z.keylo, z.keyhi = klo, khi
                z.vello, z.velhi = vlo, vhi
                z.sample = si
                rk = iz.get(GEN_ROOTKEY, -1)
                z.rootkey = rk if 0 <= rk <= 127 else \
                            (s.origkey if s.origkey <= 127 else 60)
                z.tune_cents = ((iz.get(GEN_COARSETUNE, 0)
                                 + pz.get(GEN_COARSETUNE, 0)) * 100
                                + iz.get(GEN_FINETUNE, 0)
                                + pz.get(GEN_FINETUNE, 0)
                                + s.correction)
                z.modes = iz.get(GEN_SAMPLEMODES, 0) & 3
                z.pan   = max(-500, min(500, iz.get(GEN_PAN, 0)
                                        + pz.get(GEN_PAN, 0)))
                z.scale = iz.get(GEN_SCALETUNING, 100)
                if z.scale != 100 and klo != khi and not scale_warned:
                    vprint("  warning: scaleTuning != 100 on a multi-key zone "
                           "— pitch is exact only at the zone's centre key")
                    scale_warned = True
                # Volume-envelope ADSR (timecents at inst level, preset adds).
                z.env_delay  = _timecents_to_sec(iz.get(GEN_DELAY_VOLENV,  -12000)
                                                 + pz.get(GEN_DELAY_VOLENV,  0))
                z.env_attack = _timecents_to_sec(iz.get(GEN_ATTACK_VOLENV, -12000)
                                                 + pz.get(GEN_ATTACK_VOLENV, 0))
                z.env_hold   = _timecents_to_sec(iz.get(GEN_HOLD_VOLENV,   -12000)
                                                 + pz.get(GEN_HOLD_VOLENV,   0))
                z.env_decay  = _timecents_to_sec(iz.get(GEN_DECAY_VOLENV,  -12000)
                                                 + pz.get(GEN_DECAY_VOLENV,  0))
                z.env_sustain_cb = max(0, min(1440, iz.get(GEN_SUSTAIN_VOLENV, 0)
                                              + pz.get(GEN_SUSTAIN_VOLENV, 0)))
                z.env_release = _timecents_to_sec(iz.get(GEN_RELEASE_VOLENV, -12000)
                                                  + pz.get(GEN_RELEASE_VOLENV, 0))
                # initialAttenuation: per-zone static gain in cB (preset adds to inst).
                # Clamped to the SF2 spec range [0, 1440] so any out-of-range value can
                # never collapse the folded vol-env to silence (see _SIGNED_GENS note).
                # FluidSynth scales the preset+instrument initialAttenuation by 0.4
                # (EMU_ATTENUATION_FACTOR) before clamping to the SF2 [0, 1440] cB range;
                # match it so instrument volumes line up with FluidSynth's rendering.
                z.atten_cb = max(0, min(1440, EMU_ATTENUATION_FACTOR
                                        * (iz.get(GEN_INITATTEN, 0)
                                           + pz.get(GEN_INITATTEN, 0))))
                # Static low-pass filter. initialFilterFc is absolute cents (default
                # 13500 ≈ open); initialFilterQ is cB of resonance (default 0).
                z.filter_fc = iz.get(GEN_FILTERFC, 13500) + pz.get(GEN_FILTERFC, 0)
                z.filter_q  = max(0, iz.get(GEN_FILTERQ, 0) + pz.get(GEN_FILTERQ, 0))
                # Modulation envelope (drives pitch via modEnvToPitch and/or filter via
                # modEnvToFilterFc). Times are timecents; sustain is 0.1%-of-full DECREASE.
                z.m_delay   = _timecents_to_sec(iz.get(GEN_DELAY_MODENV,  -12000)
                                                + pz.get(GEN_DELAY_MODENV,  0))
                z.m_attack  = _timecents_to_sec(iz.get(GEN_ATTACK_MODENV, -12000)
                                                + pz.get(GEN_ATTACK_MODENV, 0))
                z.m_hold    = _timecents_to_sec(iz.get(GEN_HOLD_MODENV,   -12000)
                                                + pz.get(GEN_HOLD_MODENV,   0))
                z.m_decay   = _timecents_to_sec(iz.get(GEN_DECAY_MODENV,  -12000)
                                                + pz.get(GEN_DECAY_MODENV,  0))
                z.m_sustain_pc = max(0, min(1000, iz.get(GEN_SUSTAIN_MODENV, 0)
                                            + pz.get(GEN_SUSTAIN_MODENV, 0)))
                z.m_release = _timecents_to_sec(iz.get(GEN_RELEASE_MODENV, -12000)
                                                + pz.get(GEN_RELEASE_MODENV, 0))
                z.me2pitch  = iz.get(GEN_MODENV2PITCH, 0) + pz.get(GEN_MODENV2PITCH, 0)
                z.me2filt   = iz.get(GEN_MODENV2FILT,  0) + pz.get(GEN_MODENV2FILT,  0)
                # SF2 velocity→filter modulators (FluidSynth applies them; bare generators
                # do not). Folded per-velocity in _split_velocity_filter so each velocity band
                # gets the cutoff / mod-env-to-filter FluidSynth would compute (the GeneralUser-GS
                # "muffled" fix). Combined inst(overwrite)+preset(add) per SF2.04 §9.5.
                z.vel_filter_mods = _zone_velocity_filter_mods(iglob_m, iz_mods,
                                                               pglob_m, pz_mods)
                # exclusiveClass is instrument-level and NON-additive (SF2.04 §8.1.2 #57):
                # a new note in class C kills sounding notes of the same class on the same
                # channel (FluidSynth fluid_synth_kill_by_exclusive_class). Drum kits use it
                # so a closed hi-hat (42) chokes a ringing open hi-hat (46).
                z.excl_class = iz.get(GEN_EXCLUSIVECLASS, 0)
                z.a_start = (s.start + iz.get(GEN_START_OFF, 0)
                             + 32768 * iz.get(GEN_START_COARSE, 0))
                z.a_end   = (s.end + iz.get(GEN_END_OFF, 0)
                             + 32768 * iz.get(GEN_END_COARSE, 0))
                z.a_start = max(0, z.a_start)
                z.a_end   = max(z.a_start, min(z.a_end, sf.smpl_size // 2))
                z.loop_abs_start = (s.loopstart + iz.get(GEN_STARTLOOP_OFF, 0)
                                    + 32768 * iz.get(GEN_STARTLOOP_COARSE, 0))
                z.loop_abs_end   = (s.loopend + iz.get(GEN_ENDLOOP_OFF, 0)
                                    + 32768 * iz.get(GEN_ENDLOOP_COARSE, 0))
                z.pair = None
                z.stereo = False
                z.rate = s.rate
                z.name = s.name
                zones.append(z)
        if zones:
            sf.presets[(bank, preset)] = (pname, zones)
    return sf


# ── Preset resolution / Taud instrument building ──────────────────────────────

def resolve_preset(sf: SF2, inst_key, perc_force):
    """inst_key: ('m', bank, prog) or ('d', prog). Returns (name, zones) or None."""
    if inst_key[0] == 'd':
        prog = inst_key[1]
        cands = []
        if perc_force is not None:
            cands.append(tuple(perc_force))
        cands += [(128, prog), (128, 0)]
    else:
        _, bank, prog = inst_key
        cands = [(bank, prog), (0, prog)]
    for c in cands:
        if c in sf.presets:
            return sf.presets[c]
    # Last resort: same program number in any bank, then nothing.
    prog = inst_key[1] if inst_key[0] == 'd' else inst_key[2]
    for (b, p) in sorted(sf.presets):
        if p == prog:
            return sf.presets[(b, p)]
    return None


def merge_stereo_zones(zones: list, shdrs: list, keep_stereo: bool = False) -> list:
    """Collapse L/R zone pairs into single zones. Two flavours are merged:
      (1) LINKED stereo — samples are each other's sampleLink with L/R types;
      (2) PAN stereo — two MONO-typed zones with the same key/vel rect and
          opposite hard pan (±500). SGM/Timbres store most "stereo" samples this
          way (e.g. 'VA LGFF C3-L' / '…-R'), NOT as linked L/R.
    The merged zone mixes both channels to mono and drops the pan override —
    unless `keep_stereo` (item 90), where the pair is kept as a genuine stereo
    sample: two pool spans joined by an Ixmp 's' patch. Either way the pan
    override goes, because the pair itself carries the image.
    Merging is essential: an unmerged R zone fully overlaps its L zone, so the
    disjointify spills it into a SECOND layer that then plays CENTRED alongside
    the L zone — a spurious +6 dB doubling. Lone L/R zones keep their channel."""
    out = []
    used = set()
    for i, z in enumerate(zones):
        if i in used:
            continue
        s = shdrs[z.sample]
        partner = None
        if s.stype in (2, 4) and 0 <= s.link < len(shdrs):
            for j in range(i + 1, len(zones)):
                if j in used:
                    continue
                z2 = zones[j]
                if (z2.sample == s.link
                        and (z2.keylo, z2.keyhi, z2.vello, z2.velhi)
                            == (z.keylo, z.keyhi, z.vello, z.velhi)
                        and z2.modes == z.modes
                        and z2.rootkey == z.rootkey):
                    partner = j
                    break
        if partner is None and z.pan is not None and abs(z.pan) >= 400:
            for j in range(i + 1, len(zones)):
                if j in used:
                    continue
                z2 = zones[j]
                if (z2.sample != z.sample
                        and z2.pan is not None and abs(z2.pan) >= 400
                        and (z.pan < 0) != (z2.pan < 0)        # opposite sides
                        and (z2.keylo, z2.keyhi, z2.vello, z2.velhi)
                            == (z.keylo, z.keyhi, z.vello, z.velhi)
                        and z2.modes == z.modes
                        and z2.rootkey == z.rootkey):
                    partner = j
                    break
        if partner is not None:
            used.add(partner)
            z2 = zones[partner]
            z.pair = (z.sample, z2.sample, z2.a_start)
            z.stereo = keep_stereo
            z.pan = None                          # mixed to mono → centred
            z.a_end = z.a_start + min(z.a_end - z.a_start,
                                      z2.a_end - z2.a_start)
        out.append(z)
    return out


def apply_exclusive_class(song, sf, perc_force):
    """SF2 exclusiveClass (gen 57): starting a note in class C kills any ringing note
    of the same class on the same channel — FluidSynth's
    fluid_synth_kill_by_exclusive_class (fluid_synth.c:5453). GM drum kits use it so a
    closed hi-hat (key 42) chokes a ringing open hi-hat (key 46); without it the open
    hi-hat's multi-second tail washes over the whole beat and buries the other hits.

    Resolve each percussion note's exclusiveClass from the SF2 zone it plays, then within
    each (channel, class) serialise the chokes: every note is cut at the next note of the
    same class that starts strictly later. `emit_cells` emits a fast note-fade
    (NOTE_FASTFADE) at that point and `allocate_voices` keeps the choked voice foreground
    until then. Drum channel only — GM melodic presets do not set gen 57, and a hard choke
    would fight the melodic key-off/release machinery."""
    zone_cache = {}
    def excl_of(n):
        if not n.drum:
            return 0
        zones = zone_cache.get(n.inst_key)
        if zones is None:
            res = resolve_preset(sf, n.inst_key, perc_force)
            zones = merge_stereo_zones(res[1], sf.shdrs) if res else []  # mono view: only rects/classes are read here
            zone_cache[n.inst_key] = zones
        # SF2 zone selection: first zone whose key/velocity rect contains the note.
        for z in zones:
            if z.keylo <= n.key <= z.keyhi and z.vello <= n.vel <= z.velhi:
                return z.excl_class
        return 0

    groups = {}
    for n in song.notes:
        c = excl_of(n)
        if c:
            groups.setdefault((n.ch, c), []).append(n)

    n_cut = 0
    for notes in groups.values():
        notes.sort(key=lambda n: n.start_ft)
        for i, n in enumerate(notes):
            for j in range(i + 1, len(notes)):
                if notes[j].start_ft > n.start_ft:    # next strictly-later onset chokes n
                    n.excl_cut_ft = notes[j].start_ft
                    n_cut += 1
                    break
    if n_cut:
        vprint(f"  exclusiveClass: {n_cut} percussion choke(s) across "
               f"{len(groups)} group(s)")


def _rect_of_zone(z: SFZone):
    """Zone key/vel ranges → Taud (pitch_lo, pitch_hi, vol_lo, vol_hi).
    Pitch bounds sit on half-semitone boundaries so triggers carrying an
    initial pitch bend (< 50 cents) still land inside the right rectangle;
    adjacent zones stay disjoint. Velocity per Ixmp note 5: round(v·63/127)."""
    if z.keylo <= 0:
        plo = 0x0000
    else:
        plo = max(0, min(0xFFFF, round(TAUD_C4 + (z.keylo - 0.5 - 60) * UNITS_PER_SEMI)))
    if z.keyhi >= 127:
        phi = 0xFFFF
    else:
        phi = max(0, min(0xFFFF, round(TAUD_C4 + (z.keyhi + 0.5 - 60) * UNITS_PER_SEMI) - 1))
    vlo = round(z.vello * 63 / 127)
    vhi = round(z.velhi * 63 / 127)
    return (plo, phi, vlo, vhi)


def _rect_subtract(r, k):
    """Pieces of rectangle r not covered by rectangle k (≤ 4 pieces)."""
    p0, p1, v0, v1 = r
    q0, q1, w0, w1 = k
    if p1 < q0 or p0 > q1 or v1 < w0 or v0 > w1:
        return [r]
    pieces = []
    if p0 < q0: pieces.append((p0, q0 - 1, v0, v1))
    if p1 > q1: pieces.append((q1 + 1, p1, v0, v1))
    m0, m1 = max(p0, q0), min(p1, q1)
    if v0 < w0: pieces.append((m0, m1, v0, w0 - 1))
    if v1 > w1: pieces.append((m0, m1, w1 + 1, v1))
    return pieces


class MonoSample:
    """One pooled (deduplicated) u8 sample slice — mono, or (item 90) a STEREO
    pair, where `data_r` holds the right channel: a second pool span of the same
    length that every resample/cap/truncate step below keeps frame-aligned with
    `data`, and that the Ixmp patch names through its 's' block."""
    __slots__ = ('pair', 'stereo', 'a_start', 'frames', 'rate', 'name',
                 'data', 'data_r', 'offset', 'offset_r',
                 'ratio', 'loop_native', 'synth_loop', 'synth_decay')
    def __init__(self, z: SFZone):
        self.pair    = z.pair                    # None or (idxL, idxR, b_start)
        self.stereo  = bool(getattr(z, 'stereo', False)) and z.pair is not None
        self.data_r  = None
        self.offset_r = 0
        self.a_start = z.a_start
        self.frames  = max(0, z.a_end - z.a_start)
        self.rate    = z.rate
        self.name    = z.name
        self.data    = None
        self.ratio   = 1.0
        self.offset  = 0
        # SF2 loop in NATIVE frames (mirrors the Patch loop test), or None when this
        # slice has no loop. Used by build_sample_inst_bin to decide how to fit an
        # over-length sample: a no-loop sample gets a synthesized loop, a looped one
        # is preserved (kept at 32 kHz when its loop fits, else fit-to-cap). Dedup
        # keeps the first zone's loop (same slice ⇒ same loop in practice).
        ls_n = max(0, min(z.loop_abs_start - z.a_start, self.frames))
        le_n = max(0, min(z.loop_abs_end   - z.a_start, self.frames))
        self.loop_native = (ls_n, le_n) if (z.modes in (1, 3) and le_n - ls_n >= 2) else None
        # Set when a too-long, originally UN-looped sample is resampled to the 32 kHz
        # floor and given a synthesized sustain loop (see _synth_sustain_loop): a
        # (loop_start, loop_end) pair in the FINAL output-frame domain (already scaled
        # by every resample) and the seconds over which a peak->0 vol-envelope fades
        # the looped note to silence (_synth_decay_vol_env). When set, the loop points
        # and vol-envelope of EVERY record/patch using this sample are overridden.
        self.synth_loop  = None
        self.synth_decay = None

    def key(self):
        # The stereo flag is part of the identity: the same pair rendered as one
        # mono mix and as two channels are different pool contents.
        return (self.pair[0], self.pair[1], self.a_start, self.frames, self.stereo) \
            if self.pair else (-1, -1, self.a_start, self.frames, False)

    def render(self, sf: SF2):
        if self.data is not None:
            return
        n = min(self.frames, 1 << 24)            # hard sanity cap (16M frames)
        if self.pair:
            la = sf.read_frames(self.a_start, n)
            ra = sf.read_frames(self.pair[2], n)
            m  = min(len(la), len(ra))
            if self.stereo:
                self.data   = bytes(((la[i] >> 8) + 128) & 0xFF for i in range(m))
                self.data_r = bytes(((ra[i] >> 8) + 128) & 0xFF for i in range(m))
            else:
                self.data = bytes((((la[i] + ra[i]) >> 1) >> 8) + 128 & 0xFF
                                  for i in range(m))
        else:
            la = sf.read_frames(self.a_start, n)
            self.data = bytes(((s >> 8) + 128) & 0xFF for s in la)
        self.frames = len(self.data)


class Patch:
    """One Ixmp-patch-to-be: a disjoint rect plus the zone's sample fields."""
    __slots__ = ('rect', 'zone', 'ms', 'loop_start', 'loop_end', 'loop_mode',
                 'detune', 'pan8', 'hits')
    def __init__(self, rect, z: SFZone, ms: MonoSample):
        self.rect = rect
        self.zone = z
        self.ms   = ms
        ls = z.loop_abs_start - z.a_start
        le = z.loop_abs_end   - z.a_start
        nf = max(0, z.a_end - z.a_start)
        ls = max(0, min(ls, nf)); le = max(0, min(le, nf))
        if z.modes in (1, 3) and le - ls >= 2:
            self.loop_mode  = 1 | (0x4 if z.modes == 3 else 0)
            self.loop_start = ls
            self.loop_end   = le
        else:
            self.loop_mode  = 0
            self.loop_start = 0
            self.loop_end   = 0
        # samplingRate = SF2 rate; the rootkey/tuning shift goes into the
        # signed 4096-TET detune so MIDI key 60 always means noteVal 0x5000.
        # scaleTuning (cents per key, 0 = fixed-pitch drums) is folded in
        # around the zone's centre key: exact for single-key zones, exact
        # everywhere when scale = 100.
        k_ref = (z.keylo + z.keyhi) / 2.0
        det = round(((k_ref - z.rootkey) * (z.scale / 100.0)
                     - (k_ref - 60.0)) * UNITS_PER_SEMI
                    + z.tune_cents * 4096.0 / 1200.0)
        self.detune = max(-0x8000, min(0x7FFF, det))
        if z.pan is None:
            self.pan8 = IXMP_PAN_NO_OVERRIDE
        else:
            self.pan8 = max(0, min(255, round(127.5 + z.pan * 255.0 / 1000.0)))
        self.hits = 0

    def to_ixmp_dict(self, canonical, bpm0, fadeout_override):
        r = self.ms.ratio
        # Synthesized-loop samples carry their loop in the final output-frame domain
        # (already resampled) and force a plain forward loop; otherwise the zone's SF2
        # loop scaled by this sample's resample ratio.
        if self.ms.synth_loop is not None:
            ls_w, le_w, lm_w = self.ms.synth_loop[0], self.ms.synth_loop[1], 1
        else:
            ls_w = round(self.loop_start * r)
            le_w = round(self.loop_end   * r)
            lm_w = self.loop_mode
        d = {
            'pitch_start':         self.rect[0],
            'pitch_end':           self.rect[1],
            'volume_start':        self.rect[2],
            'volume_end':          self.rect[3],
            'sample_ptr':          self.ms.offset,
            'sample_length':       min(len(self.ms.data), 0xFFFF),
            'play_start':          0,
            'loop_start':          min(0xFFFF, ls_w),
            'loop_end':            min(0xFFFF, le_w),
            'sampling_rate':       max(1, min(0xFFFF, round(self.ms.rate * r))),
            'sample_detune':       self.detune,
            'loop_mode':           lm_w,
            'default_pan':         self.pan8,
            'default_note_volume': 0,            # no override → base DNV
            'vibrato_speed':       0,
            'vibrato_sweep':       0,
            'vibrato_depth':       0,
            'vibrato_rate':        0,
            'vibrato_waveform':    0xFF,         # no override
        }
        # Stereo pair (item 90): channel 2 is its own pool span, same length and
        # geometry — only an Ixmp patch can say so, which is why a stereo
        # canonical is emitted as a patch too (see build_ixmp).
        if self.ms.stereo and self.ms.data_r:
            d['channels'] = {'mode': IXMP_CHAN_DISCRETE, 'flags': 0,
                             'ptrs': [self.ms.offset_r]}
        # Per-patch overrides — emitted ONLY when they differ from the canonical
        # zone (whose envelopes/filter live in the base instrument record, which the
        # patch falls through to when a block is absent). This is what gives SF2
        # velocity / key layers their own ADSR + filter while keeping patches lean.
        z, c = self.zone, canonical.zone
        # Effective vol-env: a synthesized-loop sample uses a peak->0 decay (no sustain),
        # else the zone's SF2 ADSR. Emitted only when it differs from the canonical's.
        vol_self  = _effective_vol_env(z, self.ms)
        vol_canon = _effective_vol_env(c, canonical.ms)
        if vol_self != vol_canon:
            d['vol_env'] = vol_self
        # SF-mode filter: mode flag + 16-bit cutoff cents / Q centibels + filter env.
        sf_s, cut_s, res_s, filt_s = _zone_filter_sf(z)
        sf_c, cut_c, res_c, filt_c = _zone_filter_sf(c)
        pit_s = _pitch_env_block(z) if z.me2pitch else None
        pit_c = _pitch_env_block(c) if c.me2pitch else None
        # Emit the 'x' block when filter (mode/cutoff/resonance/env) OR initialAttenuation
        # differs from the canonical (base) zone. initialAttenuation is a per-voice gain (NOT
        # folded into the env); when 'x' is present it carries this patch's atten, else the
        # voice inherits the base record's atten. A differing filter ENV must co-emit 'x'
        # because the env's node ratios scale the patch's OWN peak cutoff (the 'x' cutoff).
        att_s = atten_cb_to_octet(z.atten_cb)
        att_c = atten_cb_to_octet(c.atten_cb)
        # Volume Fadeout = this patch's own SF2 release segment; emit 'x' when it (or any
        # filter / atten field) differs from the canonical zone so the per-layer release
        # time is faithful (an absent 'x' falls through to the base record's fadeout). A
        # synthesized-loop sample keeps its key-off fadeout too: the peak->0 decay vol-env
        # (no sustain wrap) only fades the HELD note to silence ~SF2_SYNTH_DECAY_SEC after
        # note-on; on key-off the voice must still release over the SF2 release time as
        # FluidSynth does. Forcing 0 here left key-off inert, so released notes rang for the
        # whole 10 s decay (audible on piano/pizz/mallet patches in Musyng Kite & Timbres
        # of Heaven 4.00 whose long unlooped samples take the synth-loop path).
        fo_s = _zone_fadeout(z, bpm0, fadeout_override)
        fo_c = _zone_fadeout(c, bpm0, fadeout_override)
        filt_differs = (filt_s != filt_c)
        if (sf_s != sf_c or cut_s != cut_c or res_s != res_c or att_s != att_c
                or filt_differs or fo_s != fo_c):
            d['extra'] = {'fadeout':            fo_s,
                          'filter_sf_mode':     sf_s,
                          'default_cutoff':     cut_s,
                          'default_resonance':  res_s,
                          'initial_attenuation': att_s}
        if filt_differs:
            if filt_s is not None:
                d['filter_env'] = filt_s
            elif filt_c is not None:
                # This patch has NO filter env but the base/canonical zone DOES. Without an
                # explicit override the voice INHERITS the base record's filter env (the
                # engine's resolveActiveEnvelopes falls a patch through to the base pf-slots),
                # and since the canonical of a shared layer is the most-HIT drum (e.g. the
                # kick, ~6kHz me2filt sweep), an unfiltered patch like the open hi-hat gets
                # that sweep applied → "incredibly lowpassed". Emit an absent filter-env block
                # (PRESENT bit clear) so the engine sets hasFilterEnv=false and, with this
                # patch's 'x' cutoff already = off, bypasses the filter entirely.
                d['filter_env'] = {'loop': ENV_PF_FILTER, 'sustain': 0,
                                   'nodes': [(0, 0)] * 25}
        if pit_s != pit_c:
            if pit_s is not None:
                d['pitch_env'] = pit_s
            elif pit_c is not None:
                # Same inherited-env hazard as the filter leg above: a patch with no pitch
                # env must explicitly override the base's, or it inherits the canonical's
                # modEnvToPitch sweep (e.g. an 808 tom's pitch drop bleeding onto a co-layered
                # drum). Absent pitch-env block: m-bit clear (pitch role) + PRESENT bit clear.
                d['pitch_env'] = {'loop': 0, 'sustain': 0, 'nodes': [(0, 0)] * 25}
        return d


class TaudInstrument:
    __slots__ = ('slot', 'inst_key', 'name', 'patches', 'canonical', 'usable',
                 # True when this instrument is a LAYER of a multi-layer Metainstrument
                 # (set in allocate_slots). Meta layers emit the canonical INTO the Ixmp
                 # patch list too (build_ixmp) so the engine's resolvePatch covers the whole
                 # layer and a note in the layer's gating bbox but outside every patch
                 # resolves to null → the engine keeps the layer SILENT instead of sounding
                 # its base/canonical sample (the spurious meta-layer fallback). A standalone
                 # single-layer instrument keeps the canonical in its base record only.
                 'is_meta_layer')
    # patches: kept Patch list in zone order, canonical Patch INCLUDED
    # (the Ixmp emitter skips it unless is_meta_layer; the base record carries its fields).


def _rect_overlap(a, b) -> bool:
    """True when two (pitch_lo, pitch_hi, vol_lo, vol_hi) rectangles intersect."""
    p0, p1, v0, v1 = a
    q0, q1, w0, w1 = b
    return not (p1 < q0 or p0 > q1 or v1 < w0 or v0 > w1)


def _partition_layers(zones: list, registry: dict, max_layers: int):
    """Split zones into disjoint layers by ITERATED first-wins disjointify.

    Layer 0 is the classic disjointify result: each zone is rectangle-SUBTRACTED
    against the rects already placed in the layer, so its non-overlapping pieces
    tile in. This is essential — the velocity axis quantises 0..127 → 0..63, so
    adjacent SF2 velocity splits round to ranges that touch/overlap by ~1 unit;
    subtraction absorbs that boundary sliver into the first zone instead of
    spawning a spurious extra layer (which would DOUBLE the level at boundary
    velocities). Only a zone that is *fully* covered by the layer below — SF2's
    real simultaneous layering, detune-stacks, duplicate zones — spills down to
    the next layer, where the same disjointify runs over the spilled set. Returns
    ([ [(rect, zone, ms), …] per layer ], dropped_zone_count)."""
    remaining = []
    for z in zones:
        ms = MonoSample(z)
        if ms.frames < 2:
            continue
        ms = registry.setdefault(ms.key(), ms)
        remaining.append((z, ms))

    layers = []
    while remaining and len(layers) < max_layers:
        kept_rects = []
        layer = []
        spill = []
        for z, ms in remaining:
            pieces = [_rect_of_zone(z)]
            for k in kept_rects:
                pieces = [p2 for p in pieces for p2 in _rect_subtract(p, k)]
                if not pieces:
                    break
            pieces = [p for p in pieces if p[0] <= p[1] and p[2] <= p[3]]
            if not pieces:
                spill.append((z, ms))          # fully overlapped → next layer
                continue
            for p in pieces:
                kept_rects.append(p)
                layer.append((p, z, ms))
        if layer:
            layers.append(layer)
        remaining = spill
    return layers, len(remaining)


def _build_layer_instrument(name: str, items: list, trig: dict, trim: bool = False):
    """One normal TaudInstrument from a layer's disjoint (rect, zone, ms) items.

    Trigger hits are always counted — the most-hit patch becomes the canonical one
    (the base record's sample + ADSR). With `trim` (--trim-unused-patches) the
    patches this song never triggers are dropped, and a layer nothing hits returns
    None (silent for the whole song → dropped). Trimming is OFF by default: the
    bank then carries the preset's full zone map, and the editor's Housekeeping
    ("Cleanup instrument patches") removes what the user doesn't want."""
    all_patches = [Patch(r, z, ms) for (r, z, ms) in items]
    for (nv, v6), cnt in trig.items():
        for p in all_patches:
            r = p.rect
            if r[0] <= nv <= r[1] and r[2] <= v6 <= r[3]:
                p.hits += cnt
                break
    kept = [p for p in all_patches if p.hits > 0] if trim else all_patches
    if not kept:
        return None
    ti = TaudInstrument()
    ti.name = name
    ti.patches = kept
    ti.canonical = max(kept, key=lambda p: p.hits)
    ti.usable = True
    ti.slot = 0
    ti.inst_key = None
    ti.is_meta_layer = False        # set True in allocate_slots for multi-layer presets
    return ti


def _v6_to_midi_velocity(v6: int) -> int:
    """Representative MIDI note-on velocity (1..127) for a Taud volume level v6
    (0..63). Inverse of the converter's round(vel·63/127) trigger mapping."""
    return max(1, min(127, round(v6 * 127.0 / 63.0)))


# Cap on velocity bands a single filtered zone is split into. Bounds patch growth
# so a velocity-rich song cannot blow a sustained instrument past the engine's
# ~192-patch/instrument cap (which would silently drop bands → wrong-sample fallback,
# the same failure mode as the meta velocity-patch bug). 12 bands ≈ 5-v6 (~550-cent)
# brightness steps — finer than perceptible on a sustained note.
MAX_VEL_BANDS = 12


def _split_layer_velocity_filter(items: list, trig: dict) -> list:
    """Split each disjoint layer item ((pitch,vol)-rect, zone, ms) carrying velocity→
    filter modulators into per-velocity-band copies, each with the cutoff / mod-env-to-
    filter FluidSynth computes at that velocity.

    MUST run AFTER _partition_layers, not before. SF2 layering (e.g. the GeneralUser-GS
    closed hi-hat's bright 'Soft' sample over its filtered 'Hard' sample) is realised by
    the partition spilling a zone that is FULLY covered by a layer-mate into its own
    layer (so both sound). Fragmenting a zone into trigger-aligned filter bands BEFORE
    the partition makes a once-fully-covered mate only PARTIALLY covered, so disjointify
    subtracts (and loses) the overlap instead of spilling it — the bright 'Soft' layer
    vanished at the played velocities and the kit went muffled. Splitting per-layer here
    leaves the partition's coverage/spill decisions on whole zones intact.

    Bands TILE the item's OWN v6 rect (no gaps → no canonical fall-through), grouped at the
    distinct trigger v6 into at most [MAX_VEL_BANDS] contiguous buckets."""
    v6s = sorted({v6 for (_nv, v6) in trig})
    out = []
    for (rect, z, ms) in items:
        fc_mods, me2_mods = z.vel_filter_mods
        plo, phi, vlo, vhi = rect
        played = [v6 for v6 in v6s if vlo <= v6 <= vhi] if (fc_mods or me2_mods) else []
        if not played:
            out.append((rect, z, ms))
            continue
        gsize = max(1, (len(played) + MAX_VEL_BANDS - 1) // MAX_VEL_BANDS)
        groups = [played[i:i + gsize] for i in range(0, len(played), gsize)]
        for gi, grp in enumerate(groups):
            b_lo = vlo if gi == 0 else grp[0]
            b_hi = vhi if gi == len(groups) - 1 else groups[gi + 1][0] - 1
            if b_lo > b_hi:
                continue
            zc = copy.copy(z)                       # __slots__ shallow copy, band-local filter
            zc.filter_fc, zc.me2filt = _eval_zone_filter_at(
                z, _v6_to_midi_velocity((grp[0] + grp[-1]) // 2))
            out.append(((plo, phi, b_lo, b_hi), zc, ms))
    return out


def build_presets(sf: SF2, slot_keys: list, triggers: dict, perc_force,
                  registry: dict, max_layers: int, trim: bool = False,
                  keep_stereo: bool = False) -> dict:
    """For each preset (inst_key), partition its SF2 zones into disjoint layers
    and build one normal TaudInstrument per layer (`trim` keeps only the patches
    this song triggers — see _build_layer_instrument).
    Returns dict[inst_key → (name, [layer TaudInstrument])]. Downstream, a preset
    with >1 layer becomes a Metainstrument; a single-layer preset stays a plain
    instrument. `registry` dedupes MonoSamples across all presets/layers."""
    presets = {}
    for ik in slot_keys:
        res = resolve_preset(sf, ik, perc_force)
        if res is None:
            vprint(f"  warning: no SF2 preset for {ik!r} — its notes are dropped")
            presets[ik] = ('(missing preset)', [])
            continue
        name, zones = res
        zones = merge_stereo_zones(zones, sf.shdrs, keep_stereo)
        trig = triggers.get(ik, {})
        layer_items, dropped = _partition_layers(zones, registry, max_layers)
        if dropped:
            vprint(f"  warning: '{name}': {dropped} zone(s) exceed the "
                   f"{max_layers}-layer cap and were dropped (raise --max-layers)")
        # Per-velocity filter banding runs per-layer, AFTER the partition, so SF2 layering
        # (the spill of fully-covered layer-mates) is decided on whole zones — see
        # _split_layer_velocity_filter.
        layer_items = [_split_layer_velocity_filter(items, trig) for items in layer_items]
        layers = [ti for items in layer_items
                  if (ti := _build_layer_instrument(name, items, trig, trim)) is not None]
        if not layers and layer_items:
            # Nothing triggered (out-of-range): keep the single patch nearest the
            # mean trigger pitch so the preset still sounds (matches the old path).
            mean_nv = (sum(nv * c for (nv, _), c in trig.items())
                       / max(1, sum(trig.values()))) if trig else TAUD_C4
            flat = [Patch(r, z, ms) for items in layer_items for (r, z, ms) in items]
            best = min(flat, key=lambda p: abs((p.rect[0] + p.rect[1]) / 2 - mean_nv))
            ti = TaudInstrument()
            ti.name = name; ti.patches = [best]; ti.canonical = best
            ti.usable = True; ti.slot = 0; ti.inst_key = ik; ti.is_meta_layer = False
            layers = [ti]
        for ti in layers:
            ti.inst_key = ik
        presets[ik] = (name, layers)
        if layers:
            vprint(f"  preset '{name}': {len(zones)} zone(s) → {len(layers)} layer(s)"
                   + (" → Metainstrument" if len(layers) > 1 else ""))
        else:
            vprint(f"  warning: '{name}': no usable zones — notes dropped")
    return presets


# Metainstrument mix-volume octet for an unmixed layer (159 = 0 dB / unity); the
# converter folds per-zone level/tune into each layer instrument's patches, so the
# meta layers stay neutral. (terranmon.txt "Perceptually Significant Octet …".)
META_UNITY_OCTET = 159
# Metainstrument record byte-0 flag: STRICT layering (see build_sample_inst_bin). The
# layered-meta sentinel lives in bytes 2-3 (0xFFFF), so byte 0 is free for this flag.
META_STRICT_FLAG = 0x01
# Metainstrument record byte-0 bit 1 (P): percussion (terranmon.txt:2419-2428). A meta
# carries its own P bit because its byte 14 is layer-table data, not a sample-flags byte.
META_PERCUSSION_FLAG = 0x02

# Instrument/Sample Flags byte (record offset 14, terranmon.txt:2127-2132). Bit 4 (P)
# marks the instrument as percussion: a retuner/transposer MUST NOT touch its notes.
# OR'd into the loop-mode byte (bits 0-2) of every drum-kit instrument record.
PERCUSSION_FLAG = 0x10


def _layer_bbox(ti: 'TaudInstrument'):
    """Bounding (pitch_lo, pitch_hi, vol_lo, vol_hi) over a layer instrument's kept
    patch rects — the Metainstrument layer's gating rectangle."""
    rs = [p.rect for p in ti.patches]
    return (min(r[0] for r in rs), max(r[1] for r in rs),
            min(r[2] for r in rs), max(r[3] for r in rs))


# ── Sample pool + instrument bin ──────────────────────────────────────────────

def _env_seg_count(t_sec: float) -> int:
    """Number of linear segments to approximate an exponential (linear-dB) ramp of
    `t_sec` seconds. Short ramps keep the old 2-segment shape; long ramps (the 5–20 s
    SF2 decays/releases that a 2-point line collapses badly) get up to 8 segments so
    the curve stays smooth (issue 4)."""
    return max(3, min(8, 2 + round(t_sec / 2.0)))


def _adsr_to_env(z: SFZone):
    """SF2 volume-envelope ADSR → (env_points, sustain_idx, release_sec).

    env_points is up to 25 (value 0..63, minifloat_idx) pairs; each node's
    minifloat encodes the time to the NEXT node (engine interpolates values
    linearly across that span). The envelope carries the delay/attack/hold/decay
    legs and ENDS at the sustain node — there is NO release leg. The engine wraps
    on the sustain node while the key is held (SUSTAIN word); on key-off it holds
    at that terminal node and the Volume Fadeout (emitted with NNA Note Fade) is
    the SF2 *release segment* (see _zone_fadeout). SF2's decay is LINEAR in dB
    (exponential in amplitude); per the SF2 spec decayVolEnv is the full-100dB
    time, truncated by the sustain level. The decay leg is sampled at equal-time
    (= equal-dB) points and emitted as a piecewise-linear-amplitude approximation
    — segment count scales with its duration (issue 4) so multi-second decays
    don't collapse to a 2-point line. release_sec (= SF2 releaseVolEnv) is returned
    only to feed the fadeout calc.
    """
    EPS = 0.004                       # below the minifloat resolution (1/256 s)
    sus_cb = min(z.env_sustain_cb, 1000.0)     # clamp to 100 dB full-scale
    slevel = 10.0 ** (-z.env_sustain_cb / 200.0)
    s63 = max(0, min(63, round(63 * slevel)))
    pts = []                          # (value, delta_sec_to_next)
    if z.env_delay >= EPS:
        pts.append((0, z.env_delay))
    if z.env_attack >= EPS:
        pts.append((0, z.env_attack))
    hold = z.env_hold if z.env_hold >= EPS else 0.0
    # Decay leg: peak (63) → sustain (s63), exponential amplitude over `edec` seconds.
    # The peak node carries the hold time. The final decay node is the sustain node
    # (appended below), so the in-between nodes are f = 1/n .. (n-1)/n.
    if s63 < 63:
        edec = z.env_decay * sus_cb / 1000.0
        if edec >= EPS:
            n = _env_seg_count(edec)
            seg = edec / n
            pts.append((63, hold + seg))                       # peak, held then 1st seg
            for i in range(1, n):                              # f = 1/n .. (n-1)/n
                f = i / n
                v = round(63 * 10.0 ** (-(sus_cb * f) / 200.0))
                pts.append((max(s63, min(63, v)), seg))
        else:
            pts.append((63, hold))
    sustain_idx = len(pts)            # the node appended next is the sustain node
    rel = z.env_release
    # No release leg: the sustain node is the terminal node. While the key is held the
    # engine wraps on it (SUSTAIN word); after key-off it holds there and the Volume
    # Fadeout (NNA Note Fade) performs the SF2 release segment (see _zone_fadeout). A
    # zero sustain leaves a terminal 0 node, so the engine retires the voice naturally
    # at the end of decay.
    pts.append((s63, 0.0))            # sustain node = terminator
    env = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(env) < 25:
        env.append((env[-1][0], 0))
    return env, min(sustain_idx, 24), rel


# Envelope LOOP-word bits (terranmon.txt base byte 15/17/19).
ENV_PRESENT_BIT = 0x2000          # P — envelope present in source (LOOP-word bit 13)
ENV_SUS_ENABLE  = 0x0020          # b — enable the SUSTAIN wrap (SUSTAIN-word bit 5)
ENV_PF_FILTER   = 0x0080          # m — pitch/filter LOOP-word bit 7 (1 = filter)


def _atten_gain(atten_cb: float) -> float:
    """SF2 initialAttenuation (cB) → linear amplitude multiplier (≤ 1.0)."""
    return 10.0 ** (-max(0.0, atten_cb) / 200.0)


def _vol_env_block(z: SFZone):
    """Taud volume-envelope block dict from a zone's SF2 ADSR — the PURE ADSR shape
    at full 0..63 resolution. initialAttenuation is NO LONGER folded into the node
    peak (it would crush a heavily-attenuated env to peak ~3 and zero its tail, e.g.
    SGM 'Fantasia'); it is now carried as a separate per-voice gain — base record
    bytes 251-252 / Ixmp 'x' block initialAttenuation — applied in the mixer. Returns
    (block_dict, sustain_idx, release_sec)."""
    env, sidx, rel = _adsr_to_env(z)
    nodes = [(max(0, min(63, v)), mf) for (v, mf) in env]
    sustain = ENV_SUS_ENABLE | ((sidx & 0x1F) << 8) | (sidx & 0x1F)
    return {'loop': ENV_PRESENT_BIT, 'sustain': sustain, 'nodes': nodes}, sidx, rel


# SF2 initialFilterFc default ≈ 13500 cents (~20 kHz) means "no filter / fully open".
SF2_FILTER_OPEN_CENTS = 13500
# Taud SF-mode "filter off" sentinel for the 16-bit cutoff/resonance fields.
SF_FILTER_OFF = 0xFFFF


def _zone_filter_sf(z: SFZone):
    """Resolve a zone's filter into Taud SF-mode parameters.

    Taud SF mode (base byte 173 bit 4 / patch 'x' flag) stores the cutoff as
    SoundFont **absolute cents** and resonance as **centibels above DC gain** —
    the engine computes freq = 8.176·2^(cents/1200) and dmpfac = 10^(−Qcb/200),
    so there is no ImpulseTracker ~5 kHz cutoff ceiling. When the zone has a
    modulation envelope driving the cutoff, the stored cutoff is the PEAK the
    envelope reaches and the filter-env nodes scale it back down (see
    [_filter_env_block_sf]); the engine's `currentCutoff = baseCut · envValue`
    then reproduces the SF2 sweep exactly (linear-in-cents = the right log-Hz
    sweep).

    Returns (sf_mode, cutoff16, resonance16, filter_env_block_or_None).
    sf_mode False → no filter (IT-mode 'off')."""
    base_fc = z.filter_fc
    amt     = z.me2filt
    has_static = base_fc < SF2_FILTER_OPEN_CENTS
    has_env    = bool(amt)
    if not has_static and not has_env:
        return False, SF_FILTER_OFF, SF_FILTER_OFF, None
    peak = max(1, min(0xFFFE, round(base_fc + max(0, amt))))   # engine baseCut
    qcb  = max(0, min(0xFFFE, round(z.filter_q)))              # cB above DC gain
    env  = _filter_env_block_sf(z, base_fc, amt, peak) if has_env else None
    return True, peak, qcb, env


def _filter_env_block_sf(z: SFZone, base_fc: float, amt: float, peak: int) -> dict:
    """Filter envelope in SF-cents domain. Each node value = cutoff_cents(u)/peak·255
    following the SF2 modulation-envelope DAHDSR (u walks 0→1→sustain), where
    cutoff_cents(u) = base_fc + amt·u. 0xFF (255) = fully open at `peak`; the
    release returns to the base cutoff. The engine multiplies `peak` (= baseCut)
    by node/255 each tick, so the node ratios reproduce the SF2 cutoff sweep."""
    EPS   = 0.004
    sus_u = 1.0 - z.m_sustain_pc / 1000.0          # mod-env sustain level (0..1)

    def nodeval(u: float) -> int:
        cents = base_fc + amt * u
        return max(0, min(255, round(255.0 * cents / peak)))

    pts = []                                        # (value_byte, secs_to_next)
    if z.m_delay >= EPS:
        pts.append((nodeval(0.0), z.m_delay))
    pts.append((nodeval(0.0), z.m_attack if z.m_attack >= EPS else 0.0))
    hold = z.m_hold if z.m_hold >= EPS else 0.0
    if sus_u < 1.0 and z.m_decay >= EPS:
        pts.append((nodeval(1.0), hold + z.m_decay))
        sustain_idx = len(pts)
        pts.append((nodeval(sus_u), z.m_release if z.m_release >= EPS else 0.0))
    else:
        pts.append((nodeval(1.0), hold))
        sustain_idx = len(pts) - 1
    pts.append((nodeval(0.0), 0.0))                 # release returns to base cutoff
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((nodes[-1][0], 0))
    sustain_idx = min(sustain_idx, 24)
    loop    = ENV_PRESENT_BIT | ENV_PF_FILTER       # m-bit set = filter role
    sustain = ENV_SUS_ENABLE | ((sustain_idx & 0x1F) << 8) | (sustain_idx & 0x1F)
    return {'loop': loop, 'sustain': sustain, 'nodes': nodes}


# The engine's Volume Fadeout is LINEAR IN AMPLITUDE (fadeoutVolume drops 1→0 by
# fadeStep/1024 per tick — AudioAdapter.kt ~L3679), whereas FluidSynth's release ramps
# attenuation LINEARLY IN dB (amplitude decays exponentially: −96 dB over releaseVolEnv).
# Matching the two on "time to the absolute floor" makes the linear fade sound MUCH longer:
# a linear-amplitude fade is still at −6 dB at 50 % of its length and −20 dB only at 90 %,
# while FluidSynth is already −96 dB (silent) by then. The perceived release tail ends when
# FluidSynth has dropped ≈22 dB; for the linear fade to land there at the same wall-clock
# time it must complete in ≈0.25·releaseVolEnv (see the −18..−24 dB crossing band). This
# scale brings the fadeout in line with FluidSynth's audible release length.
_RELEASE_PERCEPTUAL_SCALE = 0.25


def _zone_fadeout(z: SFZone, bpm0: int, fadeout_override) -> int:
    """Volume Fadeout step encoding the zone's SF2 release segment (gen 38,
    releaseVolEnv). With NNA Note Fade the fadeout IS the release: on key-off the
    voice fades to silence over the release time.

    FluidSynth's release (fluid_rvoice.c:54-55, fluid_voice.c:1092-1094) ramps the
    volume-envelope coefficient LINEARLY from its value at key-off down to 0, where
    amplitude = cb2amp(960·(1−volenv_val)) — i.e. the coefficient is linear in dB. The
    release rate is fixed: a full 1.0→0 ramp takes `releaseVolEnv` seconds, so a note
    released at coefficient v reaches silence in v·releaseVolEnv. v is HIGH whenever the
    note is still audible at key-off — which is the norm for the long-decay instruments
    (bells, organs, harpsichord, sitar, mute guitar) that Timbres of Heaven & friends
    encode with a silent sustain (sustainVolEnv≈1000 cB) and a multi-second decay: the
    decay IS the sound, and the key is lifted long before it reaches the silent sustain.
    So the fadeout must reflect the FULL releaseVolEnv, NOT a sustain-scaled fraction.

    The earlier model scaled by (1000−sus_cb)/1000 (the release time FROM the sustain
    level), which is only correct for a note held all the way to its sustain. For the
    decay instruments above (sus_cb≈1000) it collapsed to ~0 → an instant cut on key-off
    instead of FluidSynth's seconds-long release — released organ/bell/harpsichord notes
    were chopped off. Dropping the factor leaves the common sustained instruments
    (sus_cb≈0, factor was ≈1) unchanged and gives the decay instruments a real release.

    The engine's fadeout is linear in AMPLITUDE while FluidSynth's release is linear in
    dB (see [_RELEASE_PERCEPTUAL_SCALE]); matching the floor-reaching time would make the
    audible tail ~4× too long, so fade_sec is scaled to FluidSynth's perceived release.
    fadeStep makes the fadeout complete in fade_sec at bpm0: the engine subtracts
    fadeStep/1024 of unit volume per song tick, and the tick rate is bpm0·2/5 Hz, giving
    fadeStep = 2560/(fade_sec·bpm0)."""
    if fadeout_override is not None:
        return min(0xFFF, max(0, fadeout_override))
    fade_sec = max(0.02, _RELEASE_PERCEPTUAL_SCALE * z.env_release)
    return max(1, min(0xFFF, round(2560.0 / (fade_sec * bpm0))))


def _extra_block(z: SFZone, bpm0: int, fadeout_override) -> dict:
    """The 'x' block: release-segment fadeout + SF-mode static cutoff/resonance + filter mode."""
    sf_mode, cut16, res16, _ = _zone_filter_sf(z)
    return {'fadeout':            _zone_fadeout(z, bpm0, fadeout_override),
            'filter_sf_mode':     sf_mode,
            'default_cutoff':     cut16,
            'default_resonance':  res16}


def _pitch_env_block(z: SFZone) -> dict:
    """Pitch ('P') envelope block from the SF2 modulation envelope (DAHDSR),
    scaled by modEnvToPitch. Engine value mapping (byte/255; 0.5 = 0x80 = unity):
    envValue 1.0 → +16 semitones, so value = 0.5 + semis/32. The mod-env is
    unipolar 0→1; release returns to unity (0x80). (Filter envelopes are built
    separately in cents domain by [_filter_env_block_sf].)"""
    EPS = 0.004
    amount_cents = z.me2pitch
    sus_lvl = 1.0 - z.m_sustain_pc / 1000.0          # mod-env sustain level (0..1)

    def mapval(u: float) -> int:
        val = 0.5 + (amount_cents * u / 100.0) / 32.0
        return max(0, min(255, round(255 * max(0.0, min(1.0, val)))))

    pts = []                                          # (value_byte, secs_to_next)
    if z.m_delay >= EPS:
        pts.append((mapval(0.0), z.m_delay))
    pts.append((mapval(0.0), z.m_attack if z.m_attack >= EPS else 0.0))
    hold = z.m_hold if z.m_hold >= EPS else 0.0
    if sus_lvl < 1.0 and z.m_decay >= EPS:
        pts.append((mapval(1.0), hold + z.m_decay))
        sustain_idx = len(pts)
        pts.append((mapval(sus_lvl), z.m_release if z.m_release >= EPS else 0.0))
    else:
        pts.append((mapval(1.0), hold))
        sustain_idx = len(pts) - 1
    pts.append((mapval(0.0), 0.0))                    # release returns to unity (0x80)
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((nodes[-1][0], 0))
    sustain_idx = min(sustain_idx, 24)
    loop = ENV_PRESENT_BIT                            # m-bit clear = pitch role
    sustain = ENV_SUS_ENABLE | ((sustain_idx & 0x1F) << 8) | (sustain_idx & 0x1F)
    return {'loop': loop, 'sustain': sustain, 'nodes': nodes}


def _zone_pf_envs(z: SFZone):
    """Return (filter_env_block_or_None, pitch_env_block_or_None) for a zone's
    modulation envelope. SF2's single mod-env can drive both targets at once;
    the filter leg is built in SF-cents domain (see [_zone_filter_sf])."""
    _, _, _, filt = _zone_filter_sf(z)
    pit = _pitch_env_block(z) if z.me2pitch else None
    return filt, pit


# ── SF2 long-sample resampling + synthesized sustain loop ─────────────────────
#
# Per-sample handling when a rendered MonoSample exceeds the 65535-frame u16 cap
# (terranmon.txt sample_length is u16). Two strategies, by the rate that fitting
# the WHOLE sample into 65535 frames would leave:
#   (1)/(2) rate >= SF2_RESAMPLE_FLOOR_HZ  → downsample the whole sample to 65535
#           frames (quality stays acceptable, full sample preserved).
#   (3)     rate <  SF2_RESAMPLE_FLOOR_HZ  → resample to the 32 kHz floor instead
#           (keeps full bandwidth), keep the first 65535 frames, and — when the
#           sample has NO loop of its own — synthesize a near-seamless forward
#           loop near the end so held notes keep sounding, plus a peak->0 decay
#           vol-envelope (see _synth_decay_vol_env) that retires the voice
#           ~SF2_SYNTH_DECAY_SEC after the note fires.
SF2_RESAMPLE_FLOOR_HZ = 32000        # TSVM native audio rate (= full-bandwidth floor)
# Min fraction of a far loop that must survive the 65535-frame cap for the keep-32 kHz
# (clamp the loop end) path to be taken instead of downsampling the whole sample below
# 32 kHz. Keeps brightness when the loop barely overflows (open hi-hat), still downsamples
# a genuinely far loop so its sustain timbre is not gutted.
LOOP_KEEP_MIN         = 0.5
SF2_SYNTH_DECAY_SEC   = 10.0         # looped-note fade-to-silence span (from note-on)
SF2_LOOP_HINT         = 8192         # spec's "last 8192 samples" → MAX loop period searched
SF2_LOOP_MIN_PERIOD   = 512          # min loop period (avoid buzzy ultra-short loops)
SF2_LOOP_MATCH_WIN    = 256          # forward-window length used to score a loop seam
SF2_LOOP_MATCH_STEP   = 2            # stride within the match window (speed/quality trade)
SF2_LOOP_COARSE_STEP  = 32           # period stride for the coarse search pass


def _synth_sustain_loop(data: bytes, cap: int, hint: int):
    """Pick a near-seamless forward loop near the end of a resampled, originally
    UN-looped sample, and truncate it to <= `cap` frames. Returns
    (body, loop_start, loop_end) with the loop region [loop_start, loop_end)
    (loop_end exclusive — matches the engine's mode-1 wrap, AudioAdapter.kt:2126).

    The loop is chosen by minimising the sum-of-squared-difference between the
    W-frame windows that FOLLOW loop_start and loop_end. Forward playback wraps
    loop_end -> loop_start, so matching data[loop_start+k] ~= data[loop_end+k]
    makes the post-wrap texture continue the pre-wrap texture seamlessly (the k=0
    term also matches the immediate seam value). `hint` (the spec's "last 8192
    samples") is the MAXIMUM loop period searched, NOT taken at face value: the
    analysis settles on the smoothest-looping period in [SF2_LOOP_MIN_PERIOD, hint]
    via a coarse sweep refined locally."""
    keep = min(len(data), cap)
    W    = SF2_LOOP_MATCH_WIN
    # loop_end sits W frames before the kept end so the forward match window
    # [loop_end, loop_end + W) stays within the data.
    loop_end = keep - W
    p_max = min(hint, loop_end)
    p_min = min(SF2_LOOP_MIN_PERIOD, p_max)
    if loop_end <= p_min:                      # too short to loop (not expected in case 3)
        return data[:keep], max(0, keep - 2), keep

    def seam_err(ls: int) -> int:
        s  = 0
        le = loop_end
        for k in range(0, W, SF2_LOOP_MATCH_STEP):
            d = data[ls + k] - data[le + k]
            s += d * d
        return s

    best_p = p_min
    best_e = seam_err(loop_end - best_p)
    p = p_min + SF2_LOOP_COARSE_STEP
    while p <= p_max:
        e = seam_err(loop_end - p)
        if e < best_e:
            best_e, best_p = e, p
        p += SF2_LOOP_COARSE_STEP
    lo = max(p_min, best_p - SF2_LOOP_COARSE_STEP)
    hi = min(p_max, best_p + SF2_LOOP_COARSE_STEP)
    for p in range(lo, hi + 1):
        e = seam_err(loop_end - p)
        if e < best_e:
            best_e, best_p = e, p

    loop_start = max(0, min(loop_end - 2, loop_end - best_p))
    return data[:keep], loop_start, loop_end


def _synth_decay_vol_env(decay_sec: float) -> dict:
    """Volume-envelope block for a synthesized-loop sample: an immediate peak that
    decays exponentially (linear-dB) to silence over `decay_sec`, with NO sustain
    or loop wrap. The looped sample would otherwise sound forever; this envelope
    fades it from the instant the note fires and — because there is no wrap
    (resolveEnvWrap returns range (-1,-1)) — the engine's fall-through
    'envelope ends at 0 => cut' rule (AudioAdapter.kt:1693/1701) retires the voice
    once it reaches the terminal 0 node, ~decay_sec after firing, regardless of
    key state. The drop spans the representable 63->1 range (~36 dB); the final
    node is a true 0 terminator."""
    DROP_CB = 360.0                            # 63 -> 1 fills the whole decay span
    n   = _env_seg_count(decay_sec)
    seg = decay_sec / n
    pts = [(63, seg)]                          # peak, held one segment then decays
    for i in range(1, n):
        v = round(63 * 10.0 ** (-(DROP_CB * (i / n)) / 200.0))
        pts.append((max(1, min(63, v)), seg))
    pts.append((0, 0.0))                       # terminal 0 node => fall-through cut
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((0, 0))
    return {'loop': ENV_PRESENT_BIT, 'sustain': 0, 'nodes': nodes}


def _effective_vol_env(z: SFZone, ms: 'MonoSample') -> dict:
    """Volume-envelope block for a (zone, sample): a synthesized-loop sample fades
    from note-on via a peak->0 decay (no sustain), overriding the SF2 ADSR;
    otherwise the zone's SF2 ADSR shape (_vol_env_block)."""
    if ms is not None and ms.synth_decay is not None:
        return _synth_decay_vol_env(ms.synth_decay)
    blk, _, _ = _vol_env_block(z)
    return blk


def build_sample_inst_bin(sf: SF2, pool: list, layer_insts: list, meta_records: list,
                          fadeout_override, bpm0: int, force_synth_loop: bool = False):
    """Render & pool every used MonoSample (with the 65535-byte per-sample
    and 8 MB global caps), write the 256-byte normal-instrument records for every
    layer instrument, then the Metainstrument records. Returns the raw
    SAMPLEINST_SIZE image.

    `force_synth_loop`: when a looped sample's loop sits past the 65535-frame cap
    even at 32 kHz (case 3c), replace its real loop with a synthesized one at the
    32 kHz floor instead of muffling the whole sample down to fit (the default).
    Trades the genuine sustain loop for full bandwidth + a 10 s decay — useful for
    banks of multi-second far-loop instruments (e.g. Timbres of Heaven)."""
    for ms in pool:
        ms.render(sf)

    def _rescale_right(ms, transform):
        """Apply the same length-changing transform to a stereo sample's right
        channel and clamp it to the left channel's length — the two spans share
        one set of loop points and one sample_length, so they must stay exactly
        frame-aligned however the fitting below reshapes them."""
        if not ms.data_r:
            return
        r = transform(ms.data_r)
        n = len(ms.data)
        ms.data_r = r[:n] if len(r) >= n else r + bytes([0x80]) * (n - len(r))

    # Per-sample u16 cap. A sample over the 65535-frame limit is shrunk one of two
    # ways (see the SF2 long-sample section above): downsample the whole thing when
    # that keeps the rate >= 32 kHz; otherwise resample to the 32 kHz floor, keep the
    # first 65535 frames and synthesize a sustain loop + decay (only when the sample
    # has no loop of its own — a sample with an SF2 loop is left to fall-through, as
    # its loop already lets it sustain within whatever frames fit).
    for ms in pool:
        native_len = len(ms.data)
        if native_len <= SAMPLE_LEN_LIMIT:
            continue
        r_fit    = SAMPLE_LEN_LIMIT / native_len
        rate_fit = ms.rate * r_fit
        r32      = SF2_RESAMPLE_FLOOR_HZ / ms.rate
        # loop start/end in 32 kHz frames (0 when unlooped) decide whether a 32 kHz render
        # still contains the loop within the 65535-frame cap.
        ls32 = round(ms.loop_native[0] * r32) if ms.loop_native else 0
        le32 = round(ms.loop_native[1] * r32) if ms.loop_native else 0

        def _fit_whole():
            """(1)/(2) downsample the WHOLE sample to <= 65535 frames. Used when the
            fitted rate stays >= 32 kHz, or as the fall-back for a looped sample whose
            loop sits past the cap at 32 kHz (only fit-to-cap keeps that far loop)."""
            ms.data   = resample_linear(ms.data, r_fit)
            _rescale_right(ms, lambda d: resample_linear(d, r_fit))
            ms.ratio *= len(ms.data) / native_len

        def _synth_path(decay=True):
            """(3) resample to the 32 kHz floor (full bandwidth), keep the first 65535
            frames and synthesize a near-seamless sustain loop near the end. With
            `decay` (the default) also install a peak->0 vol-envelope that fades the
            looped note to silence from note-on — needed for UNLOOPED samples, which have
            no natural ending. A sample that ALREADY had a loop keeps its own vol-env
            (`decay=False`): its sustain is genuine, so a held note must NOT droop — the
            SF2 ADSR + key-off fadeout end it. synth_loop takes precedence over any real
            loop_native in the record/patch writers."""
            resampled = resample_linear(ms.data, r32)
            ms.ratio *= len(resampled) / native_len    # effective rate -> 32 kHz
            ms.data   = resampled
            body, ls, le = _synth_sustain_loop(ms.data, SAMPLE_LEN_LIMIT, SF2_LOOP_HINT)
            ms.data        = body
            # The synth loop only truncates and picks loop points, so the right
            # channel takes the same resample and the same cut.
            _rescale_right(ms, lambda d: resample_linear(d, r32))
            ms.synth_loop  = (ls, le)
            ms.synth_decay = SF2_SYNTH_DECAY_SEC if decay else None
            return ls, le, len(body)

        if rate_fit >= SF2_RESAMPLE_FLOOR_HZ:
            _fit_whole()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap; "
                   f"resampling by {r_fit:.4f} (rate {rate_fit:.0f} Hz)")
        elif ms.loop_native is None:
            # (3) No loop: synthesize one at the 32 kHz floor.
            ls, le, n = _synth_path()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long & unlooped; "
                   f"32 kHz, kept {n} frames, synth loop [{ls}..{le}] "
                   f"+ {SF2_SYNTH_DECAY_SEC:.0f}s decay")
        elif le32 <= SAMPLE_LEN_LIMIT - 2:
            # (3) Looped, and the loop fits at the 32 kHz floor: resample to 32 kHz and
            # keep the first 65535 frames. The per-patch loop points (native * ratio)
            # land within the kept data, so the SF2 loop + ADSR are preserved at full
            # bandwidth (a sustain-loop release tail past loop_end is truncated to fit).
            resampled = resample_linear(ms.data, r32)
            ms.ratio *= len(resampled) / native_len
            ms.data   = resampled[:SAMPLE_LEN_LIMIT]
            _rescale_right(ms, lambda d: resample_linear(d, r32)[:SAMPLE_LEN_LIMIT])
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long & looped; "
                   f"32 kHz, kept first {len(ms.data)} frames (loop_end {le32})")
        elif force_synth_loop:
            # (3c, forced) Looped, far loop, but --force-synth-loop: drop the genuine
            # loop and synthesize one at the 32 kHz floor rather than muffling the whole
            # sample. Full bandwidth + a 10 s decay, at the cost of the real sustain.
            ls, le, n = _synth_path()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long, looped, far "
                   f"loop; FORCED synth: 32 kHz, kept {n} frames, synth loop [{ls}..{le}] "
                   f"+ {SF2_SYNTH_DECAY_SEC:.0f}s decay")
        elif le32 - ls32 > 0 and (SAMPLE_LEN_LIMIT - ls32) >= LOOP_KEEP_MIN * (le32 - ls32):
            # (3b′) Loop END sits past the cap at 32 kHz but the loop START fits and MOST of
            # the loop is retained — i.e. the sustained region lives in the first 65535 frames.
            # Keep the 32 kHz floor (full hardware rate) and SYNTHESIZE a seamless sustain loop
            # in the kept data, rather than downsampling the WHOLE sample below 32 kHz. A
            # sub-32 kHz sample plays back at a rate the engine must re-stretch to 32 kHz — a
            # SECOND linear-resample pass on top of this fit one, compounding the rolloff and
            # audibly dulling bright percussion (the GeneralUser-GS open hi-hat: 2.15 s sample,
            # loop at 1.65 s never reached before its exclusiveClass choke; the double resample
            # cost it ~11% spectral centroid vs a single 32 kHz pass). The synth loop is
            # SSD-seam-matched so it does not click on tonal samples (Grand Piano / Brass that
            # also land here) the way a hard loop-end clamp to the data boundary would, and its
            # peak→0 decay roughly tracks their natural decay. A genuinely FAR loop (retained
            # fraction < LOOP_KEEP_MIN — the sustain timbre lives past the cap) still falls
            # through to fit-to-cap below, preserving that real far loop at a muffled rate.
            # decay=False: the sample had a genuine loop, so keep its own vol-env (a held
            # note sustains via the synth loop and ends on key-off — no 10 s droop).
            ls, le, n = _synth_path(decay=False)
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long & looped, loop "
                   f"end just past cap ({100*(SAMPLE_LEN_LIMIT-ls32)//(le32-ls32)}% in cap); "
                   f"kept 32 kHz, synth loop [{ls}..{le}] (natural vol-env kept)")
        else:
            # (3) Looped but the loop sits past the 65535-frame cap at 32 kHz (a far-end
            # sustain loop on a multi-second sample): the floor rate can't hold it, so
            # downsample the whole sample to fit — the ratio-scaled loop stays valid,
            # at a sub-32 kHz rate. (This is the pre-existing fit-to-cap behaviour;
            # --force-synth-loop swaps it for the synth path above.)
            _fit_whole()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long, looped, "
                   f"far loop; fit-to-cap by {r_fit:.4f} (rate {ms.rate * r_fit:.0f} Hz)")

    # Global 8 MB pool cap. Resamples every sample down equally; synthesized loop
    # points ride the same ratio so the loop stays valid in the shrunken data.
    total = sum(len(ms.data) + len(ms.data_r or b'') for ms in pool)
    if total > SAMPLEBIN_SIZE:
        g = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample pool overflow ({total} bytes); "
               f"resampling all by {g:.4f}")
        for ms in pool:
            old = len(ms.data)
            ms.data = resample_linear(ms.data, g)
            _rescale_right(ms, lambda d: resample_linear(d, g))
            ms.ratio *= len(ms.data) / old
            if ms.synth_loop is not None:
                le = min(len(ms.data) - 1, round(ms.synth_loop[1] * g))
                ls = max(0, min(le - 2, round(ms.synth_loop[0] * g)))
                ms.synth_loop = (ls, le)

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    pos = 0
    for ms in pool:
        # A stereo sample needs room for BOTH spans; if only one fits it falls
        # back to mono rather than pointing channel 2 at someone else's bytes.
        need = len(ms.data) * (2 if ms.data_r else 1)
        if ms.data_r and pos + need > SAMPLEBIN_SIZE:
            vprint(f"  warning: pool full, '{ms.name}' falls back to mono")
            ms.data_r = None
            ms.stereo = False
        n = min(len(ms.data), SAMPLEBIN_SIZE - pos)
        if n < len(ms.data):
            vprint(f"  warning: pool full, truncating '{ms.name}'")
            ms.data = ms.data[:n]
            if ms.data_r:
                ms.data_r = ms.data_r[:n]
            if ms.synth_loop is not None:        # keep the synthesized loop inside the data
                le = min(n - 1, ms.synth_loop[1])
                ms.synth_loop = (max(0, min(le - 2, ms.synth_loop[0])), le)
        sample_bin[pos:pos+n] = ms.data
        ms.offset = pos
        pos += n
        if ms.data_r:
            sample_bin[pos:pos+n] = ms.data_r[:n]
            ms.offset_r = pos
            pos += n
    vprint(f"  sample pool: {len(pool)} sample(s), {pos} bytes")

    inst_bin = bytearray(INSTBIN_SIZE)
    # Slots of the drum-kit layer instruments, so a Metainstrument built from them can be
    # flagged percussion on its own byte-0 P bit (its byte 14 is layer-table data).
    drum_layer_slots = {ti.slot for ti in layer_insts
                        if ti.usable and ti.inst_key is not None and ti.inst_key[0] == 'd'}
    for ti in layer_insts:
        if not ti.usable:
            continue
        c  = ti.canonical
        ms = c.ms
        r  = ms.ratio
        base = ti.slot * 256
        struct.pack_into('<I', inst_bin, base + 0, ms.offset)
        struct.pack_into('<H', inst_bin, base + 4, min(len(ms.data), 0xFFFF))
        struct.pack_into('<H', inst_bin, base + 6,
                         max(1, min(0xFFFF, round(ms.rate * r))))
        struct.pack_into('<H', inst_bin, base + 8, 0)            # play start
        # Synthesized-loop samples carry their loop in the final output-frame domain
        # (already scaled by every resample) and force a plain forward loop (mode 1);
        # otherwise the canonical zone's SF2 loop, scaled by this sample's ratio.
        if ms.synth_loop is not None:
            ls_w, le_w, lm_w = ms.synth_loop[0], ms.synth_loop[1], 1
        else:
            ls_w = round(c.loop_start * r)
            le_w = round(c.loop_end   * r)
            lm_w = c.loop_mode
        struct.pack_into('<H', inst_bin, base + 10, min(0xFFFF, ls_w))
        struct.pack_into('<H', inst_bin, base + 12, min(0xFFFF, le_w))
        # Drum-kit presets carry inst_key ('d', prog); flag them as percussion so an
        # editor's retuner/transposer leaves their notes alone (terranmon.txt:2127-2132).
        if ti.inst_key is not None and ti.inst_key[0] == 'd':
            lm_w |= PERCUSSION_FLAG
        inst_bin[base + 14] = lm_w

        def wenv(loop_off, sus_off, nodes_off, blk):
            struct.pack_into('<H', inst_bin, base + loop_off, blk['loop'] & 0xFFFF)
            struct.pack_into('<H', inst_bin, base + sus_off,  blk['sustain'] & 0xFFFF)
            nodes = list(blk['nodes'])
            for k in range(25):
                v, mf = nodes[k] if k < len(nodes) else (nodes[-1][0] if nodes else 0, 0)
                inst_bin[base + nodes_off + k*2]     = v & 0xFF
                inst_bin[base + nodes_off + k*2 + 1] = mf & 0xFF

        # Volume envelope from the canonical zone's SF2 ADSR (delay/attack/hold/decay,
        # single-node sustain held while key is on). There is NO release leg: on key-off
        # the voice holds at the sustain node and the Volume Fadeout (NNA Note Fade) is
        # the SF2 release segment (see _zone_fadeout). initialAttenuation is carried
        # separately (byte 251 / 'x' octet), not folded into the node peak. Non-canonical
        # zones with a different ADSR carry their own per-patch vol_env (see
        # Patch.to_ixmp_dict); the base record is the canonical / fall-through. A
        # synthesized-loop sample instead uses a peak->0 decay envelope (no sustain) so
        # its otherwise-infinite loop fades to silence ~SF2_SYNTH_DECAY_SEC after firing.
        wenv(15, 189, 21, _effective_vol_env(c.zone, ms))
        # Pan envelope: none (default unity nodes; P bit clear in LOOP word).
        struct.pack_into('<H', inst_bin, base + 17, 0)
        for k in range(25):
            inst_bin[base + 71 + k*2] = 0x80
        # Pitch/filter envelopes — SEPARATE, fixed slots (issue 2): slot #1 (bytes
        # 19/121) is the FILTER envelope (m-bit set), defaulting flat to 0xFF
        # (fully OPEN — the engine's filter-env neutral, since currentCutoff =
        # baseCut·envValue and 1.0 = open); slot #2 (bytes 197/201) is the PITCH
        # envelope (m-bit clear), defaulting flat to 0x80 (unity, no transpose). A
        # flat slot keeps its LOOP word at 0 (P-bit clear) so the engine ignores it.
        sf_mode, cut16, res16, filt_env = _zone_filter_sf(c.zone)
        pit_env = _pitch_env_block(c.zone) if c.zone.me2pitch else None
        for k in range(25):
            inst_bin[base + 121 + k*2] = 0xFF                    # filter-env (slot 1) flat = open
            inst_bin[base + 201 + k*2] = 0x80                    # pitch-env (slot 2) flat = unity
        if filt_env is not None:
            wenv(19, 193, 121, filt_env)
        if pit_env is not None:
            wenv(197, 199, 201, pit_env)

        # Volume Fadeout = the SF2 release segment (NNA Note Fade below). Derived from
        # the canonical zone's full releaseVolEnv; see _zone_fadeout for the timecent→step
        # derivation and why it is NOT sustain-scaled. A synthesized-loop sample keeps
        # its key-off fadeout too: the peak->0 decay vol-env (no sustain wrap) only fades
        # the HELD note to silence over ~SF2_SYNTH_DECAY_SEC from note-on; on key-off the
        # voice must still release over the SF2 release time (FluidSynth does), else the
        # released note rings for the whole decay span instead of stopping.
        fo = _zone_fadeout(c.zone, bpm0, fadeout_override)
        inst_bin[base + 171] = 0xFF                              # IGV (unit)
        inst_bin[base + 172] = fo & 0xFF
        # byte 173: bits 0-3 = fadeout high nibble, bit 4 = SF filter mode (cutoff/resonance
        # are 16-bit SoundFont cents/centibels in bytes 182<<8|252 / 183<<8|253).
        inst_bin[base + 173] = ((fo >> 8) & 0x0F) | (0x10 if sf_mode else 0)
        inst_bin[base + 177] = (0x80 if c.pan8 == IXMP_PAN_NO_OVERRIDE
                                else c.pan8)                     # default pan
        struct.pack_into('<H', inst_bin, base + 178, TAUD_C4)    # PPC
        inst_bin[base + 182] = (cut16 >> 8) & 0xFF               # cutoff high (SF cents / IT byte)
        inst_bin[base + 252] = cut16 & 0xFF                      # cutoff low  (SF mode)
        inst_bin[base + 183] = (res16 >> 8) & 0xFF               # resonance high
        inst_bin[base + 253] = res16 & 0xFF                      # resonance low (SF mode)
        struct.pack_into('<H', inst_bin, base + 184, c.detune & 0xFFFF)
        # NNA = Note Fade (0b11) for every instrument, drum kits included. On any
        # key-off the voice holds at the sustain node and the Volume Fadeout performs
        # the SF2 release segment; when a fresh note displaces this voice the engine
        # ghosts it and starts the same fadeout, so released/displaced notes always
        # die over their own release time. (Supersedes the old melodic Key-Lift /
        # drum Continue split — the release now lives in the fadeout, not env nodes.)
        inst_bin[base + 186] = 0b11
        inst_bin[base + 196] = 255                               # default note vol
        # initialAttenuation (byte 251, dB-table octet) — the canonical zone's static gain,
        # applied per-voice by the mixer (no longer folded into the vol-env). Per-patch zones
        # with a different attenuation carry their own octet in the Ixmp 'x' block.
        inst_bin[base + 251] = atten_cb_to_octet(c.zone.atten_cb) & 0xFF

    # Metainstrument records: a 0xFFFF-sentinel sample pointer (high 16 bits) plus a
    # layer table (terranmon.txt "Metainstrument definition"). Layers stay neutral
    # (unity mix, zero detune); per-zone level/tune already live in each layer
    # instrument's patches. The note references the meta slot; the engine fans out.
    for meta_slot, _name, layer_descs in meta_records:
        base = meta_slot * 256
        # byte 0 bit 0 = STRICT layering: each layer's canonical is also in its Ixmp patch
        # list (build_ixmp), so the engine silences a layer whose gating bbox contains the
        # note but whose patches do not, instead of sounding that layer's base/canonical
        # (the spurious meta-layer fallback). Old files left byte 0 = 0 (legacy: base
        # fallback) and have no canonical patch, so the engine gates this on the flag.
        is_drum = any(layer_slot in drum_layer_slots for layer_slot, _rect in layer_descs)
        inst_bin[base + 0] = (META_STRICT_FLAG                  # type 0 = layered, +strict bit
                              | (META_PERCUSSION_FLAG if is_drum else 0))  # +percussion (P) for drum kits
        inst_bin[base + 1] = len(layer_descs) & 0xFF            # layer count
        inst_bin[base + 2] = 0xFF; inst_bin[base + 3] = 0xFF    # identifier (hi 16 bits)
        o = base + 4
        for layer_slot, rect in layer_descs:
            plo, phi, vlo, vhi = rect
            # 10-bit layer instrument index: low 8 bits in byte 0; bits 8..9 (the
            # auxiliary-bin $100..$3FF selector) in bits 6..7 of the volume-start byte
            # (offset +8). Layers of multi-layer presets live in the aux bin.
            inst_bin[o]     = layer_slot & 0xFF
            inst_bin[o + 1] = META_UNITY_OCTET
            struct.pack_into('<h', inst_bin, o + 2, 0)          # sample detune (neutral)
            struct.pack_into('<H', inst_bin, o + 4, plo & 0xFFFF)
            struct.pack_into('<H', inst_bin, o + 6, phi & 0xFFFF)
            inst_bin[o + 8] = (vlo & 0x3F) | (((layer_slot >> 8) & 0x3) << 6)
            inst_bin[o + 9] = vhi & 0x3F
            o += 10

    return bytes(sample_bin) + bytes(inst_bin)


# ── Cell grid (voices × rows) ────────────────────────────────────────────────

def _cell(cells: dict, v: int, row: int) -> dict:
    c = cells.get((v, row))
    if c is None:
        c = {'note': NOTE_NOP, 'inst': 0, 'vol': (SEL_FINE, 0),
             'pan': (SEL_FINE, 0), 'eff': None, 'prio': PRIO_FREE}
        cells[(v, row)] = c
    return c


def _note_end_row(n: 'Note', speed: int) -> int:
    """The row at which note `n` frees its column: key-off row for melodic
    notes, next row for a drum (its NNA ghost carries the ring), extended past
    an exclusiveClass choke so the choked note stays foreground through it."""
    srow = n.start_ft // speed
    if n.drum:
        end_row = srow + 1
    else:
        end_row = max(srow + 1, n.end_ft // speed)
    if n.excl_cut_ft is not None:
        crow = n.excl_cut_ft // speed
        if crow <= srow:
            crow = srow + 1
        end_row = max(end_row, crow + 1)
    return end_row


def _peak_columns(notes: list, speed: int) -> int:
    """Peak simultaneous columns a part needs = the maximum number of its notes
    overlapping at any row (= the min columns greedy interval-partitioning would
    use, uncapped). No mutation. Column i frees at `end_row` (exclusive), so a
    note starting on another's end row does NOT overlap it (ends sort first)."""
    events = []
    for n in notes:
        srow = n.start_ft // speed
        events.append((srow, 1))
        events.append((_note_end_row(n, speed), -1))
    events.sort()                       # (row, +1) after (row, -1): frees first
    cur = peak = 0
    for _, delta in events:
        cur += delta
        peak = max(peak, cur)
    return peak


def _schedule_part(notes: list, speed: int, cap: int) -> tuple:
    """Greedy per-row interval scheduling of ONE part's notes onto <= `cap`
    columns.

    The engine's New Note Action does the heavy lifting (matching MIDI
    polyphony semantics): a fresh trigger on an occupied voice migrates the
    old note into the mixer's background-ghost pool, so a voice is reusable
    the moment its note is *released* — the Note-Fade tail rides the ghost
    (fading over the instrument's SF2 release). Melodic voices free at their
    key-off row; drum voices (no key-off by default) free on the very next
    row. Stealing is therefore graceful: the victim is released early, not cut.

    Mutates note.voice to a LOCAL column index (and truncates stolen notes'
    end_ft). Returns (columns_used, stolen)."""
    cap = max(1, cap)
    v_end  = []     # voice → first row at which it is free again
    v_slot = []     # voice → last instrument slot (affinity only)
    v_note = []     # voice → currently scheduled note
    stolen = 0
    for n in notes:
        srow = n.start_ft // speed
        free = [v for v in range(len(v_end)) if v_end[v] <= srow]
        v = next((x for x in free if v_slot[x] == n.slot),
                 free[0] if free else -1)
        if v < 0:
            if len(v_end) < cap:
                v = len(v_end)
                v_end.append(0); v_slot.append(0); v_note.append(None)
            else:
                # Steal preference: notes held only by the sustain pedal lose
                # least (their key is already up); otherwise the note ending
                # soonest. Either way NNA turns the steal into an early release.
                pedal = [x for x in range(len(v_end))
                         if v_note[x] is not None
                         and v_note[x].pedal_ft is not None
                         and v_note[x].pedal_ft <= n.start_ft]
                cand = pedal if pedal else range(len(v_end))
                v = min(cand, key=lambda x: v_end[x])
                victim = v_note[v]
                if victim is not None and victim.end_ft > n.start_ft:
                    victim.end_ft = n.start_ft
                stolen += 1
        end_row = _note_end_row(n, speed)
        n.voice = v
        v_end[v], v_slot[v], v_note[v] = end_row, n.slot, n
    return len(v_end), stolen


def allocate_voices(notes: list, speed: int, max_voices: int) -> tuple:
    """Assign each note a voice column, laid out in per-part pools so a column
    stays with ONE MIDI part for the whole song — the way a human arranges a
    tracker, rather than the old global-greedy packing that let a column drift
    between instruments bar to bar.

    Each part (MIDI channel) reserves a contiguous block of HOME columns sized to
    its polyphony (water-filled to the most-polyphonic parts when the summed
    demand exceeds `max_voices`). A note prefers a free home column of its part —
    keeping the column part-aligned — but when its part momentarily needs more
    than it reserved it BORROWS any idle column rather than cutting a note; only
    when every column is busy (true simultaneous polyphony > cap) does it steal
    (soonest-ending / sustain-pedal-held first, the graceful NNA early-release).
    Because parts peak at different times, the global peak is usually far below
    the SUMMED per-part peaks, so borrowing absorbs the overflow with no steals on
    typical songs — matching the old global-greedy column count while keeping the
    per-part layout. Only when there are literally more parts than columns
    (`--max-voices` below the channel count) do we fall back to a shared pool.

    Mutates note.voice. Returns (n_voices, voice_part, voice_slot) where
    voice_part[v] / voice_slot[v] are the dominant MIDI channel / instrument
    slot of column v (used for pattern naming)."""
    cap = max(1, min(max_voices, MAX_VOICES))
    # Group notes by part, stable first-appearance order so intro parts take the
    # low columns (notes arrive pre-sorted by start_ft).
    parts, order = {}, []
    for n in notes:
        if n.ch not in parts:
            parts[n.ch] = []
            order.append(n.ch)
        parts[n.ch].append(n)
    natural = {ch: _peak_columns(parts[ch], speed) for ch in order}
    active = [ch for ch in order if natural[ch] > 0]

    total_stolen = 0
    if 0 < len(active) <= cap:
        # Water-fill home-column counts: each active part keeps >=1, extras go to
        # the parts with the largest unmet peak until the budget is spent.
        alloc = {ch: 1 for ch in active}
        remaining = cap - len(active)
        while remaining > 0:
            cands = [ch for ch in active if alloc[ch] < natural[ch]]
            if not cands:
                break
            ch = max(cands, key=lambda c: (natural[c] - alloc[c], natural[c]))
            alloc[ch] += 1
            remaining -= 1
        col_owner, home_cols = [], {}
        for ch in active:
            home_cols[ch] = list(range(len(col_owner), len(col_owner) + alloc[ch]))
            col_owner.extend([ch] * alloc[ch])
        total_cols = len(col_owner)
        v_end  = [0] * total_cols       # column → first row it is free again
        v_note = [None] * total_cols    # column → currently scheduled note
        for n in notes:                 # global start-time order
            hcols = home_cols.get(n.ch)
            if not hcols:
                continue
            srow = n.start_ft // speed
            v = next((c for c in hcols if v_end[c] <= srow), -1)
            if v < 0:
                # Home full: borrow an idle column before resorting to a steal.
                # Prefer one this part most recently held (sticky — concentrates a
                # part's borrowed footprint onto a few columns instead of rotating
                # through everyone's, so columns stay mostly single-part); else the
                # column freed longest ago.
                free = [c for c in range(total_cols) if v_end[c] <= srow]
                if free:
                    own = [c for c in free if v_note[c] is not None
                           and v_note[c].ch == n.ch]
                    v = min(own or free, key=lambda c: (v_end[c], c))
                else:
                    pedal = [c for c in range(total_cols)
                             if v_note[c] is not None
                             and v_note[c].pedal_ft is not None
                             and v_note[c].pedal_ft <= n.start_ft]
                    cand = pedal if pedal else range(total_cols)
                    v = min(cand, key=lambda c: v_end[c])
                    victim = v_note[v]
                    if victim is not None and victim.end_ft > n.start_ft:
                        victim.end_ft = n.start_ft
                    total_stolen += 1
            n.voice = v
            v_end[v], v_note[v] = _note_end_row(n, speed), n
    else:
        if active:
            vprint(f"  info: {len(active)} parts exceed the {cap}-column budget — "
                   f"sharing columns across parts (naming falls back per column)")
        _, total_stolen = _schedule_part(notes, speed, cap)

    if total_stolen:
        vprint(f"  info: simultaneous polyphony exceeded {cap} voices; {total_stolen} "
               f"note(s) released early (NNA ghost keeps the tail)")

    n_voices = max((n.voice for n in notes), default=-1) + 1
    part_tally = [dict() for _ in range(n_voices)]
    slot_tally = [dict() for _ in range(n_voices)]
    for n in notes:
        part_tally[n.voice][n.ch]   = part_tally[n.voice].get(n.ch, 0) + 1
        slot_tally[n.voice][n.slot] = slot_tally[n.voice].get(n.slot, 0) + 1
    voice_part = [max(t.items(), key=lambda kv: kv[1])[0] if t else -1
                  for t in part_tally]
    voice_slot = [max(t.items(), key=lambda kv: kv[1])[0] if t else 0
                  for t in slot_tally]
    return n_voices, voice_part, voice_slot


def emit_cells(song: Song, insts: dict, speed: int, rpb: int,
               eps_units: float, drum_keyoff: bool, shift_ft: int,
               max_voices: int) -> tuple:
    """Place triggers, key-offs, portamento bend segments, M channel-volume
    and T tempo effects into the (voice,row) cell grid.
    Returns (cells, n_voices, total_rows, taud_bpm0, voice_part, voice_slot)."""
    notes = [n for n in song.notes if n.slot > 0]

    def midi_bpm_at(ft):
        i = bisect.bisect_right(song.tempo_ft, ft) - 1
        return song.tempo_bpm[i] if i >= 0 else 120.0

    scale = rpb * speed / 24.0

    def taud_bpm(b):
        t = round(b * scale)
        if not (_TAUD_BPM_LO <= t <= _TAUD_BPM_HI):
            vprint(f"  warning: tempo {b:.1f} BPM maps to Taud {t}, "
                   f"clamped to {_TAUD_BPM_LO}..{_TAUD_BPM_HI} (try a different --rpb/--speed)")
        return max(_TAUD_BPM_LO, min(_TAUD_BPM_HI, t))

    def tempo_effarg(tb):
        # T $xx00 set-tempo (BPM = xx+$19) up to 280; T $FFxx extended (BPM = xx+$118) above.
        if tb <= 280:
            return ((tb - 25) & 0xFF) << 8
        return 0xFF00 | ((tb - 280) & 0xFF)

    n_voices, voice_part, voice_slot = allocate_voices(notes, speed, max_voices)
    if n_voices == 0:
        sys.exit("error: no playable notes")
    vprint(f"  voices: {n_voices} used (cap {max_voices}; NNA carries tails)")

    cells = {}

    # ── Pass 1: triggers ──
    for n in notes:
        row, tick = n.start_ft // speed, n.start_ft % speed
        c = _cell(cells, n.voice, row)
        nv = key_to_noteval(n.key + n.bend0)
        c['note'] = nv
        c['inst'] = n.slot
        c['vol']  = (SEL_SET, round(n.vel * 63 / 127))
        st = song.channels[n.ch]
        if st.cc10_ft:
            pan = _curve_at(st.cc10_ft, st.cc10_val, n.start_ft + shift_ft, 64)
            c['pan'] = (SEL_SET, round(pan * 63 / 127))
        if tick > 0:
            c['eff']  = (TOP_S, 0xD000 | (tick << 8))
            c['prio'] = PRIO_DELAY

    # ── Pass 2: key-offs (both MIDI idioms arrive here as note.end_ft) ──
    skipped_offs = 0
    for n in notes:
        if n.drum and not drum_keyoff:
            continue
        row, tick = n.end_ft // speed, n.end_ft % speed
        srow = n.start_ft // speed
        if row == srow:
            # Sub-row note (shorter than one tracker row): its key-off would land on
            # its OWN trigger row, where the trigger cell already sits — pass 2 would
            # then skip it ("row taken") and the note would ring forever until the next
            # trigger on this voice. Push the key-off to the next row (tick 0) so a
            # staccato note rounds up to ~1 row instead of hanging. If the next row is
            # itself a fresh trigger, that note cuts/NNAs this one anyway (skip is fine).
            row = srow + 1
            tick = 0
        c = cells.get((n.voice, row))
        if c is None:
            c = _cell(cells, n.voice, row)
            c['note'] = NOTE_KEYOFF
            if tick > 0:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        elif c['note'] == NOTE_NOP:
            c['note'] = NOTE_KEYOFF
            if tick > 0 and c['eff'] is None:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        else:
            skipped_offs += 1    # row taken by a retrigger — which cuts/NNAs anyway
    if skipped_offs:
        vprint(f"  info: {skipped_offs} key-off(s) absorbed by same-row retriggers")

    # ── Pass 2b: exclusiveClass chokes (fast note-fade) ──
    # The choked note holds its voice through the choke row (allocate_voices), so the
    # NOTE_FASTFADE lands on it while it is still foreground. The next same-class note
    # plays on a different column, so this never collides with a fresh trigger.
    for n in notes:
        if n.excl_cut_ft is None:
            continue
        srow = n.start_ft // speed
        row, tick = n.excl_cut_ft // speed, n.excl_cut_ft % speed
        if row <= srow:          # choke within the trigger row → round up one row
            row = srow + 1
            tick = 0
        c = cells.get((n.voice, row))
        if c is None:
            c = _cell(cells, n.voice, row)
            c['note'] = NOTE_FASTFADE
            if tick > 0:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        elif c['note'] in (NOTE_NOP, NOTE_KEYOFF):
            c['note'] = NOTE_FASTFADE          # choke supersedes a natural key-off
            if tick > 0 and c['eff'] is None:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        # else: row already holds a fresh trigger — that note cuts/NNAs this one anyway.

    # ── Pass 3: pitch-bend portamento segments ──
    # One linear segment per row: the cell carries the exact 4096-TET target
    # plus G at units/tick sized to land on it by row end (G slides on the
    # speed-1 non-first ticks). Targets within eps_units are skipped (jitter
    # simplification).
    seg_count = 0
    if speed >= 2:
        for n in notes:
            st = song.channels[n.ch]
            if len(st.bend_ft) <= 1 and n.bend0 == 0.0:
                continue
            start_row = n.start_ft // speed
            end_row   = n.end_ft   // speed
            cur = key_to_noteval(n.key + n.bend0)
            for r in range(start_row + 1, end_row):
                ftr = min((r + 1) * speed, n.end_ft) + shift_ft
                target = key_to_noteval(
                    n.key + _curve_at(st.bend_ft, st.bend_val, ftr, 0.0))
                if abs(target - cur) < eps_units:
                    continue
                if (n.voice, r) in cells:
                    continue
                step = -(-abs(target - cur) // (speed - 1))
                c = _cell(cells, n.voice, r)
                c['note'] = target
                c['eff']  = (TOP_G, min(0xFFFF, step))
                c['prio'] = PRIO_PORTA
                cur = target
                seg_count += 1
    elif any(len(st.bend_ft) > 1 for st in song.channels):
        vprint("  warning: --speed 1 cannot express portamento; "
               "pitch-bend movement dropped")
    if seg_count:
        vprint(f"  bend: {seg_count} portamento segment(s) emitted")

    # ── Pass 4: M channel volume (CC7 × CC11), per voice chronologically ──
    by_voice = {}
    for n in notes:
        by_voice.setdefault(n.voice, []).append(n)
    m_emitted = 0
    for v, vnotes in by_voice.items():
        vnotes.sort(key=lambda n: n.start_ft)
        m_state = 0x3F                            # engine channel_vol default
        for n in vnotes:
            st = song.channels[n.ch]
            for r in range(n.start_ft // speed, n.end_ft // speed + 1):
                ftr = r * speed + shift_ft
                m = round(_curve_at(st.cc7_ft,  st.cc7_val,  ftr, 100) / 127
                          * _curve_at(st.cc11_ft, st.cc11_val, ftr, 127) / 127
                          * 63)
                if m == m_state:
                    continue
                c = _cell(cells, v, r)
                if c['eff'] is not None:
                    continue                      # slot busy — retry next row
                c['eff']  = (TOP_M, (m & 0x3F) << 8)
                c['prio'] = PRIO_M
                m_state = m
                m_emitted += 1
    if m_emitted:
        vprint(f"  cc: {m_emitted} M channel-volume effect(s) emitted")

    total_rows = max(r for (_v, r) in cells) + 1

    # Anchor the song's length to the MIDI End-of-Track, NOT to the last
    # surviving note. Preset resolution drops notes whose SoundFont preset is
    # missing, so a sparse bank can drop the trailing notes and silently shorten
    # the song (E2M1: 3453 rows on a full GM bank vs 3449 when the last notes are
    # dropped) — the cue layout and final HALT then depend on the SoundFont. EoT
    # is a fixed MIDI property, so the row count is the same for every bank: the
    # dropped notes' time becomes trailing silence instead of vanishing. `max`
    # with the last trigger row still honours a note that (pathologically) starts
    # past EoT. The EoT row itself is the end-of-song boundary (exclusive), so a
    # final key-off landing exactly on it is dropped (the HALT cuts the note),
    # which also avoids the lone-key-off terminus cue the trim below handled.
    if song.eot_ft is not None:
        eot_row = (song.eot_ft - shift_ft) // speed
        last_trigger = max((n.start_ft // speed for n in notes), default=0)
        total_rows = max(eot_row, last_trigger + 1)

    # ── Pass 5: T tempo changes ──
    bpm0 = midi_bpm_at(shift_ft)                  # tempo in effect at row 0
    last = taud_bpm(bpm0)
    t_emitted = t_evict = 0
    for ft, b in zip(song.tempo_ft, song.tempo_bpm):
        row = (ft - shift_ft) // speed
        if row < 0:
            continue
        if row >= total_rows:
            break
        tb = taud_bpm(b)
        if tb == last:
            continue
        placed = False
        victim = None
        for v in range(n_voices):
            c = cells.get((v, row))
            if c is None or c['eff'] is None:
                c = _cell(cells, v, row)
                c['eff']  = (TOP_T, tempo_effarg(tb))
                c['prio'] = PRIO_TEMPO
                placed = True
                break
            if c['prio'] < PRIO_DELAY and (victim is None
                                           or c['prio'] < victim['prio']):
                victim = c
        if not placed and victim is not None:
            if victim['prio'] == PRIO_PORTA:
                victim['note'] = NOTE_NOP         # orphan G note would retrigger
            victim['eff']  = (TOP_T, tempo_effarg(tb))
            victim['prio'] = PRIO_TEMPO
            placed = True
            t_evict += 1
        if placed:
            last = tb
            t_emitted += 1
    if t_emitted:
        vprint(f"  tempo: {t_emitted} T effect(s)"
               + (f" ({t_evict} evicted a lesser effect)" if t_evict else ""))

    return cells, n_voices, total_rows, taud_bpm(bpm0), voice_part, voice_slot


# ── Pattern / cue emission and final assembly ────────────────────────────────

def _bar_align_up(row: int, timesig_ft: list, timesig: list,
                  shift_ft: int, speed: int, rpb: int) -> int:
    """Smallest bar-line row >= `row`, using the time signature of the section
    `row` falls in (sections start at time-sig changes, as in plan_cues). A row
    already on a bar line is returned unchanged. Used to bar-align the --loop
    whole-song loop-end so the loop seam lands on a bar (and a full cue)."""
    def bar_rows_of(r):
        ft = r * speed + shift_ft
        i = bisect.bisect_right(timesig_ft, ft) - 1
        num, dpow = timesig[i] if i >= 0 else (4, 2)
        return max(1, round(num * 4.0 / (2 ** dpow) * rpb))
    breaks = sorted({0} | {(ft - shift_ft) // speed for ft in timesig_ft})
    sec_start = max(b for b in breaks if b <= row)
    br = bar_rows_of(sec_start)
    return sec_start + ((row - sec_start + br - 1) // br) * br


def _bar_number_at(row: int, timesig_ft: list, timesig: list,
                   shift_ft: int, speed: int, rpb: int) -> int:
    """1-based musical bar number of grid row `row`. Bars count continuously
    from 1 at song start; bar LENGTH follows the time signature of each section
    (sections start at time-sig changes, as in plan_cues), so the count carries
    over correctly across meter changes. Since cues are whole-bar aligned within
    each section, a cue start always lands exactly on a bar line."""
    def bar_rows_of(r):
        ft = r * speed + shift_ft
        i = bisect.bisect_right(timesig_ft, ft) - 1
        num, dpow = timesig[i] if i >= 0 else (4, 2)
        return max(1, round(num * 4.0 / (2 ** dpow) * rpb))
    breaks = sorted({0} | {(ft - shift_ft) // speed for ft in timesig_ft
                           if (ft - shift_ft) // speed > 0})
    bars_before = 0
    for i, sec_start in enumerate(breaks):
        br = bar_rows_of(sec_start)
        sec_end = breaks[i + 1] if i + 1 < len(breaks) else None
        if sec_end is not None and row >= sec_end:
            bars_before += (sec_end - sec_start + br - 1) // br
            continue
        return bars_before + (row - sec_start) // br + 1
    return bars_before + 1


def plan_cues(timesig_ft: list, timesig: list, total_rows: int,
              shift_ft: int, speed: int, rpb: int) -> tuple:
    """Plan the cue layout: break a cue at every time-signature change, and pack
    each section into whole-bar cues — the largest multiple of the section's bar
    length that fits in 64 rows (so the tracker's bar/beat highlight lines up).

    Returns (cue_starts, cue_lens, init_bar_rows). cue_starts[i] is the absolute
    starting row of cue i; cue_lens[i] is its playable row count (<= 64). A
    constant 4/4 song still yields 64-row (= 4-bar) cues."""
    def timesig_at(row):
        ft = row * speed + shift_ft
        i = bisect.bisect_right(timesig_ft, ft) - 1
        return timesig[i] if i >= 0 else (4, 2)   # MIDI default = 4/4

    def bar_rows_of(sig):
        num, dpow = sig
        bar_quarters = num * 4.0 / (2 ** dpow)    # bar length in quarter notes
        return max(1, round(bar_quarters * rpb))

    breaks = {(ft - shift_ft) // speed for ft in timesig_ft}
    bounds = sorted({0, total_rows} | {r for r in breaks if 0 < r < total_rows})

    cue_starts, cue_lens = [], []
    for bi in range(len(bounds) - 1):
        seg_start, seg_end = bounds[bi], bounds[bi + 1]
        br = bar_rows_of(timesig_at(seg_start))
        cue_max = br * (PATTERN_ROWS // br) if br <= PATTERN_ROWS else PATTERN_ROWS
        r = seg_start
        while r < seg_end:
            length = min(cue_max, seg_end - r)
            cue_starts.append(r)
            cue_lens.append(length)
            r += length
    return cue_starts, cue_lens, bar_rows_of(timesig_at(0))


def _pattern_is_empty(pat_bin: bytes, idx: int) -> bool:
    """True when unique pattern `idx` carries no note / instrument / effect on any
    row — the shared silent filler emitted for a part that rests through a cue.
    (Only the vol/pan bytes are 0xC0 in a filler cell; note, inst and eff-op are
    all zero. A key-off/cut cell has a nonzero note value, so it is NOT empty.)"""
    base = idx * PATTERN_BYTES
    for r in range(PATTERN_ROWS):
        o = base + r * 8
        if pat_bin[o] or pat_bin[o + 1] or pat_bin[o + 2] or pat_bin[o + 5]:
            return False
    return True


def _blank_pattern() -> bytes:
    """A pattern of 64 silent cells, in the converter's own filler spelling
    (vol/pan 0xC0 no-ops, everything else zero) — the same bytes build_pattern_bin
    lays down for a part that rests through a whole cue."""
    blank = bytearray(PATTERN_BYTES)
    for r in range(PATTERN_ROWS):
        blank[r * 8 + 3] = 0xC0
        blank[r * 8 + 4] = 0xC0
    return bytes(blank)


def _empty_pattern_first(pat_bin: bytes, remap: dict, n_unique: int,
                         verbose_note: list) -> tuple:
    """Put an all-empty pattern on $0000 (item 159).

    Pattern $0000 is what an editor reaches for when a cue gains a channel or a
    new cue is added, so a converted song where $0000 happens to be real music
    makes every such gesture blurt out a phrase nobody asked for. Any silent
    filler pattern the song already carries is SWAPPED to the front (a pure
    permutation — the cue sheet follows through `remap`); a song that has none
    gets a fresh blank prepended, if the pattern budget can take one.

    Returns (pat_bin, remap, n_unique).
    """
    empty = next((u for u in range(n_unique) if _pattern_is_empty(pat_bin, u)), None)
    if empty == 0:
        return pat_bin, remap, n_unique
    if empty is None:
        if n_unique >= NUM_PATTERNS_MAX:
            verbose_note.append("no room for a blank $0000")
            return pat_bin, remap, n_unique
        verbose_note.append("blank $0000 added")
        return (_blank_pattern() + bytes(pat_bin),
                {k: v + 1 for k, v in remap.items()},
                n_unique + 1)
    verbose_note.append(f"blank $0000 (was ${empty:04X})")
    buf = bytearray(pat_bin)
    a, b = 0, empty * PATTERN_BYTES
    buf[a:a + PATTERN_BYTES], buf[b:b + PATTERN_BYTES] = \
        bytes(buf[b:b + PATTERN_BYTES]), bytes(buf[a:a + PATTERN_BYTES])
    swap = {0: empty, empty: 0}
    return bytes(buf), {k: swap.get(v, v) for k, v in remap.items()}, n_unique


def build_pattern_bin(cells: dict, n_voices: int,
                      cue_starts: list, cue_lens: list) -> bytes:
    """Pack patterns for cues that may start at arbitrary rows and run fewer
    than 64 rows (bar-aligned / time-signature-broken cues). Rows past a cue's
    length are silent padding (the LEN cue instruction stops playback there)."""
    n_cues = len(cue_starts)
    out = bytearray(n_cues * n_voices * PATTERN_BYTES)
    pos = 0
    for ci, (start, length) in enumerate(zip(cue_starts, cue_lens)):
        for v in range(n_voices):
            for r in range(PATTERN_ROWS):
                base = pos + r * 8
                c = cells.get((v, start + r)) if r < length else None
                if c is None:
                    out[base + 3] = 0xC0
                    out[base + 4] = 0xC0
                    continue
                struct.pack_into('<H', out, base, c['note'] & 0xFFFF)
                out[base + 2] = c['inst'] & 0xFF
                vs, vv = c['vol']
                ps, pv = c['pan']
                out[base + 3] = (vv & 0x3F) | ((vs & 3) << 6)
                out[base + 4] = (pv & 0x3F) | ((ps & 3) << 6)
                if c['eff'] is not None:
                    op, arg = c['eff']
                    out[base + 5] = op & 0xFF
                    struct.pack_into('<H', out, base + 6, arg & 0xFFFF)
            pos += PATTERN_BYTES
    return bytes(out)


def _inject_loop(pat_bin: bytes, cue_starts: list, cue_lens: list, n_voices: int,
                 rs: int, re: int) -> tuple:
    """Make the song loop from row `re` (exclusive) back to row `rs`.

    Returns (pat_bin, cue_starts, cue_lens, jump_instr). When the loop covers
    complete full-length cues from a cue boundary, `jump_instr` is the 2-byte JMP
    cue instruction to place on the (new) last cue — the clean "replace HALT with
    JMP000" case. Otherwise an in-pattern order jump (effect B → cue cs, plus
    effect C → row when the loop-start is mid-cue) is written on the last looped
    row and `jump_instr` is None. Cues after the loop-end are unreachable once we
    loop, so they are dropped."""
    n_cues = len(cue_starts)
    song_end_row = cue_starts[-1] + cue_lens[-1]
    rs = max(0, min(rs, song_end_row - 1))
    re = max(rs + 1, min(re, song_end_row))
    last_played = re - 1

    def cue_of(row):
        for ci in range(n_cues):
            if cue_starts[ci] <= row < cue_starts[ci] + cue_lens[ci]:
                return ci
        return n_cues - 1
    cs = cue_of(rs)
    ce = cue_of(last_played)
    rs_off = rs - cue_starts[cs]
    re_off = last_played - cue_starts[ce]

    # Drop the now-unreachable tail cues (after the loop-end cue).
    if ce < n_cues - 1:
        cue_starts = cue_starts[:ce + 1]
        cue_lens   = cue_lens[:ce + 1]
        pat_bin    = pat_bin[:(ce + 1) * n_voices * PATTERN_BYTES]
        n_cues = ce + 1

    # Clean whole-cue case: loop-start on a cue boundary AND loop-end on the last
    # row of a FULL 64-row cue. A cue-level JMP fires at the cue's full-pattern
    # end, which only lines up here; partial / mid-pattern loops use effect B.
    if rs_off == 0 and re_off == cue_lens[ce] - 1 and cue_lens[ce] == PATTERN_ROWS:
        return pat_bin, cue_starts, cue_lens, cue_instruction_jump(cs)

    buf = bytearray(pat_bin)

    def free_voice(skip):
        # Prefer a fully-empty cell, then any cell without an effect.
        for want_empty in (True, False):
            for v in range(n_voices):
                if v in skip:
                    continue
                off = (ce * n_voices + v) * PATTERN_BYTES + re_off * 8
                if buf[off + 5] != 0:
                    continue
                if want_empty and (buf[off] != 0 or buf[off + 1] != 0):
                    continue
                return v, off
        return None, None

    vb, ob = free_voice(set())
    if vb is None:                       # every cell on this row already has an effect
        vb, ob = 0, (ce * n_voices) * PATTERN_BYTES + re_off * 8
        vprint("  warning: loop-end row crowded — overwriting an effect with the B jump")
    buf[ob + 5] = TOP_B
    struct.pack_into('<H', buf, ob + 6, cs & 0xFFFF)
    if rs_off > 0:
        vc, oc = free_voice({vb})
        if vc is None:
            vprint("  warning: no free slot for the C row-jump — looping to the "
                   "loop-start cue's first row instead")
        else:
            buf[oc + 5] = TOP_C
            struct.pack_into('<H', buf, oc + 6, rs_off & 0xFFFF)
    return bytes(buf), cue_starts, cue_lens, None


def build_song_section(song: Song, speed: int, rpb: int, src_path: str,
                       args, slot_name: dict = None) -> dict:
    """Per-song pattern/cue build shared by the full .taud and the .tpif paths.

    Trims leading silence, emits the cell grid, plans cues, builds & dedupes the
    pattern bin, and packs the cue sheet — everything that depends on this song's
    notes but NOT on the (possibly shared) sample+instrument image. Returns a dict
    carrying the compressed pattern bin / cue sheet plus the song-table and sMet
    fields the container assemblers need.

    `slot_name` (slot → preset name) feeds the pattern-name (pNam) generator; when
    omitted, patterns fall back to preset-less names."""
    # Leading-silence trim: shift the grid so the first trigger is row 0.
    first_row = min(n.start_ft // speed for n in song.notes if n.slot > 0)
    shift_ft = first_row * speed
    if shift_ft:
        vprint(f"  info: trimming {first_row} leading silent row(s)")
        for n in song.notes:
            n.start_ft -= shift_ft
            n.end_ft   -= shift_ft
            if n.excl_cut_ft is not None:
                n.excl_cut_ft -= shift_ft

    eps_units = args.bend_epsilon * 4096.0 / 1200.0
    cells, n_voices, total_rows, bpm0, voice_part, voice_slot = emit_cells(
        song, None, speed, rpb, eps_units, args.drum_keyoff, shift_ft,
        args.max_voices)

    # --loop (whole song, no MIDI markers) bar-aligns its loop-end by DEFAULT:
    # extend the song to the next bar line so the loop seam stays on the beat grid
    # (and lands on a full cue → a clean cue-level JMP). --loop-at-eot opts out,
    # looping exactly at End-of-Track. The extension is silent padding past EoT;
    # MIDI loop markers are always honoured verbatim, never bar-rounded.
    if args.loop and song.loop_start_ft is None and not args.loop_at_eot:
        aligned = _bar_align_up(total_rows, song.timesig_ft, song.timesig,
                                shift_ft, speed, rpb)
        if aligned != total_rows:
            vprint(f"  loop: bar-aligning song end {total_rows} → {aligned} rows")
        total_rows = aligned

    # Cue layout: break at time-signature changes, pack into whole-bar cues.
    cue_starts, cue_lens, init_bar_rows = plan_cues(
        song.timesig_ft, song.timesig, total_rows, shift_ft, speed, rpb)
    n_cues = len(cue_starts)

    if n_cues > NUM_CUES:
        sys.exit(f"error: song needs {n_cues} cues > {NUM_CUES} limit "
                 f"(try a smaller --rpb)")
    if n_cues * n_voices > NUM_PATTERNS_MAX:
        sys.exit(f"error: {n_cues} cues × {n_voices} voices "
                 f"> {NUM_PATTERNS_MAX} pattern limit")

    pat_bin = build_pattern_bin(cells, n_voices, cue_starts, cue_lens)

    # The song length is anchored to End-of-Track (emit_cells), so when the MIDI
    # carries an EoT the last cue IS the EoT cue: keep the whole span (n_cues-1
    # floor) so the trailing-rest trim can't shorten it — dropped trailing notes
    # must stay as silence, not vanish, or the length would again depend on the
    # SoundFont. Without an EoT, fall back to the note-based trim; an explicit
    # loop-end marker still floors it at the cue holding the loop-end row (the
    # marker may sit in a trailing rest before EoT).
    keep_floor = 0
    if song.eot_ft is not None:
        keep_floor = n_cues - 1
    elif song.loop_end_ft is not None:
        end_row = max(0, (song.loop_end_ft - shift_ft) // speed - 1)
        for ci in range(n_cues):
            if cue_starts[ci] <= end_row < cue_starts[ci] + cue_lens[ci]:
                keep_floor = ci
                break

    # Trim trailing note-free cues: the MIDI release pass emits a final cue that
    # is just key-offs (and the silence after the song's last note), which shows
    # up as a dead bar at the end (e.g. M_E1M1's lone-key-off terminus cue). Drop
    # whole cues with no actual note; the new last cue then HALTs at its own
    # length. Special notes (key-off/cut/fade) are not notes here.
    last_cue = max(last_note_cue_index(pat_bin, n_cues, n_voices), keep_floor)
    if 0 <= last_cue < n_cues - 1:
        dropped = n_cues - 1 - last_cue
        n_cues = last_cue + 1
        cue_starts = cue_starts[:n_cues]
        cue_lens   = cue_lens[:n_cues]
        pat_bin    = pat_bin[:n_cues * n_voices * PATTERN_BYTES]
        vprint(f"  info: trimmed {dropped} trailing note-free cue(s)")

    # Looping. MIDI loop markers (loops/loope text, CC 110/111/116/117) ALWAYS
    # convert to a pattern jump; the --loop flag additionally loops a marker-less
    # MIDI start-to-end. Markers win when both are present.
    loop_jump = None
    song_end_row = cue_starts[-1] + cue_lens[-1]
    if song.loop_start_ft is not None:
        rs = (song.loop_start_ft - shift_ft) // speed
        re = (song.loop_end_ft   - shift_ft) // speed
        loop_src = "MIDI loop marker"
    elif args.loop:
        rs, re = 0, song_end_row
        loop_src = "--loop (whole song)"
    else:
        rs = re = None
    if rs is not None:
        rs = max(0, min(rs, song_end_row - 1))
        re = min(re, song_end_row)
        if re <= rs:
            vprint(f"  warning: {loop_src} loop region empty after clamping — not looping")
        else:
            pat_bin, cue_starts, cue_lens, loop_jump = _inject_loop(
                pat_bin, cue_starts, cue_lens, n_voices, rs, re)
            n_cues = len(cue_starts)
            how = "JMP cue jump" if loop_jump is not None else "in-pattern B jump"
            vprint(f"  loop: {loop_src} → rows [{rs}, {re}) via {how} "
                   f"({n_cues} cue(s) after loop trim)")

    n_pats = n_cues * n_voices
    if args.dedup_patterns:
        pat_bin, remap, n_unique = deduplicate_patterns(pat_bin, n_pats)
    else:
        # --no-dedup-patterns: keep one pattern per cue×voice cell, so no two
        # cues ever share a pattern and editing one leaves the others alone.
        remap, n_unique = {i: i for i in range(n_pats)}, n_pats
    # Reserve $0000 for silence (item 159) — the index every editor hands out
    # for a newly-added channel or cue.
    zero_note = []
    pat_bin, remap, n_unique = _empty_pattern_first(pat_bin, remap, n_unique, zero_note)
    # The cue-planning guard above counted cues BEFORE loop injection, which may
    # have split one; re-check now that the real pattern count is known.
    if n_unique > NUM_PATTERNS_MAX:
        sys.exit(f"error: song needs {n_unique} patterns > {NUM_PATTERNS_MAX} limit"
                 + ("" if args.dedup_patterns else " (drop --no-dedup-patterns)"))
    n_breaks = sum(1 for ft in song.timesig_ft
                   if 0 < (ft - shift_ft) // speed < total_rows)
    vprint(f"  patterns: {n_pats} → {n_unique} unique"
           + ("" if args.dedup_patterns else " (de-duplication off)")
           + (f", {zero_note[0]}" if zero_note else "")
           + f"; {n_cues} cue(s), {n_voices} voice(s), {total_rows} rows"
           + (f"; {n_breaks} time-signature break(s)" if n_breaks > 0 else ""))

    # ── Pattern names (pNam): "{track name} {bar}-{dup}" ──
    # allocate_voices lays columns out in per-part pools, so a column belongs to
    # one part and reads as a human-tracker label: the part's MIDI track name
    # (→ preset name → "Ch{n}"), the 1-based musical bar its cue starts on, and
    # the column's index among all columns sharing that display name (so a
    # polyphonic part's stacked columns stay distinct). Deduplicated patterns
    # take the name of their FIRST occurrence; fully-silent filler stays blank.
    def _voice_disp_name(v):
        ch = voice_part[v] if v < len(voice_part) else -1
        nm = song.track_names.get(ch) if (song.track_names and ch >= 0) else None
        if not nm and slot_name:
            nm = slot_name.get(voice_slot[v] if v < len(voice_slot) else 0)
        if not nm:
            nm = f"Ch{ch + 1}" if ch >= 0 else f"Voice{v + 1}"
        return nm.strip()
    disp_names = [_voice_disp_name(v) for v in range(n_voices)]
    voice_dup, dup_seen = [], {}
    for nm in disp_names:
        voice_dup.append(dup_seen.get(nm, 0))
        dup_seen[nm] = dup_seen.get(nm, 0) + 1
    empty_uidx = {u for u in range(n_unique) if _pattern_is_empty(pat_bin, u)}
    pattern_names = [''] * n_unique
    for ci in range(n_cues):
        bar = _bar_number_at(cue_starts[ci], song.timesig_ft, song.timesig,
                             shift_ft, speed, rpb)
        for v in range(n_voices):
            uidx = remap[ci * n_voices + v]
            if pattern_names[uidx] or uidx in empty_uidx:
                continue
            pattern_names[uidx] = f"{disp_names[v]} {bar}-{voice_dup[v]}"

    # 64-channel Taud mode kicks in only when the song ACTUALLY allocates 33+ voices
    # (which requires the user to raise --max-voices above 32). Cue width follows: 128
    # bytes / 64 channels vs the default 64 bytes / 32 channels (terranmon.txt §xHDR).
    is_64ch    = n_voices > NUM_VOICES
    cue_voices = MAX_VOICES if is_64ch else NUM_VOICES
    cue_size   = cue_voices * 2
    empty_cue  = EMPTY_CUE_64 if is_64ch else EMPTY_CUE
    if is_64ch:
        vprint(f"  64-channel mode: {n_voices} voices allocated (>32)")

    sheet = bytearray(empty_cue * n_cues)
    for ci in range(n_cues):
        pats = [remap[ci * n_voices + v] for v in range(n_voices)]
        if ci == n_cues - 1:
            # Loop back via a cue-level JMP when the loop is whole-cue clean; else
            # halt after this cue's own length (an in-pattern B jump, if any, fires
            # first, so the HALT is just the never-reached safety terminus).
            instr = loop_jump if loop_jump is not None \
                else cue_instruction_halt_at(cue_lens[ci])
        elif cue_lens[ci] < PATTERN_ROWS:
            instr = cue_instruction_len(cue_lens[ci])
        else:
            instr = CUE_INST_NOP
        sheet[ci*cue_size:(ci+1)*cue_size] = encode_cue(pats, instr, num_voices=cue_voices)

    # sMet beat divisions drive the tracker's row highlighting: primary = rows per
    # NOTATED beat (the time-sig denominator), secondary = rows per bar. Using the
    # denominator beat (not the rpb=rows-per-quarter) keeps the primary highlight a
    # divisor of the bar — e.g. 7/8 → 2 rows (eighth), bar 14: 14 % 2 == 0, aligned;
    # rpb=4 would drift (14 % 4 != 0). 4/4 → 4.
    i = bisect.bisect_right(song.timesig_ft, shift_ft) - 1
    _, init_dpow = song.timesig[i] if i >= 0 else (4, 2)
    beat_pri = max(1, round(rpb * 4 / (2 ** init_dpow)))
    title = song.title or os.path.splitext(os.path.basename(src_path))[0]

    cue_bytes, n_cues_stored = finalize_cue_sheet(sheet, num_voices=cue_voices)

    return {
        'pat_comp':  compress_blob(pat_bin,      "pattern bin"),
        'cue_comp':  compress_blob(cue_bytes,    "cue sheet"),
        'n_cues':    n_cues_stored,
        'n_voices':  n_voices,
        'is_64ch':   is_64ch,
        'n_unique':  n_unique,
        'bpm0':      bpm0,
        'speed':     speed,
        'title':     title,
        'beat_pri':  max(1, min(255, beat_pri)),
        'beat_sec':  max(1, min(255, init_bar_rows)),
        'pattern_names': pattern_names,
    }


def make_song_entry(section: dict, song_off: int, args) -> bytes:
    """32-byte song-table row from a build_song_section() result."""
    return encode_song_entry(
        song_offset=song_off,
        num_voices=section['n_voices'],
        num_patterns=section['n_unique'],
        bpm_stored=section['bpm0'] - 25,   # 9-bit; encode_song_entry packs bit 8 into byte-8 bit 7
        tick_rate=section['speed'],
        # Declare CONCERT pitch, not the tracker default. This converter pins
        # MIDI key 60 to noteVal 0x5000 (see _sample_from_zone: the rootkey
        # shift goes into the detune), and key 60 is concert middle C — so the
        # rendered song really is at A4 = 440. The tracker default (C9 @ 8363)
        # would declare A4 = 439.53 Hz, ~1.87 cents flat, which was harmless
        # only while players ignored the tuning fields. They no longer do, so a
        # mis-declaration is now audible: it would drag the whole song flat.
        # A4 @ 440 is also the exact-identity pair (440 is representable and
        # 440/2**0.75 is the reference C4 bit-for-bit), so this renders
        # byte-identically to the pre-tuning output.
        base_note=0x5C00,
        base_freq=440.0,
        flags_byte=0x00,                          # linear pitch mode
        pat_bin_comp_size=len(section['pat_comp']),
        cue_sheet_comp_size=len(section['cue_comp']),
        global_vol=0xFF,
        mixing_vol=args.mixing_vol,
        num_cues=section['n_cues'],
    )


def make_song_meta(section: dict, index: int) -> dict:
    """sMet entry (Project Data 's' block) from a build_song_section() result."""
    return {'index': index, 'name': section['title'],
            'notation': 240,    # 24-TET (MIDI is 12-TET but 24 is harmless & cleaner pre-pitchbend transpose notation); 0 = raw/hex display
            'beat_pri': section['beat_pri'],
            'beat_sec': section['beat_sec']}


def build_sampleinst_blob(sf: SF2, pool: list, layer_insts: list,
                          meta_records: list, bpm0: int, args) -> bytes:
    """Render + compress the sample+instrument image. MUST run before any
    to_ixmp_dict() call, as it assigns each MonoSample's pool offset."""
    sampleinst_raw = build_sample_inst_bin(sf, pool, layer_insts, meta_records,
                                           args.fadeout, bpm0,
                                           force_synth_loop=args.force_synth_loop)
    assert len(sampleinst_raw) == SAMPLEINST_SIZE
    return compress_blob(sampleinst_raw, "sample+inst bin")


def build_inst_names(slot_name: dict, pool: list) -> tuple:
    """(instrument_names, sample_names) for INam / SNam.

    INam is slot-indexed (entry 0 = the unused slot 0). SNam is pool-ordered
    and 0-based: pool sample i is named at SNam[i] (the reader dedupes records
    by (ptr,len), sorts by ptr, and matches that list to SNam positionally)."""
    max_slot = max([0] + list(slot_name))
    inst_names = ['' for _ in range(max_slot + 1)]
    for s, nm in slot_name.items():
        inst_names[s] = nm
    smp_names = [ms.name for ms in pool]
    return inst_names, smp_names


def build_ixmp(layer_insts: list, bpm0: int, args) -> dict:
    """The Ixmp section recreating SF2 layering (instrument-id → patch dicts).
    Reads each MonoSample's pool offset, so build_sampleinst_blob() must run first."""
    ixmp = {}
    for ti in layer_insts:
        if not ti.usable:
            continue
        # A standalone instrument keeps the canonical in its base record only (skipped here,
        # the engine falls back to base for an unmatched note). A META LAYER also emits its
        # canonical as a (thin, no-override) Ixmp patch so the engine's resolvePatch covers
        # the layer's FULL coverage — an unmatched note then resolves to null and the engine
        # keeps that layer silent instead of sounding its canonical (the spurious meta-layer
        # fallback, e.g. a closed hi-hat firing under the open hi-hat). The thin canonical
        # patch carries the same sample + rect and defers envelopes to the base, so a note
        # that DOES match the canonical plays identically.
        # A STEREO canonical must be emitted even for a standalone instrument:
        # the base record has no room for channel 2, so without a patch the note
        # would play the left channel alone (item 90).
        emitted = ti.patches if ti.is_meta_layer else \
                  [p for p in ti.patches
                   if p is not ti.canonical or (p.ms.stereo and p.ms.data_r)]
        pl = [p.to_ixmp_dict(ti.canonical, bpm0, args.fadeout) for p in emitted]
        if pl:
            ixmp[ti.slot] = pl
    if ixmp:
        vprint(f"  ixmp: {sum(len(p) for p in ixmp.values())} patch(es) "
               f"across {len(ixmp)} instrument(s)")
    return ixmp


def taud_header(kind: int, num_songs: int, comp_size: int,
                is_64channel: bool = False) -> bytes:
    """32-byte container header with projOff left at zero (patched by
    finish_container when project data is present). `kind` is one of the
    TAUD_KIND_* constants; the version byte is `kind | TAUD_VERSION`, plus the
    xHDR bit (0x20) in 64-channel mode (terranmon.txt §xHDR)."""
    version_byte = (kind & 0xC0) | TAUD_VERSION | (XHDR_FLAG if is_64channel else 0)
    header = (TAUD_MAGIC
              + bytes([version_byte, num_songs & 0xFF])
              + struct.pack('<I', comp_size)
              + struct.pack('<I', 0)              # projOff, patched in finish_container
              + (SIGNATURE + b' ' * 14)[:14])
    assert len(header) == TAUD_HEADER_SIZE
    return header


def finish_container(kind: int, num_songs: int, comp_size: int,
                     body_parts: list, proj_data: bytes,
                     is_64channel: bool = False) -> bytes:
    """Concatenate header + body parts + optional project data, patching projOff."""
    out = bytearray(taud_header(kind, num_songs, comp_size, is_64channel))
    for part in body_parts:
        out += part
    if proj_data:
        proj_off = len(out)
        struct.pack_into('<I', out, 14, proj_off)
        out += proj_data
        vprint(f"  project data: {len(proj_data)} bytes @ {proj_off}")
    return bytes(out)


def assemble_taud(sf: SF2, song: Song, layer_insts: list, meta_records: list,
                  slot_name: dict, pool: list, args) -> bytes:
    """Full single-song .taud file: sample+inst image + song table + patterns."""
    section = build_song_section(song, args.speed, args.rpb, args.input, args,
                                 slot_name)
    compressed = build_sampleinst_blob(sf, pool, layer_insts, meta_records,
                                       section['bpm0'], args)
    comp_size  = len(compressed)

    song_off = TAUD_HEADER_SIZE + comp_size + TAUD_SONG_ENTRY
    entry    = make_song_entry(section, song_off, args)
    is_64ch  = section['is_64ch']

    # ── Project data: names + Ixmp (I/S) + song metadata (s) + project name (P) ──
    # 64-channel mode REQUIRES an xHDR section, so emit project data (at least xHDR)
    # even under --no-project-data.
    proj_data = b''
    if not args.no_project_data:
        inst_names, smp_names = build_inst_names(slot_name, pool)
        ixmp = build_ixmp(layer_insts, section['bpm0'], args)
        proj_data = build_project_data(
            project_name=section['title'],
            instrument_names=inst_names,
            sample_names=smp_names,
            pattern_names=section.get('pattern_names'),
            song_metadata=[make_song_meta(section, 0)],
            ixmp_patches=ixmp or None,
            is_64channel=is_64ch,
        )
    elif is_64ch:
        proj_data = build_project_data(is_64channel=True)

    return finish_container(TAUD_KIND_FULL, 1, comp_size,
                            [compressed, entry, section['pat_comp'],
                             section['cue_comp']], proj_data, is_64channel=is_64ch)


def assemble_tsii(sf: SF2, pool: list, layer_insts: list, meta_records: list,
                  slot_name: dict, bpm0: int, args) -> bytes:
    """Sample and Instrument Image (.tsii): the shared sample+instrument bank for
    a collection of .tpif pattern files (terranmon.txt:3342). numSongs = 0, no
    song table / patterns; project data carries only the I/S blocks
    (INam, SNam, Ixmp)."""
    compressed = build_sampleinst_blob(sf, pool, layer_insts, meta_records,
                                       bpm0, args)
    proj_data = b''
    if not args.no_project_data:
        inst_names, smp_names = build_inst_names(slot_name, pool)
        ixmp = build_ixmp(layer_insts, bpm0, args)
        proj_data = build_project_data(
            instrument_names=inst_names,
            sample_names=smp_names,
            ixmp_patches=ixmp or None,
        )
    return finish_container(TAUD_KIND_SAMPLEINST, 0, len(compressed),
                            [compressed], proj_data)


def assemble_tpif(sections: list, args) -> bytes:
    """Pattern Image (.tpif): song table + patterns only, sharing the instruments
    of a separately-loaded .tsii (terranmon.txt:3368). Sample+inst compSize = 0
    (section absent); project data carries only the p/s blocks (sMet here, no
    pattern names). `sections` is a list of build_song_section() results — one
    per song in the file."""
    n = len(sections)
    table = bytearray()
    blobs = bytearray()
    # Pattern/cue data follows the whole song table; each entry points at its blob.
    cursor = TAUD_HEADER_SIZE + n * TAUD_SONG_ENTRY
    for sec in sections:
        table += make_song_entry(sec, cursor, args)
        blobs += sec['pat_comp']
        blobs += sec['cue_comp']
        cursor += len(sec['pat_comp']) + len(sec['cue_comp'])

    # A .tpif is always built from a single section (directory mode → one per MIDI),
    # so its channel mode is that section's. `any` guards the general case; mixed-mode
    # sections in one file are not produced (their cue widths would already disagree).
    is_64ch = any(sec.get('is_64ch') for sec in sections)

    proj_data = b''
    if not args.no_project_data:
        metas = [make_song_meta(sec, i) for i, sec in enumerate(sections)]
        # pNam is a single project-wide table; it maps cleanly only for a
        # one-song file (directory mode builds one .tpif per MIDI), so emit
        # pattern names only then. Multi-song .tpif files omit them.
        pat_names = sections[0].get('pattern_names') if len(sections) == 1 else None
        proj_data = build_project_data(song_metadata=metas,
                                       pattern_names=pat_names,
                                       is_64channel=is_64ch)
    elif is_64ch:
        proj_data = build_project_data(is_64channel=True)

    return finish_container(TAUD_KIND_PATTERN, n, 0,
                            [bytes(table), bytes(blobs)], proj_data, is_64channel=is_64ch)


# ── Main ──────────────────────────────────────────────────────────────────────

def _realign_target(text: str):
    """--realign-tempo VALUE: 'auto', or the real tempo in BPM."""
    t = text.strip().lower()
    if t == 'auto':
        return t
    try:
        v = float(t)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"expected auto or a tempo in BPM, got {text!r}")
    if not (_REALIGN_BPM_LO / 2.0 <= v <= _REALIGN_BPM_HI * 2.0):
        raise argparse.ArgumentTypeError(
            f"tempo must be {_REALIGN_BPM_LO / 2.0:g}..{_REALIGN_BPM_HI * 2.0:g} BPM, got {v:g}")
    return v


def _quantise_grid(text: str):
    """--quantise GRID: 'auto', 'row', or a beat subdivision from QUANTISE_GRIDS."""
    t = text.strip().lower()
    if t in ('auto', 'row'):
        return t
    try:
        v = int(t)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"expected auto, row or one of {QUANTISE_GRIDS}, got {text!r}")
    if v not in QUANTISE_GRIDS:
        raise argparse.ArgumentTypeError(
            f"grid must be one of {QUANTISE_GRIDS} (or auto / row), got {v}")
    return v


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',     help='Input .mid file, OR a directory of MIDIs '
                                      '(batch mode → shared .tsii + per-file .tpif)')
    ap.add_argument('soundfont', help='SoundFont 2 (.sf2) sample library')
    ap.add_argument('output', nargs='?', default=None,
                    help='Output .taud (default: input stem + .taud). In directory '
                         'mode: output directory (default: the input directory)')
    ap.add_argument('--perc-force-mapping', nargs=2, type=int, default=None,
                    metavar=('BANK', 'INST'),
                    help='Force the percussion channel to this SF2 preset '
                         '(default: bank 128, channel program)')
    ap.add_argument('--rpb', type=int, default=None, choices=(2, 4, 8, 16, 32, 64),
                    help='Rows per beat (default: auto from time signatures + '
                         'onset analysis). Passing a value pins this axis and '
                         'auto-fits --speed')
    ap.add_argument('--speed', type=int, default=None,
                    help='Ticks per row, 1..15 (default: auto, see --rpb). '
                         'Passing a value pins this axis and auto-fits --rpb')
    ap.add_argument('--fadeout', type=int, default=None,
                    help='Override the computed fadeout step (0..4095). By '
                         'default each instrument/patch gets a Volume Fadeout '
                         'reproducing its SF2 release segment (the full '
                         'releaseVolEnv), played out via NNA Note Fade')
    ap.add_argument('--max-voices', type=int, default=32,
                    help='Voice-column budget, 1..64 (default 32). NNA '
                         'background ghosts carry release/ring tails, so '
                         'few foreground voices are needed; songs exceeding '
                         'the budget release the oldest pedal-held or '
                         'soonest-ending note early. Setting >32 opts in to '
                         '64-channel Taud mode, but only takes effect when the '
                         'song ACTUALLY allocates 33+ voices')
    ap.add_argument('--max-layers', type=int, default=25,
                    help='Max simultaneous layers per note (default 25). Each SF2 '
                         'preset is split into this many disjoint layers; presets '
                         'needing >1 layer become a Metainstrument. 1 disables '
                         'layering (first-zone-wins, like the old behaviour). '
                         'Covers ~93%% of big-bank presets at 4, ~98%% at 5')
    ap.add_argument('--trim-unused-patches', action='store_true',
                    help='Keep only the Ixmp patches this song actually triggers, '
                         'dropping the rest of each preset\'s zone map (and the '
                         'samples only they used). OFF by default: the bank carries '
                         'the full zone map, so the instruments stay playable across '
                         'the whole keyboard after import and the editor decides what '
                         'to remove (Housekeeping > Cleanup instrument patches). Turn '
                         'it on for the smallest possible file, or when the untrimmed '
                         'pool overflows the 8 MB budget (which resamples EVERY sample '
                         'down, costing quality song-wide)')
    ap.add_argument('--bend-epsilon', type=float, default=4.0,
                    help='Pitch-bend simplification threshold in cents '
                         '(default 4.0); smaller = more faithful')
    ap.add_argument('--mixingvol', type=int, default=180, dest='mixing_vol',
                    metavar='0..255',
                    help='Song Mixingvol, 0..255 (default 180). Headroom for '
                         'the summed polyphony before the final mix clips')
    ap.add_argument('--drum-keyoff', action='store_true',
                    help='Emit KEY_OFF for percussion-channel notes too '
                         '(GM drums normally ignore note-off)')
    ap.add_argument('--loop', action='store_true',
                    help='Loop a non-looping MIDI start-to-end (replace the final '
                         'HALT with a jump back to the first cue). The loop-end is '
                         'rounded up to the next BAR LINE by default so the loop '
                         'seam stays on the beat (use --loop-at-eot to loop exactly '
                         'at End-of-Track instead). MIDIs that carry their own loop '
                         'markers (loops/loope text, or CC 110/111/116/117) are '
                         'ALWAYS looped at those points regardless of this flag')
    ap.add_argument('--loop-at-eot', action='store_true',
                    help='With --loop: loop precisely at End-of-Track instead of '
                         'rounding the loop-end up to a full bar (no effect without '
                         '--loop, or when the MIDI has its own loop markers)')
    ap.add_argument('--no-dedup-patterns', action='store_false',
                    dest='dedup_patterns', default=True,
                    help='Give every cue x voice cell its own pattern instead of '
                         'pooling byte-identical ones. By default a repeated bar '
                         '(and every silent column) is stored once and referenced '
                         'from each cue that uses it, which means editing one '
                         'occurrence in a tracker changes ALL of them. Pass this '
                         'flag when the import is a starting point for editing: '
                         'every cue becomes independent, at the cost of a bigger '
                         'pattern count (still capped at the 32767 limit)')
    ap.add_argument('--no-force-synth-loop', action='store_false',
                    dest='force_synth_loop', default=True,
                    help='Disable the default synth-loop behaviour. By default, '
                         'looped samples whose loop sits past the 65535-frame '
                         'cap even at 32 kHz (multi-second far-loop instruments, '
                         'e.g. Timbres of Heaven) have their real loop replaced '
                         'with a synthesized one at 32 kHz + a 10 s decay, instead '
                         'of muffling the whole sample down to fit — trading the '
                         'genuine sustain loop for full bandwidth. Pass this flag '
                         'to keep the genuine loop (and accept the muffling)')
    ap.add_argument('--stereo-samples', action='store_true',
                    help='Keep SF2 stereo sample pairs as genuine STEREO samples '
                         '(two pool spans joined by an Ixmp stereo patch) instead '
                         'of mixing them down to mono. Doubles the pool cost of '
                         'every stereo instrument, so a large bank may end up '
                         'resampled harder to fit the 8 MB budget')
    ap.add_argument('--realign-tempo', '--realign', nargs='?', const='auto',
                    default=None, type=_realign_target, metavar='BPM',
                    dest='realign_tempo',
                    help='Rewrite the timeline onto the grid of the tempo the '
                         'music is REALLY written in, for a MIDI whose declared '
                         'tempo does not describe its events (a beat that is 1.2 '
                         'or 1.35 quarter notes long, so nothing lines up with a '
                         'bar). Every tick and every tempo is scaled by the same '
                         'factor, which keeps the performance identical in real '
                         'time and makes the music\'s own beat one quarter note. '
                         'Give the real tempo in BPM if you know it; bare '
                         '--realign-tempo (or auto) infers it from the note '
                         'onsets and says what it chose. OFF by default. Nothing '
                         'is snapped to the new grid — add --quantise for that. '
                         'Auto leaves the file alone when the beat already is the '
                         'quarter note, or when the onsets sit on no grid at all')
    ap.add_argument('--quantise', '--quantize', nargs='?', const='auto',
                    default=None, type=_quantise_grid, metavar='GRID',
                    help='Snap notes onto a beat grid, both ends (OFF by default). '
                         'GRID is auto (the subdivision the onsets already use), '
                         'row (the Taud row grid), or one of '
                         + '/'.join(str(g) for g in QUANTISE_GRIDS)
                         + ' as a beat subdivision; bare --quantise means auto. '
                           'WARNING: this erases deliberate off-grid timing — '
                           'swing, flams, grace notes, humanised phrasing — '
                           'along with the mistakes. Onsets AND key-offs are '
                           'snapped, so a note lasts a whole number of grid '
                           'steps; anything shorter than half a step stays as '
                           'short as the grid can hold it')
    ap.add_argument('--quantise-strength', '--quantize-strength', type=int,
                    default=100, metavar='PCT', dest='quantise_strength',
                    help='How far --quantise moves each onset towards the grid, '
                         '0..100 (default 100 = onto it). Lower values tighten '
                         'sloppy timing while leaving a deliberate push or drag '
                         'audible')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the Project Data section — NOTE: this also '
                         'omits Ixmp, collapsing every instrument to its '
                         'canonical sample')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()
    set_verbose(args.verbose)

    if args.speed is not None and not (1 <= args.speed <= 15):
        sys.exit("error: --speed must be 1..15")
    if not (1 <= args.max_voices <= MAX_VOICES):
        sys.exit("error: --max-voices must be 1..64")
    if not (1 <= args.max_layers <= 25):
        sys.exit("error: --max-layers must be 1..25")
    if not (0 <= args.mixing_vol <= 255):
        sys.exit("error: --mixingvol must be 0..255")
    if not (0 <= args.quantise_strength <= 100):
        sys.exit("error: --quantise-strength must be 0..100")

    # Not vprint: quantisation is the one option here that rewrites the
    # performance rather than the encoding of it, and somebody who passed it
    # without -v still has to be told what it costs.
    if args.quantise is not None:
        print("warning: --quantise snaps notes onto the beat grid, both ends. "
              "Deliberate off-grid timing — swing, flams, grace notes, "
              "humanised phrasing — is erased along with the mistakes. "
              "Lower --quantise-strength to tighten the timing without "
              "flattening it.", file=sys.stderr)

    if os.path.isdir(args.input):
        run_directory(args)
    else:
        run_single(args)


# ── Pipeline helpers (shared by single-file and directory modes) ───────────────

def load_sf2_verbose(path: str) -> SF2:
    vprint(f"parsing SF2 '{path}'…")
    sf = parse_sf2(path)
    vprint(f"  {len(sf.presets)} preset(s), {len(sf.shdrs)} sample header(s)")
    return sf


def load_midi_song(path: str, sf: SF2, args):
    """Parse one MIDI into a Song with its resolved Taud grid, then apply SF2
    exclusive-class percussion choking. Returns (song, rpb, speed), or None when
    the MIDI carries no playable notes."""
    vprint(f"parsing MIDI '{path}'…")
    division, merged, channel_names = parse_midi(path)

    # Tempo realignment — opt-in, and FIRST: it rewrites the tick timeline the
    # rest of this function measures, so auto_timing's subdivision analysis and
    # every tempo below must see the corrected grid rather than the declared one.
    if args.realign_tempo is not None:
        merged = realign_tempo(division, merged, args.realign_tempo)

    # Resolve the Taud grid (Tickspeed + RPB) before mapping ticks to fine-ticks.
    # A pinned --rpb/--speed fixes that axis; the rest is auto-fit.
    rpb, speed, timing_info = auto_timing(
        division, merged, args.rpb, args.speed, args.max_voices)
    vprint(f"  timing: rpb {rpb}, speed {speed} ({timing_info})")

    song = extract_song(division, merged, rpb, speed)
    song.track_names = channel_names
    vprint(f"  {len(song.notes)} note(s), {len(song.tempo_ft)} tempo event(s), "
           f"{len(song.timesig_ft)} time-signature event(s)")
    if not song.notes:
        return None

    # Timing quantisation (item 168) — opt-in, and deliberately AFTER the grid
    # has been chosen: auto_timing reads the RAW onsets, so the subdivision it
    # detects is the one the performance is aiming at rather than one this pass
    # has already imposed.
    if args.quantise is not None:
        denom = resolve_quantise_grid(args.quantise, division, merged, rpb)
        strength = max(0, min(100, args.quantise_strength)) / 100.0
        moved, worst, mean, trimmed, collapsed = quantise_notes(
            song, rpb, speed, denom, strength)
        vprint(f"  quantise: 1/{denom} of a beat at {round(strength * 100)}% — "
               f"{moved}/{2 * len(song.notes)} note end(s) moved, mean {mean:.1f} / "
               f"max {worst} fine-tick(s)")
        if trimmed or collapsed:
            vprint(f"  quantise: {trimmed} accidental overlap(s) trimmed, "
                   f"{collapsed} note(s) collapsed onto another strike of the "
                   f"same key")

    # SF2 exclusiveClass percussion choking (closed hi-hat silences open hi-hat, etc.).
    apply_exclusive_class(song, sf, args.perc_force_mapping)
    return song, rpb, speed


def collect_triggers(song: Song, slot_keys: list, seen_keys: set,
                     triggers: dict) -> None:
    """Append this song's presets (first-use order) to slot_keys and merge its
    trigger (noteVal-with-initial-bend, vol6) histogram into `triggers`. The keys
    match exactly what the patterns will carry, so layer trimming sees precisely
    what the engine matches at runtime."""
    for n in song.notes:
        if n.inst_key not in seen_keys:
            seen_keys.add(n.inst_key)
            slot_keys.append(n.inst_key)
        t = triggers.setdefault(n.inst_key, {})
        k = (key_to_noteval(n.key + n.bend0), round(n.vel * 63 / 127))
        t[k] = t.get(k, 0) + 1


def allocate_slots(presets: dict, slot_keys: list):
    """Assign instrument-bin slots across `slot_keys`.

    Two bins (terranmon.txt:2036-2044): the directly-addressable bin $01..$FF (255
    slots) holds everything a pattern cell references — single-layer presets and the
    Metainstrument slot of a multi-layer preset; the auxiliary bin $100..$3FF (768
    slots, exposed in-hardware through a 3-way banked window) holds the layer
    SUBINSTRUMENTS of multi-layer presets, which are reachable only through their
    Metainstrument's layer table (never a pattern cell). So a meta at e.g. $01 with 10
    layers puts those layers at $100..$109 and the meta at $01. Metainstruments
    themselves are NEVER allocated in the aux bin.

    Returns (layer_insts, meta_records, slot_name, note_slot)."""
    next_norm   = 1          # directly-addressable bin $01..$FF
    next_aux    = 0x100      # auxiliary bin $100..$3FF (layer subinstruments)
    layer_insts = []         # all normal instruments, .slot assigned
    meta_records = []        # (meta_slot, name, [(layer_slot, bbox_rect)])
    slot_name   = {}         # slot → display name
    note_slot   = {}         # inst_key → slot a note triggers (0 = unplayable)
    for ik in slot_keys:
        name, layers = presets[ik]
        if not layers:
            note_slot[ik] = 0
            continue
        if len(layers) == 1:
            # Single layer: a plain instrument the pattern references directly.
            if next_norm > 255:
                vprint(f"  warning: $01..$FF budget exhausted — preset '{name}' dropped")
                note_slot[ik] = 0
                continue
            ti = layers[0]
            ti.slot = next_norm; next_norm += 1
            ti.is_meta_layer = False
            layer_insts.append(ti)
            slot_name[ti.slot] = name
            note_slot[ik] = ti.slot
        else:
            # Multi-layer: the Metainstrument goes in the directly-addressable bin;
            # its layer subinstruments go in the auxiliary bin.
            if next_norm > 255 or next_aux + len(layers) - 1 > 0x3FF:
                vprint(f"  warning: instrument budget exhausted — preset '{name}' dropped")
                note_slot[ik] = 0
                continue
            meta_slot = next_norm; next_norm += 1
            for li, ti in enumerate(layers):
                ti.slot = next_aux; next_aux += 1
                ti.is_meta_layer = True     # emit canonical into Ixmp too (strict layering)
                layer_insts.append(ti)
                slot_name[ti.slot] = f"{name} L{li}"
            meta_records.append((meta_slot, name,
                                 [(ti.slot, _layer_bbox(ti)) for ti in layers]))
            slot_name[meta_slot] = name
            note_slot[ik] = meta_slot
    vprint(f"  slots: {next_norm - 1} in $01..$FF, {next_aux - 0x100} in aux $100..$3FF — "
           f"{len(layer_insts)} instrument(s), {len(meta_records)} Metainstrument(s)")
    return layer_insts, meta_records, slot_name, note_slot


def tag_notes(song: Song, note_slot: dict) -> bool:
    """Tag each note with its trigger slot and drop the unresolvable ones. Returns
    True when the song keeps at least one note."""
    unplayable = 0
    for n in song.notes:
        n.slot = note_slot.get(n.inst_key, 0)
        if n.slot == 0:
            unplayable += 1
    if unplayable:
        vprint(f"  warning: {unplayable} note(s) dropped (unresolvable preset)")
    song.notes = [n for n in song.notes if n.slot > 0]
    return bool(song.notes)


def build_pool(layer_insts: list) -> list:
    """Pool = every sample referenced by a kept patch (canonical included), in
    deterministic first-reference order. Everything else is trimmed."""
    pool = []
    seen = set()
    for ti in layer_insts:
        for p in ti.patches:
            if id(p.ms) not in seen:
                seen.add(id(p.ms))
                pool.append(p.ms)
    return pool


def find_midi_files(dir_path: str) -> list:
    """Top-level .mid / .midi files in `dir_path`, sorted for deterministic order."""
    out = []
    for name in sorted(os.listdir(dir_path)):
        full = os.path.join(dir_path, name)
        if (os.path.isfile(full)
                and os.path.splitext(name)[1].lower() in ('.mid', '.midi')):
            out.append(full)
    return out


# ── Conversion entry points ────────────────────────────────────────────────────

def run_single(args) -> None:
    """Single MIDI → one self-contained .taud."""
    if args.output is None:
        args.output = os.path.splitext(args.input)[0] + '.taud'

    sf = load_sf2_verbose(args.soundfont)
    loaded = load_midi_song(args.input, sf, args)
    if loaded is None:
        sys.exit("error: MIDI contains no playable notes")
    song, args.rpb, args.speed = loaded

    slot_keys, seen_keys, triggers = [], set(), {}
    collect_triggers(song, slot_keys, seen_keys, triggers)
    vprint(f"  {len(slot_keys)} preset(s) in use")

    registry = {}
    presets = build_presets(sf, slot_keys, triggers, args.perc_force_mapping,
                            registry, args.max_layers, args.trim_unused_patches,
                            getattr(args, 'stereo_samples', False))
    layer_insts, meta_records, slot_name, note_slot = allocate_slots(
        presets, slot_keys)

    if not tag_notes(song, note_slot):
        sys.exit("error: no notes survived preset resolution")
    pool = build_pool(layer_insts)

    taud = assemble_taud(sf, song, layer_insts, meta_records, slot_name, pool, args)
    sf.file.close()

    with open(args.output, 'wb') as f:
        f.write(taud)
    print(f"wrote {len(taud)} bytes to '{args.output}'")


def run_directory(args) -> None:
    """Directory of MIDIs → one shared .tsii (sample+instrument bank spanning the
    union of every song) + one .tpif per MIDI (patterns only). terranmon.txt:3342."""
    out_dir = args.output or args.input
    midis = find_midi_files(args.input)
    if not midis:
        sys.exit(f"error: no .mid/.midi files in directory '{args.input}'")
    os.makedirs(out_dir, exist_ok=True)
    vprint(f"directory mode: {len(midis)} MIDI file(s) → shared .tsii + per-file .tpif")

    sf = load_sf2_verbose(args.soundfont)

    # Phase 1: parse every MIDI, aggregating the preset/trigger universe so the
    # shared instrument bank covers the union of all songs.
    jobs = []     # (path, song, rpb, speed) for files with playable notes
    slot_keys, seen_keys, triggers = [], set(), {}
    for path in midis:
        loaded = load_midi_song(path, sf, args)
        if loaded is None:
            vprint(f"  warning: '{os.path.basename(path)}' has no playable notes — skipped")
            continue
        song, rpb, speed = loaded
        collect_triggers(song, slot_keys, seen_keys, triggers)
        jobs.append((path, song, rpb, speed))
    if not jobs:
        sys.exit("error: no MIDI file produced playable notes")
    vprint(f"  {len(slot_keys)} preset(s) across {len(jobs)} song(s)")

    # Phase 2: build the one shared instrument set for the whole union.
    registry = {}
    presets = build_presets(sf, slot_keys, triggers, args.perc_force_mapping,
                            registry, args.max_layers, args.trim_unused_patches,
                            getattr(args, 'stereo_samples', False))
    layer_insts, meta_records, slot_name, note_slot = allocate_slots(
        presets, slot_keys)

    # Phase 3: per song — tag notes against the shared slots, build the pattern
    # section, and write its .tpif. (Independent of the sample+inst image below.)
    sections = []
    for path, song, rpb, speed in jobs:
        stem = os.path.splitext(os.path.basename(path))[0]
        vprint(f"building '{stem}'…")
        if not tag_notes(song, note_slot):
            vprint(f"  warning: '{stem}' lost all notes to preset resolution — skipped")
            continue
        section = build_song_section(song, speed, rpb, path, args, slot_name)
        tpif = assemble_tpif([section], args)
        out_path = os.path.join(out_dir, stem + '.tpif')
        with open(out_path, 'wb') as f:
            f.write(tpif)
        print(f"wrote {len(tpif)} bytes to '{out_path}'")
        sections.append(section)
    if not sections:
        sys.exit("error: no song survived preset resolution")

    # Phase 4: the shared .tsii. Its fadeouts encode SF2 release times in seconds,
    # but the engine fades per song-tick (rate ∝ BPM), so one image matches only one
    # tempo exactly — target the mean of the songs' initial BPMs (override per-step
    # with --fadeout). build_pool / build_sampleinst_blob run last because they
    # assign the sample offsets the .tsii's Ixmp reads.
    pool = build_pool(layer_insts)
    ref_bpm0 = round(sum(s['bpm0'] for s in sections) / len(sections))
    vprint(f"building shared .tsii (reference BPM {ref_bpm0})…")
    tsii = assemble_tsii(sf, pool, layer_insts, meta_records, slot_name,
                         ref_bpm0, args)
    sf.file.close()

    sf_stem = os.path.splitext(os.path.basename(args.soundfont))[0]
    tsii_path = os.path.join(out_dir, sf_stem + '.tsii')
    with open(tsii_path, 'wb') as f:
        f.write(tsii)
    print(f"wrote {len(tsii)} bytes to '{tsii_path}'")


if __name__ == '__main__':
    main()
