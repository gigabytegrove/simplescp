package web

import (
	"net/http"
	"sync"
	"time"

	"github.com/gigabytegrove/simplescp/internal/store"
)

type runtimeSettingsState struct {
	mu    sync.RWMutex
	value store.ServerSettings
}

func newRuntimeSettingsState(v store.ServerSettings) *runtimeSettingsState {
	return &runtimeSettingsState{value: v}
}

func (s *runtimeSettingsState) get() store.ServerSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.value
}

func (s *runtimeSettingsState) set(v store.ServerSettings) {
	s.mu.Lock()
	s.value = v
	s.mu.Unlock()
}

func (a *app) runtimeSettings() store.ServerSettings {
	return a.settings.get()
}

func (a *app) applyRuntimeSettings(v store.ServerSettings) {
	a.settings.set(v)
	a.loginLimiter.set(v.LoginMaxAttempts, time.Duration(v.LoginWindowSeconds)*time.Second)
	a.transferSem.setLimit(v.MaxConcurrentTransfers)
}

func (a *app) adminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := a.store.GetServerSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to load server settings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": settings,
		"updates": map[string]any{
			"installation": "manual_only",
			"description":  "SimpleSCP never installs an update unless an administrator explicitly presses Install update.",
		},
	})
}

func (a *app) adminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var input store.ServerSettings
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid server settings")
		return
	}
	if err := a.store.SaveServerSettings(input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.applyRuntimeSettings(input)
	a.logger.Info("server settings changed by administrator",
		"cookie_secure", input.CookieSecure,
		"session_ttl_seconds", input.SessionTTLSeconds,
		"ssh_timeout_seconds", input.SSHTimeoutSeconds,
		"max_upload_bytes", input.MaxUploadBytes,
		"max_concurrent_transfers", input.MaxConcurrentTransfers,
		"login_max_attempts", input.LoginMaxAttempts,
		"login_window_seconds", input.LoginWindowSeconds,
	)
	writeJSON(w, http.StatusOK, map[string]any{"settings": input})
}
