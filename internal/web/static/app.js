"use strict";

const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
const state = {
  connections: [],
  panes: {
    left: makePaneState(),
    right: makePaneState()
  },
  pendingTrust: null,
  activePane: "left",
  selectionAnchor: { left: null, right: null },
  activity: [],
  actionResolver: null,
  localLocations: []
};

const $ = (sel, root = document) => root.querySelector(sel);
const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function makePaneState() {
  return {
    mode: "remote",
    connectionId: 0,
    path: "/",
    selected: [],
    localRoot: null,
    localRootId: "",
    localRootName: "",
    localHandles: new Map()
  };
}

function localDeckSupported() {
  return window.isSecureContext && typeof window.showDirectoryPicker === "function" && "indexedDB" in window;
}

function openLocalDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open("simplescp-local", 1);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains("locations")) {
        db.createObjectStore("locations", { keyPath:"id" });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error("Unable to open local location storage.")); };
  });
}

async function loadLocalLocations() {
  if (!("indexedDB" in window)) {
    state.localLocations = [];
    return;
  }
  const db = await openLocalDB();
  state.localLocations = await new Promise(function (resolve, reject) {
    const tx = db.transaction("locations", "readonly");
    const req = tx.objectStore("locations").getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error || new Error("Unable to load local locations.")); };
  });
  db.close();
  updateLocalLocationStatus();
}

async function saveLocalLocation(handle) {
  const id = "loc-" + crypto.randomUUID();
  const record = { id:id, name:handle.name || "Local location", handle:handle, addedAt:Date.now() };
  const db = await openLocalDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction("locations", "readwrite");
    tx.objectStore("locations").put(record);
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error || new Error("Unable to save local location.")); };
  });
  db.close();
  state.localLocations.push(record);
  updateLocalLocationStatus();
  return record;
}

async function removeLocalLocation(id) {
  const db = await openLocalDB();
  await new Promise(function (resolve, reject) {
    const tx = db.transaction("locations", "readwrite");
    tx.objectStore("locations").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error || new Error("Unable to remove local location.")); };
  });
  db.close();
  state.localLocations = state.localLocations.filter(function (item) { return item.id !== id; });
  updateLocalLocationStatus();
}

function updateLocalLocationStatus() {
  const el = $("#localLocationStatus");
  if (!el) return;
  const count = state.localLocations.length;
  el.textContent = count
    ? "Local computer: " + count + " saved location" + (count === 1 ? "" : "s")
    : "Local computer: no saved locations";
}

async function ensureLocalPermission(record) {
  if (!record || !record.handle) return false;
  const opts = { mode:"readwrite" };
  if (typeof record.handle.queryPermission === "function") {
    const current = await record.handle.queryPermission(opts);
    if (current === "granted") return true;
  }
  if (typeof record.handle.requestPermission === "function") {
    return (await record.handle.requestPermission(opts)) === "granted";
  }
  return true;
}

async function addLocalLocation(side) {
  if (!localDeckSupported()) {
    toast("Local computer access requires Chrome or Edge over HTTPS (or localhost).", "error");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode:"readwrite", id:"simplescp-local-" + side });
    const record = await saveLocalLocation(handle);
    const pane = state.panes[side];
    pane.mode = "browser";
    pane.connectionId = 0;
    pane.path = "/";
    pane.selected = [];
    pane.localRoot = handle;
    pane.localRootId = record.id;
    pane.localRootName = record.name;
    pane.localHandles = new Map();
    renderServerSelects();
    await loadPane(side);
  } catch (err) {
    if (!err || err.name !== "AbortError") {
      toast(err && err.message ? err.message : "Unable to add local location.", "error");
    }
  }
}

async function selectLocalLocation(side, id) {
  const record = state.localLocations.find(function (item) { return item.id === id; });
  if (!record) return;
  if (!await ensureLocalPermission(record)) {
    toast("Permission to this local location was not granted.", "error");
    return;
  }
  const pane = state.panes[side];
  pane.mode = "browser";
  pane.connectionId = 0;
  pane.path = "/";
  pane.selected = [];
  pane.localRoot = record.handle;
  pane.localRootId = record.id;
  pane.localRootName = record.name;
  pane.localHandles = new Map();
  renderServerSelects();
  await loadPane(side);
}

function toast(message, type) {
  const host = $("#toastHost");
  if (!host) return;
  const item = document.createElement("div");
  item.className = "toast " + (type || "");
  item.textContent = message;
  host.appendChild(item);
  setTimeout(function () { item.remove(); }, 4200);
}

function setStatus(message, type) {
  const el = $("#status");
  if (!el) return;
  el.className = "status " + (type || "ready");
  el.innerHTML = '<span class="status-dot"></span><span></span>';
  el.lastElementChild.textContent = message;
}

async function api(url, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, opts.headers || {});
  const method = String(opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") opts.headers["X-CSRF-Token"] = csrf;
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(url, opts);
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Session expired");
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.indexOf("application/json") !== -1 ? await response.json() : await response.text();
  if (!response.ok) {
    const message = data && data.error ? data.error : (data || "Request failed (" + response.status + ")");
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = String(value == null ? "" : value);
  return div.innerHTML;
}

function bytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  for (const unit of units) {
    if (v < 1024 || unit === "TB") return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + " " + unit;
    v /= 1024;
  }
  return n + " B";
}

