package web

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"mime"
	"net"
	"os"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gigabytegrove/simplescp/internal/buildinfo"
	"github.com/gigabytegrove/simplescp/internal/config"
	"github.com/gigabytegrove/simplescp/internal/sshclient"
	"github.com/gigabytegrove/simplescp/internal/updater"
	"github.com/gigabytegrove/simplescp/internal/store"
)

//go:embed templates/*.html static/*
var assets embed.FS

type app struct {
	cfg       config.Config
	store     *store.Store
	logger    *slog.Logger
	templates *template.Template
	mux          *http.ServeMux
	loginLimiter *loginLimiter
	transferSem  chan struct{}
	updater      *updater.Manager
}

type ctxKey string
const sessionKey ctxKey = "session"

func New(cfg config.Config, db *store.Store, logger *slog.Logger) (http.Handler, error) {
	t, err := template.ParseFS(assets, "templates/*.html")
	if err != nil { return nil, fmt.Errorf("parse templates: %w", err) }
	a := &app{
		cfg:cfg,
		store:db,
		logger:logger,
		templates:t,
		mux:http.NewServeMux(),
		loginLimiter:newLoginLimiter(cfg.LoginMaxAttempts, cfg.LoginWindow),
		transferSem:make(chan struct{}, cfg.MaxConcurrentTransfers),
		updater:updater.New(cfg.DataDir),
	}
	a.routes()
	return a.securityHeaders(a.sameOrigin(a.sessionMiddleware(a.mux))), nil
}

func (a *app) routes() {
	staticFS := http.FileServer(http.FS(assets))
	a.mux.Handle("GET /static/", staticFS)
	a.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK); _,_ = w.Write([]byte("ok")) })
	a.mux.HandleFunc("GET /login", a.loginPage)
	a.mux.HandleFunc("POST /login", a.login)
	a.mux.HandleFunc("POST /logout", a.requireAuth(a.requireCSRF(a.logout)))
	a.mux.HandleFunc("GET /", a.requireAuth(a.dashboard))

	a.mux.HandleFunc("GET /api/connections", a.requireAuth(a.listConnections))
	a.mux.HandleFunc("POST /api/connections", a.requireAuth(a.requireCSRF(a.createConnection)))
	a.mux.HandleFunc("PUT /api/connections/{id}", a.requireAuth(a.requireCSRF(a.updateConnection)))
	a.mux.HandleFunc("DELETE /api/connections/{id}", a.requireAuth(a.requireCSRF(a.deleteConnection)))
	a.mux.HandleFunc("POST /api/connections/{id}/trust", a.requireAuth(a.requireCSRF(a.trustConnection)))
	a.mux.HandleFunc("GET /api/connections/{id}/list", a.requireAuth(a.listRemote))
	a.mux.HandleFunc("POST /api/connections/{id}/mkdir", a.requireAuth(a.requireCSRF(a.mkdirRemote)))
	a.mux.HandleFunc("POST /api/connections/{id}/rename", a.requireAuth(a.requireCSRF(a.renameRemote)))
	a.mux.HandleFunc("POST /api/connections/{id}/delete", a.requireAuth(a.requireCSRF(a.deleteRemote)))
	a.mux.HandleFunc("POST /api/connections/{id}/upload", a.requireAuth(a.requireCSRF(a.uploadRemote)))
	a.mux.HandleFunc("GET /api/connections/{id}/download", a.requireAuth(a.downloadRemote))
	a.mux.HandleFunc("POST /api/transfer", a.requireAuth(a.requireCSRF(a.transferRemote)))
	a.mux.HandleFunc("GET /api/update", a.requireAuth(a.requireAdmin(a.updateStatus)))
	a.mux.HandleFunc("POST /api/update/install", a.requireAuth(a.requireAdmin(a.requireCSRF(a.installUpdate))))
	a.mux.HandleFunc("POST /api/update/rollback", a.requireAuth(a.requireAdmin(a.requireCSRF(a.rollbackUpdate))))
}

func (a *app) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		if !strings.HasPrefix(r.URL.Path, "/static/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
		}
		if a.cfg.CookieSecure {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w,r)
	})
}

