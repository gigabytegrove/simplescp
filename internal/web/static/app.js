"use strict";

const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
const state = {
  connections: [],
  panes: {
    left: { connectionId: 0, path: "/", selected: null },
    right: { connectionId: 0, path: "/", selected: null }
  },
  pendingTrust: null
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
  el.textContent = message;
  el.className = "status " + (type || "ready");
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
    host.innerHTML = '<div class="empty-state">No saved servers yet. Add a connection to start browsing and transferring files.</div>';
    return;
  }
  host.innerHTML = state.connections.map(function (c) {
    return '<div class="connection-card" data-id="' + c.id + '">' +
      '<div class="name"><span class="trust-dot ' + (c.host_key_fingerprint ? "trusted" : "") + '"></span>' + escapeHTML(c.name) + '</div>' +
      '<div class="meta">' + escapeHTML(c.username) + '@' + escapeHTML(c.host) + ':' + c.port + '</div>' +
      '<div class="connection-actions">' +
      '<button data-action="left">Open left</button>' +
      '<button data-action="right">Open right</button>' +
      '<button data-action="edit">Edit</button>' +
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
  state.panes[side].selected = null;
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
  pane.selected = null;
  updatePaneSelection(side);

  if (!pane.connectionId) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">Choose a saved server.</td></tr>';
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
      renderEntries(side, data.entries || []);
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
    tbody.innerHTML = '<tr><td colspan="3" class="muted">This folder is empty.</td></tr>';
    return;
  }

  entries.sort(function (a, b) {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  tbody.innerHTML = entries.map(function (entry) {
    return '<tr class="entry-row" data-path="' + escapeHTML(entry.path) + '" data-name="' + escapeHTML(entry.name) + '" data-dir="' + (entry.is_dir ? "1" : "0") + '" data-size="' + entry.size + '">' +
      '<td><div class="file-name"><span class="file-icon">' + (entry.is_dir ? "▰" : "·") + '</span><span class="file-name-text">' + escapeHTML(entry.name) + '</span></div></td>' +
      '<td>' + (entry.is_dir ? "—" : bytes(entry.size)) + '</td>' +
      '<td>' + new Date(entry.mod_time).toLocaleString() + '</td>' +
      '</tr>';
  }).join("");

  $$(".entry-row", tbody).forEach(function (row) {
    row.addEventListener("click", function () { selectEntry(side, row); });
    row.addEventListener("dblclick", function () {
      if (row.dataset.dir === "1") {
        state.panes[side].path = row.dataset.path;
        loadPane(side);
      }
    });
  });
}

function selectEntry(side, row) {
  const el = paneElement(side);
  $$(".entry-row", el).forEach(function (r) { r.classList.remove("selected"); });
  row.classList.add("selected");
  state.panes[side].selected = {
    path: row.dataset.path,
    name: row.dataset.name,
    isDir: row.dataset.dir === "1",
    size: Number(row.dataset.size || 0)
  };
  updatePaneSelection(side);
}

function updatePaneSelection(side) {
  const pane = state.panes[side];
  const el = paneElement(side);
  const selected = pane.selected;
  $(".selection-text", el).textContent = selected ? selected.name + (selected.isDir ? " · folder" : " · " + bytes(selected.size)) : "Nothing selected";
  $(".download-btn", el).disabled = !selected || selected.isDir;
  $(".delete-btn", el).disabled = !selected;
  $(".rename-btn", el).disabled = !selected;
  const other = state.panes[side === "left" ? "right" : "left"];
  $(".copy-to-other", el).disabled = !selected || selected.isDir || !other.connectionId;
}

function wirePanes() {
  $$(".file-pane").forEach(function (el) {
    const side = el.dataset.pane;

    $(".server-select", el).addEventListener("change", function (e) {
      const id = Number(e.target.value);
      if (id) connectPane(side, id);
      else {
        state.panes[side] = { connectionId: 0, path: "/", selected: null };
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
    $(".mkdir-btn", el).addEventListener("click", function () { createFolder(side); });
    $(".rename-btn", el).addEventListener("click", function () { renameSelected(side); });
    $(".download-btn", el).addEventListener("click", function () { downloadSelected(side); });
    $(".delete-btn", el).addEventListener("click", function () { deleteSelected(side); });
    $(".copy-to-other", el).addEventListener("click", function () { copySelected(side); });
  });
}

async function uploadFiles(side, files) {
  if (!files.length) return;
  const pane = state.panes[side];
  const form = new FormData();
  files.forEach(function (f) { form.append("files", f, f.name); });
  setStatus("Uploading " + files.length + " file" + (files.length === 1 ? "" : "s") + "…", "busy");
  try {
    await withTrustRetry(side, function () {
      return api("/api/connections/" + pane.connectionId + "/upload?path=" + encodeURIComponent(pane.path), { method: "POST", body: form });
    });
    toast("Upload complete.", "success");
    setStatus("Upload complete", "success");
    await loadPane(side);
  } catch (err) {
    setStatus("Upload failed", "error");
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
    await loadPane(side);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected;
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
    await loadPane(side);
  } catch (err) {
    toast(err.message, "error");
  }
}

function downloadSelected(side) {
  const pane = state.panes[side];
  if (!pane.selected || pane.selected.isDir) return;
  location.href = "/api/connections/" + pane.connectionId + "/download?path=" + encodeURIComponent(pane.selected.path);
}

async function deleteSelected(side) {
  const pane = state.panes[side];
  const selected = pane.selected;
  if (!selected) return;
  const suffix = selected.isDir ? " and everything inside it" : "";
  if (!confirm('Delete ' + (selected.isDir ? "folder" : "file") + ' "' + selected.name + '"' + suffix + "?")) return;
  try {
    await api("/api/connections/" + pane.connectionId + "/delete", {
      method: "POST",
      body: { path: selected.path, recursive: selected.isDir }
    });
    toast("Deleted.", "success");
    await loadPane(side);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function copySelected(side) {
  const source = state.panes[side];
  const destinationSide = side === "left" ? "right" : "left";
  const destination = state.panes[destinationSide];
  if (!source.selected || source.selected.isDir || !destination.connectionId) return;
  const destinationPath = normalizePath(destination.path + "/" + source.selected.name);
  setStatus("Copying " + source.selected.name + "…", "busy");

  try {
    await api("/api/transfer", {
      method: "POST",
      body: {
        source_connection_id: source.connectionId,
        source_path: source.selected.path,
        destination_connection_id: destination.connectionId,
        destination_path: destinationPath
      }
    });
    toast("Copied " + source.selected.name + ".", "success");
    setStatus("Transfer complete", "success");
    await loadPane(destinationSide);
  } catch (err) {
    setStatus("Transfer failed", "error");
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
      if (state.panes[side].connectionId === id) state.panes[side] = { connectionId: 0, path: "/", selected: null };
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

document.addEventListener("DOMContentLoaded", async function () {
  wirePanes();
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
