#!/usr/bin/env python3
"""bnkbank.py — AdLib .BNK → Taud instrument bank driver (Microtone.js).

A thin wrapper around opl2taud's canonical BNK→Taud machinery (parse_bnk,
build_bank, assemble_tsii — vendor/converters/opl2taud.py) so the web app can
import instruments straight from a raw .BNK, WITHOUT an .ims/.rol song
alongside it. This file is Microtone.js code (not vendored); it only
ORCHESTRATES the canonical functions so there is still exactly one BNK→Taud
mapping implementation.

    bnkbank.py list  <in.bnk> <out.json>
    bnkbank.py build <in.bnk> <selection.json> <out.tsii>

list  → out.json: [{"index": I, "name": "..."}], bank order. `index` is the
        patch's position in parse_bnk's `patches` list, NOT the bank's own
        record index — it is what `build` selects by, because BNK names are
        not guaranteed unique (opl2taud's by-name lookup is first-writer-wins
        and case-folded, which would silently merge duplicates here).
build → selection.json holds [index, index, ...] in the order the app wants
        them placed; emits a .tsii whose directly-addressable slots ($01..$FF)
        are those patches in that order, each a two-operator OPL instrument
        (Metainstrument type 8; opl2taud's 'melodic' role — there is no song
        here to say which channels, if any, were rhythm mode), ready for the
        app's bank-merge import.  Two identical patches still get a slot each,
        so slot n is always the n-th patch picked.
"""
import argparse
import json
import sys

from opl2taud import parse_bnk, build_bank, assemble_tsii, MAIN_SLOTS


def cmd_list(args):
    with open(args.input, "rb") as f:
        bank = parse_bnk(f.read())
    out = [{"index": i, "name": p.name} for i, p in enumerate(bank["patches"])]
    with open(args.output, "w") as f:
        json.dump(out, f)
    print(f"{len(out)} patches")


def cmd_build(args):
    with open(args.selection) as f:
        selection = json.load(f)
    if not selection:
        sys.exit("error: empty patch selection")
    if len(selection) > MAIN_SLOTS:
        sys.exit(f"error: {len(selection)} patches > {MAIN_SLOTS} directly-addressable slots")

    with open(args.input, "rb") as f:
        bank = parse_bnk(f.read())
    patches = bank["patches"]
    entries = []
    for i in selection:
        if not (0 <= i < len(patches)):
            sys.exit(f"error: patch index {i} out of range")
        entries.append({"patch": patches[i], "kind": "melodic", "name": patches[i].name})

    out = build_bank(entries, share=False)
    tsii = assemble_tsii(out)
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
    bp.set_defaults(fn=cmd_build)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
