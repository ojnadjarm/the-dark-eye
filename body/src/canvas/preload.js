const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("canvasApi", {
  onItem: (fn) => ipcRenderer.on("canvas-item", (_e, item) => fn(item)),
  verdict: (id, verdict) => ipcRenderer.send("canvas-verdict", { id, verdict }),
  close: () => ipcRenderer.send("canvas-close"),
});