func (a *app) sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}

		check := func(raw string) bool {
			if strings.TrimSpace(raw) == "" {
				return true
			}
			u, err := url.Parse(raw)
			if err != nil || u.Host == "" {
				return false
			}
			return strings.EqualFold(u.Host, r.Host)
		}

		if !check(r.Header.Get("Origin")) || !check(r.Header.Get("Referer")) {
			writeError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func randomWebToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (a *app) newLoginCSRF() (string, error) {
	nonce, err := randomWebToken(24)
	if err != nil {
		return "", err
	}
	issued := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	payload := issued + "." + nonce
	mac := hmac.New(sha256.New, a.cfg.MasterKey)
	_, _ = mac.Write([]byte("simplescp-login-csrf:" + payload))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + signature, nil
}

func (a *app) validLoginCSRF(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	issuedUnix, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}
	issued := time.Unix(issuedUnix, 0).UTC()
	now := time.Now().UTC()
	if issued.After(now.Add(time.Minute)) || now.Sub(issued) > 10*time.Minute {
		return false
	}
	payload := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, a.cfg.MasterKey)
	_, _ = mac.Write([]byte("simplescp-login-csrf:" + payload))
	expected := mac.Sum(nil)
	provided, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	return hmac.Equal(expected, provided)
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func secureEqual(a, b string) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (a *app) acquireTransfer(r *http.Request) bool {
	select {
	case a.transferSem <- struct{}{}:
		return true
	case <-r.Context().Done():
		return false
	}
}

func (a *app) releaseTransfer() {
	<-a.transferSem
}

func (a *app) sessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("simplescp_session")
		if err == nil && c.Value != "" {
			if sess, err := a.store.GetSession(c.Value); err == nil {
				r = r.WithContext(context.WithValue(r.Context(), sessionKey, sess))
			}
		}
		next.ServeHTTP(w,r)
	})
}

func sessionFrom(r *http.Request) (store.Session, bool) {
	s, ok := r.Context().Value(sessionKey).(store.Session)
	return s, ok
}

func (a *app) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := sessionFrom(r); !ok {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeError(w,http.StatusUnauthorized,"authentication required")
				return
			}
			http.Redirect(w,r,"/login",http.StatusSeeOther)
			return
		}
		next(w,r)
	}
}

func (a *app) requireCSRF(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := sessionFrom(r)
		if !ok || !secureEqual(r.Header.Get("X-CSRF-Token"), sess.CSRFToken) {
			writeError(w,http.StatusForbidden,"invalid CSRF token")
			return
		}
		next(w,r)
	}
}

func (a *app) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := sessionFrom(r)
		if !ok || !sess.IsAdmin {
			writeError(w, http.StatusForbidden, "administrator access required")
			return
		}
		next(w, r)
	}
}

func (a *app) loginPage(w http.ResponseWriter, r *http.Request) {
	if _, ok := sessionFrom(r); ok {
		http.Redirect(w,r,"/",http.StatusSeeOther)
		return
	}
	token, err := a.newLoginCSRF()
	if err != nil {
		http.Error(w, "Unable to initialize login", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type","text/html; charset=utf-8")
	_ = a.templates.ExecuteTemplate(w,"login.html",map[string]any{"CSRF":token,"Version":buildinfo.Version})
}

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w,"Bad request",http.StatusBadRequest)
		return
	}

	loginToken := r.FormValue("csrf_token")
	if !a.validLoginCSRF(loginToken) {
		token, tokenErr := a.newLoginCSRF()
		if tokenErr != nil {
			http.Error(w, "Unable to initialize login", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type","text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_ = a.templates.ExecuteTemplate(w,"login.html",map[string]any{
			"Error":"Your sign-in form expired. Please try again.",
			"CSRF":token,
			"Version":buildinfo.Version,
		})
		return
	}

	username := strings.TrimSpace(r.FormValue("username"))
	limitKey := clientIP(r) + "\x00" + strings.ToLower(username)
	if !a.loginLimiter.allow(limitKey, time.Now()) {
		w.Header().Set("Retry-After", strconv.FormatInt(int64(a.cfg.LoginWindow.Seconds()), 10))
		http.Error(w, "Too many login attempts", http.StatusTooManyRequests)
		return
	}

	u, err := a.store.Authenticate(username,r.FormValue("password"))
	if err != nil {
		time.Sleep(350*time.Millisecond)
		w.Header().Set("Content-Type","text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_ = a.templates.ExecuteTemplate(w,"login.html",map[string]any{
			"Error":"Invalid username or password.",
			"CSRF":loginToken,
			"Version":buildinfo.Version,
		})
		return
	}
	a.loginLimiter.reset(limitKey)

	token, _, expires, err := a.store.CreateSession(u.ID,a.cfg.SessionTTL)
	if err != nil {
		http.Error(w,"Unable to create session",http.StatusInternalServerError)
		return
	}
	http.SetCookie(w,&http.Cookie{
		Name:"simplescp_session",Value:token,Path:"/",Expires:expires,MaxAge:int(a.cfg.SessionTTL.Seconds()),HttpOnly:true,
		Secure:a.cfg.CookieSecure,SameSite:http.SameSiteStrictMode,
	})
	http.Redirect(w,r,"/",http.StatusSeeOther)
}