function normalizePath(value) {
  const parts = String(value || "/").replaceAll("\\\\", "/").split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

function parentPath(value) {
  const p = normalizePath(value);
  if (p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

function connectionById(id) {
  return state.connections.find(function (c) { return Number(c.id) === Number(id); });
}

function setActivePane(side) {
  state.activePane = side;
  document.querySelectorAll(".file-pane").forEach(function (pane) {
    pane.classList.toggle("active-pane", pane.dataset.pane === side);
  });
}

function renderBreadcrumbs(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const host = $(".breadcrumbs", el);
  if (!host) return;

  if (pane.mode === "bridge") {
    const label = pane.path || "This PC";
    host.innerHTML = '<button type="button" class="breadcrumb current">' + escapeHTML(label) + '</button>';
    return;
  }

  const parts = normalizePath(pane.path).split("/").filter(Boolean);
  const crumbs = [{ label: pane.mode === "browser" ? (pane.localRootName || "Local") : "/", path: "/" }];
  let current = "";
  parts.forEach(function (part) {
    current += "/" + part;
    crumbs.push({ label: part, path: current });
  });

  host.innerHTML = crumbs.map(function (crumb, index) {
    const last = index === crumbs.length - 1;
    return '<button type="button" class="breadcrumb' + (last ? " current" : "") + '" data-path="' + escapeHTML(crumb.path) + '">' +
      escapeHTML(crumb.label) + '</button>' + (last ? "" : '<span class="breadcrumb-sep">›</span>');
  }).join("");

  host.querySelectorAll(".breadcrumb").forEach(function (button) {
    button.addEventListener("click", function () {
      pane.path = button.dataset.path;
      loadPane(side);
    });
  });
}

function fileKind(name, isDir) {
  if (isDir) return { icon: "▰", kind: "folder" };
  const lower = String(name || "").toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  if (["jpg","jpeg","png","gif","webp","svg","bmp","ico"].includes(ext)) return { icon: "▧", kind: "image" };
  if (["zip","tar","gz","tgz","bz2","xz","7z","rar"].includes(ext)) return { icon: "▤", kind: "archive" };
  if (["js","ts","go","py","php","rb","rs","java","c","cpp","h","css","html","json","yaml","yml","xml","sh"].includes(ext)) return { icon: "‹›", kind: "code" };
  if (["mp3","wav","flac","aac","ogg","m4a"].includes(ext)) return { icon: "♪", kind: "audio" };
  if (["mp4","mkv","mov","avi","webm","m4v"].includes(ext)) return { icon: "▶", kind: "video" };
  if (["pdf","doc","docx","txt","md","rtf","odt","xls","xlsx","csv"].includes(ext)) return { icon: "≡", kind: "document" };
  return { icon: "•", kind: "file" };
}

function filterPane(side, query) {
  const q = String(query || "").trim().toLowerCase();
  const el = paneElement(side);
  let visible = 0;
  el.querySelectorAll(".entry-row").forEach(function (row) {
    const show = !q || String(row.dataset.name || "").toLowerCase().includes(q);
    row.hidden = !show;
    if (show) visible++;
  });
  el.classList.toggle("filtering", Boolean(q));
  const counter = $(".filter-count", el);
  if (counter) counter.textContent = q ? visible + " shown" : "";
}

function addActivity(type, title, detail, status) {
  const item = {
    id: Date.now() + Math.random(),
    type: type,
    title: title,
    detail: detail || "",
    status: status || "success",
    time: new Date()
  };
  state.activity.unshift(item);
  state.activity = state.activity.slice(0, 30);
  renderActivity();
  return item.id;
}

function updateActivity(id, status, detail) {
  const item = state.activity.find(function (entry) { return entry.id === id; });
  if (!item) return;
  item.status = status;
  if (detail) item.detail = detail;
  renderActivity();
}

function showActionDialog(options) {
  const dialog = $("#actionDialog");
  const form = $("#actionForm");
  const inputWrap = $("#actionInputWrap");
  const input = $("#actionInput");
  const warning = $("#actionWarning");
  const confirmButton = $("#actionConfirm");

  $("#actionEyebrow").textContent = options.eyebrow || "FILE ACTION";
  $("#actionTitle").textContent = options.title || "Confirm action";
  $("#actionDescription").textContent = options.description || "";
  $("#actionInputHint").textContent = options.hint || "";
  confirmButton.textContent = options.confirmLabel || "Continue";
  confirmButton.classList.toggle("danger", Boolean(options.danger));
  confirmButton.classList.toggle("primary", !options.danger);

  inputWrap.classList.toggle("hidden", !options.input);
  warning.classList.toggle("hidden", !options.warning);
  warning.textContent = options.warning || "";

  input.value = options.value || "";
  input.placeholder = options.placeholder || "";

  dialog.showModal();
  if (options.input) {
    requestAnimationFrame(function () {
      input.focus();
      input.select();
    });
  } else {
    requestAnimationFrame(function () { confirmButton.focus(); });
  }

  return new Promise(function (resolve) {
    state.actionResolver = resolve;
  });
}

function resolveActionDialog(value) {
  if (state.actionResolver) {
    state.actionResolver(value);
    state.actionResolver = null;
  }
  $("#actionDialog").close();
}

function renderActivity() {
  const list = $("#activityList");
  const summary = $("#activitySummary");
  if (!list || !summary) return;

  if (!state.activity.length) {
    summary.textContent = "No recent transfers";
    list.innerHTML = '<div class="activity-empty">Uploads, copies, deletes and connection activity will appear here.</div>';
    return;
  }

  const active = state.activity.filter(function (item) { return item.status === "busy"; }).length;
  summary.textContent = active ? active + " operation" + (active === 1 ? "" : "s") + " running" : state.activity.length + " recent operation" + (state.activity.length === 1 ? "" : "s");

  list.innerHTML = state.activity.map(function (item) {
    return '<div class="activity-item ' + escapeHTML(item.status) + '">' +
      '<span class="activity-status-icon">' + (item.status === "busy" ? "↻" : item.status === "error" ? "!" : "✓") + '</span>' +
      '<div class="activity-copy"><strong>' + escapeHTML(item.title) + '</strong><span>' + escapeHTML(item.detail) + '</span></div>' +
      '<time>' + item.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + '</time>' +
      '</div>';
  }).join("");
}

function paneElement(side) {
  return document.querySelector('.file-pane[data-pane="' + side + '"]');
}

async function loadConnections() {
  const data = await api("/api/connections");
  state.connections = data.connections || [];
  renderConnections();
  renderServerSelects();
}

function renderConnections() {
  const host = $("#connectionsList");
  if (!state.connections.length) {
    host.innerHTML = '<div class="empty-state"><strong>No saved servers</strong><span>Add your first SSH connection to start browsing remote files.</span></div>';
    return;
  }
  host.innerHTML = state.connections.map(function (c) {
    const trusted = Boolean(c.host_key_fingerprint);
    return '<div class="connection-card" data-id="' + c.id + '">' +
      '<div class="connection-card-top">' +
        '<div class="name"><span class="trust-dot ' + (trusted ? "trusted" : "") + '"></span>' + escapeHTML(c.name) + '</div>' +
        '<span class="connection-state ' + (trusted ? "trusted" : "") + '">' + (trusted ? "Verified" : "Unverified") + '</span>' +
      '</div>' +
      '<div class="meta">' + escapeHTML(c.username) + '@' + escapeHTML(c.host) + ':' + c.port + '</div>' +
      '<div class="connection-actions">' +
      '<button data-action="left">Open left</button>' +
      '<button data-action="right">Open right</button>' +
      '<button data-action="edit" title="Edit connection" aria-label="Edit connection">•••</button>' +
      '</div></div>';
  }).join("");

  all(".connection-card", host).forEach(function (card) {
    card.addEventListener("click", function (event) {
      const btn = event.target.closest("button");
      if (!btn) return;
      const id = Number(card.dataset.id);
      if (btn.dataset.action === "edit") openConnectionDialog(id);
      else connectPane(btn.dataset.action, id);
    });
  });
}

function renderServerSelects() {
  all(".file-pane").forEach(function (paneEl) {
    const side = paneEl.dataset.pane;
    const pane = state.panes[side];

    const endpoint = $(".endpoint-type", paneEl);
    endpoint.value = pane.mode === "browser" ? "browser" : pane.mode;

    const server = $(".server-select", paneEl);
    let serverHTML = '<option value="">Choose session…</option>';
    state.connections.forEach(function (c) {
      serverHTML += '<option value="' + c.id + '"' + (pane.mode === "remote" && Number(pane.connectionId) === Number(c.id) ? " selected" : "") + '>' + escapeHTML(c.name) + '</option>';
    });
    server.innerHTML = serverHTML;

    const drives = $(".local-drive-select", paneEl);
    drives.innerHTML = '<option value="">This PC</option>' + state.bridge.roots.map(function (root) {
      return '<option value="' + escapeHTML(root.path) + '"' + (pane.mode === "bridge" && pane.bridgeRoot === root.path ? " selected" : "") + '>' +
        escapeHTML(root.name + (root.kind === "drive" ? "" : " · " + root.kind)) + '</option>';
    }).join("");
  });
}

async function connectPane(side, id) {
  const c = connectionById(id);
  if (!c) return;
  const pane = state.panes[side];
  pane.mode = "remote";
  pane.connectionId = Number(id);
  pane.path = normalizePath(c.default_path || "/");
  pane.selected = [];
  pane.bridgeRoot = "";
  pane.localRoot = null;
  pane.localRootName = "";
  pane.localHandles = new Map();
  renderServerSelects();
  await loadPane(side);
}

function localDeckSupported() {
  return window.isSecureContext && typeof window.showDirectoryPicker === "function";
}

async function openLocalDeck(side) {
  if (!localDeckSupported()) {
    renderServerSelects();
    toast("Local computer access requires Chrome/Edge in a secure HTTPS context (or localhost).", "error");
    return;
  }
  try {
    const root = await window.showDirectoryPicker({ mode: "readwrite", id: "simplescp-" + side });
    const pane = state.panes[side];
    pane.mode = "browser";
    pane.connectionId = 0;
    pane.path = "/";
    pane.selected = [];
    pane.localRoot = root;
    pane.localRootName = root.name || "Local";
    pane.localHandles = new Map();
    renderServerSelects();
    await loadPane(side);
  } catch (err) {
    renderServerSelects();
    if (!err || err.name !== "AbortError") {
      toast(err && err.message ? err.message : "Unable to open local folder.", "error");
    }
  }
}

async function localDirectoryForPath(pane, rawPath) {
  if (!pane.localRoot) throw new Error("Choose a local folder first.");
  let current = pane.localRoot;
  const parts = normalizePath(rawPath).split("/").filter(Boolean);
  for (const part of parts) {
    current = await current.getDirectoryHandle(part);
  }
  return current;
}

function updatePaneModeUI(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const bridge = pane.mode === "bridge";
  const browser = pane.mode === "browser";
  const local = bridge || browser;

  el.classList.toggle("local-pane", local);
  el.classList.toggle("bridge-pane", bridge);
  $(".endpoint-type", el).value = pane.mode;
  $(".server-select", el).classList.toggle("hidden", pane.mode !== "remote");
  $(".local-drive-select", el).classList.toggle("hidden", !bridge);
  $(".local-pair-btn", el).classList.toggle("hidden", !bridge);
  $(".path-prefix", el).textContent = bridge ? "local:" : browser ? "folder:" : "sftp:";
  $(".upload-btn", el).textContent = browser ? "Change root" : "Upload";
  $(".download-btn", el).textContent = bridge ? "Save copy" : "Download";
  $(".path-input", el).readOnly = bridge && !pane.path;
}

async function loadLocalPane(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const tbody = $(".file-list", el);
  if (!pane.localRoot) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>No local folder granted</strong><span>Choose Local computer… and grant a folder.</span></td></tr>';
    return;
  }

  setStatus("Reading local folder…", "busy");
  try {
    const dir = await localDirectoryForPath(pane, pane.path);
    const entries = [];
    pane.localHandles = new Map();
    for await (const [name, handle] of dir.entries()) {
      const entryPath = normalizePath(pane.path + "/" + name);
      pane.localHandles.set(entryPath, handle);
      if (handle.kind === "directory") {
        entries.push({ name:name, path:entryPath, is_dir:true, size:0, mod_time:null });
      } else {
        const file = await handle.getFile();
        entries.push({ name:name, path:entryPath, is_dir:false, size:file.size, mod_time:new Date(file.lastModified).toISOString() });
      }
    }
    $(".path-input", el).value = pane.path;
    renderBreadcrumbs(side);
    renderEntries(side, entries);
    filterPane(side, $(".pane-search", el)?.value || "");
    setStatus("Ready", "ready");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">' + escapeHTML(err.message || "Unable to read local folder") + '</td></tr>';
    setStatus("Local folder unavailable", "error");
  }
}

async function loadBridgePane(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const tbody = $(".file-list", el);

  if (!state.bridge.token || !state.bridge.roots.length) {
    if (!await ensureBridge(side)) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>Local Bridge not connected</strong><span>Click Connect local to pair this computer.</span></td></tr>';
      return;
    }
  }

  if (!pane.path) {
    const roots = state.bridge.roots.map(function (root) {
      return { name:root.name, path:root.path, is_dir:true, size:0, mod_time:null };
    });
    renderEntries(side, roots);
    $(".path-input", el).value = "This PC";
    renderBreadcrumbs(side);
    setStatus("Ready", "ready");
    return;
  }

  try {
    setStatus("Reading local computer…", "busy");
    const data = await bridgeFetch("/v1/list?path=" + encodeURIComponent(pane.path));
    pane.path = data.path;
    $(".path-input", el).value = pane.path;
    renderBreadcrumbs(side);
    renderEntries(side, data.entries || []);
    filterPane(side, $(".pane-search", el)?.value || "");
    setStatus("Ready", "ready");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">' + escapeHTML(err.message) + '</td></tr>';
    setStatus("Local computer unavailable", "error");
    toast(err.message, "error");
  }
}

async function withTrustRetry(side, task) {
  try {
    return await task();
  } catch (err) {
    if (err.status === 428 && err.data && err.data.fingerprint) {
      state.pendingTrust = {
        connectionId: state.panes[side].connectionId,
        retry: task
      };
      $("#trustFingerprint").textContent = err.data.fingerprint;
      $("#trustDialog").showModal();
      return null;
    }
    throw err;
  }
}

async function loadPane(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const tbody = $(".file-list", el);
  updatePaneModeUI(side);
  $(".path-input", el).value = pane.path;
  pane.selected = [];
  state.selectionAnchor[side] = null;
  renderBreadcrumbs(side);
  updatePaneSelection(side);

  if (pane.mode === "bridge") {
    await loadBridgePane(side);
    return;
  }
  if (pane.mode === "browser") {
    await loadLocalPane(side);
    return;
  }

  if (!pane.connectionId) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>No endpoint open</strong><span>Choose a saved server or Local computer… above.</span></td></tr>';
    return;
  }

  const c = connectionById(pane.connectionId);
  setStatus("Connecting to " + (c ? c.name : "server") + "…", "busy");
  tbody.innerHTML = '<tr><td colspan="3" class="muted">Loading…</td></tr>';

  try {
    await withTrustRetry(side, async function () {
      const data = await api("/api/connections/" + pane.connectionId + "/list?path=" + encodeURIComponent(pane.path));
      pane.path = data.path;
      $(".path-input", el).value = pane.path;
      renderBreadcrumbs(side);
      renderEntries(side, data.entries || []);
      filterPane(side, $(".pane-search", el)?.value || "");
      setStatus("Ready", "ready");
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">' + escapeHTML(err.message) + '</td></tr>';
    setStatus("Connection failed", "error");
    toast(err.message, "error");
  }
}

function renderEntries(side, entries) {
  const el = paneElement(side);
  const tbody = $(".file-list", el);

  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>This folder is empty</strong><span>Upload a file or create a new folder here.</span></td></tr>';
    return;
  }

  entries.sort(function (a, b) {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  tbody.innerHTML = entries.map(function (entry) {
    const kind = fileKind(entry.name, entry.is_dir);
    return '<tr class="entry-row" role="row" aria-selected="false" data-path="' + escapeHTML(entry.path) + '" data-name="' + escapeHTML(entry.name) + '" data-dir="' + (entry.is_dir ? "1" : "0") + '" data-size="' + entry.size + '">' +
      '<td><div class="file-name"><span class="file-icon file-kind-' + kind.kind + '">' + kind.icon + '</span><span class="file-name-text">' + escapeHTML(entry.name) + '</span></div></td>' +
      '<td>' + (entry.is_dir ? "—" : bytes(entry.size)) + '</td>' +
      '<td>' + (entry.mod_time ? new Date(entry.mod_time).toLocaleString() : "—") + '</td>' +
      '</tr>';
  }).join("");

  all(".entry-row", tbody).forEach(function (row) {
    row.addEventListener("click", function (event) {
      setActivePane(side);
      selectEntry(side, row, event.ctrlKey || event.metaKey, event.shiftKey);
    });
    row.addEventListener("dblclick", function () {
      if (row.dataset.dir === "1") {
        state.panes[side].path = row.dataset.path;
        loadPane(side);
      }
    });
  });
}

function rowItem(row) {
  const side = row.closest(".file-pane")?.dataset.pane;
  const pane = side ? state.panes[side] : null;
  return {
    path: row.dataset.path,
    name: row.dataset.name,
    isDir: row.dataset.dir === "1",
    size: Number(row.dataset.size || 0),
    handle: pane && pane.mode === "browser" ? pane.localHandles.get(row.dataset.path) || null : null
  };
}

function syncRowSelection(side) {
  const selectedPaths = new Set(state.panes[side].selected.map(function (entry) { return entry.path; }));
  all(".entry-row", paneElement(side)).forEach(function (row) {
    row.classList.toggle("selected", selectedPaths.has(row.dataset.path));
    row.setAttribute("aria-selected", selectedPaths.has(row.dataset.path) ? "true" : "false");
  });
}

function selectEntry(side, row, additive, range) {
  const pane = state.panes[side];
  const rows = all(".entry-row", paneElement(side)).filter(function (candidate) { return !candidate.hidden; });
  const index = rows.indexOf(row);
  const item = rowItem(row);

  if (range && state.selectionAnchor[side] !== null && index >= 0) {
    const start = Math.min(state.selectionAnchor[side], index);
    const end = Math.max(state.selectionAnchor[side], index);
    const rangeItems = rows.slice(start, end + 1).map(rowItem);
    if (additive) {
      const merged = new Map(pane.selected.map(function (entry) { return [entry.path, entry]; }));
      rangeItems.forEach(function (entry) { merged.set(entry.path, entry); });
      pane.selected = Array.from(merged.values());
    } else {
      pane.selected = rangeItems;
    }
  } else {
    const existing = pane.selected.findIndex(function (entry) { return entry.path === item.path; });
    if (!additive) {
      pane.selected = [item];
    } else if (existing >= 0) {
      pane.selected.splice(existing, 1);
    } else {
      pane.selected.push(item);
    }
    state.selectionAnchor[side] = index >= 0 ? index : null;
  }

  syncRowSelection(side);
  updatePaneSelection(side);
}

function selectAllVisible(side) {
  const rows = all(".entry-row", paneElement(side)).filter(function (row) { return !row.hidden; });
  state.panes[side].selected = rows.map(rowItem);
  state.selectionAnchor[side] = rows.length ? 0 : null;
  syncRowSelection(side);
  updatePaneSelection(side);
}

function updatePaneSelection(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const selected = pane.selected;
  const count = selected.length;
  $(".selection-text", el).textContent = !count ? "0 selected" :
    count === 1 ? selected[0].name + (selected[0].isDir ? " · folder" : " · " + bytes(selected[0].size)) :
    count + " items selected";

  $(".download-btn", el).disabled = count !== 1 || selected[0]?.isDir || pane.mode === "browser";
  $(".delete-btn", el).disabled = count === 0;
  $(".rename-btn", el).disabled = count !== 1;

  const other = state.panes[side === "left" ? "right" : "left"];
  const destinationReady =
    other.mode === "bridge" ? Boolean(state.bridge.token && (other.path || state.bridge.roots.length)) :
    other.mode === "browser" ? Boolean(other.localRoot) :
    Boolean(other.connectionId);
  $(".copy-to-other", el).disabled = count === 0 || selected.some(function (item) { return item.isDir; }) || !destinationReady;
}

function wirePanes() {
  document.querySelectorAll(".file-pane").forEach(function (el) {
    const side = el.dataset.pane;
    el.addEventListener("pointerdown", function () { setActivePane(side); });

    $(".endpoint-type", el).addEventListener("change", async function (e) {
      const pane = state.panes[side];
      const mode = e.target.value;
      if (mode === "remote") {
        pane.mode = "remote";
        pane.path = "/";
        pane.bridgeRoot = "";
        renderServerSelects();
        await loadPane(side);
      } else if (mode === "bridge") {
        pane.mode = "bridge";
        pane.connectionId = 0;
        pane.localRoot = null;
        pane.path = "";
        pane.bridgeRoot = "";
        renderServerSelects();
        if (await ensureBridge(side)) {
          pane.path = state.bridge.roots[0]?.path || "";
          pane.bridgeRoot = pane.path;
          renderServerSelects();
          await loadPane(side);
        } else {
          updatePaneModeUI(side);
        }
      } else {
        await openLocalDeck(side);
      }
    });

    $(".server-select", el).addEventListener("change", async function (e) {
      if (e.target.value) await connectPane(side, Number(e.target.value));
    });

    $(".local-drive-select", el).addEventListener("change", async function (e) {
      const pane = state.panes[side];
      pane.mode = "bridge";
      pane.bridgeRoot = e.target.value || "";
      pane.path = e.target.value || "";
      await loadPane(side);
    });

    $(".local-pair-btn", el).addEventListener("click", function () {
      state.bridge.pendingSide = side;
      $("#localBridgeDialog").showModal();
      detectLocalBridge();
    });

    $(".pane-refresh", el).addEventListener("click", function () { loadPane(side); });
    $(".home-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      if (pane.mode === "bridge") pane.path = pane.bridgeRoot || "";
      else pane.path = "/";
      loadPane(side);
    });
    $(".go-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      pane.path = pane.mode === "bridge" ? $(".path-input", el).value.trim() : normalizePath($(".path-input", el).value);
      loadPane(side);
    });
    $(".path-input", el).addEventListener("keydown", function (e) {
      if (e.key === "Enter") $(".go-btn", el).click();
    });
    $(".up-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      pane.path = pane.mode === "bridge" ? bridgeParentPath(pane.path) : parentPath(pane.path);
      loadPane(side);
    });

    $(".upload-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      if (pane.mode === "browser") return openLocalDeck(side);
      if (pane.mode === "remote" && !pane.connectionId) return toast("Choose a session first.", "error");
      $(".upload-input", el).click();
    });
    $(".upload-input", el).addEventListener("change", function (e) { uploadFiles(side, Array.from(e.target.files)); });

    ["dragenter","dragover"].forEach(function (eventName) {
      el.addEventListener(eventName, function (e) { e.preventDefault(); el.classList.add("drag-active"); });
    });
    ["dragleave","drop"].forEach(function (eventName) {
      el.addEventListener(eventName, function (e) { e.preventDefault(); el.classList.remove("drag-active"); });
    });
    el.addEventListener("drop", function (e) {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) uploadFiles(side, files);
    });

    $(".mkdir-btn", el).addEventListener("click", function () { createFolder(side); });
    $(".rename-btn", el).addEventListener("click", function () { renameSelected(side); });
    $(".download-btn", el).addEventListener("click", function () { downloadSelected(side); });
    $(".delete-btn", el).addEventListener("click", function () { deleteSelected(side); });
    $(".copy-to-other", el).addEventListener("click", function () { copySelected(side); });
    $(".pane-search", el).addEventListener("input", function (e) { filterPane(side, e.target.value); });
  });

  $("#copyLeftToRight")?.addEventListener("click", function () { copySelected("left"); });
  $("#copyRightToLeft")?.addEventListener("click", function () { copySelected("right"); });
}

