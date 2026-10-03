package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	listenAddress = "127.0.0.1:9431"
	desktopCookie = "_simplescp_desktop"
)

type config struct {
	ServerURL string `json:"server_url"`
	DeviceID  string `json:"device_id"`
	Secret    string `json:"secret"`
	Name      string `json:"name"`
}

type rootInfo struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Detail     string `json:"detail,omitempty"`
	TotalBytes uint64 `json:"total_bytes,omitempty"`
	FreeBytes  uint64 `json:"free_bytes,omitempty"`
}

type entryInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	IsDir   bool      `json:"is_dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

type desktopApp struct {
	mu         sync.RWMutex
	cfg        config
	configPath string
	token      string
	proxy      *httputil.ReverseProxy
	target     *url.URL
}

func main() {
	cfgPath := desktopConfigPath()
	cfg, _ := loadConfig(cfgPath)
	if strings.TrimSpace(cfg.DeviceID) == "" {
		cfg.DeviceID = randomToken()
	}
	if strings.TrimSpace(cfg.Secret) == "" {
		cfg.Secret = randomToken() + randomToken()
	}
	if strings.TrimSpace(cfg.Name) == "" {
		if host, err := os.Hostname(); err == nil && strings.TrimSpace(host) != "" {
			cfg.Name = host
		} else {
			cfg.Name = "SimpleSCP Desktop"
		}
	}
	if err := saveConfig(cfgPath, cfg); err != nil {
		log.Fatalf("save desktop identity: %v", err)
	}

	app := &desktopApp{
		cfg:        cfg,
		configPath: cfgPath,
		token:      randomToken(),
	}
	if cfg.ServerURL != "" {
		if err := app.setServer(cfg.ServerURL); err != nil {
			log.Printf("saved server URL is invalid: %v", err)
			app.cfg.ServerURL = ""
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /_desktop/info", app.requireDesktopSession(app.handleInfo))
	mux.HandleFunc("GET /_desktop/list", app.requireDesktopSession(app.handleList))
	mux.HandleFunc("GET /_desktop/file", app.requireDesktopSession(app.handleReadFile))
	mux.HandleFunc("PUT /_desktop/file", app.requireDesktopSession(app.handleWriteFile))
	mux.HandleFunc("POST /_desktop/mkdir", app.requireDesktopSession(app.handleMkdir))
	mux.HandleFunc("POST /_desktop/rename", app.requireDesktopSession(app.handleRename))
	mux.HandleFunc("POST /_desktop/delete", app.requireDesktopSession(app.handleDelete))
	mux.HandleFunc("POST /_desktop/config", app.requireDesktopSession(app.handleConfig))
	mux.HandleFunc("/", app.handleRoot)

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           app.issueDesktopSession(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	localURL := "http://" + listenAddress + "/"
	fmt.Println("SimpleSCP Desktop")
	fmt.Println("=================")
	fmt.Println("Local UI:", localURL)
	if cfg.ServerURL != "" {
		fmt.Println("Server:", cfg.ServerURL)
	} else {
		fmt.Println("Server: not configured")
	}
	fmt.Println("Close this application to remove local filesystem access.")

	if cfg.ServerURL != "" {
		go app.heartbeatLoop()
	}

	go func() {
		time.Sleep(350 * time.Millisecond)
		if err := openBrowser(localURL); err != nil {
			log.Printf("open browser: %v", err)
		}
	}()

	log.Fatal(server.ListenAndServe())
}

func desktopConfigPath() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil || home == "" {
			return "simplescp-desktop.json"
		}
		base = home
	}
	dir := filepath.Join(base, "SimpleSCP")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "desktop.json")
}

func loadConfig(path string) (config, error) {
	var cfg config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func saveConfig(path string, cfg config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func (a *desktopApp) issueDesktopSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(desktopCookie)
		if err != nil || !secureEqual(cookie.Value, a.token) {
			http.SetCookie(w, &http.Cookie{
				Name:     desktopCookie,
				Value:    a.token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				MaxAge:   86400,
			})
		}
		next.ServeHTTP(w, r)
	})
}

func (a *desktopApp) requireDesktopSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(desktopCookie)
		if err != nil || !secureEqual(cookie.Value, a.token) {
			writeError(w, http.StatusForbidden, "desktop session required")
			return
		}
		next(w, r)
	}
}

func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (a *desktopApp) setServer(raw string) error {
	raw = strings.TrimSpace(raw)
	target, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return errors.New("server URL must use http or https")
	}
	if target.Host == "" {
		return errors.New("server URL must include a host")
	}
	target.Path = strings.TrimRight(target.Path, "/")

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host

		upstreamOrigin := target.Scheme + "://" + target.Host
		if req.Header.Get("Origin") != "" {
			req.Header.Set("Origin", upstreamOrigin)
		}
		if ref := req.Header.Get("Referer"); ref != "" {
			if parsed, parseErr := url.Parse(ref); parseErr == nil {
				parsed.Scheme = target.Scheme
				parsed.Host = target.Host
				req.Header.Set("Referer", parsed.String())
			}
		}
		removeCookie(req, desktopCookie)
		a.mu.RLock()
		cfg := a.cfg
		a.mu.RUnlock()
		req.Header.Set("X-SimpleSCP-Desktop-ID", cfg.DeviceID)
		req.Header.Set("X-SimpleSCP-Desktop-Secret", cfg.Secret)
		req.Header.Set("X-SimpleSCP-Desktop-Name", cfg.Name)
		req.Header.Set("X-SimpleSCP-Desktop-OS", runtime.GOOS)
		req.Header.Set("X-SimpleSCP-Desktop-Arch", runtime.GOARCH)
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		rewriteCookies(resp)
		if location := resp.Header.Get("Location"); location != "" {
			if parsed, err := url.Parse(location); err == nil && parsed.IsAbs() && parsed.Host == target.Host {
				parsed.Scheme = "http"
				parsed.Host = listenAddress
				resp.Header.Set("Location", parsed.String())
			}
		}
		return nil
	}

	a.mu.Lock()
	a.target = target
	a.proxy = proxy
	a.cfg.ServerURL = raw
	a.mu.Unlock()
	return nil
}

func removeCookie(req *http.Request, name string) {
	cookies := req.Cookies()
	req.Header.Del("Cookie")
	for _, cookie := range cookies {
		if cookie.Name == name {
			continue
		}
		req.AddCookie(cookie)
	}
}

func rewriteCookies(resp *http.Response) {
	cookies := resp.Cookies()
	if len(cookies) == 0 {
		return
	}
	resp.Header.Del("Set-Cookie")
	for _, cookie := range cookies {
		cookie.Secure = false
		cookie.Domain = ""
		resp.Header.Add("Set-Cookie", cookie.String())
	}
}

func (a *desktopApp) handleRoot(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/_desktop/") {
		http.NotFound(w, r)
		return
	}

	a.mu.RLock()
	proxy := a.proxy
	configured := a.cfg.ServerURL != ""
	a.mu.RUnlock()

	if !configured || proxy == nil {
		a.serveSetup(w, r)
		return
	}
	proxy.ServeHTTP(w, r)
}

func (a *desktopApp) serveSetup(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SimpleSCP Desktop Setup</title>
<style>
:root{font-family:Segoe UI,Arial,sans-serif;color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171b1d;color:#eef2f0}
main{width:min(520px,calc(100vw - 32px));padding:28px;border:1px solid #3c4446;border-radius:12px;background:#23282a;box-shadow:0 20px 50px #0007}
h1{margin:0 0 8px;font-size:25px}p{color:#aeb8b4;line-height:1.5}
label{display:grid;gap:7px;margin-top:22px;font-weight:600}
input{height:42px;padding:0 12px;border:1px solid #515b5e;border-radius:7px;background:#15191a;color:#fff;font:inherit}
button{height:40px;margin-top:14px;padding:0 14px;border:0;border-radius:7px;background:#c6612d;color:#fff;font-weight:700;cursor:pointer}
#error{min-height:18px;color:#ee897f;font-size:12px;margin-top:10px}
</style></head>
<body><main><h1>SimpleSCP Desktop</h1>
<p>Connect this desktop application to your SimpleSCP Server. Local disks and mounted filesystems stay on this machine.</p>
<label>SimpleSCP Server URL<input id="server" placeholder="https://scp.example.com" autocomplete="url"></label>
<button id="save">Connect</button><div id="error"></div></main>
<script>
document.getElementById("save").onclick=async()=>{
 const button=document.getElementById("save"),error=document.getElementById("error");
 button.disabled=true;error.textContent="";
 try{
  const response=await fetch("/_desktop/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({server_url:document.getElementById("server").value})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||"Unable to save server");
  location.href="/";
 }catch(err){error.textContent=err.message;button.disabled=false}
};
</script></body></html>`)
}

