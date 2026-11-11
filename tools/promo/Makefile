# The promo's song, built from its Motif program. The program lives out of tree
# (OoT_musical_experiments/ is gitignored), so the build lands here, in build/
# (gitignored too). Re-run after changing the program.
#
#   make            build/Eighth.taud
#   make serve      the repo root on :8950 (a fresh origin: no saved projects,
#                   no autosave dialog), then open
#                   http://127.0.0.1:8950/tools/promo/

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

serve: build/Eighth.taud
	cd $(ROOT) && python3 microtone-worker/tools/test-server.py 8950

.PHONY: all serve
