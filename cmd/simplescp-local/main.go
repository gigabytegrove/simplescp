package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const listenAddr = "127.0.0.1:9431"

type session struct {
	Token  string
	Origin string
	Expiry time.Time
}

type bridge struct {
	pairCode    string
	mu          sync.Mutex
	sessions    map[string]session
	sessionFile string
}

type rootInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type entryInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	IsDir   bool      `json:"is_dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

func main() {
	sessionFile := bridgeSessionFile()
	b := &bridge{
		pairCode:    randomCode(),
		sessions:    make(map[string]session),
		sessionFile: sessionFile,
	}
	b.loadSessions()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", b.info)
	mux.HandleFunc("POST /v1/pair", b.pair)
	mux.HandleFunc("OPTIONS /", b.options)
	mux.HandleFunc("GET /v1/roots", b.auth(b.roots))
	mux.HandleFunc("GET /v1/list", b.auth(b.list))
	mux.HandleFunc("GET /v1/file", b.auth(b.download))
	mux.HandleFunc("PUT /v1/file", b.auth(b.upload))
	mux.HandleFunc("POST /v1/mkdir", b.auth(b.mkdir))
	mux.HandleFunc("POST /v1/rename", b.auth(b.rename))
	mux.HandleFunc("POST /v1/delete", b.auth(b.remove))

	fmt.Println("SimpleSCP Local Bridge")
	fmt.Println("======================")
	fmt.Println("Listening on http://" + listenAddr)
	fmt.Println("Pairing code:", b.pairCode)
	fmt.Println("Keep this window open while using local disks in SimpleSCP.")

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	log.Fatal(srv.ListenAndServe())
}

func bridgeSessionFile() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil || home == "" {
			return ""
		}
		dir = home
	}
	dir = filepath.Join(dir, "SimpleSCP")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "local-bridge-sessions.json")
}

func (b *bridge) loadSessions() {
	if b.sessionFile == "" {
		return
	}
	data, err := os.ReadFile(b.sessionFile)
	if err != nil {
		return
	}
	var saved []session
	if json.Unmarshal(data, &saved) != nil {
		return
	}
	now := time.Now()
	for _, item := range saved {
		if item.Token != "" && item.Origin != "" && item.Expiry.After(now) {
			b.sessions[item.Token] = item
		}
	}
}

func (b *bridge) saveSessionsLocked() {
	if b.sessionFile == "" {
		return
	}
	now := time.Now()
	items := make([]session, 0, len(b.sessions))
	for token, item := range b.sessions {
		if item.Expiry.After(now) {
			items = append(items, item)
		} else {
			delete(b.sessions, token)
		}
	}
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return
	}
	tmp := b.sessionFile + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, b.sessionFile)
	}
}

func randomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf)
}

func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func originAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	return strings.HasPrefix(origin, "https://") ||
		strings.HasPrefix(origin, "http://localhost") ||
		strings.HasPrefix(origin, "http://127.0.0.1")
}

func setCORS(w http.ResponseWriter, origin string) {
	if originAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
	w.Header().Set("Access-Control-Max-Age", "600")
}

func (b *bridge) options(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r.Header.Get("Origin"))
	w.WriteHeader(http.StatusNoContent)
}

func (b *bridge) info(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r.Header.Get("Origin"))
	writeJSON(w, http.StatusOK, map[string]any{
		"name": "SimpleSCP Local Bridge",
		"version": "dev",
		"os": runtime.GOOS,
		"arch": runtime.GOARCH,
	})
}

func (b *bridge) pair(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	setCORS(w, origin)
	if !originAllowed(origin) {
		writeErr(w, http.StatusForbidden, "origin is not allowed")
		return
	}

	var in struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid pairing request")
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.ToUpper(strings.TrimSpace(in.Code))), []byte(b.pairCode)) != 1 {
		time.Sleep(250 * time.Millisecond)
		writeErr(w, http.StatusUnauthorized, "invalid pairing code")
		return
	}

	token := randomToken()
	s := session{Token: token, Origin: origin, Expiry: time.Now().Add(30 * 24 * time.Hour)}
	b.mu.Lock()
	b.sessions[token] = s
	b.saveSessionsLocked()
	b.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"expires": s.Expiry,
	})
}

func (b *bridge) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		setCORS(w, origin)
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		if !strings.HasPrefix(header, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "pairing required")
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		b.mu.Lock()
		s, ok := b.sessions[token]
		if ok && time.Now().After(s.Expiry) {
			delete(b.sessions, token)
			b.saveSessionsLocked()
			ok = false
		}
		b.mu.Unlock()
		if !ok || !subtleCompare(origin, s.Origin) {
			writeErr(w, http.StatusUnauthorized, "pairing required")
			return
		}
		next(w, r)
	}
}

func subtleCompare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func localRoots() []rootInfo {
	var roots []rootInfo
	switch runtime.GOOS {
	case "windows":
		for c := 'A'; c <= 'Z'; c++ {
			p := string(c) + ":\\"
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				roots = append(roots, rootInfo{Name: string(c) + ":", Path: p, Kind: "drive"})
			}
		}
	case "darwin":
		roots = append(roots, rootInfo{Name: "/", Path: "/", Kind: "root"})
		if items, err := os.ReadDir("/Volumes"); err == nil {
			for _, item := range items {
				if item.IsDir() {
					roots = append(roots, rootInfo{Name: item.Name(), Path: filepath.Join("/Volumes", item.Name()), Kind: "volume"})
				}
			}
		}
	default:
		roots = append(roots, rootInfo{Name: "/", Path: "/", Kind: "root"})
		for _, base := range []string{"/mnt", "/media"} {
			if items, err := os.ReadDir(base); err == nil {
				for _, item := range items {
					if item.IsDir() {
						roots = append(roots, rootInfo{Name: item.Name(), Path: filepath.Join(base, item.Name()), Kind: "mount"})
					}
				}
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, rootInfo{Name: "Home", Path: home, Kind: "home"})
	}
	return uniqueRoots(roots)
}

func uniqueRoots(in []rootInfo) []rootInfo {
	seen := map[string]bool{}
	out := make([]rootInfo, 0, len(in))
	for _, r := range in {
		p := filepath.Clean(r.Path)
		if seen[p] {
			continue
		}
		seen[p] = true
		r.Path = p
		out = append(out, r)
	}
	return out
}

func (b *bridge) roots(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"roots": localRoots()})
}

func cleanLocalPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("path is required")
	}
	p := filepath.Clean(raw)
	if !filepath.IsAbs(p) {
		return "", errors.New("absolute path required")
	}
	return p, nil
}

func (b *bridge) list(w http.ResponseWriter, r *http.Request) {
	p, err := cleanLocalPath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	entries := make([]entryInfo, 0, len(items))
	for _, item := range items {
		info, err := item.Info()
		if err != nil {
			continue
		}
		entries = append(entries, entryInfo{
			Name: item.Name(),
			Path: filepath.Join(p, item.Name()),
			IsDir: item.IsDir(),
			Size: info.Size(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"path": p, "entries": entries})
}

func (b *bridge) download(w http.ResponseWriter, r *http.Request) {
	p, err := cleanLocalPath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		writeErr(w, http.StatusBadRequest, "file path required")
		return
	}
	name := filepath.Base(p)
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.Header().Set("X-SimpleSCP-Filename", name)
	_, _ = io.Copy(w, f)
}

func (b *bridge) upload(w http.ResponseWriter, r *http.Request) {
	p, err := cleanLocalPath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	tmp := p + ".simplescp-part"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	n, copyErr := io.Copy(f, io.LimitReader(r.Body, 100<<30))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		writeErr(w, http.StatusBadRequest, "unable to write local file")
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bytes": n})
}

func decodeBody(r *http.Request, dst any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func (b *bridge) mkdir(w http.ResponseWriter, r *http.Request) {
	var in struct{ Path string `json:"path"` }
	if decodeBody(r, &in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid request")
		return
	}
	p, err := cleanLocalPath(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.Mkdir(p, 0o755); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (b *bridge) rename(w http.ResponseWriter, r *http.Request) {
	var in struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if decodeBody(r, &in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid request")
		return
	}
	oldPath, err := cleanLocalPath(in.OldPath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	newPath, err := cleanLocalPath(in.NewPath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (b *bridge) remove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if decodeBody(r, &in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid request")
		return
	}
	p, err := cleanLocalPath(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, root := range localRoots() {
		if filepath.Clean(root.Path) == p {
			writeErr(w, http.StatusForbidden, "refusing to delete a filesystem root")
			return
		}
	}
	if in.Recursive {
		err = os.RemoveAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Ensure this remains loopback-only even if listenAddr changes accidentally.
func init() {
	host, _, err := net.SplitHostPort(listenAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		panic("SimpleSCP Local Bridge must bind to loopback only")
	}
}
