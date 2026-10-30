#!/usr/bin/env python3
"""sf2taudify.py — build a Taud-conformant custom SF2 from any SoundFont.

Rewrites a .sf2 so that every sample is already in the shape the canonical
midi2taud/sf2bank pipeline (vendor/converters/midi2taud.py,
build_sample_inst_bin) would reduce it to, so converting the output soundfont
never takes a lossy per-sample rescue path — and the file is small enough to
bundle (the raw 16-bit result plus gzip lands well under the 25 MiB
Cloudflare Pages per-file limit):

  1. 32 kHz floor        — samples above SF2_RESAMPLE_FLOOR_HZ (the TSVM
                           native rate) are resampled down with the same
                           Kaiser-windowed polyphase sinc as the converters
                           (taud_common.resample_bandlimited, beta 8.0).
  2. 65535-frame cap     — a sample still over SAMPLE_LEN_LIMIT is truncated;
                           a loop that no longer fits is replaced by a
                           seam-matched synthesized sustain loop near the end
                           (midi2taud _synth_sustain_loop, "forced synth
                           loop" = the --force-synth-loop treatment), and an
                           originally UN-looped sample additionally gets a
                           10 s decay-to-silence volume envelope baked into
                           its zones (the _synth_decay_vol_env equivalent:
                           decayVolEnv 10 s, sustainVolEnv 100 dB) plus
                           sampleModes = 1.
  3. tail trim           — mode-1-only loops lose their never-played
                           post-loop tail; unlooped tails are cut where they
                           stay below the taud 8-bit floor (|s16| < 256
                           quantises to ±1 LSB around the u8 bias).
  4. top-byte quantise   — the taud pipeline keeps only (s16 >> 8) + 128, so
                           samples are stored as (round(s16/256) << 8): the
                           converter output is exactly round(s16/256) + 128
                           and the gzipped file shrinks by ~2/3.

Zone bookkeeping: instrument-level address-offset generators are rescaled by
each sample's exact resample ratio (coarse+fine re-split as needed, global
zones folded down); a start-offset zone whose slice would be eaten by the cap
is split onto its own new sample record so it keeps the full slice it has
today (e.g. the GeneralUser Birds offset zone).

Stereo: the samples the converter plays as a stereo pair — sampleLinked L/R
samples, and mono samples whose zones are hard-panned to opposite sides —
are transformed together, so they leave with one rate, one length and one
loop (the converter plays both spans with a single length and loop, mixed to
mono or, with --stereo, as a real stereo sample). A synthesized loop is
seam-matched on both sides at once; a split pair's clones stay linked.

Usage:
  python3 sf2taudify.py INPUT.sf2 [-o OUT.taud.sf2] [--no-gz] [--keep-16bit]
                        [--tail-thresh N] [--progress] [-v]

Output defaults to <input stem>.taud.sf2 plus a deterministic (mtime 0)
gzip alongside (.gz) — the .gz is what the web app fetches. Requires numpy.
--progress prints "progress F" lines (F from 0 to 1) for a host to show; the
app's soundfont manager runs this script under Pyodide and reads them.
"""

import argparse
import gzip
import math
import os
import struct
import sys

try:
    import numpy as np
except ImportError:
    sys.exit("error: sf2taudify.py needs numpy (pip install numpy)")

# Format constants — fixed by the TSVM Taud engine / converter pipeline
# (taud_common.py SAMPLE_LEN_LIMIT, midi2taud.py SF2_* block).
RATE_FLOOR   = 32000       # TSVM native audio rate
CAP          = 65535       # per-sample u16 frame cap
LOOP_PAD     = 8           # frames kept past loop_end (interpolator guard)
TAIL_THRESH  = 256         # |s16| below this quantises to ±1 u8 LSB
SMPL_PAD     = 46          # spec-required zero frames between samples
DECAY_TC     = 3986        # timecents ≈ 10 s (SF2_SYNTH_DECAY_SEC) full-scale decay
DECAY_SUS_CB = 1000        # sustainVolEnv 100 dB -> terminal-0 taud env node

# _synth_sustain_loop tunables (midi2taud.py, kept in lockstep).
LOOP_HINT        = 8192    # max loop period searched
LOOP_MIN_PERIOD  = 512
LOOP_MATCH_WIN   = 256
LOOP_MATCH_STEP  = 2
LOOP_COARSE_STEP = 32

# Kaiser-sinc resampler tunables (taud_common.resample_bandlimited).
KAISER_BETA = 8.0
PHASES      = 512

# SF2 generator ids.
G_START_OFF, G_END_OFF, G_STARTLOOP_OFF, G_ENDLOOP_OFF = 0, 1, 2, 3
G_START_COARSE, G_END_COARSE = 4, 12
G_STARTLOOP_COARSE, G_ENDLOOP_COARSE = 45, 50
G_DECAY_VOLENV, G_SUSTAIN_VOLENV = 36, 37
G_INSTRUMENT, G_SAMPLEID, G_SAMPLEMODES = 41, 53, 54
G_PAN, G_KEYRANGE, G_VELRANGE, G_ROOTKEY = 17, 43, 44, 58
FULL_RANGE = 0x7F00                  # keyRange/velRange default: lo 0, hi 127
ADDR_GENS = (G_START_OFF, G_START_COARSE, G_END_OFF, G_END_COARSE,
             G_STARTLOOP_OFF, G_STARTLOOP_COARSE,
             G_ENDLOOP_OFF, G_ENDLOOP_COARSE)