func (a *desktopApp) handleConfig(w http.ResponseWriter, r *http.Request) {
	var input config
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid configuration")
		return
	}
	if err := a.setServer(input.ServerURL); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := saveConfig(a.configPath, a.cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "unable to save configuration")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *desktopApp) handleInfo(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	serverURL := a.cfg.ServerURL
	a.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"available":  true,
		"name":       "SimpleSCP Desktop",
		"os":         runtime.GOOS,
		"arch":       runtime.GOARCH,
		"server_url": serverURL,
		"device_id":  a.cfg.DeviceID,
		"device_name": a.cfg.Name,
		"roots":      enumerateRoots(),
	})
}

func (a *desktopApp) heartbeatLoop() {
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	<-timer.C

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		if err := a.sendHeartbeat(); err != nil {
			log.Printf("desktop check-in: %v", err)
		}
		<-ticker.C
	}
}

func (a *desktopApp) sendHeartbeat() error {
	a.mu.RLock()
	cfg := a.cfg
	a.mu.RUnlock()
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return nil
	}
	endpoint := strings.TrimRight(cfg.ServerURL, "/") + "/api/desktop/heartbeat"
	body, err := json.Marshal(map[string]any{"roots": enumerateRoots()})
	if err != nil { return err }
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil { return err }
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-SimpleSCP-Desktop-ID", cfg.DeviceID)
	req.Header.Set("X-SimpleSCP-Desktop-Secret", cfg.Secret)
	req.Header.Set("X-SimpleSCP-Desktop-Name", cfg.Name)
	req.Header.Set("X-SimpleSCP-Desktop-OS", runtime.GOOS)
	req.Header.Set("X-SimpleSCP-Desktop-Arch", runtime.GOARCH)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized {
		return nil // not enrolled yet; browser enrollment will establish it
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func cleanAbsolutePath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("path is required")
	}
	path := filepath.Clean(raw)
	if !filepath.IsAbs(path) {
		return "", errors.New("absolute path required")
	}
	return path, nil
}

