"use strict";

const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
const state = {
  connections: [],
  panes: {
    left: { connectionId: 0, path: "/", selected: [] },
    right: { connectionId: 0, path: "/", selected: [] }
  },
  pendingTrust: null,
  activePane: "left",
  activity: []
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
  $(".file-pane").forEach(function (pane) {
    pane.classList.toggle("active-pane", pane.dataset.pane === side);
  });
}

function renderBreadcrumbs(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const host = $(".breadcrumbs", el);
  if (!host) return;

  const parts = normalizePath(pane.path).split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
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

  $(".breadcrumb", host).forEach(function (button) {
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
  $(".entry-row", el).forEach(function (row) {
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

  $$(".connection-card", host).forEach(function (card) {
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
  $$(".file-pane").forEach(function (paneEl) {
    const side = paneEl.dataset.pane;
    const select = $(".server-select", paneEl);
    const current = state.panes[side].connectionId;
    let html = '<option value="">Choose a server…</option>';
    state.connections.forEach(function (c) {
      html += '<option value="' + c.id + '"' + (Number(current) === Number(c.id) ? " selected" : "") + '>' + escapeHTML(c.name) + '</option>';
    });
    select.innerHTML = html;
  });
}

async function connectPane(side, id) {
  const c = connectionById(id);
  if (!c) return;
  state.panes[side].connectionId = Number(id);
  state.panes[side].path = normalizePath(c.default_path || "/");
  state.panes[side].selected = [];
  renderServerSelects();
  await loadPane(side);
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
  $(".path-input", el).value = pane.path;
  pane.selected = [];
  renderBreadcrumbs(side);
  updatePaneSelection(side);

  if (!pane.connectionId) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted empty-pane-message"><strong>No server open</strong><span>Choose a saved server above or open one from the sidebar.</span></td></tr>';
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
    return '<tr class="entry-row" data-path="' + escapeHTML(entry.path) + '" data-name="' + escapeHTML(entry.name) + '" data-dir="' + (entry.is_dir ? "1" : "0") + '" data-size="' + entry.size + '">' +
      '<td><div class="file-name"><span class="file-icon file-kind-' + kind.kind + '">' + kind.icon + '</span><span class="file-name-text">' + escapeHTML(entry.name) + '</span></div></td>' +
      '<td>' + (entry.is_dir ? "—" : bytes(entry.size)) + '</td>' +
      '<td>' + new Date(entry.mod_time).toLocaleString() + '</td>' +
      '</tr>';
  }).join("");

  $$(".entry-row", tbody).forEach(function (row) {
    row.addEventListener("click", function (event) {
      setActivePane(side);
      selectEntry(side, row, event.ctrlKey || event.metaKey);
    });
    row.addEventListener("dblclick", function () {
      if (row.dataset.dir === "1") {
        state.panes[side].path = row.dataset.path;
        loadPane(side);
      }
    });
  });
}

function selectEntry(side, row, additive) {
  const pane = state.panes[side];
  const item = {
    path: row.dataset.path,
    name: row.dataset.name,
    isDir: row.dataset.dir === "1",
    size: Number(row.dataset.size || 0)
  };
  const existing = pane.selected.findIndex(function (entry) { return entry.path === item.path; });

  if (!additive) {
    pane.selected = [item];
  } else if (existing >= 0) {
    pane.selected.splice(existing, 1);
  } else {
    pane.selected.push(item);
  }

  const selectedPaths = new Set(pane.selected.map(function (entry) { return entry.path; }));
  $(".entry-row", paneElement(side)).forEach(function (r) {
    r.classList.toggle("selected", selectedPaths.has(r.dataset.path));
  });
  updatePaneSelection(side);
}

function updatePaneSelection(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const selected = pane.selected;
  const count = selected.length;
  if (!count) {
    $(".selection-text", el).textContent = "Nothing selected";
  } else if (count === 1) {
    const item = selected[0];
    $(".selection-text", el).textContent = item.name + (item.isDir ? " · folder" : " · " + bytes(item.size));
  } else {
    $(".selection-text", el).textContent = count + " items selected";
  }

  $(".download-btn", el).disabled = count !== 1 || selected[0].isDir;
  $(".delete-btn", el).disabled = count === 0;
  $(".rename-btn", el).disabled = count !== 1;
  const other = state.panes[side === "left" ? "right" : "left"];
  $(".copy-to-other", el).disabled = count === 0 || selected.some(function (item) { return item.isDir; }) || !other.connectionId;
}

function wirePanes() {
  $(".file-pane").forEach(function (el) {
    const side = el.dataset.pane;
    el.addEventListener("pointerdown", function () { setActivePane(side); });

    $(".server-select", el).addEventListener("change", function (e) {
      const id = Number(e.target.value);
      if (id) connectPane(side, id);
      else {
        state.panes[side] = { connectionId: 0, path: "/", selected: [] };
        loadPane(side);
      }
    });

    $(".pane-refresh", el).addEventListener("click", function () { loadPane(side); });
    $(".go-btn", el).addEventListener("click", function () {
      state.panes[side].path = normalizePath($(".path-input", el).value);
      loadPane(side);
    });
    $(".path-input", el).addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        state.panes[side].path = normalizePath(e.target.value);
        loadPane(side);
      }
    });
    $(".up-btn", el).addEventListener("click", function () {
      state.panes[side].path = parentPath(state.panes[side].path);
      loadPane(side);
    });
    $(".upload-btn", el).addEventListener("click", function () {
      if (!state.panes[side].connectionId) return toast("Choose a server first.", "error");
      $(".upload-input", el).click();
    });
    $(".upload-input", el).addEventListener("change", function (e) { uploadFiles(side, Array.from(e.target.files)); });

    ["dragenter", "dragover"].forEach(function (eventName) {
      el.addEventListener(eventName, function (e) {
        e.preventDefault();
        if (!state.panes[side].connectionId) return;
        el.classList.add("drag-active");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      el.addEventListener(eventName, function (e) {
        e.preventDefault();
        el.classList.remove("drag-active");
      });
    });
    el.addEventListener("drop", function (e) {
      if (!state.panes[side].connectionId) {
        toast("Choose a server before dropping files.", "error");
        return;
      }
      const files = Array.from(e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : []);
      if (files.length) uploadFiles(side, files);
    });

    $(".mkdir-btn", el).addEventListener("click", function () { createFolder(side); });
    $(".rename-btn", el).addEventListener("click", function () { renameSelected(side); });
    $(".download-btn", el).addEventListener("click", function () { downloadSelected(side); });
    $(".delete-btn", el).addEventListener("click", function () { deleteSelected(side); });
    $(".copy-to-other", el).addEventListener("click", function () { copySelected(side); });
    $(".pane-search", el).addEventListener("input", function (e) { filterPane(side, e.target.value); });
  });
}

async function uploadFiles(side, files) {
  if (!files.length) return;
  const pane = state.panes[side];
  const form = new FormData();
  files.forEach(function (f) { form.append("files", f, f.name); });
  setStatus("Uploading " + files.length + " file" + (files.length === 1 ? "" : "s") + "…", "busy");
  const activityId = addActivity("upload", "Upload", files.length + " file" + (files.length === 1 ? "" : "s") + " to " + pane.path, "busy");
  try {
    await withTrustRetry(side, function () {
      return api("/api/connections/" + pane.connectionId + "/upload?path=" + encodeURIComponent(pane.path), { method: "POST", body: form });
    });
    toast("Upload complete.", "success");
    setStatus("Upload complete", "success");
    updateActivity(activityId, "success", files.length + " file" + (files.length === 1 ? "" : "s") + " uploaded to " + pane.path);
    await loadPane(side);
  } catch (err) {
    setStatus("Upload failed", "error");
    updateActivity(activityId, "error", err.message);
    toast(err.message, "error");
  } finally {
    $(".upload-input", paneElement(side)).value = "";
  }
}

async function createFolder(side) {
  const pane = state.panes[side];
  if (!pane.connectionId) return toast("Choose a server first.", "error");
  const name = prompt("New folder name:");
  if (!name) return;
  const cleanName = name.trim().replaceAll("/", "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid folder name.", "error");
  try {
    await withTrustRetry(side, function () {
      return api("/api/connections/" + pane.connectionId + "/mkdir", {
        method: "POST",
        body: { path: normalizePath(pane.path + "/" + cleanName) }
      });
    });
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
  const nextName = prompt("Rename to:", selected.name);
  if (!nextName || nextName === selected.name) return;
  const cleanName = nextName.trim().replaceAll("/", "");
  if (!cleanName || cleanName === "." || cleanName === "..") return toast("Invalid name.", "error");
  try {
    await api("/api/connections/" + pane.connectionId + "/rename", {
      method: "POST",
      body: {
        old_path: selected.path,
        new_path: normalizePath(pane.path + "/" + cleanName)
      }
    });
    toast("Renamed.", "success");
    addActivity("rename", "Renamed item", selected.name + " → " + cleanName, "success");
    await loadPane(side);
  } catch (err) {
    addActivity("rename", "Rename failed", err.message, "error");
    toast(err.message, "error");
  }
}

function downloadSelected(side) {
  const pane = state.panes[side];
  if (pane.selected.length !== 1 || pane.selected[0].isDir) return;
  location.href = "/api/connections/" + pane.connectionId + "/download?path=" + encodeURIComponent(pane.selected[0].path);
}

async function deleteSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected.slice();
  if (!selected.length) return;
  const label = selected.length === 1 ? '"' + selected[0].name + '"' : selected.length + " selected items";
  if (!confirm("Delete " + label + "? Folders will be removed recursively.")) return;
  const activityId = addActivity("delete", "Delete", selected.length + " item" + (selected.length === 1 ? "" : "s") + " from " + pane.path, "busy");
  try {
    setStatus("Deleting " + selected.length + " item" + (selected.length === 1 ? "" : "s") + "…", "busy");
    for (const item of selected) {
      await api("/api/connections/" + pane.connectionId + "/delete", {
        method: "POST",
        body: { path: item.path, recursive: item.isDir }
      });
    }
    toast("Deleted " + selected.length + " item" + (selected.length === 1 ? "" : "s") + ".", "success");
    setStatus("Delete complete", "success");
    updateActivity(activityId, "success", selected.length + " item" + (selected.length === 1 ? "" : "s") + " deleted from " + pane.path);
    await loadPane(side);
  } catch (err) {
    setStatus("Delete failed", "error");
    updateActivity(activityId, "error", err.message);
    toast(err.message, "error");
  }
}

async function copySelected(side) {
  const source = state.panes[side];
  const destinationSide = side === "left" ? "right" : "left";
  const destination = state.panes[destinationSide];
  const selected = source.selected.slice();
  if (!selected.length || selected.some(function (item) { return item.isDir; }) || !destination.connectionId) return;
  setStatus("Copying " + selected.length + " file" + (selected.length === 1 ? "" : "s") + "…", "busy");
  const sourceConnection = connectionById(source.connectionId);
  const destinationConnection = connectionById(destination.connectionId);
  const activityId = addActivity("copy", "Server-to-server copy", selected.length + " file" + (selected.length === 1 ? "" : "s") + " · " + (sourceConnection ? sourceConnection.name : "source") + " → " + (destinationConnection ? destinationConnection.name : "destination"), "busy");

  try {
    for (const item of selected) {
      await api("/api/transfer", {
        method: "POST",
        body: {
          source_connection_id: source.connectionId,
          source_path: item.path,
          destination_connection_id: destination.connectionId,
          destination_path: normalizePath(destination.path + "/" + item.name)
        }
      });
    }
    toast("Copied " + selected.length + " file" + (selected.length === 1 ? "" : "s") + ".", "success");
    setStatus("Transfer complete", "success");
    updateActivity(activityId, "success", selected.length + " file" + (selected.length === 1 ? "" : "s") + " copied successfully");
    await loadPane(destinationSide);
  } catch (err) {
    setStatus("Transfer failed", "error");
    updateActivity(activityId, "error", err.message);
    toast(err.message, "error");
  }
}

function updateAuthFields() {
  const type = $("#connectionForm").elements.auth_type.value;
  $$(".auth-password").forEach(function (el) { el.classList.toggle("hidden", type !== "password"); });
  $$(".auth-key").forEach(function (el) { el.classList.toggle("hidden", type !== "key"); });
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
  if (!id || !c || !confirm('Delete saved connection "' + c.name + '"?')) return;

  try {
    await api("/api/connections/" + id, { method: "DELETE" });
    $("#connectionDialog").close();
    ["left", "right"].forEach(function (side) {
      if (state.panes[side].connectionId === id) state.panes[side] = { connectionId: 0, path: "/", selected: [] };
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
  $$(".close-dialog").forEach(function (btn) {
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

async function logout() {
  try {
    await api("/logout", { method: "POST" });
  } finally {
    location.href = "/login";
  }
}

function wirePremiumControls() {
  setActivePane("left");

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
      pane.querySelectorAll(".entry-row").forEach(function (row) { row.classList.remove("selected"); });
      updatePaneSelection(side);
    }
  });
}

document.addEventListener("DOMContentLoaded", async function () {
  wirePanes();
  wirePremiumControls();
  wireDialogs();
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