VERBOSE = False


def vprint(*a):
    if VERBOSE:
        print(*a)


# ---------------------------------------------------------------- RIFF parse

def parse_riff(data):
    """-> (info_items ordered [(id, bytes)], smpl (off, size), pdta ordered
    [(id, bytes)]). sm24 is dropped (meaningless after quantisation)."""
    if data[:4] != b'RIFF' or data[8:12] != b'sfbk':
        sys.exit("error: not an SF2 file (bad RIFF/sfbk magic)")
    riff_end = 8 + struct.unpack_from('<I', data, 4)[0]
    info, pdta = [], []
    smpl = None
    pos = 12
    while pos + 8 <= riff_end:
        cid = data[pos:pos+4]
        sz = struct.unpack_from('<I', data, pos+4)[0]
        if cid == b'LIST':
            ltype = data[pos+8:pos+12]
            inner, inner_end = pos + 12, pos + 8 + sz
            while inner + 8 <= inner_end:
                scid = data[inner:inner+4]
                ssz = struct.unpack_from('<I', data, inner+4)[0]
                if ltype == b'INFO':
                    info.append((scid, data[inner+8:inner+8+ssz]))
                elif ltype == b'sdta':
                    if scid == b'smpl':
                        smpl = (inner + 8, ssz)
                    elif scid == b'sm24':
                        print("note: dropping sm24 (24-bit extension)")
                elif ltype == b'pdta':
                    pdta.append((scid, data[inner+8:inner+8+ssz]))
                inner += 8 + ssz + (ssz & 1)
        pos += 8 + sz + (sz & 1)
    if smpl is None:
        sys.exit("error: SF2 has no smpl chunk")
    return info, smpl, pdta


class Sample:
    __slots__ = ('name', 'start', 'end', 'ls', 'le', 'rate', 'origkey',
                 'corr', 'link', 'stype',
                 # census / transform state
                 'modes', 'data', 'q', 'new_rate', 'nls', 'nle',
                 'synth', 'decay', 'new_start', 'zone_loops')

    def __init__(self, rec):
        self.name = rec[:20].split(b'\x00')[0]
        (self.start, self.end, self.ls, self.le, self.rate) = \
            struct.unpack_from('<IIIII', rec, 20)
        self.origkey = rec[40]
        self.corr = struct.unpack_from('b', rec, 41)[0]
        self.link, self.stype = struct.unpack_from('<HH', rec, 42)
        if self.rate == 0:
            self.rate = 8363
        self.modes = set()
        self.zone_loops = set()     # (start, end) relative frames of every looped zone
        self.data = None            # np.int16 (transformed)
        self.q = 1.0                # exact resample ratio (n_out / n_in)
        self.new_rate = self.rate
        self.nls = self.nle = 0     # transformed loop, relative frames
        self.synth = False          # loop replaced by a synthesized one
        self.decay = False          # zones need the baked 10 s decay ADSR
        self.new_start = 0

    @property
    def frames(self):
        return max(0, self.end - self.start)


def parse_bag_zones(bag_data, gen_data, b0, b1):
    """-> list over bags [ordered [(op, amt)]], plus per-bag modNdx list.
    The FIRST bag without a terminal sampleID gen is the global zone."""
    zones, mods = [], []
    for bi in range(b0, b1):
        g0 = struct.unpack_from('<H', bag_data, bi*4)[0]
        g1 = struct.unpack_from('<H', bag_data, (bi+1)*4)[0]
        m0 = struct.unpack_from('<H', bag_data, bi*4+2)[0]
        zones.append([struct.unpack_from('<Hh', gen_data, gi*4)
                      for gi in range(g0, g1)])
        mods.append(m0)
    return zones, mods


# ------------------------------------------------------------- DSP helpers

def kaiser_sinc_table(cutoff, half_width):
    """Polyphase Kaiser-sinc kernel, DC-normalised per phase — the numpy
    twin of taud_common._windowed_sinc_table."""
    n_taps = 2 * half_width
    k = np.arange(n_taps)[None, :] - (half_width - 1)
    frac = (np.arange(PHASES) / PHASES)[:, None]
    x = k - frac
    a = 2.0 * cutoff * x
    table = 2.0 * cutoff * np.sinc(a)
    r = np.clip(x / half_width, -1.0, 1.0)
    table *= np.i0(KAISER_BETA * np.sqrt(1.0 - r * r)) / np.i0(KAISER_BETA)
    table /= table.sum(axis=1, keepdims=True)   # unity DC gain
    return table


def resample_sinc(data, ratio):
    """Band-limited resample of a float array by `ratio` (< 1 = down), same
    design as taud_common.resample_bandlimited (edge-clamped, phase table)."""
    n_in = len(data)
    n_out = max(1, int(n_in * ratio))
    if ratio == 1.0 or n_in == 0:
        return data.copy()
    cutoff = 0.5 * min(1.0, ratio)
    half_width = max(8, min(24, round(12.0 / min(1.0, ratio))))
    table = kaiser_sinc_table(cutoff, half_width)
    n_taps = 2 * half_width
    src = np.arange(n_out) * (1.0 / ratio)
    i0 = src.astype(np.int64)
    phase = ((src - i0) * PHASES).astype(np.int64) & (PHASES - 1)
    out = np.empty(n_out)
    pad = np.concatenate([np.full(half_width - 1, data[0]), data,
                          np.full(half_width + 1, data[-1])])
    CHUNK = 1 << 18
    for c0 in range(0, n_out, CHUNK):
        c1 = min(n_out, c0 + CHUNK)
        idx = i0[c0:c1, None] + np.arange(n_taps)[None, :]   # into pad
        out[c0:c1] = np.einsum('ij,ij->i', pad[idx], table[phase[c0:c1]])
    return out


