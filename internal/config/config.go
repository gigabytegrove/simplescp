package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen        string
	DataDir       string
	MasterKey     []byte
	AdminUser     string
	AdminPassword string
	CookieSecure  bool
	SessionTTL    time.Duration
	SSHTimeout    time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Listen:        env("SIMPLE_SCP_LISTEN", ":8080"),
		DataDir:       env("SIMPLE_SCP_DATA_DIR", "/data"),
		AdminUser:     env("SIMPLE_SCP_ADMIN_USER", "admin"),
		AdminPassword: os.Getenv("SIMPLE_SCP_ADMIN_PASSWORD"),
	}

	keyText := strings.TrimSpace(os.Getenv("SIMPLE_SCP_MASTER_KEY"))
	if keyText == "" {
		return Config{}, errors.New("SIMPLE_SCP_MASTER_KEY is required")
	}
	key, err := base64.StdEncoding.DecodeString(keyText)
	if err != nil || len(key) != 32 {
		return Config{}, errors.New("SIMPLE_SCP_MASTER_KEY must be a base64-encoded 32-byte key")
	}
	cfg.MasterKey = key

	if strings.TrimSpace(cfg.AdminPassword) == "" {
		return Config{}, errors.New("SIMPLE_SCP_ADMIN_PASSWORD is required")
	}
	if len(cfg.AdminPassword) < 12 {
		return Config{}, errors.New("SIMPLE_SCP_ADMIN_PASSWORD must be at least 12 characters")
	}

	cfg.CookieSecure, err = strconv.ParseBool(env("SIMPLE_SCP_COOKIE_SECURE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("invalid SIMPLE_SCP_COOKIE_SECURE: %w", err)
	}
	cfg.SessionTTL, err = time.ParseDuration(env("SIMPLE_SCP_SESSION_TTL", "24h"))
	if err != nil || cfg.SessionTTL < 15*time.Minute {
		return Config{}, errors.New("SIMPLE_SCP_SESSION_TTL must be a valid duration of at least 15m")
	}
	cfg.SSHTimeout, err = time.ParseDuration(env("SIMPLE_SCP_SSH_TIMEOUT", "15s"))
	if err != nil || cfg.SSHTimeout < time.Second {
		return Config{}, errors.New("SIMPLE_SCP_SSH_TIMEOUT must be a valid duration of at least 1s")
	}

	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return Config{}, fmt.Errorf("create data directory: %w", err)
	}
	abs, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve data directory: %w", err)
	}
	cfg.DataDir = abs
	return cfg, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