func (a *desktopApp) handleList(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbsolutePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := os.ReadDir(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries := make([]entryInfo, 0, len(items))
	for _, item := range items {
		info, err := item.Info()
		if err != nil {
			continue
		}
		entries = append(entries, entryInfo{
			Name:    item.Name(),
			Path:    filepath.Join(path, item.Name()),
			IsDir:   item.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "entries": entries})
}

func (a *desktopApp) handleReadFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbsolutePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		writeError(w, http.StatusBadRequest, "file path required")
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(path)))
	_, _ = io.Copy(w, file)
}

func (a *desktopApp) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbsolutePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tmp := path + ".simplescp-part-" + randomToken()[:8]
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	n, copyErr := io.Copy(file, io.LimitReader(r.Body, 100<<30))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		writeError(w, http.StatusBadRequest, "unable to write local file")
		return
	}
	_ = os.Remove(path)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bytes": n})
}

func (a *desktopApp) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	path, err := cleanAbsolutePath(input.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *desktopApp) handleRename(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	oldPath, err := cleanAbsolutePath(input.OldPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	newPath, err := cleanAbsolutePath(input.NewPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFilesystemRoot(oldPath) {
		writeError(w, http.StatusForbidden, "cannot rename a filesystem root")
		return
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *desktopApp) handleDelete(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	path, err := cleanAbsolutePath(input.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFilesystemRoot(path) {
		writeError(w, http.StatusForbidden, "cannot delete a filesystem root")
		return
	}
	if input.Recursive {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isFilesystemRoot(path string) bool {
	clean := filepath.Clean(path)
	for _, root := range enumerateRoots() {
		if samePath(clean, filepath.Clean(root.Path)) {
			return true
		}
	}
	return false
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func enumerateRoots() []rootInfo {
	if runtime.GOOS == "windows" {
		if roots := windowsRootsPowerShell(); len(roots) > 0 {
			return roots
		}
		return windowsRootsFallback()
	}
	return linuxRoots()
}

func windowsRootsPowerShell() []rootInfo {
	script := `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,ProviderName,Size,FreeSpace | ConvertTo-Json -Compress`
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil || len(out) == 0 {
		return nil
	}
	type disk struct {
		DeviceID     string `json:"DeviceID"`
		VolumeName   string `json:"VolumeName"`
		DriveType    int    `json:"DriveType"`
		ProviderName string `json:"ProviderName"`
		Size         uint64 `json:"Size"`
		FreeSpace    uint64 `json:"FreeSpace"`
	}
	var many []disk
	if err := json.Unmarshal(out, &many); err != nil {
		var one disk
		if json.Unmarshal(out, &one) != nil {
			return nil
		}
		many = []disk{one}
	}
	roots := make([]rootInfo, 0, len(many))
	for _, d := range many {
		if d.DeviceID == "" {
			continue
		}
		path := d.DeviceID + "\\"
		if _, err := os.Stat(path); err != nil {
			continue
		}
		name := d.DeviceID
		kind := "drive"
		detail := d.VolumeName
		if d.DriveType == 4 {
			kind = "network"
			if d.ProviderName != "" {
				detail = d.ProviderName
			}
		} else if d.DriveType == 2 {
			kind = "removable"
		} else if d.DriveType == 5 {
			kind = "optical"
		}
		if d.VolumeName != "" && d.DriveType != 4 {
			name = d.VolumeName + " (" + d.DeviceID + ")"
		} else if d.DriveType == 3 {
			name = "Local Disk (" + d.DeviceID + ")"
		} else if d.DriveType == 4 && d.ProviderName != "" {
			name = filepath.Base(strings.TrimRight(d.ProviderName, "\\")) + " (" + d.DeviceID + ")"
		}
		roots = append(roots, rootInfo{
			Name:       name,
			Path:       path,
			Kind:       kind,
			Detail:     detail,
			TotalBytes: d.Size,
			FreeBytes:  d.FreeSpace,
		})
	}
	sort.Slice(roots, func(i, j int) bool { return strings.ToLower(roots[i].Path) < strings.ToLower(roots[j].Path) })
	return roots
}

func windowsRootsFallback() []rootInfo {
	var roots []rootInfo
	for letter := 'A'; letter <= 'Z'; letter++ {
		path := fmt.Sprintf("%c:\\", letter)
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			roots = append(roots, rootInfo{Name: fmt.Sprintf("Drive (%c:)", letter), Path: path, Kind: "drive"})
		}
	}
	return roots
}

func linuxRoots() []rootInfo {
	roots := []rootInfo{{Name: "Filesystem", Path: "/", Kind: "root"}}
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err == nil {
		seen := map[string]bool{"/": true}
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 10 {
				continue
			}
			sep := -1
			for i, field := range fields {
				if field == "-" {
					sep = i
					break
				}
			}
			if sep < 0 || sep+2 >= len(fields) {
				continue
			}
			mountPoint := decodeMountPath(fields[4])
			fsType := fields[sep+1]
			source := decodeMountPath(fields[sep+2])
			if seen[mountPoint] || isPseudoFilesystem(fsType, mountPoint) {
				continue
			}
			seen[mountPoint] = true
			name := filepath.Base(mountPoint)
			if name == "." || name == "/" || name == "" {
				name = mountPoint
			}
			roots = append(roots, rootInfo{Name: name, Path: mountPoint, Kind: "mount", Detail: source})
		}
	}
	sort.Slice(roots[1:], func(i, j int) bool { return strings.ToLower(roots[1+i].Path) < strings.ToLower(roots[1+j].Path) })
	return roots
}

func decodeMountPath(value string) string {
	replacer := strings.NewReplacer("\\040", " ", "\\011", "\t", "\\012", "\n", "\\134", "\\")
	return replacer.Replace(value)
}

func isPseudoFilesystem(fsType, mountPoint string) bool {
	switch fsType {
	case "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "securityfs", "pstore", "debugfs", "tracefs", "configfs", "mqueue", "hugetlbfs", "fusectl", "binfmt_misc":
		return true
	}
	if strings.HasPrefix(mountPoint, "/proc") || strings.HasPrefix(mountPoint, "/sys") || strings.HasPrefix(mountPoint, "/dev") {
		return true
	}
	return false
}

func decodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func openBrowser(rawURL string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL).Start()
	case "darwin":
		return exec.Command("open", rawURL).Start()
	default:
		return exec.Command("xdg-open", rawURL).Start()
	}
}

// Keep the desktop bridge loopback-only.
func init() {
	host, _, err := net.SplitHostPort(listenAddress)
	if err != nil {
		panic(err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		panic("SimpleSCP Desktop must bind to loopback only")
	}
}