func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("simplescp_session"); err == nil { _ = a.store.DeleteSession(c.Value) }
	http.SetCookie(w,&http.Cookie{Name:"simplescp_session",Value:"",Path:"/",MaxAge:-1,HttpOnly:true,Secure:a.cfg.CookieSecure,SameSite:http.SameSiteStrictMode})
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) dashboard(w http.ResponseWriter, r *http.Request) {
	sess,_ := sessionFrom(r)
	w.Header().Set("Content-Type","text/html; charset=utf-8")
	if err := a.templates.ExecuteTemplate(w,"dashboard.html",map[string]any{"Username":sess.Username,"CSRF":sess.CSRFToken,"IsAdmin":sess.IsAdmin,"Version":buildinfo.Version}); err != nil {
		a.logger.Error("render dashboard","error",err)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type","application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w,status,map[string]any{"error":message})
}
func decodeJSON(r *http.Request, dst any) error {
	dec:=json.NewDecoder(io.LimitReader(r.Body,1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}
func parseID(r *http.Request) (int64,error) {
	return strconv.ParseInt(r.PathValue("id"),10,64)
}
func userID(r *http.Request) int64 { s,_:=sessionFrom(r); return s.UserID }

type connectionInput struct {
	Name string `json:"name"`
	Host string `json:"host"`
	Port int `json:"port"`
	Username string `json:"username"`
	AuthType string `json:"auth_type"`
	Password string `json:"password"`
	PrivateKey string `json:"private_key"`
	Passphrase string `json:"passphrase"`
	DefaultPath string `json:"default_path"`
}

func toConnection(in connectionInput, uid int64) store.Connection {
	port:=in.Port; if port==0 { port=22 }
	return store.Connection{UserID:uid,Name:in.Name,Host:in.Host,Port:port,Username:in.Username,AuthType:in.AuthType,Password:in.Password,PrivateKey:in.PrivateKey,Passphrase:in.Passphrase,DefaultPath:in.DefaultPath}
}

func publicConnection(c store.Connection) store.Connection {
	c.Password=""; c.PrivateKey=""; c.Passphrase=""
	return c
}

func (a *app) listConnections(w http.ResponseWriter,r *http.Request) {
	items,err:=a.store.ListConnections(userID(r))
	if err!=nil { writeError(w,500,"unable to load connections"); return }
	writeJSON(w,200,map[string]any{"connections":items})
}

func (a *app) createConnection(w http.ResponseWriter,r *http.Request) {
	var in connectionInput
	if err:=decodeJSON(r,&in); err!=nil { writeError(w,400,"invalid connection payload"); return }
	c:=toConnection(in,userID(r))
	saved,err:=a.store.SaveConnection(c)
	if err!=nil { writeError(w,400,err.Error()); return }
	writeJSON(w,201,publicConnection(saved))
}

func (a *app) updateConnection(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	var in connectionInput
	if err:=decodeJSON(r,&in); err!=nil { writeError(w,400,"invalid connection payload"); return }
	c:=toConnection(in,userID(r)); c.ID=id
	current,err:=a.store.GetConnection(userID(r),id)
	if err!=nil { writeError(w,404,"connection not found"); return }
	if current.Host != strings.TrimSpace(c.Host) || current.Port != c.Port {
		c.HostKeyFingerprint=""
	} else {
		c.HostKeyFingerprint=current.HostKeyFingerprint
	}
	saved,err:=a.store.SaveConnection(c)
	if err!=nil { writeError(w,400,err.Error()); return }
	writeJSON(w,200,publicConnection(saved))
}

func (a *app) deleteConnection(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	if err:=a.store.DeleteConnection(userID(r),id); err!=nil { writeError(w,404,"connection not found"); return }
	w.WriteHeader(http.StatusNoContent)
}

type trustRequest struct {
	Fingerprint string `json:"fingerprint"`
}

func (a *app) trustConnection(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	var in trustRequest
	if err:=decodeJSON(r,&in); err!=nil || strings.TrimSpace(in.Fingerprint)=="" {
		writeError(w,400,"fingerprint is required")
		return
	}
	c,err:=a.store.GetConnection(userID(r),id)
	if err!=nil { writeError(w,404,"connection not found"); return }
	fp,err:=sshclient.ProbeFingerprint(c,a.cfg.SSHTimeout)
	if err!=nil { writeError(w,502,err.Error()); return }
	if !secureEqual(fp, strings.TrimSpace(in.Fingerprint)) {
		writeError(w,http.StatusConflict,"host key changed before confirmation; verify the new fingerprint")
		return
	}
	if err:=a.store.SetHostFingerprint(userID(r),id,fp); err!=nil { writeError(w,500,"unable to save host key"); return }
	writeJSON(w,200,map[string]any{"fingerprint":fp})
}

func (a *app) dialConnection(r *http.Request,id int64) (*sshclient.Client,error) {
	c,err:=a.store.GetConnection(userID(r),id)
	if err!=nil { return nil,errors.New("connection not found") }
	return sshclient.Dial(c,a.cfg.SSHTimeout)
}

func sshError(w http.ResponseWriter,err error) {
	var hk *sshclient.HostKeyError
	if errors.As(err,&hk) {
		writeJSON(w,http.StatusPreconditionRequired,map[string]any{"error":"host key not trusted","fingerprint":hk.Fingerprint})
		return
	}
	writeError(w,http.StatusBadGateway,err.Error())
}

func (a *app) listRemote(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }
	defer client.Close()
	p:=r.URL.Query().Get("path")
	items,err:=client.List(p); if err!=nil { sshError(w,err); return }
	writeJSON(w,200,map[string]any{"path":sshclient.CleanRemote(p),"entries":items})
}

type pathRequest struct { Path string `json:"path"` }
func (a *app) mkdirRemote(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	var in pathRequest; if decodeJSON(r,&in)!=nil || strings.TrimSpace(in.Path)=="" { writeError(w,400,"path is required"); return }
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }; defer client.Close()
	if err:=client.Mkdir(in.Path); err!=nil { sshError(w,err); return }
	w.WriteHeader(http.StatusNoContent)
}
type renameRequest struct { OldPath string `json:"old_path"`; NewPath string `json:"new_path"` }
func (a *app) renameRemote(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	var in renameRequest; if decodeJSON(r,&in)!=nil || in.OldPath=="" || in.NewPath=="" { writeError(w,400,"old_path and new_path are required"); return }
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }; defer client.Close()
	if err:=client.Rename(in.OldPath,in.NewPath); err!=nil { sshError(w,err); return }
	w.WriteHeader(http.StatusNoContent)
}
type deleteRequest struct { Path string `json:"path"`; Recursive bool `json:"recursive"` }
func (a *app) deleteRemote(w http.ResponseWriter,r *http.Request) {
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	var in deleteRequest; if decodeJSON(r,&in)!=nil || in.Path=="" { writeError(w,400,"path is required"); return }
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }; defer client.Close()
	if err:=client.Remove(in.Path,in.Recursive); err!=nil { sshError(w,err); return }
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) uploadRemote(w http.ResponseWriter,r *http.Request) {
	if !a.acquireTransfer(r) { writeError(w,499,"request canceled"); return }
	defer a.releaseTransfer()
	r.Body = http.MaxBytesReader(w, r.Body, a.cfg.MaxUploadBytes)
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	target:=sshclient.CleanRemote(r.URL.Query().Get("path"))
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }; defer client.Close()
	mr,err:=r.MultipartReader(); if err!=nil { writeError(w,400,"multipart upload required"); return }
	var uploaded []map[string]any
	for {
		part,err:=mr.NextPart()
		if errors.Is(err,io.EOF) { break }
		if err!=nil { writeError(w,400,"invalid multipart upload"); return }
		if part.FileName()=="" { part.Close(); continue }
		name:=path.Base(strings.ReplaceAll(part.FileName(),"\\","/"))
		if name=="." || name=="/" || name=="" { part.Close(); continue }
		finalPath:=path.Join(target,name)
		tempPath,dst,err:=client.CreateTemp(finalPath)
		if err!=nil { part.Close(); sshError(w,err); return }
		n,copyErr:=io.Copy(dst,part)
		closeErr:=dst.Close()
		part.Close()
		if copyErr!=nil {
			client.AbortTemp(tempPath)
			if strings.Contains(copyErr.Error(), "request body too large") {
				writeError(w,http.StatusRequestEntityTooLarge,"upload exceeds configured size limit")
				return
			}
			sshError(w,copyErr)
			return
		}
		if closeErr!=nil {
			client.AbortTemp(tempPath)
			sshError(w,closeErr)
			return
		}
		if err:=client.CommitTemp(tempPath,finalPath); err!=nil {
			client.AbortTemp(tempPath)
			sshError(w,err)
			return
		}
		uploaded=append(uploaded,map[string]any{"name":name,"bytes":n})
	}
	writeJSON(w,201,map[string]any{"uploaded":uploaded})
}

