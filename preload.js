const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ghost", {
  setOpacity: (value) => ipcRenderer.send("set-opacity", value),
  toggleClickThrough: () => ipcRenderer.send("toggle-click-through"),
  setBarHover: (hovered) => ipcRenderer.send("bar-hover", hovered),
  resizeStart: (dir) => ipcRenderer.send("resize-start", dir),
  resizeEnd: () => ipcRenderer.send("resize-end"),
  toggleSound: () => ipcRenderer.send("toggle-sound"),
  hide: () => ipcRenderer.send("hide"),
  showTab: (id) => ipcRenderer.send("show-tab", id),
  reload: () => ipcRenderer.send("reload"),
  quit: () => ipcRenderer.send("quit"),
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onSound: (fn) => ipcRenderer.on("sound", (_e, on) => fn(on)),
});
