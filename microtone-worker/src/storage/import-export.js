// Import (browser file → bytes) and export (bytes → download) helpers.

export function pickFile(accept = ".taud,.tsii,.tpif") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] ?? null);
    // Some browsers never fire change on cancel — resolve(null) leak is harmless.
    input.click();
  });
}

/** The same, for several files at once: an array (empty on cancel, where the
 *  browser says so). */
export function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => resolve([...input.files]);
    input.click();
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
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
