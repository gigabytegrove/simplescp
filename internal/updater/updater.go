package updater

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const latestReleaseURL = "https://api.github.com/repos/gigabytegrove/simplescp/releases/latest"

type Manager struct {
	dataDir string
	client  *http.Client
}

type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type release struct {
	TagName         string  `json:"tag_name"`
	HTMLURL         string  `json:"html_url"`
	TargetCommitish string  `json:"target_commitish"`
	Prerelease      bool    `json:"prerelease"`
	PublishedAt     string  `json:"published_at"`
	Assets          []Asset `json:"assets"`
}

type Status struct {
	Current          string `json:"current"`
	Latest           string `json:"latest"`
	UpdateAvailable  bool   `json:"update_available"`
	ReleaseURL       string `json:"release_url,omitempty"`
	Architecture     string `json:"architecture"`
	RollbackAvailable bool  `json:"rollback_available"`
}

type InstallResult struct {
	Version string `json:"version"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
}

func New(dataDir string) *Manager {
	return &Manager{
		dataDir: dataDir,
		client: &http.Client{Timeout: 2 * time.Minute},
	}
}

func (m *Manager) updateDir() string { return filepath.Join(m.dataDir, "update") }
func (m *Manager) activePath() string { return filepath.Join(m.updateDir(), "simplescp") }
func (m *Manager) previousPath() string { return filepath.Join(m.updateDir(), "simplescp.previous") }

func (m *Manager) Status(ctx context.Context, current, commit, buildTime string) (Status, error) {
	rel, err := m.releaseFor(ctx)
	if err != nil {
		return Status{}, err
	}

	_, rollbackErr := os.Stat(m.previousPath())
	updateAvailable := normalizeVersion(current) != normalizeVersion(rel.TagName)

	trimmedCommit := strings.TrimSpace(commit)
	if trimmedCommit != "" && trimmedCommit != "unknown" && strings.EqualFold(trimmedCommit, strings.TrimSpace(rel.TargetCommitish)) {
		updateAvailable = false
	} else if normalizeVersion(current) == "dev" || normalizeVersion(current) == "main" || strings.HasPrefix(strings.ToLower(normalizeVersion(current)), "edge-") {
		// Source-built and legacy Edge containers should move onto the
		// published Live channel. If build identity is available, avoid
		// downgrading a source build newer than the latest Live release.
		builtAt, builtErr := time.Parse(time.RFC3339, strings.TrimSpace(buildTime))
		publishedAt, publishedErr := time.Parse(time.RFC3339, strings.TrimSpace(rel.PublishedAt))
		if builtErr == nil && publishedErr == nil {
			updateAvailable = publishedAt.After(builtAt) || !strings.EqualFold(trimmedCommit, strings.TrimSpace(rel.TargetCommitish))
		} else {
			updateAvailable = true
		}
	}

	return Status{
		Current: current,
		Latest: rel.TagName,
		UpdateAvailable: updateAvailable,
		ReleaseURL: rel.HTMLURL,
		Architecture: runtime.GOARCH,
		RollbackAvailable: rollbackErr == nil,
	}, nil
}

func normalizeVersion(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), "v")
}

func (m *Manager) releaseFor(ctx context.Context) (release, error) {
	var rel release
	body, err := m.fetch(ctx, latestReleaseURL, 2<<20)
	if err != nil {
		return rel, err
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return rel, fmt.Errorf("decode latest Live release: %w", err)
	}
	if strings.TrimSpace(rel.TagName) == "" {
		return rel, errors.New("latest Live release has no tag")
	}
	if rel.Prerelease {
		return rel, errors.New("latest release is marked as a prerelease")
	}
	return rel, nil
}

func (m *Manager) fetch(ctx context.Context, rawURL string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "SimpleSCP-Updater")
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download update metadata: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update server returned HTTP %d", resp.StatusCode)
	}
	r := io.LimitReader(resp.Body, max+1)
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("update download exceeded size limit")
	}
	return data, nil
}

func findAsset(rel release, name string) (Asset, bool) {
	for _, asset := range rel.Assets {
		if asset.Name == name {
			return asset, true
		}
	}
	return Asset{}, false
}

func checksumFromManifest(manifest []byte, filename string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(manifest)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && strings.TrimPrefix(fields[len(fields)-1], "*") == filename {
			if len(fields[0]) != 64 {
				return "", errors.New("invalid checksum in release manifest")
			}
			if _, err := hex.DecodeString(fields[0]); err != nil {
				return "", errors.New("invalid checksum in release manifest")
			}
			return strings.ToLower(fields[0]), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("checksum for %s not found", filename)
}

func (m *Manager) Install(ctx context.Context, current string) (InstallResult, error) {
	if runtime.GOOS != "linux" {
		return InstallResult{}, fmt.Errorf("self-update is only supported in the Linux container")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return InstallResult{}, fmt.Errorf("self-update is not published for architecture %s", runtime.GOARCH)
	}

	rel, err := m.releaseFor(ctx)
	if err != nil {
		return InstallResult{}, err
	}
	filename := "simplescp-linux-" + runtime.GOARCH
	binAsset, ok := findAsset(rel, filename)
	if !ok {
		return InstallResult{}, fmt.Errorf("release %s does not contain %s", rel.TagName, filename)
	}
	sumAsset, ok := findAsset(rel, "SHA256SUMS")
	if !ok {
		return InstallResult{}, fmt.Errorf("release %s does not contain SHA256SUMS", rel.TagName)
	}

	manifest, err := m.fetch(ctx, sumAsset.BrowserDownloadURL, 1<<20)
	if err != nil {
		return InstallResult{}, fmt.Errorf("download checksum manifest: %w", err)
	}
	expected, err := checksumFromManifest(manifest, filename)
	if err != nil {
		return InstallResult{}, err
	}

	binary, err := m.fetch(ctx, binAsset.BrowserDownloadURL, 100<<20)
	if err != nil {
		return InstallResult{}, fmt.Errorf("download update binary: %w", err)
	}
	sum := sha256.Sum256(binary)
	actual := hex.EncodeToString(sum[:])
	if actual != expected {
		return InstallResult{}, errors.New("downloaded update failed SHA-256 verification")
	}

	if err := os.MkdirAll(m.updateDir(), 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("create update directory: %w", err)
	}
	tmp := filepath.Join(m.updateDir(), ".simplescp.next")
	if err := os.WriteFile(tmp, binary, 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("stage update: %w", err)
	}
	if err := os.Chmod(tmp, 0o700); err != nil {
		_ = os.Remove(tmp)
		return InstallResult{}, fmt.Errorf("secure update binary: %w", err)
	}

	active := m.activePath()
	previous := m.previousPath()
	_ = os.Remove(previous)
	if _, err := os.Stat(active); err == nil {
		if err := os.Rename(active, previous); err != nil {
			_ = os.Remove(tmp)
			return InstallResult{}, fmt.Errorf("preserve previous update: %w", err)
		}
	}
	if err := os.Rename(tmp, active); err != nil {
		if _, prevErr := os.Stat(previous); prevErr == nil {
			_ = os.Rename(previous, active)
		}
		return InstallResult{}, fmt.Errorf("activate update: %w", err)
	}

	return InstallResult{Version: rel.TagName, Bytes: int64(len(binary)), SHA256: actual}, nil
}

func (m *Manager) Rollback() error {
	active := m.activePath()
	previous := m.previousPath()

	if _, err := os.Stat(previous); err == nil {
		swap := filepath.Join(m.updateDir(), ".simplescp.rollback")
		_ = os.Remove(swap)
		if err := os.Rename(active, swap); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("stage current binary: %w", err)
		}
		if err := os.Rename(previous, active); err != nil {
			_ = os.Rename(swap, active)
			return fmt.Errorf("restore previous binary: %w", err)
		}
		_ = os.Rename(swap, previous)
		return nil
	}

	// No prior self-update exists. Removing the active override makes the
	// immutable image binary become active on the next container restart.
	if err := os.Remove(active); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("restore bundled image binary: %w", err)
	}
	return nil
}