async function uploadFiles(side, files) {
  if (!files.length) return;
  const pane = state.panes[side];
  setStatus("Uploading " + files.length + " file" + (files.length === 1 ? "" : "s") + "…", "busy");
  const activityId = addActivity("upload", "Upload", files.length + " file" + (files.length === 1 ? "" : "s") + " to " + (pane.path || "destination"), "busy");
  try {
    if (pane.mode === "bridge") {
      if (!pane.path) throw new Error("Choose a local drive or folder first.");
      for (const file of files) {
        await bridgeFetch("/v1/file?path=" + encodeURIComponent(bridgeJoin(pane.path, file.name)), { method:"PUT", body:file, headers:{ "Content-Type":"application/octet-stream" } });
      }
    } else if (pane.mode === "browser") {
      throw new Error("Use drag/drop only with a remote server or Local Bridge.");
    } else {
      const form = new FormData();
      files.forEach(function (file) { form.append("files", file, file.name); });
      await withTrustRetry(side, function () {
        return api("/api/connections/" + pane.connectionId + "/upload?path=" + encodeURIComponent(pane.path), { method:"POST", body:form });
      });
    }
    updateActivity(activityId, "success", "Upload complete");
    setStatus("Upload complete", "success");
    await loadPane(side);
  } catch (err) {
    updateActivity(activityId, "error", err.message);
    setStatus("Upload failed", "error");
    toast(err.message, "error");
  }
}

