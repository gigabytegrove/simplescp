package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gigabytegrove/simplescp/internal/buildinfo"
	"github.com/gigabytegrove/simplescp/internal/config"
	"github.com/gigabytegrove/simplescp/internal/store"
	"github.com/gigabytegrove/simplescp/internal/updater"
	"github.com/gigabytegrove/simplescp/internal/vault"
	webapp "github.com/gigabytegrove/simplescp/internal/web"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	if !cfg.CookieSecure {
		logger.Warn("secure cookies are disabled; do not expose SimpleSCP over an untrusted network without TLS")
	}

	v, err := vault.New(cfg.MasterKey)
	if err != nil {
		logger.Error("vault initialization failed", "error", err)
		os.Exit(1)
	}

	db, err := store.Open(cfg.DataDir, v)
	if err != nil {
		logger.Error("database initialization failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.BootstrapAdmin(cfg.AdminUser, cfg.AdminPassword); err != nil {
		logger.Error("admin bootstrap failed", "error", err)
		os.Exit(1)
	}
	db.CleanupSessions()

	app, err := webapp.New(cfg, db, logger)
	if err != nil {
		logger.Error("web application initialization failed", "error", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           app,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		logger.Info("SimpleSCP listening", "address", cfg.Listen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	}()

	if cfg.AutoUpdate {
		updateManager := updater.New(cfg.DataDir)
		go func() {
			initialDelay := time.NewTimer(45 * time.Second)
			defer initialDelay.Stop()

			select {
			case <-initialDelay.C:
			}

			ticker := time.NewTicker(cfg.AutoUpdateInterval)
			defer ticker.Stop()

			check := func() bool {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
				defer cancel()

				status, err := updateManager.Status(ctx, buildinfo.Version, buildinfo.Commit, buildinfo.BuildTime)
				if err != nil {
					logger.Warn("automatic update check failed", "error", err)
					return false
				}
				if !status.UpdateAvailable {
					logger.Info("automatic update check complete", "current", buildinfo.Version, "latest", status.Latest)
					return false
				}

				result, err := updateManager.Install(ctx, buildinfo.Version)
				if err != nil {
					logger.Error("automatic update failed", "error", err)
					return false
				}

				logger.Info("automatic update installed; restarting", "version", result.Version, "sha256", result.SHA256)
				proc, err := os.FindProcess(os.Getpid())
				if err != nil {
					logger.Error("automatic update restart failed", "error", err)
					return false
				}
				if err := proc.Signal(syscall.SIGTERM); err != nil {
					logger.Error("automatic update restart signal failed", "error", err)
					return false
				}
				return true
			}

			if check() {
				return
			}
			for range ticker.C {
				if check() {
					return
				}
			}
		}()
		logger.Info("automatic updates enabled", "interval", cfg.AutoUpdateInterval.String())
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}
