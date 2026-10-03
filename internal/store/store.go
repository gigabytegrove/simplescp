package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gigabytegrove/simplescp/internal/vault"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

type Store struct {
	db    *sql.DB
	vault *vault.Vault
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	IsAdmin  bool   `json:"is_admin"`
}

type Session struct {
	UserID    int64
	Username  string
	IsAdmin   bool
	CSRFToken string
	ExpiresAt time.Time
}

type Connection struct {
	ID                 int64     `json:"id"`
	UserID             int64     `json:"-"`
	Name               string    `json:"name"`
	Host               string    `json:"host"`
	Port               int       `json:"port"`
	Username           string    `json:"username"`
	AuthType           string    `json:"auth_type"`
	Password           string    `json:"-"`
	PrivateKey         string    `json:"-"`
	Passphrase         string    `json:"-"`
	HostKeyFingerprint string    `json:"host_key_fingerprint,omitempty"`
	DefaultPath        string    `json:"default_path"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type DesktopDevice struct {
	ID          int64      `json:"id"`
	DeviceUID   string     `json:"device_uid"`
	OwnerUserID int64      `json:"owner_user_id"`
	OwnerName   string     `json:"owner_name,omitempty"`
	Name        string     `json:"name"`
	Platform    string     `json:"platform"`
	Arch        string     `json:"arch"`
	Enabled     bool       `json:"enabled"`
	LastSeen    *time.Time `json:"last_seen,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type DesktopRoot struct {
	ID         int64      `json:"id"`
	DeviceID   int64      `json:"device_id"`
	Name       string     `json:"name"`
	Path       string     `json:"path"`
	Kind       string     `json:"kind"`
	Detail     string     `json:"detail,omitempty"`
	TotalBytes uint64     `json:"total_bytes,omitempty"`
	FreeBytes  uint64     `json:"free_bytes,omitempty"`
	Online     bool       `json:"online"`
	Enabled    bool       `json:"enabled"`
	LastSeen   *time.Time `json:"last_seen,omitempty"`
}

type DesktopACL struct {
	RootID    int64 `json:"root_id"`
	UserID    int64 `json:"user_id"`
	CanRead   bool  `json:"can_read"`
	CanWrite  bool  `json:"can_write"`
	CanRename bool  `json:"can_rename"`
	CanDelete bool  `json:"can_delete"`
}

type DesktopRootAccess struct {
	DesktopRoot
	DesktopACL
}

type DesktopInventory struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Detail     string `json:"detail,omitempty"`
	TotalBytes uint64 `json:"total_bytes,omitempty"`
	FreeBytes  uint64 `json:"free_bytes,omitempty"`
}

