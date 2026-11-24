// Import (browser file → bytes) and export (bytes → download) helpers.

// The desktop app (desktop-qt) opens Open and Save dialogs of its own, the
// desktop's, and all it sees of a picker is the file types: it cannot tell
// Import MIDI from Open. The page tells it the dialog's title first
// (desktop-qt/src/shell.cpp `AppPage::chooseFiles`).
const DIALOGS = globalThis.__MICROTONE_NATIVE__?.dialogs ?? null;

/** Run `open` (which opens a file picker or starts a download) under a
 *  dialog titled `title` ("" = the shell's own Open or Save). `kind` is
 *  "open" or "save". In a browser `open` runs at once, inside the click that
 *  asked for it. In the desktop app it runs once the shell has the title, at
 *  most a second later: a picker needs the click's user activation, which
 *  lasts five seconds. */
export function withDialogTitle(kind, title, open) {
  if (!DIALOGS) {
    open();
    return;
  }
  const told = fetch(DIALOGS.base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, title: title ?? "", lang: document.documentElement.lang }),
  }).catch(() => {});
  Promise.race([told, new Promise((r) => setTimeout(r, 1000))]).then(open);
}

/** One file; `title` names the dialog in the desktop app. */
export function pickFile(accept = ".taud,.tsii,.tpif", title = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] ?? null);
    // Some browsers never fire change on cancel — resolve(null) leak is harmless.
    withDialogTitle("open", title, () => input.click());
  });
}

/** The same, for several files at once: an array (empty on cancel, where the
 *  browser says so). */
export function pickFiles(accept, title = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => resolve([...input.files]);
    withDialogTitle("open", title, () => input.click());
  });
}

export function download(bytes, name) {
  downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), name);
}

/** Download an already-built Blob. Large exports (the stem ZIP) assemble their
 *  Blob from chunks so the bytes are never copied a second time. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // No title: the desktop's Save dialog says "Save" in the page's language.
  withDialogTitle("save", "", () => {
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}
