#!/usr/bin/env python3
"""Cut a promo take out of a screen recording, lined up on its sync cue.

The promo page (tools/promo/) opens every take with a white frame and a 1 kHz
beep at the same instant. This finds both in the recording, measures how far
the recorder put the sound from the picture, and writes the take from just
after the flash to the end of the end card, with the sound moved back into
line, as an H.264 + AAC MP4 ready for YouTube or Reddit.

    python3 tools/promo/cut.py RECORDING.mkv --to 159.56 [--out promo.mp4]

--to is the end of the take in seconds after the flash: the promo page shows
the whole command, numbers filled in, when the take is over. Without it the
take runs to the end of the recording.

    --from S        start S seconds after the flash (default 0.25: past the
                    white frame and the beep, on the title card)
    --crop W:H:X:Y  crop the picture too (if the recorder did not)
    --fade S        fade in and out over S seconds (default 0.4; 0 for none)
    --no-sync-fix   leave the sound where the recorder put it
    --crf N         x264 quality (default 18: visually lossless for screen
                    content; lower = bigger)
    --dry-run       find the cue and print the ffmpeg command, but do not run it

Needs ffmpeg and ffprobe on PATH.
"""
import argparse
import re
import shlex
import subprocess
import sys

SEARCH = 120.0  # seconds of the recording searched for the cue


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True)


def duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path]).stdout
    return float(out.strip())


def metadata_series(cmd, key):
    """(time, value) pairs from an ffmpeg `metadata=print`/`ametadata=print` run."""
    out = run(cmd).stdout
    series, t = [], None
    for line in out.splitlines():
        m = re.search(r"pts_time:([-\d.]+)", line)
        if m:
            t = float(m.group(1))
            continue
        if t is not None and line.startswith(key + "="):
            v = line.split("=", 1)[1]
            series.append((t, float(v) if v not in ("-inf", "inf", "nan") else -200.0))
    return series


def find_flash(path):
    """The first frame that is nearly white after a dark one."""
    vf = "scale=64:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-"
    # -ss 0 so the times count from the file's start, as every -ss below does
    s = metadata_series(["ffmpeg", "-hide_banner", "-nostats", "-ss", "0", "-t", str(SEARCH), "-i", path,
                         "-an", "-vf", vf, "-f", "null", "-"], "lavfi.signalstats.YAVG")
    prev = 255.0
    for t, y in s:
        if y >= 200 and prev < 120:
            return t
        prev = y
    sys.exit("cut.py: no sync flash in the first %d s (a white frame after a dark one)" % SEARCH)


def find_beep(path, near):
    """The onset of the 1 kHz beep closest to `near`, to 5 ms: the first 5 ms
    block within 12 dB of the loudest block in the band around it."""
    lo = max(0.0, near - 1.5)
    af = ("bandpass=f=1000:width_type=h:w=300,asetnsamples=n=240:p=0,"
          "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-")
    s = metadata_series(["ffmpeg", "-hide_banner", "-nostats", "-ss", str(lo), "-t", "3",
                         "-i", path, "-vn", "-af", af, "-f", "null", "-"],
                        "lavfi.astats.Overall.RMS_level")
    if not s:
        return None
    peak = max(v for _, v in s)
    if peak < -45:
        return None
    for t, v in s:
        if v >= peak - 12:
            return lo + t  # an input -ss restarts the clock at the cut
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("recording")
    ap.add_argument("--out", default="promo.mp4")
    ap.add_argument("--from", dest="start", type=float, default=0.25)
    ap.add_argument("--to", type=float, default=None)
    ap.add_argument("--crop", default=None)
    ap.add_argument("--fade", type=float, default=0.4)
    ap.add_argument("--no-sync-fix", action="store_true")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    total = duration(a.recording)
    flash = find_flash(a.recording)
    beep = find_beep(a.recording, flash)
    print(f"flash at {flash:.3f} s", file=sys.stderr)
    if beep is None:
        print("no beep found near it: the sound stays where it is (was desktop audio recorded?)",
              file=sys.stderr)
        offset = 0.0
    else:
        offset = beep - flash
        print(f"beep at {beep:.3f} s: the sound is {offset * 1000:+.0f} ms from the picture",
              file=sys.stderr)
        if a.no_sync_fix or abs(offset) < 0.010:
            offset = 0.0

    v_in = flash + a.start
    end = flash + a.to if a.to is not None else total
    length = min(end, total) - v_in
    if length <= 0:
        sys.exit("cut.py: nothing left to cut (check --from/--to)")

    vf = [] if not a.crop else [f"crop={a.crop}"]
    af = []
    if a.fade > 0:
        vf += [f"fade=t=in:st=0:d={a.fade}", f"fade=t=out:st={length - a.fade:.3f}:d={a.fade}"]
        af += [f"afade=t=in:st=0:d={a.fade}", f"afade=t=out:st={length - a.fade:.3f}:d={a.fade}"]
    vf.append("format=yuv420p")

    # The same file twice: the picture from the flash, the sound from the beep.
    cmd = ["ffmpeg", "-hide_banner", "-y",
           "-ss", f"{v_in:.3f}", "-i", a.recording,
           "-ss", f"{v_in + offset:.3f}", "-i", a.recording,
           "-t", f"{length:.3f}",
           "-map", "0:v:0", "-map", "1:a:0?",
           "-vf", ",".join(vf)]
    if af:
        cmd += ["-af", ",".join(af)]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", str(a.crf), "-tune", "animation",
            "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
            "-movflags", "+faststart", a.out]
    print(f"cutting {length:.2f} s from {v_in:.3f} s into {a.out}", file=sys.stderr)
    print(shlex.join(cmd), file=sys.stderr)
    if not a.dry_run:
        subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