async function createFolder(side) {
  const pane = state.panes[side];
  if (pane.mode === "remote" && !pane.connectionId) return toast("Choose a server first.", "error");
  if (pane.mode === "browser" && !pane.localRoot) return toast("Choose a local folder first.", "error");

  const name = await showActionDialog({
    eyebrow: "NEW FOLDER",
    title: "Create a folder",
    description: "Create a new folder in " + pane.path + ".",
    input: true,
    placeholder: "Folder name",
    hint: "Folder names cannot contain /.",
    confirmLabel: "Create folder"
  });
  if (!name) return;
  const cleanName = name.trim().replaceAll("/", "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid folder name.", "error");

  try {
    if (pane.mode === "bridge") {
      await bridgeFetch("/v1/mkdir", { method:"POST", body:{ path:bridgeJoin(pane.path, cleanName) } });
    } else if (pane.mode === "browser") {
      const dir = await localDirectoryForPath(pane, pane.path);
      await dir.getDirectoryHandle(cleanName, { create:true });
    } else {
      await withTrustRetry(side, function () {
        return api("/api/connections/" + pane.connectionId + "/mkdir", {
          method: "POST",
          body: { path: normalizePath(pane.path + "/" + cleanName) }
        });
      });
    }
    addActivity("folder", "Created folder", cleanName + " in " + pane.path, "success");
    await loadPane(side);
  } catch (err) {
    addActivity("folder", "Create folder failed", err.message, "error");
    toast(err.message, "error");
  }
}

