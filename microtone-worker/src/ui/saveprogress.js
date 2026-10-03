// A manual save's progress, shown in the status bar where the unsaved dot is —
// the dot steps aside while it runs. Save, Save As, Export, an online upload,
// the Files-tab import and the upgrade copy compress at Zstandard level 19,
// which takes seconds on a big song, and the dot is where "is this saved yet?"
// is already answered. Autosave stays silent.
//
// The bar follows the compression (toSaveBytes' onProgress); once that is done
// it is full and breathes until the write — or the upload — settles.

let running = 0; // saves in flight: two Ctrl+S in a row are two
let latest = 0;  // only the newest of them moves the bar

/** Is a manual save running? updateStatus keeps the dot hidden while one is. */
export function saveInProgress() {
  return running > 0;
}

/**
 * Run `save(onProgress)` with the bar up and return what it returns; `save`
 * hands `onProgress` on to doc.toSaveBytes.
 */
export async function withSaveProgress(store, save) {
  const bar = typeof document === "undefined" ? null : document.getElementById("stSaving");
  const mine = ++latest;
  let shown = 0;
  running++;
  if (bar) {
    bar.value = 0;
    bar.classList.remove("save-writing");
    bar.hidden = false;
  }
  store.emit("status"); // the dot steps aside
  try {
    return await save((done, total) => {
      if (!bar || mine !== latest) return;
      const fraction = total > 0 ? done / total : 1;
      // A step is ~1/33 of a sample image; skip the moves nobody could see.
      if (fraction < 1 && fraction - shown < 0.01) return;
      shown = fraction;
      bar.value = fraction;
      if (fraction >= 1) bar.classList.add("save-writing");
    });
  } finally {
    if (--running === 0 && bar) {
      bar.hidden = true;
      bar.classList.remove("save-writing");
    }
    store.emit("status"); // …and comes back if something is still unsaved
  }
}
