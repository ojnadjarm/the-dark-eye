const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("eye", {
  onSpeak: (fn) => ipcRenderer.on("speak", (_e, text) => fn(text)),
  onStatus: (fn) => ipcRenderer.on("status", (_e, s) => fn(s)),
  onAudio: (fn) => ipcRenderer.on("audio", (_e, chunk) => fn(chunk)),
  onPtt: (fn) => ipcRenderer.on("ptt", (_e, down) => fn(down)),
  onHeard: (fn) => ipcRenderer.on("heard", (_e, text) => fn(text)),
  onSession: (fn) => ipcRenderer.on("session", (_e, s) => fn(s)),
  onDock: (fn) => ipcRenderer.on("dock", (_e, d) => fn(d)),
  sendMic: (payload) => ipcRenderer.send("mic-audio", payload),
  dockHover: (over) => ipcRenderer.send("dock-hover", over),
  dockClick: (mark) => ipcRenderer.send("dock-click", mark),
  debug: (m) => ipcRenderer.send("debug", m),
});
