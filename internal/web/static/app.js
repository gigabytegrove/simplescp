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
  desktop: {
    available: false,
    info: null,
    device: null,
    roots: [],
    ticket: "",
    expires: 0
  }
};

const $ = (sel, root = document) => root.querySelector(sel);
const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function makePaneState() {
  return {
    mode: "remote",
    connectionId: 0,
    path: "/",
    selected: [],
    localRootId: "",
    localRootName: ""
  };
}

function updateLocalLocationStatus() {
  const el = $("#localLocationStatus");
  if (!el) return;
  if (!state.desktop.available) {
    el.textContent = "Local computer: open through SimpleSCP Desktop";
    return;
  }
  const name = state.desktop.device?.name || state.desktop.info?.device_name || "SimpleSCP Desktop";
  el.textContent = "Local computer: " + name + " · " + state.desktop.roots.length + " available location" + (state.desktop.roots.length === 1 ? "" : "s");
}

async function detectDesktop() {
  try {
    const response = await fetch("/_desktop/info", { cache:"no-store" });
    if (!response.ok) throw new Error("Desktop unavailable");
    const info = await response.json();
    if (!info || !info.available) throw new Error("Desktop unavailable");
    state.desktop.available = true;
    state.desktop.info = info;
    await api("/api/desktop/enroll", {
      method:"POST",
      body:{ roots: info.roots || [] }
    });
    await refreshDesktopAccess();
    return true;
  } catch (_) {
    state.desktop.available = false;
    state.desktop.info = null;
    state.desktop.device = null;
    state.desktop.roots = [];
    state.desktop.ticket = "";
    state.desktop.expires = 0;
    updateLocalLocationStatus();
    return false;
  }
}

async function refreshDesktopAccess() {
  if (!state.desktop.available) throw new Error("Open this server through SimpleSCP Desktop to use Local computer.");
  const data = await api("/api/desktop/access");
  state.desktop.device = data.device || null;
  state.desktop.roots = data.roots || [];
  state.desktop.ticket = data.ticket || "";
  state.desktop.expires = Number(data.expires || 0);
  updateLocalLocationStatus();
  renderServerSelects();
  return data;
}

async function ensureDesktopTicket() {
  const now = Math.floor(Date.now() / 1000);
  if (!state.desktop.ticket || state.desktop.expires <= now + 45) {
    await refreshDesktopAccess();
  }
}

async function desktopFetch(url, options) {
  await ensureDesktopTicket();
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, opts.headers || {}, {
    "X-SimpleSCP-Access": state.desktop.ticket
  });
  if (opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(url, opts);
  if (response.status === 403 && state.desktop.available) {
    state.desktop.ticket = "";
  }
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : (data || "Desktop request failed"));
  }
  return data;
}

async function desktopFileResponse(path) {
  await ensureDesktopTicket();
  const response = await fetch("/_desktop/file?path=" + encodeURIComponent(path), {
    headers: { "X-SimpleSCP-Access": state.desktop.ticket }
  });
  if (!response.ok) {
    let message = "Unable to read local file.";
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (_) {}
    throw new Error(message);
  }
  return response;
}

function desktopRootById(id) {
  return state.desktop.roots.find(function (root) { return Number(root.id) === Number(id); }) || null;
}

function desktopSeparator(path) {
  return String(path || "").includes("\\") ? "\\" : "/";
}

function desktopJoin(base, name) {
  const sep = desktopSeparator(base);
  return String(base || "").replace(/[\\/]+$/, "") + sep + String(name || "").replace(/^[\\/]+/, "");
}

function desktopSamePath(a, b) {
  const left = String(a || "").replace(/[\\/]+$/, "");
  const right = String(b || "").replace(/[\\/]+$/, "");
  const windows = left.includes("\\") || /^[A-Za-z]:/.test(left);
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function desktopParent(path, rootPath) {
  if (desktopSamePath(path, rootPath)) return "";
  const trimmed = String(path || "").replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return rootPath;
  let parent = trimmed.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) parent += "\\";
  if (!parent) parent = "/";
  return parent;
}

function desktopRelativeParts(path, rootPath) {
  const raw = String(path || "");
  const root = String(rootPath || "");
  let relative = raw;
  if (raw.toLowerCase().startsWith(root.toLowerCase())) {
    relative = raw.slice(root.length);
  }
  return relative.split(/[\\/]+/).filter(Boolean);
}

