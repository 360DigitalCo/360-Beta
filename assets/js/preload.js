// 360 Desktop — preload script
// contextIsolation is on and nodeIntegration is off in both windows, so
// this is the only bridge between the renderer (plain web content) and
// the main process. Keeps the exposed surface minimal and explicit.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop360", {
  // Called by the overlay widget when the cursor enters/leaves it, so the
  // window can be click-through everywhere except the widget itself.
  setOverlayInteractive: (interactive) => ipcRenderer.send("overlay-set-interactive", interactive),

  openChat: () => ipcRenderer.send("overlay-open-chat"),
  dismissOverlay: () => ipcRenderer.send("overlay-dismiss"),

  // Overlay widget only: which game (or null) is currently detected.
  onGameDetected: (callback) => {
    ipcRenderer.on("game-detected", (_evt, gameName) => callback(gameName));
  },

  // Main window only: fires on every game start/stop regardless of which
  // page is loaded, so assets/js/main.js (site-wide) can persist it to
  // profiles.current_activity for the chat member list to read.
  onGameActivity: (callback) => {
    ipcRenderer.on("game-activity", (_evt, gameName) => callback(gameName));
  },
});