def synth_sustain_loop(q8s, keep):
    """Seam-matched forward loop near the end of the quantised u8-scale
    signals `q8s` (scored in the domain the taud bank actually stores),
    truncated to `keep`. Port of midi2taud._synth_sustain_loop; loop_end
    exclusive. Every side of a stereo pair is one entry of `q8s`: the seam
    error is summed over them, so the one loop suits both channels."""
    keep = min(min(len(q8) for q8 in q8s), keep)
    W = LOOP_MATCH_WIN
    loop_end = keep - W
    p_max = min(LOOP_HINT, loop_end)
    p_min = min(LOOP_MIN_PERIOD, p_max)
    if loop_end <= p_min:
        return max(0, keep - 2), keep

    tails = [q8[loop_end:loop_end + W:LOOP_MATCH_STEP] for q8 in q8s]

    def seam_err(p):
        err = 0.0
        for q8, tail in zip(q8s, tails):
            d = q8[loop_end - p:loop_end - p + W:LOOP_MATCH_STEP] - tail
            err += float(np.dot(d, d))
        return err

    cands = list(range(p_min, p_max + 1, LOOP_COARSE_STEP))
    errs = [seam_err(p) for p in cands]
    best_p = cands[int(np.argmin(errs))]
    lo = max(p_min, best_p - LOOP_COARSE_STEP)
    hi = min(p_max, best_p + LOOP_COARSE_STEP)
    fine = list(range(lo, hi + 1))
    ferrs = [seam_err(p) for p in fine]
    if min(ferrs) < min(errs):
        best_p = fine[int(np.argmin(ferrs))]
    loop_start = max(0, min(loop_end - 2, loop_end - best_p))
    return loop_start, loop_end


# ------------------------------------------------------------ the transform

def transform_group(group, smpl16, tail_thresh, quantise):
    """Fill s.data / s.q / s.new_rate / s.nls / s.nle / s.synth / s.decay for
    each sample of `group`: one sample, or the sides of a stereo pair
    (stereo_pairs). The converter plays a pair as two spans with ONE
    length and its first side's loop points, so the sides take one resample
    ratio, one length and one synthesized loop — transformed one by one, each
    trimmed its tail and searched its seam on its own and the pair came apart.
    Only the baked decay stays per side: a looped side that takes the shared
    synthesized loop keeps sustaining. A group of one is the plain per-sample
    transform."""
    live = []
    for s in group:
        if s.frames == 0:
            s.data = np.zeros(0, np.int16)
        else:
            live.append(s)
    if not live:
        return

    # loop in the source domain (shdr loop values are junk on unlooped
    # drums — e.g. GeneralUser stores [start+8, end-8] — so gate on modes)
    raws, src_loops, has_loop = [], [], []
    for s in live:
        n = s.frames
        raws.append(smpl16[s.start:s.end].astype(np.float64))
        ls = max(0, min(s.ls - s.start, n))
        le = max(0, min(s.le - s.start, n))
        src_loops.append((ls, le))
        has_loop.append(bool(s.modes & {1, 3}) and le - ls >= 2)

    # 1. 32 kHz floor. The resampler scales time by exactly `ratio`, so that is
    # the rate the data now has and the factor every position scales by — not
    # len(out)/len(in), which int() truncation makes short by up to a frame.
    # A loop keeps its pitch only if it spans the same time as before, and a
    # loop is a whole number of frames: so a looped sample's ratio is lowered to
    # the nearest one that makes its loop exactly floor(L·ratio) frames. Rounding
    # the two loop ends separately instead put a 13-frame single-cycle loop as
    # much as half a semitone out (GeneralUser's synth leads, tine and sine
    # layers). Lowering, never raising, keeps the rate at or under the floor.
    rate = live[0].rate              # a group shares one rate (group_samples)
    if rate > RATE_FLOOR:
        ratio = RATE_FLOOR / rate
        # the shortest loop any zone plays out of any side — a zone's loop
        # offsets can make it shorter than the header's — is the one rounding
        # hurts most; every other lands within half a frame
        loops = []
        for s, (ls, le), h in zip(live, src_loops, has_loop):
            if h:
                loops += [lp for lp in s.zone_loops if lp[1] - lp[0] >= 2] or [(ls, le)]
        if loops:
            shortest = min(e - b for b, e in loops)
            frames = math.floor(shortest * ratio)
            if frames >= 2:
                ratio = frames / shortest
        datas = [resample_sinc(raw, ratio) for raw in raws]
        for s in live:
            s.q = ratio
            s.new_rate = max(1, round(s.rate * ratio))
    else:
        datas = raws

    # the loop in the resampled domain: the start rounds to the nearest frame
    # and the length is carried over whole, so the seam stays where it was in
    # the waveform's own cycle.
    new_loops = []
    for i, (s, (ls, le)) in enumerate(zip(live, src_loops)):
        n_out = len(datas[i])
        nls = round(ls * s.q)
        nle = nls + round((le - ls) * s.q)
        if nle > n_out:              # a loop ending on the last frame: slide
            nls, nle = max(0, nls - (nle - n_out)), n_out    # it back, length kept
        if has_loop[i] and nle - nls < 2:
            has_loop[i] = False
        new_loops.append((nls, nle))

    # 2./3. length ladder — one length for the group: the longest any side
    # needs, so no side loses a loud tail or a loop to its partner's
    keep = 0
    for s, data, (nls, nle), h in zip(live, datas, new_loops, has_loop):
        k = len(data)
        uses_tail = (not h) or bool(s.modes & {0, 3})
        if h and not uses_tail:
            k = min(k, nle + LOOP_PAD)                       # dead post-loop tail
        elif uses_tail and tail_thresh > 0:
            loud = np.nonzero(np.abs(data) >= tail_thresh)[0]
            last = int(loud[-1]) + 1 if len(loud) else 0
            k = min(k, max(last + LOOP_PAD, 16))
            if h:
                k = max(k, nle + LOOP_PAD)                   # never cut the loop
        keep = max(keep, k)
    synth = False
    if keep > CAP:
        keep = CAP
        for (nls, nle), h in zip(new_loops, has_loop):
            if h and nle <= CAP - 2:
                pass                                         # real loop kept
            else:
                synth = True                                 # (for every side)
    decay = [synth and not h for h in has_loop]              # one-shot: bake fade

    # 4. top-byte quantise (round beats the pipeline's floor — the converter
    # computes (s>>8)+128 from what we store, so stored round(s/256)<<8 makes
    # the bank byte exactly round(s16/256)+128)
    q8s = []
    for i, data in enumerate(datas):
        data = data[:min(keep, len(data))]
        q8 = np.clip(np.round(data / 256.0), -128, 127)
        if quantise:
            data = (q8 * 256.0)
        datas[i] = data
        q8s.append(q8)

    if synth:
        nls, nle = synth_sustain_loop(q8s, keep)
        # the synth loop is terminal (wraps forever, or mode 1 is being
        # forced): the post-loop seam window is never played — drop it
        if all(d or s.modes == {1} for s, d in zip(live, decay)):
            datas = [data[:nle + LOOP_PAD] for data in datas]
        new_loops = [(nls, nle)] * len(live)
    else:                                            # scaled (junk loops kept)
        new_loops = [(min(nls, len(data)), min(nle, len(data)))
                     for data, (nls, nle) in zip(datas, new_loops)]

    for s, data, (nls, nle), d in zip(live, datas, new_loops, decay):
        s.synth, s.decay = synth, d
        s.nls, s.nle = nls, nle
        s.data = np.clip(np.round(data), -32768, 32767).astype(np.int16)