async function showLocalComputer(side) {
  if (!state.desktop.available) {
    toast("Local computer requires SimpleSCP Desktop. Open this server from the Desktop application.", "error");
    state.panes[side].mode = "remote";
    renderServerSelects();
    return;
  }
  const pane = state.panes[side];
  pane.mode = "desktop";
  pane.connectionId = 0;
  pane.path = "";
  pane.selected = [];
  pane.localRootId = "";
  pane.localRootName = "";
  renderServerSelects();
  await loadPane(side);
}

async function selectDesktopRoot(side, id) {
  const root = desktopRootById(id);
  if (!root) return;
  const pane = state.panes[side];
  pane.mode = "desktop";
  pane.connectionId = 0;
  pane.path = root.path;
  pane.selected = [];
  pane.localRootId = String(root.id);
  pane.localRootName = root.name;
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

  if (pane.mode === "desktop") {
    if (!pane.localRootId) {
      host.innerHTML = '<button type="button" class="breadcrumb current" data-desktop-home="1">This PC</button>';
      return;
    }
    const root = desktopRootById(pane.localRootId);
    if (!root) {
      host.innerHTML = '<button type="button" class="breadcrumb current" data-desktop-home="1">This PC</button>';
      return;
    }
    const parts = desktopRelativeParts(pane.path, root.path);
    const crumbs = [{label:"This PC",home:true},{label:root.name,path:root.path}];
    let current = root.path;
    parts.forEach(function (part) {
      current = desktopJoin(current, part);
      crumbs.push({label:part,path:current});
    });
    host.innerHTML = crumbs.map(function (crumb,index) {
      const last=index===crumbs.length-1;
      return '<button type="button" class="breadcrumb' + (last ? " current" : "") + '"' +
        (crumb.home ? ' data-desktop-home="1"' : ' data-path="' + escapeHTML(crumb.path) + '"') +
        '>' + escapeHTML(crumb.label) + '</button>' + (last ? "" : '<span class="breadcrumb-sep">›</span>');
    }).join("");
    all(".breadcrumb",host).forEach(function(button){
      button.addEventListener("click",function(){
        if(button.dataset.desktopHome==="1") showLocalComputer(side);
        else { pane.path=button.dataset.path; loadPane(side); }
      });
    });
    return;
  }

  const parts = normalizePath(pane.path).split("/").filter(Boolean);
  const crumbs = [{ label:"/", path:"/" }];
  let current = "";
  parts.forEach(function (part) {
    current += "/" + part;
    crumbs.push({ label:part, path:current });
  });
  host.innerHTML = crumbs.map(function (crumb,index) {
    const last=index===crumbs.length-1;
    return '<button type="button" class="breadcrumb' + (last ? " current" : "") + '" data-path="' + escapeHTML(crumb.path) + '">' +
      escapeHTML(crumb.label) + '</button>' + (last ? "" : '<span class="breadcrumb-sep">›</span>');
  }).join("");
  all(".breadcrumb",host).forEach(function(button){
    button.addEventListener("click",function(){ pane.path=button.dataset.path; loadPane(side); });
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
    host.innerHTML = '<div class="empty-state"><strong>No saved sessions</strong><span>Create a session to connect to a remote server.</span></div>';
    return;
  }

  host.innerHTML = state.connections.map(function (c) {
    const trusted = Boolean(c.host_key_fingerprint);
    const title = c.username + "@" + c.host + ":" + c.port;
    return '<div class="connection-card" data-id="' + c.id + '" title="' + escapeHTML(title) + '">' +
      '<div class="connection-card-top">' +
        '<div class="name"><span class="trust-dot ' + (trusted ? "trusted" : "") + '"></span><span class="connection-name">' + escapeHTML(c.name) + '</span></div>' +
      '</div>' +
      '<div class="connection-actions">' +
        '<button data-action="left" title="Open in left pane" aria-label="Open ' + escapeHTML(c.name) + ' in left pane">L</button>' +
        '<button data-action="right" title="Open in right pane" aria-label="Open ' + escapeHTML(c.name) + ' in right pane">R</button>' +
        '<button data-action="edit" title="Edit session" aria-label="Edit ' + escapeHTML(c.name) + '">•••</button>' +
      '</div></div>';
  }).join("");

  all(".connection-card", host).forEach(function (card) {
    card.addEventListener("click", function (event) {
      const id = Number(card.dataset.id);
      const btn = event.target.closest("button");
      if (btn) {
        if (btn.dataset.action === "edit") openConnectionDialog(id);
        else connectPane(btn.dataset.action, id);
        return;
      }
      connectPane(state.activePane, id);
    });
  });
}

function renderServerSelects() {
  all(".file-pane").forEach(function (paneEl) {
    const pane = state.panes[paneEl.dataset.pane];
    $(".endpoint-type", paneEl).value = pane.mode;

    const server = $(".server-select", paneEl);
    let serverHTML = '<option value="">Select server…</option>';
    state.connections.forEach(function (c) {
      serverHTML += '<option value="' + c.id + '"' + (pane.mode === "remote" && Number(pane.connectionId) === Number(c.id) ? " selected" : "") + '>' + escapeHTML(c.name) + '</option>';
    });
    server.innerHTML = serverHTML;

    const locations = $(".local-location-select", paneEl);
    let localHTML = '<option value="__thispc__"' + (pane.mode === "desktop" && !pane.localRootId ? " selected" : "") + '>This PC</option>';
    state.desktop.roots.forEach(function (root) {
      localHTML += '<option value="' + root.id + '"' + (pane.mode === "desktop" && Number(pane.localRootId) === Number(root.id) ? " selected" : "") + '>' + escapeHTML(root.name) + '</option>';
    });
    locations.innerHTML = localHTML;
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
  pane.localRootId = "";
  pane.localRootName = "";
  renderServerSelects();
  await loadPane(side);
}

async function openLocalDeck(side) {
  await showLocalComputer(side);
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
  const local = pane.mode === "desktop";
  const home = local && !pane.localRootId;

  el.classList.toggle("local-pane", local);
  el.classList.toggle("local-home", home);
  $(".endpoint-type", el).value = pane.mode;
  $(".server-select", el).classList.toggle("hidden", local);
  $(".local-location-select", el).classList.toggle("hidden", !local);
  $(".path-prefix", el).textContent = local ? "local" : "sftp";
  $(".path-input", el).value = home ? "This PC" : pane.path;
  $(".path-input", el).readOnly = home;
  $(".upload-btn", el).textContent = local ? "Import" : "Upload";
  $(".mkdir-btn", el).disabled = home;
}

async function loadDesktopPane(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const tbody = $(".file-list", el);

  if (!state.desktop.available) {
    tbody.innerHTML = '<tr><td colspan="3"><div class="local-welcome"><div class="local-welcome-icon">⌂</div><strong>SimpleSCP Desktop is not active</strong><span>Open this server through the SimpleSCP Desktop application to access local disks and mounted filesystems.</span></div></td></tr>';
    setStatus("Desktop unavailable","error");
    return;
  }

  if (!pane.localRootId) {
    const entries = state.desktop.roots.map(function(root){
      return {
        name:root.name,
        path:root.path,
        is_dir:true,
        size:Number(root.total_bytes || 0),
        mod_time:null,
        local_root_id:String(root.id),
        local_kind:root.kind,
        local_detail:root.detail || "",
        free_bytes:Number(root.free_bytes || 0)
      };
    });
    $(".path-input",el).value="This PC";
    renderBreadcrumbs(side);
    renderEntries(side,entries);
    filterPane(side,$(".pane-search",el)?.value||"");
    setStatus("Local computer","ready");
    updatePaneSelection(side);
    return;
  }

  try {
    setStatus("Reading local files…","busy");
    const data = await desktopFetch("/_desktop/list?path=" + encodeURIComponent(pane.path));
    pane.path = data.path;
    $(".path-input",el).value = pane.path;
    renderBreadcrumbs(side);
    renderEntries(side,data.entries || []);
    filterPane(side,$(".pane-search",el)?.value||"");
    setStatus("Ready","ready");
  } catch(err) {
    tbody.innerHTML='<tr><td colspan="3" class="muted empty-pane-message"><strong>Unable to read local computer</strong><span>'+escapeHTML(err.message)+'</span></td></tr>';
    setStatus("Local access failed","error");
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

  if (pane.mode === "desktop") {
    await loadDesktopPane(side);
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
    tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>This location is empty</strong><span>There are no items in this location.</span></td></tr>';
    return;
  }

  entries.sort(function (a, b) {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity:"base" });
  });

  tbody.innerHTML = entries.map(function (entry) {
    const isLocalRoot = Boolean(entry.local_root_id);
    const kind = isLocalRoot
      ? { icon: entry.local_kind === "network" ? "⇄" : entry.local_kind === "removable" ? "▣" : "▰", kind:"drive" }
      : fileKind(entry.name, entry.is_dir);
    const rootUsage = isLocalRoot && Number(entry.size || 0) > 0
      ? bytes(Math.max(0, Number(entry.size || 0) - Number(entry.free_bytes || 0))) + " used"
      : "Location";
    return '<tr class="entry-row' + (isLocalRoot ? " local-root-row" : "") + '" role="row" aria-selected="false" ' +
      'data-path="' + escapeHTML(entry.path) + '" data-name="' + escapeHTML(entry.name) + '" ' +
      'data-dir="' + (entry.is_dir ? "1" : "0") + '" data-size="' + Number(entry.size || 0) + '"' +
      (isLocalRoot ? ' data-local-root-id="' + escapeHTML(entry.local_root_id) + '"' : "") + '>' +
      '<td><div class="file-name"><span class="file-icon file-kind-' + kind.kind + '">' + kind.icon + '</span>' +
      '<span class="file-name-text">' + escapeHTML(entry.name) + '</span>' +
      (isLocalRoot ? '<span class="entry-badge">' + escapeHTML((entry.local_kind || "drive").toUpperCase()) + '</span>' : "") +
      '</div></td>' +
      '<td>' + (isLocalRoot ? escapeHTML(rootUsage) : entry.is_dir ? "—" : bytes(entry.size)) + '</td>' +
      '<td>' + (isLocalRoot ? escapeHTML(entry.local_detail || "") : entry.mod_time ? new Date(entry.mod_time).toLocaleString() : "—") + '</td>' +
      '</tr>';
  }).join("");

  all(".entry-row", tbody).forEach(function (row) {
    row.addEventListener("click", function (event) {
      setActivePane(side);
      selectEntry(side, row, event.ctrlKey || event.metaKey, event.shiftKey);
    });
    row.addEventListener("dblclick", async function () {
      if (row.dataset.localRootId) {
        await selectDesktopRoot(side, row.dataset.localRootId);
        return;
      }
      if (row.dataset.dir === "1") {
        state.panes[side].path = row.dataset.path;
        loadPane(side);
      }
    });
  });
}

function rowItem(row) {
  return {
    path: row.dataset.path,
    name: row.dataset.name,
    isDir: row.dataset.dir === "1",
    size: Number(row.dataset.size || 0),
    localRootId: row.dataset.localRootId || ""
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
  const hasLocalRoot = selected.some(function (item) { return Boolean(item.localRootId); });
  const access = pane.mode === "desktop" && pane.localRootId ? desktopRootById(pane.localRootId) : null;

  $(".selection-text", el).textContent = !count ? "0 selected" :
    count === 1 ? selected[0].name + (selected[0].localRootId ? " · local drive" : selected[0].isDir ? " · folder" : " · " + bytes(selected[0].size)) :
    count + " items selected";

  $(".download-btn", el).disabled = count !== 1 || selected[0]?.isDir || hasLocalRoot;
  $(".delete-btn", el).disabled = count === 0 || hasLocalRoot || (pane.mode === "desktop" && access && !access.can_delete);
  $(".rename-btn", el).disabled = count !== 1 || hasLocalRoot || (pane.mode === "desktop" && access && !access.can_rename);
  $(".mkdir-btn", el).disabled = pane.mode === "desktop" ? (!pane.localRootId || (access && !access.can_write)) : false;

  const other = state.panes[side === "left" ? "right" : "left"];
  const destinationReady = other.mode === "desktop" ? Boolean(other.localRootId) : Boolean(other.connectionId);
  const destinationAccess = other.mode === "desktop" && other.localRootId ? desktopRootById(other.localRootId) : null;
  const blocked = count === 0 || hasLocalRoot || selected.some(function (item) { return item.isDir; }) ||
    !destinationReady || (other.mode === "desktop" && destinationAccess && !destinationAccess.can_write);
  $(".copy-to-other", el).disabled = blocked;
  const centerButton = side === "left" ? $("#copyLeftToRight") : $("#copyRightToLeft");
  if (centerButton) centerButton.disabled = blocked;
}

function wirePanes() {
  document.querySelectorAll(".file-pane").forEach(function (el) {
    const side = el.dataset.pane;
    el.addEventListener("pointerdown", function () { setActivePane(side); });

    $(".endpoint-type", el).addEventListener("change", async function (e) {
      const pane = state.panes[side];
      if (e.target.value === "remote") {
        pane.mode = "remote";
        pane.path = "/";
        pane.localRootId = "";
        pane.localRootName = "";
        renderServerSelects();
        await loadPane(side);
      } else {
        await showLocalComputer(side);
      }
    });

    $(".server-select", el).addEventListener("change", async function (e) {
      if (e.target.value) await connectPane(side, Number(e.target.value));
    });

    $(".local-location-select", el).addEventListener("change", async function (e) {
      if (e.target.value === "__thispc__") await showLocalComputer(side);
      else if (e.target.value) await selectDesktopRoot(side, e.target.value);
    });

    $(".pane-refresh", el).addEventListener("click", async function () {
      if (state.panes[side].mode === "desktop") {
        try { await refreshDesktopAccess(); } catch (_) {}
      }
      loadPane(side);
    });
    $(".home-btn", el).addEventListener("click", function () {
      if (state.panes[side].mode === "desktop") showLocalComputer(side);
      else {
        state.panes[side].path = "/";
        loadPane(side);
      }
    });
    $(".go-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      if (pane.mode === "desktop") {
        const value = $(".path-input", el).value.trim();
        if (value && value !== "This PC") {
          pane.path = value;
          loadPane(side);
        }
      } else {
        pane.path = normalizePath($(".path-input", el).value);
        loadPane(side);
      }
    });
    $(".path-input", el).addEventListener("keydown", function (e) {
      if (e.key === "Enter") $(".go-btn", el).click();
    });
    $(".up-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      if (pane.mode === "desktop") {
        const root = desktopRootById(pane.localRootId);
        if (!root || desktopSamePath(pane.path, root.path)) showLocalComputer(side);
        else {
          pane.path = desktopParent(pane.path, root.path);
          loadPane(side);
        }
      } else {
        pane.path = parentPath(pane.path);
        loadPane(side);
      }
    });

    $(".upload-btn", el).addEventListener("click", function () {
      const pane = state.panes[side];
      if (pane.mode === "remote" && !pane.connectionId) return toast("Choose a session first.", "error");
      if (pane.mode === "desktop" && !pane.localRootId) return toast("Open a local drive first.", "error");
      $(".upload-input", el).click();
    });
    $(".upload-input", el).addEventListener("change", function (e) {
      uploadFiles(side, Array.from(e.target.files));
      e.target.value = "";
    });

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
  setStatus("Copying " + files.length + " file" + (files.length === 1 ? "" : "s") + "…", "busy");
  const activityId = addActivity("upload", pane.mode === "desktop" ? "Local copy" : "Upload", files.length + " file" + (files.length === 1 ? "" : "s") + " to " + pane.path, "busy");
  try {
    if (pane.mode === "desktop") {
      if (!pane.localRootId) throw new Error("Open a local drive first.");
      for (const file of files) {
        await desktopFetch("/_desktop/file?path=" + encodeURIComponent(desktopJoin(pane.path, file.name)), {
          method:"PUT",
          headers:{ "Content-Type": file.type || "application/octet-stream" },
          body:file
        });
      }
    } else {
      const form = new FormData();
      files.forEach(function (file) { form.append("files", file, file.name); });
      await withTrustRetry(side, function () {
        return api("/api/connections/" + pane.connectionId + "/upload?path=" + encodeURIComponent(pane.path), { method:"POST", body:form });
      });
    }
    updateActivity(activityId, "success", "Transfer complete");
    setStatus("Transfer complete", "success");
    await loadPane(side);
  } catch (err) {
    updateActivity(activityId, "error", err.message);
    setStatus("Transfer failed", "error");
    toast(err.message, "error");
  }
}

async function createFolder(side) {
  const pane = state.panes[side];
  if (pane.mode === "remote" && !pane.connectionId) return toast("Choose a server first.", "error");
  if (pane.mode === "desktop" && !pane.localRootId) return toast("Open a local drive first.", "error");

  const name = await showActionDialog({
    eyebrow: "NEW FOLDER",
    title: "Create a folder",
    description: "Create a new folder in " + pane.path + ".",
    input: true,
    placeholder: "Folder name",
    hint: "Folder names cannot contain / or \\.",
    confirmLabel: "Create folder"
  });
  if (!name) return;
  const cleanName = name.trim().replace(/[\\/]/g, "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid folder name.", "error");

  try {
    if (pane.mode === "desktop") {
      await desktopFetch("/_desktop/mkdir", { method:"POST", body:{ path:desktopJoin(pane.path, cleanName) } });
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
    hint: "Names cannot contain / or \\.",
    confirmLabel: "Rename"
  });
  if (!nextName || nextName === selected.name) return;
  const cleanName = nextName.trim().replace(/[\\/]/g, "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid name.", "error");

  try {
    if (pane.mode === "desktop") {
      await desktopFetch("/_desktop/rename", {
        method:"POST",
        body:{ old_path:selected.path, new_path:desktopJoin(pane.path, cleanName) }
      });
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
  if (pane.selected.length !== 1 || pane.selected[0].isDir || pane.selected[0].localRootId) return;
  if (pane.mode === "desktop") {
    try {
      const response = await desktopFileResponse(pane.selected[0].path);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = pane.selected[0].name;
      anchor.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  location.href = "/api/connections/" + pane.connectionId + "/download?path=" + encodeURIComponent(pane.selected[0].path);
}

async function deleteSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected.slice();
  if (!selected.length) return;
  const label = selected.length === 1 ? selected[0].name : selected.length + " selected items";
  const locationLabel = pane.mode === "desktop" ? "local computer" : "remote server";
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
    if (pane.mode === "desktop") {
      for (const item of selected) {
        await desktopFetch("/_desktop/delete", { method:"POST", body:{ path:item.path, recursive:item.isDir } });
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

async function copyDesktopToRemote(source, destination, destinationSide, selected) {
  for (const item of selected) {
    const response = await desktopFileResponse(item.path);
    const blob = await response.blob();
    const form = new FormData();
    form.append("files", blob, item.name);
    await withTrustRetry(destinationSide, function () {
      return api("/api/connections/" + destination.connectionId + "/upload?path=" + encodeURIComponent(destination.path), { method:"POST", body:form });
    });
  }
}

async function copyRemoteToDesktop(source, destination, selected) {
  for (const item of selected) {
    const response = await remoteResponse(source, item);
    const blob = await response.blob();
    await desktopFetch("/_desktop/file?path=" + encodeURIComponent(desktopJoin(destination.path, item.name)), {
      method:"PUT",
      headers:{ "Content-Type":"application/octet-stream" },
      body:blob
    });
  }
}

async function copyDesktopToDesktop(source, destination, selected) {
  for (const item of selected) {
    const response = await desktopFileResponse(item.path);
    const blob = await response.blob();
    await desktopFetch("/_desktop/file?path=" + encodeURIComponent(desktopJoin(destination.path, item.name)), {
      method:"PUT",
      headers:{ "Content-Type":"application/octet-stream" },
      body:blob
    });
  }
}

async function copySelected(side) {
  const source = state.panes[side];
  const destinationSide = side === "left" ? "right" : "left";
  const destination = state.panes[destinationSide];
  const selected = source.selected.slice();
  const destinationReady = destination.mode === "desktop" ? Boolean(destination.localRootId) : Boolean(destination.connectionId);

  if (!selected.length || selected.some(function (item) { return item.isDir || item.localRootId; }) || !destinationReady) return;

  setStatus("Copying " + selected.length + " file" + (selected.length === 1 ? "" : "s") + "…", "busy");
  const sourceLabel = source.mode === "desktop" ? (source.localRootName || "Local computer") : (connectionById(source.connectionId)?.name || "server");
  const destinationLabel = destination.mode === "desktop" ? (destination.localRootName || "Local computer") : (connectionById(destination.connectionId)?.name || "server");
  const activityId = addActivity("copy", "Transfer", sourceLabel + " → " + destinationLabel, "busy");

  try {
    if (source.mode === "desktop" && destination.mode === "remote") {
      await copyDesktopToRemote(source, destination, destinationSide, selected);
    } else if (source.mode === "remote" && destination.mode === "desktop") {
      await copyRemoteToDesktop(source, destination, selected);
    } else if (source.mode === "desktop" && destination.mode === "desktop") {
      await copyDesktopToDesktop(source, destination, selected);
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

function desktopLastSeenLabel(value) {
  if (!value) return "Never";
  const t = new Date(value);
  const diff = Date.now() - t.getTime();
  if (diff < 120000) return "Online";
  if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + "m ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + "h ago";
  return t.toLocaleString();
}

function desktopOnline(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() < 120000;
}

function findACL(root, userId) {
  return (root.acls || []).find(function (acl) { return Number(acl.user_id) === Number(userId); }) || {
    can_read:false, can_write:false, can_rename:false, can_delete:false
  };
}

function renderDesktopAdmin(data) {
  const host = $("#desktopAdminList");
  if (!host) return;
  const desktops = data.desktops || [];
  const users = data.users || [];
  $("#desktopAdminSummary").textContent = desktops.length + " enrolled desktop" + (desktops.length === 1 ? "" : "s");

  if (!desktops.length) {
    host.innerHTML = '<div class="desktop-admin-empty"><strong>No desktops enrolled</strong><span>Open SimpleSCP through the Desktop application and sign in to enroll that machine.</span></div>';
    return;
  }

  host.innerHTML = desktops.map(function (device) {
    const online = desktopOnline(device.last_seen);
    const roots = device.roots || [];
    const rootHTML = roots.length ? roots.map(function (root) {
      const used = Number(root.total_bytes || 0) > 0 ? Math.max(0, Number(root.total_bytes) - Number(root.free_bytes || 0)) : 0;
      const capacity = Number(root.total_bytes || 0) > 0 ? bytes(used) + " used of " + bytes(root.total_bytes) : (root.detail || root.kind || "location");
      const aclRows = users.map(function (user) {
        const acl = findACL(root, user.id);
        return '<tr data-root-id="' + root.id + '" data-user-id="' + user.id + '">' +
          '<td><strong>' + escapeHTML(user.username) + '</strong>' + (Number(user.id) === Number(device.owner_user_id) ? '<span class="acl-owner">owner</span>' : '') + '</td>' +
          '<td><label class="acl-check"><input type="checkbox" data-perm="can_read"' + (acl.can_read ? " checked" : "") + '>Read</label></td>' +
          '<td><label class="acl-check"><input type="checkbox" data-perm="can_write"' + (acl.can_write ? " checked" : "") + '>Write</label></td>' +
          '<td><label class="acl-check"><input type="checkbox" data-perm="can_rename"' + (acl.can_rename ? " checked" : "") + '>Rename</label></td>' +
          '<td><label class="acl-check"><input type="checkbox" data-perm="can_delete"' + (acl.can_delete ? " checked" : "") + '>Delete</label></td>' +
          '</tr>';
      }).join("");

      return '<div class="desktop-root-card" data-root-id="' + root.id + '">' +
        '<div class="desktop-root-head">' +
          '<div class="desktop-root-icon">' + (root.kind === "network" ? "⇄" : root.kind === "removable" ? "▣" : "▰") + '</div>' +
          '<div class="desktop-root-copy"><strong>' + escapeHTML(root.name) + '</strong><code>' + escapeHTML(root.path) + '</code><span>' + escapeHTML(capacity) + '</span></div>' +
          '<div class="desktop-root-state"><span class="inventory-state ' + (root.online ? "online" : "offline") + '">' + (root.online ? "online" : "offline") + '</span>' +
          '<label class="switch-line"><input class="root-enabled" type="checkbox"' + (root.enabled ? " checked" : "") + '>Available</label></div>' +
        '</div>' +
        '<details class="acl-panel"><summary>Access control</summary>' +
          '<table class="acl-table"><thead><tr><th>User</th><th>Read</th><th>Write</th><th>Rename</th><th>Delete</th></tr></thead><tbody>' + aclRows + '</tbody></table>' +
        '</details>' +
      '</div>';
    }).join("") : '<div class="desktop-no-roots">No filesystem locations reported yet. Keep SimpleSCP Desktop open so it can check in.</div>';

    return '<article class="desktop-device-card" data-device-id="' + device.id + '">' +
      '<div class="desktop-device-head">' +
        '<div class="desktop-device-main"><span class="device-presence ' + (online ? "online" : "offline") + '"></span>' +
          '<div><input class="desktop-name-input" value="' + escapeHTML(device.name) + '" maxlength="128">' +
          '<span>' + escapeHTML(device.platform + " / " + device.arch) + ' · owner ' + escapeHTML(device.owner_name || "") + ' · ' + escapeHTML(desktopLastSeenLabel(device.last_seen)) + '</span></div></div>' +
        '<div class="desktop-device-actions">' +
          '<label class="switch-line"><input class="desktop-enabled" type="checkbox"' + (device.enabled ? " checked" : "") + '>Enabled</label>' +
          '<button class="desktop-save" type="button">Save</button>' +
          '<button class="desktop-remove danger-action" type="button">Remove</button>' +
        '</div>' +
      '</div>' +
      '<div class="desktop-roots">' + rootHTML + '</div>' +
    '</article>';
  }).join("");

  all(".desktop-device-card", host).forEach(function (card) {
    const deviceId = Number(card.dataset.deviceId);
    $(".desktop-save", card).addEventListener("click", async function () {
      try {
        await api("/api/admin/desktops/" + deviceId, {
          method:"PUT",
          body:{
            name:$(".desktop-name-input", card).value.trim(),
            enabled:$(".desktop-enabled", card).checked
          }
        });
        toast("Desktop settings saved.", "success");
        await loadDesktopAdmin();
      } catch (err) { toast(err.message, "error"); }
    });
    $(".desktop-remove", card).addEventListener("click", async function () {
      const ok = await showActionDialog({
        eyebrow:"REMOVE DESKTOP",
        title:"Remove this desktop?",
        description:"The desktop will need to enroll again before SimpleSCP can use its local filesystems.",
        warning:"Stored location inventory and ACLs for this desktop will be deleted.",
        confirmLabel:"Remove desktop",
        danger:true
      });
      if (!ok) return;
      try {
        await api("/api/admin/desktops/" + deviceId, { method:"DELETE" });
        toast("Desktop removed.", "success");
        await loadDesktopAdmin();
      } catch (err) { toast(err.message, "error"); }
    });
  });

  all(".desktop-root-card", host).forEach(function (rootCard) {
    const rootId = Number(rootCard.dataset.rootId);
    $(".root-enabled", rootCard).addEventListener("change", async function () {
      try {
        await api("/api/admin/desktops/0/roots/" + rootId, {
          method:"PUT",
          body:{enabled:this.checked}
        });
        toast(this.checked ? "Location enabled." : "Location disabled.", "success");
      } catch (err) {
        this.checked = !this.checked;
        toast(err.message, "error");
      }
    });
  });

  all(".acl-table tbody tr", host).forEach(function (row) {
    all('input[type="checkbox"]', row).forEach(function (box) {
      box.addEventListener("change", async function () {
        const rootId = Number(row.dataset.rootId);
        const userId = Number(row.dataset.userId);
        const body = {};
        all('input[type="checkbox"]', row).forEach(function (input) {
          body[input.dataset.perm] = input.checked;
        });
        try {
          await api("/api/admin/desktops/0/roots/" + rootId + "/acl/" + userId, { method:"PUT", body:body });
        } catch (err) {
          toast(err.message, "error");
          await loadDesktopAdmin();
        }
      });
    });
  });
}

async function loadDesktopAdmin() {
  const host = $("#desktopAdminList");
  if (host) host.innerHTML = '<div class="desktop-admin-empty">Loading desktop inventory…</div>';
  try {
    const data = await api("/api/admin/desktops");
    renderDesktopAdmin(data);
  } catch (err) {
    if (host) host.innerHTML = '<div class="desktop-admin-empty error">' + escapeHTML(err.message) + '</div>';
  }
}

function wireDesktopAdmin() {
  const button = $("#desktopAdminBtn");
  const dialog = $("#desktopAdminDialog");
  if (!button || !dialog) return;
  button.addEventListener("click", function () {
    dialog.showModal();
    loadDesktopAdmin();
  });
  $("#desktopAdminRefresh")?.addEventListener("click", loadDesktopAdmin);
  all(".desktop-admin-close").forEach(function (close) {
    close.addEventListener("click", function () { dialog.close(); });
  });
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
  wireDesktopAdmin();
  wireUpdater();
  $("#logoutBtn").addEventListener("click", logout);
  $("#refreshConnections").addEventListener("click", loadConnections);
  try {
    await loadConnections();
    await detectDesktop();
    renderServerSelects();
    await Promise.all([loadPane("left"), loadPane("right")]);
    setStatus("Ready", "ready");
  } catch (err) {
    toast(err.message, "error");
    setStatus("Unable to load connections", "error");
  }
});
