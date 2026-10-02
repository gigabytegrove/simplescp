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
`)
	if err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	return nil
}

func (s *Store) BootstrapAdmin(username, password string) error {
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return errors.New("admin username is empty")
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
