// OPFS write worker — Safari path: createSyncAccessHandle is worker-only.
self.onmessage = async (e) => {
  const { id, name, dirPath = ["projects"], bytes } = e.data;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const part of dirPath) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(new Uint8Array(bytes), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
    self.postMessage({ id });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