func (a *app) downloadRemote(w http.ResponseWriter,r *http.Request) {
	if !a.acquireTransfer(r) { writeError(w,499,"request canceled"); return }
	defer a.releaseTransfer()
	id,err:=parseID(r); if err!=nil { writeError(w,400,"invalid connection id"); return }
	remotePath:=r.URL.Query().Get("path"); if remotePath=="" { writeError(w,400,"path is required"); return }
	client,err:=a.dialConnection(r,id); if err!=nil { sshError(w,err); return }; defer client.Close()
	f,info,err:=client.Open(remotePath); if err!=nil { sshError(w,err); return }; defer f.Close()
	filename:=path.Base(remotePath)
	w.Header().Set("Content-Disposition",fmt.Sprintf("attachment; filename*=UTF-8''%s",url.PathEscape(filename)))
	if ct:=mime.TypeByExtension(path.Ext(filename)); ct!="" { w.Header().Set("Content-Type",ct) } else { w.Header().Set("Content-Type","application/octet-stream") }
	w.Header().Set("Content-Length",strconv.FormatInt(info.Size(),10))
	_,_ = io.Copy(w,f)
}

type transferRequest struct {
	SourceConnectionID int64 `json:"source_connection_id"`
	SourcePath string `json:"source_path"`
	DestinationConnectionID int64 `json:"destination_connection_id"`
	DestinationPath string `json:"destination_path"`
}
func (a *app) transferRemote(w http.ResponseWriter,r *http.Request) {
	if !a.acquireTransfer(r) { writeError(w,499,"request canceled"); return }
	defer a.releaseTransfer()
	var in transferRequest
	if decodeJSON(r,&in)!=nil || in.SourceConnectionID<=0 || in.DestinationConnectionID<=0 || in.SourcePath=="" || in.DestinationPath=="" {
		writeError(w,400,"source and destination connection/path are required"); return
	}
	src,err:=a.dialConnection(r,in.SourceConnectionID); if err!=nil { sshError(w,err); return }; defer src.Close()
	dst,err:=a.dialConnection(r,in.DestinationConnectionID); if err!=nil { sshError(w,err); return }; defer dst.Close()
	n,err:=sshclient.CopyFile(src,in.SourcePath,dst,in.DestinationPath); if err!=nil { sshError(w,err); return }
	writeJSON(w,200,map[string]any{"bytes":n})
}

func (a *app) updateStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.updater.Status(r.Context(), buildinfo.Version, buildinfo.Commit, buildinfo.BuildTime)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func restartAfterResponse() {
	go func() {
		time.Sleep(900 * time.Millisecond)
		os.Exit(0)
	}()
}

func (a *app) installUpdate(w http.ResponseWriter, r *http.Request) {
	result, err := a.updater.Install(r.Context(), buildinfo.Version)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "installed",
		"version": result.Version,
		"bytes": result.Bytes,
		"sha256": result.SHA256,
		"restart": true,
	})
	restartAfterResponse()
}

func (a *app) rollbackUpdate(w http.ResponseWriter, r *http.Request) {
	if err := a.updater.Rollback(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status":"rollback-staged","restart":true})
	restartAfterResponse()
}