async function copyLocalHandle(handle, destinationDir, destinationName) {
  if (!handle) throw new Error("Local file handle is no longer available.");
  if (handle.kind === "file") {
    const src = await handle.getFile();
    const destHandle = await destinationDir.getFileHandle(destinationName, { create:true });
    const writable = await destHandle.createWritable();
    await writable.write(src);
    await writable.close();
    return;
  }
  const destDir = await destinationDir.getDirectoryHandle(destinationName, { create:true });
  for await (const [childName, child] of handle.entries()) {
    await copyLocalHandle(child, destDir, childName);
  }
}

async function renameSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected[0];
  if (!selected) return;
  const nextName = await showActionDialog({
    eyebrow: "RENAME",
    title: "Rename item",
    description: "Choose a new name for " + selected.name + ".",
    input: true,
    value: selected.name,
    hint: "Names cannot contain /.",
    confirmLabel: "Rename"
  });
  if (!nextName || nextName === selected.name) return;
  const cleanName = nextName.trim().replaceAll("/", "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid name.", "error");

  try {
    if (pane.mode === "bridge") {
      await bridgeFetch("/v1/rename", { method:"POST", body:{ old_path:selected.path, new_path:bridgeJoin(pane.path, cleanName) } });
    } else if (pane.mode === "browser") {
      const parent = await localDirectoryForPath(pane, pane.path);
      const handle = selected.handle || pane.localHandles.get(selected.path);
      if (handle && typeof handle.move === "function") {
        await handle.move(parent, cleanName);
      } else {
        await copyLocalHandle(handle, parent, cleanName);
        await parent.removeEntry(selected.name, { recursive:selected.isDir });
      }
    } else {
      await api("/api/connections/" + pane.connectionId + "/rename", {
        method: "POST",
        body: { old_path:selected.path, new_path:normalizePath(pane.path + "/" + cleanName) }
      });
    }
    toast("Renamed.", "success");
    addActivity("rename", "Renamed item", selected.name + " → " + cleanName, "success");
    await loadPane(side);
  } catch (err) {
    addActivity("rename", "Rename failed", err.message, "error");
    toast(err.message, "error");
  }
}

