const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("canvasApi", {
  onItem: (fn) => ipcRenderer.on("canvas-item", (_e, item) => fn(item)),
  onChatLog: (fn) => ipcRenderer.on("chat-log", (_e, entries) => fn(entries)),
  onChatEntry: (fn) => ipcRenderer.on("chat-entry", (_e, entry) => fn(entry)),
  onSession: (fn) => ipcRenderer.on("session", (_e, s) => fn(s)),
  onNote: (fn) => ipcRenderer.on("note", (_e, text) => fn(text)),
  verdict: (id, verdict) => ipcRenderer.send("canvas-verdict", { id, verdict }),
  chat: (text) => ipcRenderer.send("canvas-chat", text),
  paste: (bytes) => ipcRenderer.send("canvas-paste", { bytes }),
  close: () => ipcRenderer.send("canvas-close"),
});
