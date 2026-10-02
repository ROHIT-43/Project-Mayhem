// Ghost Chat: WhatsApp Web inside an always-on-top, see-through window
// that is excluded from screen capture (setContentProtection).
const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
  screen,
  WebContentsView,
  globalShortcut,
  ipcMain,
  session,
} = require("electron");

// The sites shown in the window, one per tab.
const TABS = [
  { id: "whatsapp", label: "WhatsApp", url: "https://web.whatsapp.com/" },
  { id: "riseup", label: "Pad", url: "https://pad.riseup.net/p/yourpa" },
];
const TOOLBAR_HEIGHT = 34;
const MIN_OPACITY = 0.2;
const OPACITY_STEP = 0.1;
const EDGE = 10; // width of the invisible resize border, in pixels
const MIN_SIZE = 300; // smallest the window may be dragged to, in pixels

// Keep a plain arrow over the window: no hand, no text cursor.
const CURSOR_CSS = "*, *::before, *::after { cursor: default !important; }";

// Settings (window position, size, opacity) survive restarts.
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const defaults = {
  width: 420,
  height: 640,
  x: undefined,
  y: undefined,
  opacity: 0.85,
  tab: "whatsapp",
};

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) };
  } catch {
    return { ...defaults };
  }
}

function saveSettings() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const data = {
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    opacity: win.getOpacity(),
    tab: activeTab,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(data));
  } catch {}
}

let win = null;
const views = new Map(); // tab id -> WebContentsView
let activeTab = TABS[0].id;
let clickThrough = false;

// WhatsApp Web refuses unknown browsers, so present as plain Chrome.
const chromeUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = chromeUA;

function protect(w) {
  w.setContentProtection(true);
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenSpaces: true });
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("state", {
    opacity: win.getOpacity(),
    clickThrough,
    tab: activeTab,
    tabs: TABS.map(({ id, label }) => ({ id, label })),
  });
}

function setOpacity(value) {
  const v = Math.min(1, Math.max(MIN_OPACITY, Math.round(value * 100) / 100));
  win.setOpacity(v);
  sendState();
  saveSettings();
}

// Click-through: the mouse passes through the window. `forward: true` keeps
// mouse-move events flowing to the toolbar, so hovering the bar can re-enable
// clicks (otherwise the button that turns this off would be unclickable too).
function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  sendState();
}

// macOS draws a resize cursor whenever the pointer nears the edge of a
// resizable window, and screen sharing captures that cursor. So the window is
// never system-resizable: dragging the invisible border zones resizes it here
// instead, which leaves the cursor a plain arrow throughout. Moving the window
// ("move") goes through the same code, because a native drag strip would
// swallow presses on the two top corners.
let resizeTimer = null;
let resizeFrom = null; // { dir, bounds, point }
let resizeTicks = 0;

function startEdgeResize(dir) {
  if (resizeTimer) return;
  resizeFrom = { dir, bounds: win.getBounds(), point: screen.getCursorScreenPoint() };
  resizeTicks = 0;
  resizeTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopEdgeResize();
    const p = screen.getCursorScreenPoint();
    const { dir: d, bounds: b, point: start } = resizeFrom;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    const next = { x: b.x, y: b.y, width: b.width, height: b.height };

    // Careful: "move" contains the letter "e", so the compass checks below
    // must never run for it, or moving would also resize the right edge.
    if (d === "move") {
      next.x = b.x + dx;
      next.y = b.y + dy;
    } else {
      if (d.includes("e")) next.width = Math.max(MIN_SIZE, b.width + dx);
      if (d.includes("s")) next.height = Math.max(MIN_SIZE, b.height + dy);
      if (d.includes("w")) {
        next.width = Math.max(MIN_SIZE, b.width - dx);
        next.x = b.x + (b.width - next.width);
      }
      if (d.includes("n")) {
        next.height = Math.max(MIN_SIZE, b.height - dy);
        next.y = b.y + (b.height - next.height);
      }
    }
    win.setBounds(next);
    layoutViews(); // the resize event may not fire, so re-fit the page ourselves
    // Changing bounds can drop the window back to the desktop layer, so its
    // floating behaviour is re-asserted a few times a second while dragging.
    if (resizeTicks++ % 6 === 0) protect(win);
    if (resizeTicks > 60 * 15) stopEdgeResize(); // stuck drag safety net
  }, 16);
}

function stopEdgeResize() {
  if (!resizeTimer) return;
  clearInterval(resizeTimer);
  resizeTimer = null;
  resizeFrom = null;
  layoutViews();
  protect(win);
  saveSettings();
}

// Called while the pointer is over the toolbar strip.
function setBarHovered(hovered) {
  if (!clickThrough || !win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!hovered, { forward: true });
}