async function downloadSelected(side) {
  const pane = state.panes[side];
  if (pane.selected.length !== 1 || pane.selected[0].isDir || pane.mode === "browser") return;
  if (pane.mode === "bridge") {
    try {
      const response = await fetch(state.bridge.base + "/v1/file?path=" + encodeURIComponent(pane.selected[0].path), {
        headers:{ Authorization:"Bearer " + state.bridge.token }
      });
      if (!response.ok) throw new Error("Unable to read local file.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = pane.selected[0].name; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  location.href = "/api/connections/" + pane.connectionId + "/download?path=" + encodeURIComponent(pane.selected[0].path);
}

async function deleteSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected.slice();
  if (!selected.length) return;
  const label = selected.length === 1 ? selected[0].name : selected.length + " selected items";
  const locationLabel = pane.mode === "browser" ? "local computer" : "remote server";
  const confirmed = await showActionDialog({
    eyebrow: "DESTRUCTIVE ACTION",
    title: selected.length === 1 ? "Delete " + label + "?" : "Delete selected items?",
    description: selected.length === 1 ? "This item will be permanently removed from the " + locationLabel + "." : selected.length + " selected items will be permanently removed from the " + locationLabel + ".",
    warning: selected.some(function (item) { return item.isDir; }) ? "Selected folders will be deleted recursively, including everything inside them." : "This action cannot be undone.",
    confirmLabel: "Delete",
    danger: true
  });
  if (!confirmed) return;

  const activityId = addActivity("delete", "Delete", selected.length + " item" + (selected.length === 1 ? "" : "s") + " from " + pane.path, "busy");
  try {
    setStatus("Deleting " + selected.length + " item" + (selected.length === 1 ? "" : "s") + "…", "busy");
    if (pane.mode === "bridge") {
      for (const item of selected) {
        await bridgeFetch("/v1/delete", { method:"POST", body:{ path:item.path, recursive:item.isDir } });
      }
    } else if (pane.mode === "browser") {
      const dir = await localDirectoryForPath(pane, pane.path);
      for (const item of selected) {
        await dir.removeEntry(item.name, { recursive:item.isDir });
      }
    } else {
      for (const item of selected) {
        await api("/api/connections/" + pane.connectionId + "/delete", {
          method: "POST",
          body: { path:item.path, recursive:item.isDir }
        });
      }
    }
    setStatus("Delete complete", "success");
    updateActivity(activityId, "success", selected.length + " item" + (selected.length === 1 ? "" : "s") + " deleted");
    await loadPane(side);
  } catch (err) {
    setStatus("Delete failed", "error");
    updateActivity(activityId, "error", err.message);
    toast(err.message, "error");
  }
}

async function remoteResponse(source, item) {
  const response = await fetch("/api/connections/" + source.connectionId + "/download?path=" + encodeURIComponent(item.path));
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Session expired");
  }
  if (!response.ok) {
    let message = "Unable to download remote file.";
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (_) {}
    throw new Error(message);
  }
  return response;
}

async function copyLocalToRemote(source, destination, destinationSide, selected) {
  for (const item of selected) {
    const handle = item.handle || source.localHandles.get(item.path);
    if (!handle || handle.kind !== "file") throw new Error("Local file handle is unavailable.");
    const file = await handle.getFile();
    const form = new FormData();
    form.append("files", file, item.name);
    await withTrustRetry(destinationSide, function () {
      return api("/api/connections/" + destination.connectionId + "/upload?path=" + encodeURIComponent(destination.path), { method:"POST", body:form });
    });
  }
}

async function copyRemoteToLocal(source, destination, selected) {
  const dir = await localDirectoryForPath(destination, destination.path);
  for (const item of selected) {
    const response = await remoteResponse(source, item);
    const destHandle = await dir.getFileHandle(item.name, { create:true });
    const writable = await destHandle.createWritable();
    if (response.body && typeof response.body.pipeTo === "function") {
      await response.body.pipeTo(writable);
    } else {
      await writable.write(await response.blob());
      await writable.close();
    }
  }
}

async function copyLocalToLocal(source, destination, selected) {
  const dir = await localDirectoryForPath(destination, destination.path);
  for (const item of selected) {
    const handle = item.handle || source.localHandles.get(item.path);
    await copyLocalHandle(handle, dir, item.name);
  }
}

async function bridgeFileBlob(item) {
  const response = await fetch(state.bridge.base + "/v1/file?path=" + encodeURIComponent(item.path), {
    headers:{ Authorization:"Bearer " + state.bridge.token }
  });
  if (!response.ok) throw new Error("Unable to read local file.");
  return response.blob();
}

async function copyBridgeToRemote(source, destination, destinationSide, selected) {
  for (const item of selected) {
    const blob = await bridgeFileBlob(item);
    const form = new FormData();
    form.append("files", blob, item.name);
    await withTrustRetry(destinationSide, function () {
      return api("/api/connections/" + destination.connectionId + "/upload?path=" + encodeURIComponent(destination.path), { method:"POST", body:form });
    });
  }
}

async function copyRemoteToBridge(source, destination, selected) {
  for (const item of selected) {
    const response = await remoteResponse(source, item);
    const blob = await response.blob();
    await bridgeFetch("/v1/file?path=" + encodeURIComponent(bridgeJoin(destination.path, item.name)), {
      method:"PUT", body:blob, headers:{ "Content-Type":"application/octet-stream" }
    });
  }
}

async function copyBridgeToBridge(source, destination, selected) {
  for (const item of selected) {
    const blob = await bridgeFileBlob(item);
    await bridgeFetch("/v1/file?path=" + encodeURIComponent(bridgeJoin(destination.path, item.name)), {
      method:"PUT", body:blob, headers:{ "Content-Type":"application/octet-stream" }
    });
  }
}

async function copySelected(side) {
  const source = state.panes[side];
  const destinationSide = side === "left" ? "right" : "left";
  const destination = state.panes[destinationSide];
  const selected = source.selected.slice();

  const destinationReady =
    destination.mode === "bridge" ? Boolean(state.bridge.token && destination.path) :
    destination.mode === "browser" ? Boolean(destination.localRoot) :
    Boolean(destination.connectionId);

  if (!selected.length || selected.some(function (item) { return item.isDir; }) || !destinationReady) return;

  setStatus("Copying " + selected.length + " file" + (selected.length === 1 ? "" : "s") + "…", "busy");
  const sourceLabel = source.mode === "bridge" ? "Local computer" : source.mode === "browser" ? "Browser folder" : (connectionById(source.connectionId)?.name || "server");
  const destinationLabel = destination.mode === "bridge" ? "Local computer" : destination.mode === "browser" ? "Browser folder" : (connectionById(destination.connectionId)?.name || "server");
  const activityId = addActivity("copy", "Transfer", sourceLabel + " → " + destinationLabel, "busy");

  try {
    if (source.mode === "bridge" && destination.mode === "remote") {
      await copyBridgeToRemote(source, destination, destinationSide, selected);
    } else if (source.mode === "remote" && destination.mode === "bridge") {
      await copyRemoteToBridge(source, destination, selected);
    } else if (source.mode === "bridge" && destination.mode === "bridge") {
      await copyBridgeToBridge(source, destination, selected);
    } else if (source.mode === "browser" && destination.mode === "remote") {
      await copyLocalToRemote(source, destination, destinationSide, selected);
    } else if (source.mode === "remote" && destination.mode === "browser") {
      await copyRemoteToLocal(source, destination, selected);
    } else if (source.mode === "browser" && destination.mode === "browser") {
      await copyLocalToLocal(source, destination, selected);
    } else {
      for (const item of selected) {
        await api("/api/transfer", {
          method:"POST",
          body:{
            source_connection_id:source.connectionId,
            source_path:item.path,
            destination_connection_id:destination.connectionId,
            destination_path:normalizePath(destination.path + "/" + item.name)
          }
        });
      }
    }
    setStatus("Transfer complete", "success");
    updateActivity(activityId, "success", selected.length + " file" + (selected.length === 1 ? "" : "s") + " copied");
    await loadPane(destinationSide);
  } catch (err) {
    setStatus("Transfer failed", "error");
    updateActivity(activityId, "error", err.message);
    toast(err.message, "error");
  }
}

function updateAuthFields() {
  const type = $("#connectionForm").elements.auth_type.value;
  all(".auth-password").forEach(function (el) { el.classList.toggle("hidden", type !== "password"); });
  all(".auth-key").forEach(function (el) { el.classList.toggle("hidden", type !== "key"); });
}

function openConnectionDialog(id) {
  id = Number(id || 0);
  const dialog = $("#connectionDialog");
  const form = $("#connectionForm");
  form.reset();
  form.elements.port.value = 22;
  form.elements.default_path.value = "/";
  form.elements.id.value = "";
  $("#deleteConnectionBtn").classList.add("hidden");
  $("#connectionDialogTitle").textContent = id ? "Edit connection" : "New connection";

  if (id) {
    const c = connectionById(id);
    if (!c) return;
    form.elements.id.value = c.id;
    form.elements.name.value = c.name;
    form.elements.host.value = c.host;
    form.elements.port.value = c.port;
    form.elements.username.value = c.username;
    form.elements.auth_type.value = c.auth_type;
    form.elements.default_path.value = c.default_path || "/";
    $("#deleteConnectionBtn").classList.remove("hidden");
  }

  updateAuthFields();
  dialog.showModal();
}

async function saveConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = Number(form.elements.id.value || 0);
  const body = {
    name: form.elements.name.value,
    host: form.elements.host.value,
    port: Number(form.elements.port.value || 22),
    username: form.elements.username.value,
    auth_type: form.elements.auth_type.value,
    password: form.elements.password.value,
    private_key: form.elements.private_key.value,
    passphrase: form.elements.passphrase.value,
    default_path: form.elements.default_path.value || "/"
  };

  try {
    await api(id ? "/api/connections/" + id : "/api/connections", {
      method: id ? "PUT" : "POST",
      body: body
    });
    $("#connectionDialog").close();
    toast(id ? "Connection updated." : "Connection saved.", "success");
    await loadConnections();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteConnection() {
  const id = Number($("#connectionForm").elements.id.value || 0);
  const c = connectionById(id);
  if (!id || !c) return;
  const confirmed = await showActionDialog({
    eyebrow: "REMOVE SERVER",
    title: "Delete " + c.name + "?",
    description: "This removes the saved connection profile from SimpleSCP. It does not modify the remote server.",
    warning: "Any saved encrypted credentials for this connection will also be removed.",
    confirmLabel: "Delete connection",
    danger: true
  });
  if (!confirmed) return;

  try {
    await api("/api/connections/" + id, { method: "DELETE" });
    $("#connectionDialog").close();
    ["left", "right"].forEach(function (side) {
      if (state.panes[side].mode === "remote" && state.panes[side].connectionId === id) state.panes[side] = makePaneState();
    });
    await loadConnections();
    await Promise.all([loadPane("left"), loadPane("right")]);
    toast("Connection deleted.", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

function wireDialogs() {
  $("#newConnectionBtn").addEventListener("click", function () { openConnectionDialog(0); });
  $("#connectionForm").addEventListener("submit", saveConnection);
  $("#connectionForm").elements.auth_type.addEventListener("change", updateAuthFields);
  all(".close-dialog").forEach(function (btn) {
    btn.addEventListener("click", function () { $("#connectionDialog").close(); });
  });
  $("#deleteConnectionBtn").addEventListener("click", deleteConnection);
  $("#cancelTrust").addEventListener("click", function () {
    state.pendingTrust = null;
    $("#trustDialog").close();
  });
  $("#confirmTrust").addEventListener("click", async function () {
    const pending = state.pendingTrust;
    if (!pending) return;
    try {
      await api("/api/connections/" + pending.connectionId + "/trust", {
        method: "POST",
        body: { fingerprint: $("#trustFingerprint").textContent.trim() }
      });
      $("#trustDialog").close();
      state.pendingTrust = null;
      await loadConnections();
      toast("Host fingerprint saved.", "success");
      await pending.retry();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function refreshUpdateStatus() {
  const dialog = $("#updateDialog");
  if (!dialog) return;
  $("#updateState").textContent = "Checking…";
  $("#installUpdateBtn").disabled = true;
  try {
    const status = await api("/api/update");
    $("#updateCurrent").textContent = status.current || "unknown";
    $("#updateLatest").textContent = status.latest || "unknown";
    $("#updateArch").textContent = status.architecture || "unknown";
    $("#updateState").textContent = status.update_available ? "Update available" : "Current";
    $("#updateMessage").textContent = status.update_available
      ? "A verified release is available. Installing it updates this same container and preserves a rollback binary."
      : "This container is already on the latest published release.";
    $("#installUpdateBtn").disabled = !status.update_available;
    $("#rollbackUpdateBtn").disabled = !status.rollback_available;
  } catch (err) {
    $("#updateState").textContent = "Check failed";
    $("#updateMessage").textContent = err.message;
  }
}

async function waitForRestart() {
  setStatus("Restarting SimpleSCP…", "busy");
  await new Promise(function (resolve) { setTimeout(resolve, 1800); });
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch("/healthz", { cache:"no-store" });
      if (response.ok) {
        location.reload();
        return;
      }
    } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  $("#updateMessage").textContent = "Update was staged. Reload the page after the container finishes restarting.";
}

function wireLocalBridge() {
  const dialog = $("#localBridgeDialog");
  if (!dialog) return;
  all(".local-bridge-close").forEach(function (button) {
    button.addEventListener("click", function () { dialog.close(); });
  });
  $("#pairLocalBridgeBtn").addEventListener("click", pairLocalBridge);
  $("#localBridgeCode").addEventListener("keydown", function (event) {
    if (event.key === "Enter") pairLocalBridge();
  });
  detectLocalBridge().then(function () { refreshBridgeRoots().then(renderServerSelects); });
}

function wireUpdater() {
  const button = $("#updateBtn");
  const dialog = $("#updateDialog");
  if (!button || !dialog) return;

  button.addEventListener("click", function () {
    dialog.showModal();
    refreshUpdateStatus();
  });
  all(".update-close").forEach(function (close) {
    close.addEventListener("click", function () { dialog.close(); });
  });
  $("#installUpdateBtn").addEventListener("click", async function () {
    this.disabled = true;
    $("#rollbackUpdateBtn").disabled = true;
    $("#updateState").textContent = "Installing…";
    $("#updateMessage").textContent = "Downloading and verifying the release binary…";
    try {
      const result = await api("/api/update/install", { method:"POST" });
      $("#updateState").textContent = "Installed " + (result.version || "");
      $("#updateMessage").textContent = "Verified update installed. Restarting this container…";
      waitForRestart();
    } catch (err) {
      $("#updateState").textContent = "Install failed";
      $("#updateMessage").textContent = err.message;
      this.disabled = false;
    }
  });
  $("#rollbackUpdateBtn").addEventListener("click", async function () {
    this.disabled = true;
    $("#installUpdateBtn").disabled = true;
    $("#updateState").textContent = "Rolling back…";
    try {
      await api("/api/update/rollback", { method:"POST" });
      $("#updateMessage").textContent = "Rollback staged. Restarting this container…";
      waitForRestart();
    } catch (err) {
      $("#updateState").textContent = "Rollback failed";
      $("#updateMessage").textContent = err.message;
      refreshUpdateStatus();
    }
  });
}

async function logout() {
  try {
    await api("/logout", { method: "POST" });
  } finally {
    location.href = "/login";
  }
}

function wirePremiumControls() {
  setActivePane("left");

  $("#actionForm")?.addEventListener("submit", function (event) {
    event.preventDefault();
    const inputVisible = !$("#actionInputWrap").classList.contains("hidden");
    resolveActionDialog(inputVisible ? $("#actionInput").value.trim() : true);
  });

  document.querySelectorAll(".action-cancel").forEach(function (button) {
    button.addEventListener("click", function () { resolveActionDialog(null); });
  });

  $("#actionDialog")?.addEventListener("cancel", function (event) {
    event.preventDefault();
    resolveActionDialog(null);
  });

  $("#activityToggle")?.addEventListener("click", function () {
    const drawer = $("#activityDrawer");
    const collapsed = drawer.classList.toggle("collapsed");
    this.setAttribute("aria-expanded", String(!collapsed));
  });

  $("#clearActivity")?.addEventListener("click", function () {
    state.activity = state.activity.filter(function (item) { return item.status === "busy"; });
    renderActivity();
  });

  document.addEventListener("keydown", function (event) {
    const target = event.target;
    const typing = target && ["INPUT","TEXTAREA","SELECT"].includes(target.tagName);
    const side = state.activePane;
    const pane = paneElement(side);

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $(".pane-search", pane)?.focus();
      $(".pane-search", pane)?.select();
      return;
    }

    if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllVisible(side);
      return;
    }

    if (typing) return;

    if (event.key === "F5") {
      event.preventDefault();
      loadPane(side);
    } else if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      state.panes[side].path = parentPath(state.panes[side].path);
      loadPane(side);
    } else if (event.key === "Delete" && state.panes[side].selected.length) {
      event.preventDefault();
      deleteSelected(side);
    } else if (event.key === "Escape") {
      state.panes[side].selected = [];
      state.selectionAnchor[side] = null;
      pane.querySelectorAll(".entry-row").forEach(function (row) { row.classList.remove("selected"); });
      updatePaneSelection(side);
    }
  });
}

document.addEventListener("DOMContentLoaded", async function () {
  wirePanes();
  wirePremiumControls();
  wireDialogs();
  wireLocalBridge();
  wireUpdater();
  $("#logoutBtn").addEventListener("click", logout);
  $("#refreshConnections").addEventListener("click", loadConnections);
  try {
    await loadConnections();
    await Promise.all([loadPane("left"), loadPane("right")]);
    setStatus("Ready", "ready");
  } catch (err) {
    toast(err.message, "error");
    setStatus("Unable to load connections", "error");
  }
});
