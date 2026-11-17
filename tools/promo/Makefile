# The promo's song, built from its Motif program. The program lives out of tree
# (OoT_musical_experiments/ is gitignored), so the build lands here, in build/
# (gitignored too). Re-run after changing the program.
#
#   make            build/Eighth.taud
#   make works      the songs of ?scene=works, converted from the original
#                   modules in MODS (default: the TSVM checkout beside this one)
#   make serve      the repo root on :8950 (a fresh origin: no saved projects,
#                   no autosave dialog), then open
#                   http://127.0.0.1:8950/tools/promo/  (?scene=works for the second)

ROOT  := ../..
MOTIF := node $(ROOT)/microtone-worker/tools/motif.js
SRC   := $(ROOT)/OoT_musical_experiments/eight-bit/Eighth.tml

all: build/Eighth.taud

# The song (not the project) is renamed "Eighth": the top bar's song picker
# then stays on one line.
build/Eighth.taud: $(SRC) retitle.mjs
	mkdir -p build
	$(MOTIF) $(SRC) build/Eighth.full.taud
	node retitle.mjs build/Eighth.full.taud $@ 0 "Eighth"

# "It plays what people actually wrote": the modules are not ours and are not
# in the repository, so they are converted from wherever they are kept, by the
# converters the app runs on an import (with the arguments it passes: none).
# A converter change rebuilds them.
MODS ?= $(ROOT)/../tsvm
CONV := $(ROOT)/microtone-worker/vendor/converters
WORKS := build/changing_waves.taud build/4THSYM.taud build/adlib.taud

works: $(WORKS)

build/changing_waves.taud: $(CONV)/mod2taud.py $(CONV)/taud_common.py
	mkdir -p build
	python3 $(CONV)/mod2taud.py "$(MODS)/changing waves.mod" $@
build/4THSYM.taud: $(CONV)/it2taud.py $(CONV)/taud_common.py
	mkdir -p build
	python3 $(CONV)/it2taud.py "$(MODS)/4THSYM.it" $@
build/adlib.taud: $(CONV)/s3m2taud.py $(CONV)/taud_common.py
	mkdir -p build
	python3 $(CONV)/s3m2taud.py "$(MODS)/adlib.s3m" $@

serve: build/Eighth.taud
	cd $(ROOT) && python3 microtone-worker/tools/test-server.py 8950

.PHONY: all works serve
