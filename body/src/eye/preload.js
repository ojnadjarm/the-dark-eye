const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("eye", {
  onSpeak: (fn) => ipcRenderer.on("speak", (_e, text) => fn(text)),
  onStatus: (fn) => ipcRenderer.on("status", (_e, s) => fn(s)),
  onAudio: (fn) => ipcRenderer.on("audio", (_e, chunk) => fn(chunk)),
  onPtt: (fn) => ipcRenderer.on("ptt", (_e, down) => fn(down)),
  onHeard: (fn) => ipcRenderer.on("heard", (_e, text) => fn(text)),
  onSession: (fn) => ipcRenderer.on("session", (_e, s) => fn(s)),
  onAttention: (fn) => ipcRenderer.on("attention", (_e, a) => fn(a)),
  sendMic: (payload) => ipcRenderer.send("mic-audio", payload),
  debug: (m) => ipcRenderer.send("debug", m),
});
