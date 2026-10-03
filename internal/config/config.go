package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Listen        string
	DataDir       string
	MasterKey     []byte
	AdminUser     string
	AdminPassword string
}

func Load() (Config, error) {
	cfg := Config{
		Listen:    env("SIMPLE_SCP_LISTEN", ":8080"),
		DataDir:   env("SIMPLE_SCP_DATA_DIR", "/data"),
		AdminUser: env("SIMPLE_SCP_ADMIN_USER", "admin"),
	}

	adminPassword, err := secretValue("SIMPLE_SCP_ADMIN_PASSWORD", "SIMPLE_SCP_ADMIN_PASSWORD_FILE")
	if err != nil {
		return Config{}, err
	}
	cfg.AdminPassword = adminPassword

	keyRaw, err := secretValue("SIMPLE_SCP_MASTER_KEY", "SIMPLE_SCP_MASTER_KEY_FILE")
	if err != nil {
		return Config{}, err
	}
	keyText := strings.TrimSpace(keyRaw)
	if keyText == "" {
		return Config{}, errors.New("SIMPLE_SCP_MASTER_KEY is required")
	}
	key, err := base64.StdEncoding.DecodeString(keyText)
	if err != nil || len(key) != 32 {
		return Config{}, errors.New("SIMPLE_SCP_MASTER_KEY must be a base64-encoded 32-byte key")
	}
	cfg.MasterKey = key

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

func secretValue(envName, fileEnvName string) (string, error) {
	filePath := strings.TrimSpace(os.Getenv(fileEnvName))
	if filePath != "" {
		data, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileEnvName, err)
		}
		return strings.TrimRight(string(data), "\r\n"), nil
	}
	return os.Getenv(envName), nil
}
