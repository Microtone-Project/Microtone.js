#!/usr/bin/env python3
"""sf2bank.py — SoundFont → Taud instrument bank driver (Microtone.js).

A thin wrapper around midi2taud's canonical SF2→Taud machinery (parse_sf2,
build_presets, allocate_slots, assemble_tsii — vendor/converters/midi2taud.py)
so the web app can import instruments from an .sf2 WITHOUT a MIDI file. This
file is Microtone.js code (not vendored); it only ORCHESTRATES the canonical
functions so there is still exactly one SF2→Taud mapping implementation.

    sf2bank.py list  <in.sf2> <out.json>
    sf2bank.py build <in.sf2> <selection.json> <out.tsii> [--bpm N] [--stereo]

list  → out.json: [{"bank": B, "program": P, "name": "...", "stereo": bool}]
        sorted; "stereo" = the preset has stereo sample pairs.
build → selection.json holds [[bank, program], ...]; emits a .tsii whose
        directly-addressable slots ($01..$FF) are the selected presets in
        order (multi-layer presets become Metainstruments with their layers
        in the aux bin), ready for the app's bank-merge import.

Unlike a MIDI conversion there is no trigger histogram to trim patches with,
so `build` fabricates a UNIFORM full-range histogram (every MIDI key at every
vol6 level, count 1): every zone is kept and weighting-sensitive choices
(canonical zone, mean-pitch fallback) stay neutral.

--stereo (item 90.1) keeps an instrument's SF2 stereo sample pairs as genuine
stereo samples — two pool spans joined by an Ixmp 's' patch — instead of mixing
them down to mono; it costs twice the pool bytes per stereo instrument.

--bpm should be the DESTINATION song's BPM — fadeout steps encode SF2 release seconds per
song-tick, so the bank matches that tempo exactly (midi2taud batch-mode
semantics).
"""
import argparse
import json
import sys
from types import SimpleNamespace

from midi2taud import (
    parse_sf2, key_to_noteval, build_presets, allocate_slots, build_pool,
    assemble_tsii, merge_stereo_zones,
)


def cmd_list(args):
    sf = parse_sf2(args.input)
    # "stereo": the preset has zones the bank build pairs into a stereo sample
    # (midi2taud merge_stereo_zones, the pairing --stereo keeps) — what the
    # import list's ST chip shows.
    out = [
        {"bank": bank, "program": prog, "name": sf.presets[(bank, prog)][0],
         "stereo": any(z.pair is not None
                       for z in merge_stereo_zones(sf.presets[(bank, prog)][1], sf.shdrs))}
        for (bank, prog) in sorted(sf.presets)
    ]
    sf.file.close()
    with open(args.output, "w") as f:
        json.dump(out, f)
    print(f"{len(out)} presets")


def cmd_build(args):
    with open(args.selection) as f:
        selection = json.load(f)
    if not selection:
        sys.exit("error: empty preset selection")

    sf = parse_sf2(args.input)
    # ('d', prog) routes through the percussion candidates (128, prog) →
    # (128, 0); anything the user picked from bank 128 IS a drum kit.
    slot_keys = [("d", prog) if bank == 128 else ("m", bank, prog)
                 for bank, prog in selection]

    full_grid = {}
    for key in range(128):
        nv = key_to_noteval(key)
        for v6 in range(64):
            full_grid[(nv, v6)] = 1
    triggers = {ik: dict(full_grid) for ik in slot_keys}

    conv_args = SimpleNamespace(
        no_project_data=False,   # keep INam/SNam/Ixmp — the merge carries names
        fadeout=None,            # derive per-instrument from SF2 release @ bpm
        force_synth_loop=True,   # far-loop rescue (upstream midi2taud default)
        stereo_samples=args.stereo,
    )
    registry = {}
    presets = build_presets(sf, slot_keys, triggers, None, registry, args.max_layers,
                            False, args.stereo)
    layer_insts, meta_records, slot_name, _note_slot = allocate_slots(presets, slot_keys)
    if not layer_insts:
        sys.exit("error: no usable zones in the selected presets")
    pool = build_pool(layer_insts)
    tsii = assemble_tsii(sf, pool, layer_insts, meta_records, slot_name,
                         args.bpm, conv_args)
    sf.file.close()

    with open(args.output, "wb") as f:
        f.write(tsii)
    print(f"wrote {len(tsii)} bytes to '{args.output}'")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("list")
    lp.add_argument("input")
    lp.add_argument("output")
    lp.set_defaults(fn=cmd_list)
    bp = sub.add_parser("build")
    bp.add_argument("input")
    bp.add_argument("selection")
    bp.add_argument("output")
    bp.add_argument("--bpm", type=int, default=125)
    bp.add_argument("--max-layers", type=int, default=4, dest="max_layers")
    bp.add_argument("--stereo", action="store_true",
                    help="Keep stereo sample pairs as stereo samples (item 90.1)")
    bp.set_defaults(fn=cmd_build)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