type secretPayload struct {
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

func Open(dataDir string, v *vault.Vault) (*Store, error) {
	path := filepath.Join(dataDir, "simplescp.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		db.Close()
		return nil, fmt.Errorf("configure sqlite: %w", err)
	}
	s := &Store{db: db, vault: v}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
		db.Close()
		return nil, fmt.Errorf("secure database file: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash BLOB NOT NULL,
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash BLOB PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	csrf_token TEXT NOT NULL,
	expires_at DATETIME NOT NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS connections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	host TEXT NOT NULL,
	port INTEGER NOT NULL DEFAULT 22,
	username TEXT NOT NULL,
	auth_type TEXT NOT NULL CHECK(auth_type IN ('password','key')),
	encrypted_secret TEXT NOT NULL DEFAULT '',
	host_key_fingerprint TEXT NOT NULL DEFAULT '',
	default_path TEXT NOT NULL DEFAULT '/',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id);

CREATE TABLE IF NOT EXISTS desktop_devices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_uid TEXT NOT NULL UNIQUE,
	owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	platform TEXT NOT NULL,
	arch TEXT NOT NULL,
	secret_hash BLOB NOT NULL,
	encrypted_secret TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	last_seen DATETIME,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_desktop_devices_owner ON desktop_devices(owner_user_id);

CREATE TABLE IF NOT EXISTS desktop_roots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id INTEGER NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	path TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'drive',
	detail TEXT NOT NULL DEFAULT '',
	total_bytes INTEGER NOT NULL DEFAULT 0,
	free_bytes INTEGER NOT NULL DEFAULT 0,
	online INTEGER NOT NULL DEFAULT 1,
	enabled INTEGER NOT NULL DEFAULT 1,
	last_seen DATETIME,
	UNIQUE(device_id, path)
);
CREATE INDEX IF NOT EXISTS idx_desktop_roots_device ON desktop_roots(device_id);

CREATE TABLE IF NOT EXISTS desktop_acl (
	root_id INTEGER NOT NULL REFERENCES desktop_roots(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	can_read INTEGER NOT NULL DEFAULT 0,
	can_write INTEGER NOT NULL DEFAULT 0,
	can_rename INTEGER NOT NULL DEFAULT 0,
	can_delete INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY(root_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_desktop_acl_user ON desktop_acl(user_id);
`)
	if err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	return nil
}

func (s *Store) BootstrapAdmin(username, password string) error {
	username = strings.TrimSpace(username)

	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		return err
	}

	// If a password is explicitly configured, keep that administrator
	// credential synchronized across container redeploys. Persistent Docker
	// volumes otherwise preserve an old bootstrap password indefinitely.
	if strings.TrimSpace(password) == "" {
		if count > 0 {
			return nil
		}
		return errors.New("initial admin password is required on a fresh database")
	}
	if username == "" {
		return errors.New("admin username is empty")
	}
	if len(password) < 12 {
		return errors.New("admin password must be at least 12 characters")
	}

	var id int64
	var currentHash []byte
	err := s.db.QueryRow("SELECT id,password_hash FROM users WHERE username = ? COLLATE NOCASE", username).Scan(&id, &currentHash)
	if err == nil {
		if bcrypt.CompareHashAndPassword(currentHash, []byte(password)) == nil {
			_, err = s.db.Exec("UPDATE users SET is_admin=1 WHERE id=?", id)
			return err
		}
		hash, hashErr := bcrypt.GenerateFromPassword([]byte(password), 12)
		if hashErr != nil {
			return fmt.Errorf("hash admin password: %w", hashErr)
		}
		_, err = s.db.Exec("UPDATE users SET password_hash=?,is_admin=1 WHERE id=?", hash, id)
		if err != nil {
			return fmt.Errorf("synchronize admin password: %w", err)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}
	_, err = s.db.Exec("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)", username, hash)
	if err != nil {
		return fmt.Errorf("create admin user: %w", err)
	}
	return nil
}

func (s *Store) Authenticate(username, password string) (User, error) {
	var u User
	var hash []byte
	var admin int
	err := s.db.QueryRow("SELECT id,username,password_hash,is_admin FROM users WHERE username = ? COLLATE NOCASE", strings.TrimSpace(username)).
		Scan(&u.ID, &u.Username, &hash, &admin)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, errors.New("invalid username or password")
		}
		return User{}, err
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		return User{}, errors.New("invalid username or password")
	}
	u.IsAdmin = admin == 1
	return u, nil
}

func randomToken(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func (s *Store) CreateSession(userID int64, ttl time.Duration) (token, csrf string, expires time.Time, err error) {
	token, err = randomToken(32)
	if err != nil { return "", "", time.Time{}, err }
	csrf, err = randomToken(24)
	if err != nil { return "", "", time.Time{}, err }
	expires = time.Now().UTC().Add(ttl)
	_, err = s.db.Exec("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)", tokenHash(token), userID, csrf, expires)
	return
}

func (s *Store) GetSession(token string) (Session, error) {
	var sess Session
	var admin int
	err := s.db.QueryRow(`
SELECT s.user_id,u.username,u.is_admin,s.csrf_token,s.expires_at
FROM sessions s JOIN users u ON u.id=s.user_id
WHERE s.token_hash=? AND s.expires_at > ?`, tokenHash(token), time.Now().UTC()).
		Scan(&sess.UserID, &sess.Username, &admin, &sess.CSRFToken, &sess.ExpiresAt)
	if err != nil {
		return Session{}, err
	}
	sess.IsAdmin = admin == 1
	return sess, nil
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec("DELETE FROM sessions WHERE token_hash=?", tokenHash(token))
	return err
}

func (s *Store) CleanupSessions() {
	_, _ = s.db.Exec("DELETE FROM sessions WHERE expires_at <= ?", time.Now().UTC())
}

func (s *Store) ListConnections(userID int64) ([]Connection, error) {
	rows, err := s.db.Query(`
SELECT id,user_id,name,host,port,username,auth_type,host_key_fingerprint,default_path,created_at,updated_at
FROM connections WHERE user_id=? ORDER BY name COLLATE NOCASE`, userID)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		var c Connection
		if err := rows.Scan(&c.ID,&c.UserID,&c.Name,&c.Host,&c.Port,&c.Username,&c.AuthType,&c.HostKeyFingerprint,&c.DefaultPath,&c.CreatedAt,&c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetConnection(userID, id int64) (Connection, error) {
	var c Connection
	var encrypted string
	err := s.db.QueryRow(`
SELECT id,user_id,name,host,port,username,auth_type,encrypted_secret,host_key_fingerprint,default_path,created_at,updated_at
FROM connections WHERE id=? AND user_id=?`, id, userID).
		Scan(&c.ID,&c.UserID,&c.Name,&c.Host,&c.Port,&c.Username,&c.AuthType,&encrypted,&c.HostKeyFingerprint,&c.DefaultPath,&c.CreatedAt,&c.UpdatedAt)
	if err != nil { return Connection{}, err }
	if encrypted != "" {
		raw, err := s.vault.Decrypt(encrypted)
		if err != nil { return Connection{}, err }
		var sec secretPayload
		if err := json.Unmarshal(raw, &sec); err != nil { return Connection{}, errors.New("stored connection secret is invalid") }
		c.Password, c.PrivateKey, c.Passphrase = sec.Password, sec.PrivateKey, sec.Passphrase
	}
	return c, nil
}

func validateConnection(c *Connection) error {
	c.Name = strings.TrimSpace(c.Name)
	c.Host = strings.TrimSpace(c.Host)
	c.Username = strings.TrimSpace(c.Username)
	c.DefaultPath = strings.TrimSpace(c.DefaultPath)
	if c.Name == "" || c.Host == "" || c.Username == "" {
		return errors.New("name, host, and username are required")
	}
	if len(c.Name) > 128 {
		return errors.New("connection name is too long")
	}
	if len(c.Host) > 253 {
		return errors.New("host is too long")
	}
	if len(c.Username) > 128 {
		return errors.New("username is too long")
	}
	if len(c.DefaultPath) > 4096 {
		return errors.New("default path is too long")
	}
	if len(c.Password) > 4096 || len(c.Passphrase) > 4096 {
		return errors.New("credential value is too long")
	}
	if len(c.PrivateKey) > 65536 {
		return errors.New("private key is too large")
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	if c.AuthType != "password" && c.AuthType != "key" {
		return errors.New("auth_type must be password or key")
	}
	if c.DefaultPath == "" { c.DefaultPath = "/" }
	return nil
}

func validateActiveSecret(c Connection) error {
	switch c.AuthType {
	case "password":
		if c.Password == "" {
			return errors.New("password authentication requires a password")
		}
	case "key":
		if strings.TrimSpace(c.PrivateKey) == "" {
			return errors.New("key authentication requires a private key")
		}
	}
	return nil
}

func (s *Store) SaveConnection(c Connection) (Connection, error) {
	if err := validateConnection(&c); err != nil { return Connection{}, err }
	sec := secretPayload{Password:c.Password, PrivateKey:c.PrivateKey, Passphrase:c.Passphrase}
	raw, err := json.Marshal(sec)
	if err != nil { return Connection{}, err }
	encrypted, err := s.vault.Encrypt(raw)
	if err != nil { return Connection{}, err }

	if c.ID == 0 {
		if err := validateActiveSecret(c); err != nil { return Connection{}, err }
		res, err := s.db.Exec(`
INSERT INTO connections(user_id,name,host,port,username,auth_type,encrypted_secret,host_key_fingerprint,default_path)
VALUES(?,?,?,?,?,?,?,?,?)`, c.UserID,c.Name,c.Host,c.Port,c.Username,c.AuthType,encrypted,c.HostKeyFingerprint,c.DefaultPath)
		if err != nil { return Connection{}, err }
		c.ID, _ = res.LastInsertId()
		return s.GetConnection(c.UserID, c.ID)
	}

	current, err := s.GetConnection(c.UserID, c.ID)
	if err != nil { return Connection{}, err }
	if c.Password == "" && c.PrivateKey == "" && c.Passphrase == "" {
		c.Password, c.PrivateKey, c.Passphrase = current.Password, current.PrivateKey, current.Passphrase
		raw, _ = json.Marshal(secretPayload{Password:c.Password,PrivateKey:c.PrivateKey,Passphrase:c.Passphrase})
		encrypted, err = s.vault.Encrypt(raw)
		if err != nil { return Connection{}, err }
	}
	if err := validateActiveSecret(c); err != nil { return Connection{}, err }
	_, err = s.db.Exec(`
UPDATE connections SET name=?,host=?,port=?,username=?,auth_type=?,encrypted_secret=?,host_key_fingerprint=?,default_path=?,updated_at=CURRENT_TIMESTAMP
WHERE id=? AND user_id=?`, c.Name,c.Host,c.Port,c.Username,c.AuthType,encrypted,c.HostKeyFingerprint,c.DefaultPath,c.ID,c.UserID)
	if err != nil { return Connection{}, err }
	return s.GetConnection(c.UserID, c.ID)
}

func (s *Store) SetHostFingerprint(userID, id int64, fingerprint string) error {
	res, err := s.db.Exec("UPDATE connections SET host_key_fingerprint=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?", fingerprint,id,userID)
	if err != nil { return err }
	n, _ := res.RowsAffected()
	if n != 1 { return sql.ErrNoRows }
	return nil
}

func (s *Store) DeleteConnection(userID, id int64) error {
	res, err := s.db.Exec("DELETE FROM connections WHERE id=? AND user_id=?", id,userID)
	if err != nil { return err }
	n, _ := res.RowsAffected()
	if n != 1 { return sql.ErrNoRows }
	return nil
}

func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query("SELECT id,username,is_admin FROM users ORDER BY username COLLATE NOCASE")
	if err != nil { return nil, err }
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		var admin int
		if err := rows.Scan(&u.ID, &u.Username, &admin); err != nil { return nil, err }
		u.IsAdmin = admin == 1
		out = append(out, u)
	}
	return out, rows.Err()
}

func validateDesktopIdentity(uid, secret string) error {
	if len(strings.TrimSpace(uid)) < 16 || len(uid) > 128 {
		return errors.New("invalid desktop device id")
	}
	if len(strings.TrimSpace(secret)) < 32 || len(secret) > 512 {
		return errors.New("invalid desktop secret")
	}
	return nil
}

func (s *Store) EnrollDesktop(ownerUserID int64, uid, secret, name, platform, arch string) (DesktopDevice, error) {
	uid = strings.TrimSpace(uid)
	secret = strings.TrimSpace(secret)
	name = strings.TrimSpace(name)
	platform = strings.TrimSpace(platform)
	arch = strings.TrimSpace(arch)
	if err := validateDesktopIdentity(uid, secret); err != nil { return DesktopDevice{}, err }
	if name == "" { name = "SimpleSCP Desktop" }
	if len(name) > 128 || len(platform) > 32 || len(arch) > 32 {
		return DesktopDevice{}, errors.New("desktop metadata is too long")
	}

	var existingID, existingOwner int64
	var existingHash []byte
	err := s.db.QueryRow("SELECT id,owner_user_id,secret_hash FROM desktop_devices WHERE device_uid=?", uid).
		Scan(&existingID, &existingOwner, &existingHash)
	if err == nil {
		if existingOwner != ownerUserID {
			return DesktopDevice{}, errors.New("desktop is already enrolled to another user")
		}
		if subtleConstantCompare(existingHash, tokenHash(secret)) == false {
			return DesktopDevice{}, errors.New("desktop identity could not be verified")
		}
		_, err = s.db.Exec(`UPDATE desktop_devices SET name=?,platform=?,arch=?,last_seen=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
			name, platform, arch, time.Now().UTC(), existingID)
		if err != nil { return DesktopDevice{}, err }
		return s.GetDesktop(existingID)
	}
	if !errors.Is(err, sql.ErrNoRows) { return DesktopDevice{}, err }

	encrypted, err := s.vault.Encrypt([]byte(secret))
	if err != nil { return DesktopDevice{}, err }
	res, err := s.db.Exec(`
INSERT INTO desktop_devices(device_uid,owner_user_id,name,platform,arch,secret_hash,encrypted_secret,last_seen)
VALUES(?,?,?,?,?,?,?,?)`, uid, ownerUserID, name, platform, arch, tokenHash(secret), encrypted, time.Now().UTC())
	if err != nil { return DesktopDevice{}, err }
	id, _ := res.LastInsertId()
	return s.GetDesktop(id)
}

func subtleConstantCompare(a, b []byte) bool {
	if len(a) != len(b) { return false }
	var diff byte
	for i := range a { diff |= a[i] ^ b[i] }
	return diff == 0
}

func (s *Store) GetDesktop(id int64) (DesktopDevice, error) {
	var d DesktopDevice
	var enabled int
	var last sql.NullTime
	err := s.db.QueryRow(`
SELECT d.id,d.device_uid,d.owner_user_id,u.username,d.name,d.platform,d.arch,d.enabled,d.last_seen,d.created_at,d.updated_at
FROM desktop_devices d JOIN users u ON u.id=d.owner_user_id
WHERE d.id=?`, id).
		Scan(&d.ID,&d.DeviceUID,&d.OwnerUserID,&d.OwnerName,&d.Name,&d.Platform,&d.Arch,&enabled,&last,&d.CreatedAt,&d.UpdatedAt)
	if err != nil { return DesktopDevice{}, err }
	d.Enabled = enabled == 1
	if last.Valid { t := last.Time; d.LastSeen = &t }
	return d, nil
}

func (s *Store) GetDesktopByIdentity(uid, secret string) (DesktopDevice, string, error) {
	if err := validateDesktopIdentity(uid, secret); err != nil { return DesktopDevice{}, "", err }
	var id int64
	var hash []byte
	var encrypted string
	err := s.db.QueryRow("SELECT id,secret_hash,encrypted_secret FROM desktop_devices WHERE device_uid=?", strings.TrimSpace(uid)).
		Scan(&id,&hash,&encrypted)
	if err != nil { return DesktopDevice{}, "", err }
	if !subtleConstantCompare(hash, tokenHash(strings.TrimSpace(secret))) {
		return DesktopDevice{}, "", errors.New("desktop identity could not be verified")
	}
	d, err := s.GetDesktop(id)
	if err != nil { return DesktopDevice{}, "", err }
	raw, err := s.vault.Decrypt(encrypted)
	if err != nil { return DesktopDevice{}, "", err }
	return d, string(raw), nil
}

func (s *Store) ListDesktops() ([]DesktopDevice, error) {
	rows, err := s.db.Query(`
SELECT d.id,d.device_uid,d.owner_user_id,u.username,d.name,d.platform,d.arch,d.enabled,d.last_seen,d.created_at,d.updated_at
FROM desktop_devices d JOIN users u ON u.id=d.owner_user_id
ORDER BY d.name COLLATE NOCASE`)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []DesktopDevice
	for rows.Next() {
		var d DesktopDevice
		var enabled int
		var last sql.NullTime
		if err := rows.Scan(&d.ID,&d.DeviceUID,&d.OwnerUserID,&d.OwnerName,&d.Name,&d.Platform,&d.Arch,&enabled,&last,&d.CreatedAt,&d.UpdatedAt); err != nil {
			return nil, err
		}
		d.Enabled = enabled == 1
		if last.Valid { t := last.Time; d.LastSeen = &t }
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) UpdateDesktop(id int64, name string, enabled bool) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 { return errors.New("invalid desktop name") }
	res, err := s.db.Exec("UPDATE desktop_devices SET name=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", name, boolInt(enabled), id)
	if err != nil { return err }
	n,_ := res.RowsAffected()
	if n != 1 { return sql.ErrNoRows }
	return nil
}

func (s *Store) DeleteDesktop(id int64) error {
	res, err := s.db.Exec("DELETE FROM desktop_devices WHERE id=?", id)
	if err != nil { return err }
	n,_ := res.RowsAffected()
	if n != 1 { return sql.ErrNoRows }
	return nil
}

func boolInt(v bool) int {
	if v { return 1 }
	return 0
}

func (s *Store) SyncDesktopRoots(deviceID int64, roots []DesktopInventory) error {
	tx, err := s.db.Begin()
	if err != nil { return err }
	defer tx.Rollback()

	now := time.Now().UTC()
	var ownerUserID int64
	if err := tx.QueryRow("SELECT owner_user_id FROM desktop_devices WHERE id=?", deviceID).Scan(&ownerUserID); err != nil { return err }
	if _, err := tx.Exec("UPDATE desktop_roots SET online=0 WHERE device_id=?", deviceID); err != nil { return err }
	for _, root := range roots {
		root.Name = strings.TrimSpace(root.Name)
		root.Path = strings.TrimSpace(root.Path)
		root.Kind = strings.TrimSpace(root.Kind)
		root.Detail = strings.TrimSpace(root.Detail)
		if root.Name == "" || root.Path == "" || len(root.Path) > 4096 || len(root.Name) > 256 || len(root.Detail) > 2048 {
			continue
		}
		if root.Kind == "" { root.Kind = "drive" }
		_, err := tx.Exec(`
INSERT INTO desktop_roots(device_id,name,path,kind,detail,total_bytes,free_bytes,online,enabled,last_seen)
VALUES(?,?,?,?,?,?,?,1,1,?)
ON CONFLICT(device_id,path) DO UPDATE SET
	name=excluded.name,kind=excluded.kind,detail=excluded.detail,total_bytes=excluded.total_bytes,
	free_bytes=excluded.free_bytes,online=1,last_seen=excluded.last_seen`,
			deviceID, root.Name, root.Path, root.Kind, root.Detail, root.TotalBytes, root.FreeBytes, now)
		if err != nil { return err }

		var rootID int64
		if err := tx.QueryRow("SELECT id FROM desktop_roots WHERE device_id=? AND path=?", deviceID, root.Path).Scan(&rootID); err != nil { return err }
		if _, err := tx.Exec(`
INSERT INTO desktop_acl(root_id,user_id,can_read,can_write,can_rename,can_delete)
VALUES(?,?,1,1,1,1)
ON CONFLICT(root_id,user_id) DO NOTHING`, rootID, ownerUserID); err != nil { return err }
	}
	if _, err := tx.Exec("UPDATE desktop_devices SET last_seen=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", now, deviceID); err != nil { return err }
	return tx.Commit()
}

func (s *Store) ListDesktopRoots(deviceID int64) ([]DesktopRoot, error) {
	rows, err := s.db.Query(`
SELECT id,device_id,name,path,kind,detail,total_bytes,free_bytes,online,enabled,last_seen
FROM desktop_roots WHERE device_id=? ORDER BY path COLLATE NOCASE`, deviceID)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []DesktopRoot
	for rows.Next() {
		var r DesktopRoot
		var online, enabled int
		var last sql.NullTime
		if err := rows.Scan(&r.ID,&r.DeviceID,&r.Name,&r.Path,&r.Kind,&r.Detail,&r.TotalBytes,&r.FreeBytes,&online,&enabled,&last); err != nil {
			return nil, err
		}
		r.Online = online == 1
		r.Enabled = enabled == 1
		if last.Valid { t := last.Time; r.LastSeen = &t }
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) UpdateDesktopRoot(deviceID, rootID int64, enabled bool) error {
	res, err := s.db.Exec("UPDATE desktop_roots SET enabled=? WHERE id=? AND device_id=?", boolInt(enabled), rootID, deviceID)
	if err != nil { return err }
	n,_ := res.RowsAffected()
	if n != 1 { return sql.ErrNoRows }
	return nil
}

func (s *Store) SetDesktopACL(deviceID, rootID, userID int64, acl DesktopACL) error {
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM desktop_roots WHERE id=? AND device_id=?", rootID, deviceID).Scan(&count); err != nil {
		return err
	}
	if count != 1 { return sql.ErrNoRows }
	_, err := s.db.Exec(`
INSERT INTO desktop_acl(root_id,user_id,can_read,can_write,can_rename,can_delete)
VALUES(?,?,?,?,?,?)
ON CONFLICT(root_id,user_id) DO UPDATE SET
	can_read=excluded.can_read,can_write=excluded.can_write,can_rename=excluded.can_rename,can_delete=excluded.can_delete`,
		rootID,userID,boolInt(acl.CanRead),boolInt(acl.CanWrite),boolInt(acl.CanRename),boolInt(acl.CanDelete))
	return err
}

func (s *Store) ListDesktopACLs(rootID int64) ([]DesktopACL, error) {
	rows, err := s.db.Query("SELECT root_id,user_id,can_read,can_write,can_rename,can_delete FROM desktop_acl WHERE root_id=? ORDER BY user_id", rootID)
	if err != nil { return nil, err }
	defer rows.Close()
	var out []DesktopACL
	for rows.Next() {
		var a DesktopACL
		var r,w,n,d int
		if err := rows.Scan(&a.RootID,&a.UserID,&r,&w,&n,&d); err != nil { return nil, err }
		a.CanRead=r==1; a.CanWrite=w==1; a.CanRename=n==1; a.CanDelete=d==1
		out = append(out,a)
	}
	return out,rows.Err()
}

func (s *Store) EffectiveDesktopRoots(deviceID, userID int64) ([]DesktopRootAccess, error) {
	d, err := s.GetDesktop(deviceID)
	if err != nil { return nil, err }
	if !d.Enabled { return []DesktopRootAccess{}, nil }

	roots, err := s.ListDesktopRoots(deviceID)
	if err != nil { return nil, err }
	out := make([]DesktopRootAccess,0,len(roots))
	for _, root := range roots {
		if !root.Enabled || !root.Online { continue }
		access := DesktopRootAccess{DesktopRoot:root}
		access.RootID = root.ID
		access.UserID = userID
		var rr,ww,nn,dd int
		err := s.db.QueryRow("SELECT can_read,can_write,can_rename,can_delete FROM desktop_acl WHERE root_id=? AND user_id=?", root.ID,userID).
			Scan(&rr,&ww,&nn,&dd)
		if errors.Is(err,sql.ErrNoRows) { continue }
		if err != nil { return nil,err }
		access.CanRead=rr==1; access.CanWrite=ww==1; access.CanRename=nn==1; access.CanDelete=dd==1
		if access.CanRead || access.CanWrite || access.CanRename || access.CanDelete {
			out = append(out, access)
		}
	}
	return out,nil
}
