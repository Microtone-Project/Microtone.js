# The demo songs that Motif builds, and the manifest that lists every demo.
#
#   make        (from this directory) rebuild what changed, then bring
#               demos.json's byte counts up to date
#   make -B     rebuild them all
#
# A Motif program cannot choose its file's signature — the signature says what
# wrote the file, not what the song is — so this is where the demos are signed.
# Needs node and python3 (the soundfont bank is made by the app's own
# converter, run locally).

MOTIF   := node ../../tools/motif.js
SIGN    := --signature "Microtone Demo"
FONT    := ../GeneralUser-GS.taud.sf2.gz
DEMOS   := Huygens_clock.taud

all: $(DEMOS)
	node ../../tools/demo-manifest.js

%.taud: %.tml $(FONT)
	$(MOTIF) $< $@ $(SIGN)

.PHONY: all