function toggleVisible() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function layoutViews() {
  const [width, height] = win.getContentSize();
  // Inset so the window's own page keeps a border strip for the resize zones.
  const bounds = {
    x: EDGE,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, width - EDGE * 2),
    height: Math.max(0, height - TOOLBAR_HEIGHT - EDGE),
  };
  for (const view of views.values()) view.setBounds(bounds);
}

// Only the active tab is visible; the others stay loaded in the background,
// so switching back is instant and no messages are missed.
function showTab(id) {
  if (!views.has(id)) return;
  activeTab = id;
  for (const [tabId, view] of views) view.setVisible(tabId === id);
  sendState();
  saveSettings();
}

// Lock down a tab's session so nothing leaks outside the protected window.
function hardenSession(ses) {
  // System notifications would pop up on the shared screen: always deny them.
  const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Save downloaded images straight to Downloads; a Save dialog would be visible.
  ses.on("will-download", (_event, item) => {
    item.setSavePath(path.join(app.getPath("downloads"), item.getFilename()));
  });
}

function createWindow() {
  const s = loadSettings();

  win = new BrowserWindow({
    width: s.width,
    height: s.height,
    x: s.x,
    y: s.y,
    minWidth: MIN_SIZE,
    minHeight: MIN_SIZE,
    frame: false,
    resizable: false, // resizing is handled by startEdgeResize, not macOS
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: "#111b21",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  protect(win);
  win.setOpacity(s.opacity);
  win.loadFile(path.join(__dirname, "toolbar.html"));

  for (const tab of TABS) {
    const ses = session.fromPartition(`persist:${tab.id}`);
    hardenSession(ses);

    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
    });
    win.contentView.addChildView(view);
    views.set(tab.id, view);

    const wc = view.webContents;
    wc.setAudioMuted(true); // no notification sounds for the mic to pick up

    // The mouse pointer IS captured by screen sharing, even over this hidden
    // window. A hand or text cursor over apparently empty screen gives the game
    // away, so force a plain arrow everywhere inside the page.
    wc.on("dom-ready", () => {
      wc.insertCSS(CURSOR_CSS);
    });

    // Links open in another protected window, never the normal browser.
    wc.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: { webPreferences: { session: ses } },
    }));
    wc.on("did-create-window", (child) => protect(child));

    wc.loadURL(tab.url, { userAgent: chromeUA });
  }
  layoutViews();
  showTab(TABS.some((t) => t.id === s.tab) ? s.tab : TABS[0].id);

  win.on("resize", layoutViews);
  win.on("moved", saveSettings);
  win.on("resized", saveSettings);
  win.once("ready-to-show", () => {
    protect(win);
    win.show();
    sendState();
  });
  win.on("show", () => protect(win));
  win.on("close", saveSettings); // window is gone by will-quit, so save here
  win.on("closed", () => app.quit());
}

ipcMain.on("set-opacity", (_e, value) => setOpacity(Number(value)));
ipcMain.on("toggle-click-through", () => setClickThrough(!clickThrough));
ipcMain.on("bar-hover", (_e, hovered) => setBarHovered(!!hovered));
ipcMain.on("resize-start", (_e, dir) => startEdgeResize(String(dir)));
ipcMain.on("resize-end", () => stopEdgeResize());
ipcMain.on("hide", () => win.hide());
ipcMain.on("show-tab", (_e, id) => showTab(String(id)));
ipcMain.on("reload", () => views.get(activeTab)?.webContents.reload());
ipcMain.on("toggle-sound", () => {
  const wc = views.get(activeTab).webContents;
  wc.setAudioMuted(!wc.isAudioMuted());
  win.webContents.send("sound", !wc.isAudioMuted());
});
ipcMain.on("quit", () => app.quit());
ipcMain.handle("get-state", () => ({
  opacity: win.getOpacity(),
  clickThrough,
  tab: activeTab,
  tabs: TABS.map(({ id, label }) => ({ id, label })),
}));

// Only one copy may run: a second one would leave an extra window on screen
// that the first one cannot close.
if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (win && !win.isDestroyed()) {
    win.showInactive();
    protect(win);
  }
});

app.whenReady().then(() => {
  // No Dock icon, no app name in the menu bar, not in Cmd+Tab.
  if (app.dock) app.dock.hide();

  createWindow();

  globalShortcut.register("Control+Alt+Space", toggleVisible);
  globalShortcut.register("Control+Alt+G", () => setClickThrough(!clickThrough));
  TABS.forEach((tab, i) => {
    globalShortcut.register(`Control+Alt+${i + 1}`, () => showTab(tab.id));
  });
  globalShortcut.register("Control+Alt+Up", () => setOpacity(win.getOpacity() + OPACITY_STEP));
  globalShortcut.register("Control+Alt+Down", () => setOpacity(win.getOpacity() - OPACITY_STEP));
  globalShortcut.register("Control+Alt+Q", () => app.quit());
});

app.on("will-quit", () => {
  saveSettings();
  globalShortcut.unregisterAll();
});