def stereo_pairs(samples, zone_views, phdr, pbag, pgen, decayed=()):
    """The samples the converter plays as stereo pairs (midi2taud
    merge_stereo_zones over a preset's zones, each an instrument zone under a
    preset zone: rects intersected, pans summed): LINKED — a zone on an
    L/R-typed sample and a zone on its sampleLink — and PAN — two zones
    hard-panned (|pan| >= 400) to opposite sides — each pair with the same
    key/vel rect, sampleModes and root key. The two sides are often two
    instruments layered by one preset. Plenty of soundfonts carry junk
    sampleLinks (0 on every L/R sample), which only a partner ZONE confirms.
    Partners are matched the converter's way — each zone takes the FIRST
    unused one after it, a linked partner before a panned one — since in a
    preset layering two stereo instruments an L zone of one also fits the R
    of the other. The zones of a `decayed` sample are read as sampleModes 1,
    which the rewrite will give them. -> {(si, sj), ...}"""
    pairs = set()

    inst_views = {}                  # inst -> [merged instrument zone]
    for ii, zi, merged in zone_views:
        if not samples[merged[G_SAMPLEID]].stype & 0x8000:    # ROM: not played
            inst_views.setdefault(ii, []).append(merged)
    buckets = {}                     # (preset, rect, modes, rootkey) -> [(si, pan)]
    for pi in range(len(phdr) // 38 - 1):
        b0 = struct.unpack_from('<H', phdr, pi*38 + 24)[0]
        b1 = struct.unpack_from('<H', phdr, (pi+1)*38 + 24)[0]
        pzones, _ = parse_bag_zones(pbag, pgen, b0, b1)
        pglob = {}
        for zi, pz_raw in enumerate(pzones):
            pz = dict(pz_raw)
            if G_INSTRUMENT not in pz:
                if zi == 0:
                    pglob = pz
                continue
            pz = {**pglob, **pz}
            pk, pv = pz.get(G_KEYRANGE, FULL_RANGE), pz.get(G_VELRANGE, FULL_RANGE)
            for merged in inst_views.get(pz[G_INSTRUMENT], ()):
                ik = merged.get(G_KEYRANGE, FULL_RANGE)
                iv = merged.get(G_VELRANGE, FULL_RANGE)
                rect = (max(ik & 0xFF, pk & 0xFF), min(ik >> 8 & 0xFF, pk >> 8 & 0xFF),
                        max(iv & 0xFF, pv & 0xFF), min(iv >> 8 & 0xFF, pv >> 8 & 0xFF))
                if rect[0] > rect[1] or rect[2] > rect[3]:
                    continue
                si = merged[G_SAMPLEID]
                s = samples[si]
                rk = merged.get(G_ROOTKEY, -1)
                rk = rk if 0 <= rk <= 127 else (s.origkey if s.origkey <= 127 else 60)
                pan = max(-500, min(500, merged.get(G_PAN, 0) + pz.get(G_PAN, 0)))
                modes = 1 if si in decayed else merged.get(G_SAMPLEMODES, 0) & 3
                key = (pi, rect, modes, rk)
                buckets.setdefault(key, []).append((si, pan))
    for zones in buckets.values():
        used = set()
        for a, (si, pan) in enumerate(zones):
            if a in used:
                continue
            s = samples[si]
            partner = None
            if s.stype in (2, 4) and 0 <= s.link < len(samples):
                partner = next((b for b in range(a + 1, len(zones))
                                if b not in used and zones[b][0] == s.link), None)
            if partner is None and abs(pan) >= 400:
                partner = next((b for b in range(a + 1, len(zones))
                                if b not in used and zones[b][0] != si
                                and abs(zones[b][1]) >= 400
                                and (pan < 0) != (zones[b][1] < 0)), None)
            if partner is not None:
                used.add(partner)
                pairs.add((si, zones[partner][0]))
    return pairs


def group_samples(samples, pairs):
    """Every sample in one transform group: union-find over `pairs`, so a
    sample paired in two presets ties both partners into one group. A group
    cannot share a resample across sample rates, so a group of mixed rates is
    split by rate (the converter plays such a pair's second side at the
    first's rate in any case). -> ([tuple of sample indices, ...],
    {warning, ...})"""
    parent = list(range(len(samples)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for si, sj in pairs:
        parent[find(sj)] = find(si)
    groups = {}
    for i in range(len(samples)):
        groups.setdefault(find(i), []).append(i)
    out, warnings = [], set()
    for g in groups.values():
        by_rate = {}
        for i in g:
            by_rate.setdefault(samples[i].rate, []).append(i)
        if len(by_rate) > 1:
            warnings.add("warning: stereo pair " + " / ".join(
                         repr(samples[i].name.decode('latin-1')) for i in g)
                         + " differs in sample rate — only same-rate sides "
                         "are kept aligned")
        out += [tuple(part) for part in by_rate.values()]
    return out, warnings


def refit_offset(total, q):
    """Scale a combined coarse+fine address offset, re-split -> (coarse, fine)."""
    return split_offset(int(round(total * q)))


def split_offset(t):
    """A frame offset as SF2's (coarse, fine) generator pair."""
    coarse = int(t / 32768)          # trunc toward zero keeps |fine| < 32768
    return coarse, t - 32768 * coarse


def main():
    ap = argparse.ArgumentParser(description="Build a Taud-conformant SF2.")
    ap.add_argument('input')
    ap.add_argument('-o', '--output', default=None,
                    help="output path (default <input stem>.taud.sf2)")
    ap.add_argument('--no-gz', action='store_true',
                    help="skip writing the gzipped copy alongside")
    ap.add_argument('--keep-16bit', action='store_true',
                    help="keep full 16-bit sample precision (bigger gzip; "
                         "the taud pipeline only ever reads the top byte)")
    ap.add_argument('--tail-thresh', type=int, default=TAIL_THRESH,
                    help=f"sub-floor tail trim threshold on |s16| "
                         f"(default {TAIL_THRESH}; 0 disables)")
    ap.add_argument('--progress', action='store_true',
                    help="print 'progress F' lines (0 <= F <= 1) as it works")
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()
    global VERBOSE
    VERBOSE = args.verbose

    shown = [-1]

    def progress(f):                 # the samples are most of the work: 0 … 0.9
        if args.progress and int(f * 100) > shown[0]:
            shown[0] = int(f * 100)
            print(f"progress {f:.2f}", flush=True)

    out_path = args.output or (args.input[:-4] if args.input.lower()
                               .endswith('.sf2') else args.input) + '.taud.sf2'

    data = open(args.input, 'rb').read()
    info, (smpl_off, smpl_size), pdta = parse_riff(data)
    pd = dict(pdta)
    for need in ('phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'):
        if need.encode() not in pd:
            sys.exit(f"error: missing pdta sub-chunk '{need}'")
    smpl16 = np.frombuffer(data, dtype='<i2', count=smpl_size // 2,
                           offset=smpl_off)

    shdr = pd[b'shdr']
    samples = [Sample(shdr[i*46:(i+1)*46]) for i in range(len(shdr)//46 - 1)]

    # --- instrument zones (census over ALL instruments; presets only gate
    # the report — samples referenced by no instrument at all are passed
    # through loop-safely with no tail trim)
    inst, ibag, igen = pd[b'inst'], pd[b'ibag'], pd[b'igen']
    n_inst = len(inst) // 22 - 1
    inst_bags = []                   # per inst: (bag0, zones, modNdx)
    for i in range(n_inst):
        b0 = struct.unpack_from('<H', inst, i*22 + 20)[0]
        b1 = struct.unpack_from('<H', inst, (i+1)*22 + 20)[0]
        zones, mods = parse_bag_zones(ibag, igen, b0, b1)
        inst_bags.append((b0, zones, mods))

    # sanity: sample generators are illegal at preset level (SF2 8.5)
    pgen = pd[b'pgen']
    for gi in range(len(pgen) // 4):
        op, amt = struct.unpack_from('<Hh', pgen, gi*4)
        if op in ADDR_GENS + (G_SAMPLEMODES,) and amt != 0:
            sys.exit(f"error: preset-level sample generator {op} present — "
                     "unsupported (and illegal per SF2 spec 8.5)")

    # census: modes per sample; fold global-zone gens into a per-zone view
    zone_views = []                  # (inst_idx, zone_idx_in_inst, merged dict)
    for ii, (b0, zones, _) in enumerate(inst_bags):
        glob = {}
        for zi, zone in enumerate(zones):
            gd = {}
            for o, a in zone:
                gd[o] = a
            if G_SAMPLEID not in gd:
                if zi == 0:
                    glob = gd
                continue
            merged = dict(glob)
            merged.update(gd)
            si = merged[G_SAMPLEID]
            if 0 <= si < len(samples):
                samples[si].modes.add(merged.get(G_SAMPLEMODES, 0) & 3)
                zone_views.append((ii, zi, merged))

    frames_in = sum(s.frames for s in samples)

    # --- split pass: a start-offset zone slicing an over-cap sample keeps
    # today's converter behaviour (the slice is its own pooled MonoSample,
    # keyed by a_start) by moving onto its own record when the base sample's
    # truncation would eat a material part of it. Identical slices share one
    # clone.
    SPLIT_SLACK = 1024               # frames (~32 ms) — below this, keep the cut
    splits = 0
    split_zones = set()              # (inst_idx, zone_idx): globals already folded
    split_cache = {}                 # (si, off, ls, le, mode) -> clone index
    for ii, zi, merged in zone_views:
        si = merged[G_SAMPLEID]
        s = samples[si]
        off = merged.get(G_START_OFF, 0) + 32768 * merged.get(G_START_COARSE, 0)
        if off <= 0 or s.frames == 0:
            continue
        q = min(1.0, RATE_FLOOR / s.rate)
        slice_len = s.frames - off
        if int(s.frames * q) <= CAP:                        # base not capped
            continue
        new_slice = CAP - round(off * q)
        old_slice = min(round(slice_len * q), CAP)          # slice as its own sample
        if not (0 < slice_len <= CAP and new_slice < old_slice - SPLIT_SLACK):
            continue
        # fold the zone's loop offsets into the clone, clamp into the slice
        lso = merged.get(G_STARTLOOP_OFF, 0) + 32768 * merged.get(G_STARTLOOP_COARSE, 0)
        leo = merged.get(G_ENDLOOP_OFF, 0) + 32768 * merged.get(G_ENDLOOP_COARSE, 0)
        mode = merged.get(G_SAMPLEMODES, 0) & 3
        key = (si, off, lso, leo, mode)
        new_si = split_cache.get(key)
        if new_si is None:
            ns = Sample(shdr[si*46:(si+1)*46])              # clone base record
            ns.name = (s.name[:15] + b'~slc')
            ns.start = s.start + off
            ns.ls = min(max(s.ls + lso, ns.start), s.end)
            ns.le = min(max(s.le + leo, ns.start), s.end)
            ns.modes = {mode}
            ns.link, ns.stype = 0, 1
            new_si = len(samples)
            samples.append(ns)
            split_cache[key] = new_si
        # retarget the zone: sampleID -> clone, address gens -> 0
        zone = inst_bags[ii][1][zi]
        for gi2, (o, a) in enumerate(zone):
            if o in ADDR_GENS:
                zone[gi2] = (o, 0)
            elif o == G_SAMPLEID:
                zone[gi2] = (o, new_si)
        merged[G_SAMPLEID] = new_si
        for g in ADDR_GENS:
            merged[g] = 0
        split_zones.add((ii, zi))
        splits += 1
        vprint(f"  split: inst {ii} zone {zi} offset {off} on "
               f"'{s.name.decode('latin-1')}' -> sample #{new_si}")

    # a split linked pair stays linked: each side's clone takes the other
    # side's clone (same offsets) as its sampleLink, and its L/R type back —
    # a clone left mono-typed would lose its partner in the converter, whose
    # R zone would then play as a second, centred layer over the L one
    for (si, *rest), ci in split_cache.items():
        s = samples[si]
        if (s.stype not in (2, 4) or not 0 <= s.link < len(samples)
                or samples[s.link].link != si
                or samples[s.link].stype != 6 - s.stype):    # junk link
            continue
        cj = split_cache.get((s.link, *rest))
        if cj is None:
            print(f"warning: '{s.name.decode('latin-1')}' was split for a "
                  f"start offset but its linked partner was not — the pair "
                  f"loses its link there")
            continue
        samples[ci].link, samples[ci].stype = cj, s.stype

    # --- zone loops: every loop a looped zone plays out of each sample, its loop
    # offsets applied (globals folded exactly as the rewrite below folds them),
    # so the 32 kHz resample can keep the shortest one a whole number of frames
    for ii, (b0, zones, _) in enumerate(inst_bags):
        glob = None
        for zi, zone in enumerate(zones):
            if not any(o == G_SAMPLEID for o, _ in zone):
                if glob is None and zi == 0:
                    glob = zone
                continue
            gd = dict(zone)
            gv = dict(glob) if glob and (ii, zi) not in split_zones else {}
            si = gd.get(G_SAMPLEID, -1)
            if not (0 <= si < len(samples)):
                continue
            if gd.get(G_SAMPLEMODES, gv.get(G_SAMPLEMODES, 0)) & 3 not in (1, 3):
                continue
            s = samples[si]
            lso = (gv.get(G_STARTLOOP_OFF, 0) + gd.get(G_STARTLOOP_OFF, 0)
                   + 32768 * (gv.get(G_STARTLOOP_COARSE, 0) + gd.get(G_STARTLOOP_COARSE, 0)))
            leo = (gv.get(G_ENDLOOP_OFF, 0) + gd.get(G_ENDLOOP_OFF, 0)
                   + 32768 * (gv.get(G_ENDLOOP_COARSE, 0) + gd.get(G_ENDLOOP_COARSE, 0)))
            zs = max(0, min(s.ls - s.start + lso, s.frames))
            ze = max(0, min(s.le - s.start + leo, s.frames))
            if ze - zs >= 2:
                s.zone_loops.add((zs, ze))

    # --- per-sample transform; the sides of a stereo pair together. A baked
    # decay rewrites its zones to sampleModes 1, which can pair zones the
    # converter did not pair before (a one-shot organ beside a looped vibe,
    # panned apart): so pair again with the modes as they will be written and
    # redo every group that grew, until none does. Groups only ever merge.
    pairs, decayed, done = set(), set(), {}
    frames_done = 0
    while True:
        pairs |= stereo_pairs(samples, zone_views, pd[b'phdr'], pd[b'pbag'],
                              pgen, decayed)
        groups, warnings = group_samples(samples, pairs)
        todo = [g for g in groups if any(done.get(i) != g for i in g)]
        if not todo:
            break
        for g in todo:
            transform_group([samples[i] for i in g], smpl16, args.tail_thresh,
                            not args.keep_16bit)
            for i in g:
                done[i] = g
            frames_done += sum(samples[i].frames for i in g)
            progress(0.9 * min(1.0, frames_done / max(1, frames_in)))
        decayed = {i for i, s in enumerate(samples) if s.decay}
    for w in sorted(warnings):
        print(w)
    stereo = [g for g in groups if len(g) > 1]
    n_synth = n_decay = n_resamp = 0
    for s in samples:
        if s.rate != s.new_rate:
            n_resamp += 1
        if s.synth:
            n_synth += 1
            vprint(f"  synth loop: '{s.name.decode('latin-1')}' "
                   f"[{s.nls},{s.nle}] of {len(s.data)}"
                   + (" + 10s decay" if s.decay else ""))
        if s.decay:
            n_decay += 1
    frames_out = sum(len(s.data) for s in samples)

    # --- rewrite instrument zones: scale address offsets, force sampleModes
    # + decay ADSR where required, zero loop offsets on synth-looped samples.
    # Global-zone address gens are folded down into each sample zone and
    # zeroed in place, so per-sample ratios apply cleanly.
    for ii, (b0, zones, _) in enumerate(inst_bags):
        glob = None
        for zi, zone in enumerate(zones):
            if not any(o == G_SAMPLEID for o, _ in zone):
                if glob is None and zi == 0:
                    glob = zone
                continue
            gd = dict(zone)
            # a split zone already had its global offsets folded into the
            # new sample record — do not re-apply them here
            gv = dict(glob) if glob and (ii, zi) not in split_zones else {}
            si = gd.get(G_SAMPLEID, -1)
            if not (0 <= si < len(samples)):
                continue
            s = samples[si]

            def combined(fine_op, coarse_op):
                return (gv.get(fine_op, 0) + gd.get(fine_op, 0)
                        + 32768 * (gv.get(coarse_op, 0) + gd.get(coarse_op, 0)))

            want = {}
            c, f = refit_offset(combined(G_START_OFF, G_START_COARSE), s.q)
            want[G_START_OFF], want[G_START_COARSE] = f, c
            c, f = refit_offset(combined(G_END_OFF, G_END_COARSE), s.q)
            want[G_END_OFF], want[G_END_COARSE] = f, c
            if s.synth:
                want[G_STARTLOOP_OFF] = want[G_STARTLOOP_COARSE] = 0
                want[G_ENDLOOP_OFF] = want[G_ENDLOOP_COARSE] = 0
            else:
                lso = combined(G_STARTLOOP_OFF, G_STARTLOOP_COARSE)
                leo = combined(G_ENDLOOP_OFF, G_ENDLOOP_COARSE)
                if s.q != 1.0 and (lso or leo):
                    # the zone's own loop — start rounded, LENGTH rounded once —
                    # as offsets from the new header loop; scaling the two
                    # offsets separately could stretch or shrink it a frame
                    zs = s.ls - s.start + lso
                    ze = s.le - s.start + leo
                    nzs = round(zs * s.q)
                    nze = nzs + round((ze - zs) * s.q)
                    lso_t, leo_t = nzs - s.nls, nze - s.nle
                else:
                    lso_t, leo_t = round(lso * s.q), round(leo * s.q)
                want[G_STARTLOOP_COARSE], want[G_STARTLOOP_OFF] = split_offset(lso_t)
                want[G_ENDLOOP_COARSE], want[G_ENDLOOP_OFF] = split_offset(leo_t)
            if s.decay:
                want[G_SAMPLEMODES] = 1
                want[G_DECAY_VOLENV] = DECAY_TC
                want[G_SUSTAIN_VOLENV] = DECAY_SUS_CB
            # apply: rewrite existing gens (every occurrence — last wins per
            # spec); insert missing non-zero ones just before the terminal
            # sampleID gen (SF2 8.1.2 ordering)
            applied = set()
            for gi2, (o, a) in enumerate(zone):
                if o in want:
                    zone[gi2] = (o, want[o])
                    applied.add(o)
            inserts = [(o, a) for o, a in want.items()
                       if a != 0 and o not in applied]
            if inserts:
                term = next(k for k, (o, _) in enumerate(zone) if o == G_SAMPLEID)
                zone[term:term] = inserts
        if glob:                     # zero the folded-down global address gens
            for gi2, (o, a) in enumerate(glob):
                if o in ADDR_GENS:
                    glob[gi2] = (o, 0)

    # --- layout the new smpl chunk
    pos = 0
    parts = []
    pad = np.zeros(SMPL_PAD, np.int16)
    for s in samples:
        s.new_start = pos
        parts.append(s.data)
        parts.append(pad)
        pos += len(s.data) + SMPL_PAD
    new_smpl = np.concatenate(parts) if parts else np.zeros(0, np.int16)

    # --- rebuild shdr
    out_shdr = bytearray()
    for s in samples:
        end = s.new_start + len(s.data)
        out_shdr += struct.pack('<20sIIIIIBbHH', s.name, s.new_start, end,
                                s.new_start + s.nls, s.new_start + s.nle,
                                s.new_rate, s.origkey, s.corr, s.link, s.stype)
    out_shdr += struct.pack('<20sIIIIIBbHH', b'EOS', 0, 0, 0, 0, 0, 0, 0, 0, 0)

    # --- rebuild igen + ibag (gen indices shift on insert; mod indices stay,
    # incl. the original terminal record's)
    out_igen = bytearray()
    out_ibag = bytearray()
    gen_idx = 0
    for (b0, zones, mods) in inst_bags:
        for zone, m0 in zip(zones, mods):
            out_ibag += struct.pack('<HH', gen_idx, m0)
            for o, a in zone:
                out_igen += struct.pack('<Hh', o, a)
                gen_idx += 1
    t_mod = struct.unpack_from('<H', ibag, (len(ibag)//4 - 1)*4 + 2)[0]
    out_ibag += struct.pack('<HH', gen_idx, t_mod)
    if gen_idx > 0xFFFF:
        sys.exit(f"error: igen overflow ({gen_idx} generators)")

    # --- INFO: note the transform in ICMT
    note = (f"sf2taudify: 32kHz floor, {CAP}-frame cap, forced synth loops, "
            f"taud top-byte samples.")
    new_info = []
    had_icmt = False
    for cid, body in info:
        if cid == b'ICMT':
            txt = body.rstrip(b'\x00')
            body = txt + b'\r\n' + note.encode('latin-1') + b'\x00'
            had_icmt = True
        new_info.append((cid, body))
    if not had_icmt:
        new_info.append((b'ICMT', note.encode('latin-1') + b'\x00'))

    # --- serialise
    def chunk(cid, body):
        b = bytes(body)
        return cid + struct.pack('<I', len(b)) + b + (b'\x00' if len(b) & 1 else b'')

    def list_chunk(ltype, items):
        body = ltype + b''.join(chunk(cid, b) for cid, b in items)
        return b'LIST' + struct.pack('<I', len(body)) + body

    new_pdta = []
    for cid, body in pdta:
        if cid == b'shdr':
            body = out_shdr
        elif cid == b'igen':
            body = out_igen
        elif cid == b'ibag':
            body = out_ibag
        new_pdta.append((cid, body))

    payload = (b'sfbk'
               + list_chunk(b'INFO', new_info)
               + list_chunk(b'sdta', [(b'smpl', new_smpl.tobytes())])
               + list_chunk(b'pdta', new_pdta))
    out = b'RIFF' + struct.pack('<I', len(payload)) + payload
    with open(out_path, 'wb') as fh:
        fh.write(out)

    print(f"{args.input}: {len(data)/1048576:.2f} MiB, "
          f"{frames_in} frames -> {out_path}: {len(out)/1048576:.2f} MiB, "
          f"{frames_out} frames")
    print(f"  {n_resamp} resampled to <= {RATE_FLOOR} Hz, {n_synth} synth "
          f"loops ({n_decay} with baked decay), {splits} offset zones split, "
          f"{len(stereo)} stereo groups kept aligned")

    if not args.no_gz:
        progress(0.95)
        gz_path = out_path + '.gz'
        with open(gz_path, 'wb') as fh:      # mtime 0 + no embedded filename:
            with gzip.GzipFile(filename='', fileobj=fh, mode='wb',
                               compresslevel=9, mtime=0) as gz:  # byte-stable
                gz.write(out)
        print(f"  {gz_path}: {os.path.getsize(gz_path)/1048576:.2f} MiB")


if __name__ == '__main__':
    main()
