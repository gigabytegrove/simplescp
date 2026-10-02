package sshclient

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gigabytegrove/simplescp/internal/store"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var ErrHostKeyNotTrusted = errors.New("remote host key is not trusted")

type HostKeyError struct {
	Fingerprint string
}

func (e *HostKeyError) Error() string {
	return "remote host key is not trusted: " + e.Fingerprint
}

type Client struct {
	SSH  *ssh.Client
	SFTP *sftp.Client
}

type Entry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	IsDir   bool      `json:"is_dir"`
	ModTime time.Time `json:"mod_time"`
}

func ProbeFingerprint(c store.Connection, timeout time.Duration) (string, error) {
	addr := net.JoinHostPort(c.Host, fmt.Sprintf("%d", c.Port))
	var fingerprint string
	cfg := &ssh.ClientConfig{
		User: c.Username,
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			fingerprint = ssh.FingerprintSHA256(key)
			return ErrHostKeyNotTrusted
		},
		Timeout: timeout,
	}
	conn, err := ssh.Dial("tcp", addr, cfg)
	if conn != nil { _ = conn.Close() }
	if fingerprint != "" {
		return fingerprint, nil
	}
	if err != nil {
		return "", fmt.Errorf("probe host key: %w", err)
	}
	return "", errors.New("server did not present a host key")
}

func Dial(c store.Connection, timeout time.Duration) (*Client, error) {
	if c.HostKeyFingerprint == "" {
		fp, err := ProbeFingerprint(c, timeout)
		if err != nil { return nil, err }
		return nil, &HostKeyError{Fingerprint: fp}
	}

	auth, err := authMethod(c)
	if err != nil { return nil, err }

	cfg := &ssh.ClientConfig{
		User: c.Username,
		Auth: []ssh.AuthMethod{auth},
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			got := ssh.FingerprintSHA256(key)
			if got != c.HostKeyFingerprint {
				return fmt.Errorf("host key mismatch: expected %s, got %s", c.HostKeyFingerprint, got)
			}
			return nil
		},
		Timeout: timeout,
	}
	addr := net.JoinHostPort(c.Host, fmt.Sprintf("%d", c.Port))
	sshConn, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh connection failed: %w", err)
	}
	sf, err := sftp.NewClient(sshConn, sftp.UseConcurrentReads(true), sftp.UseConcurrentWrites(true))
	if err != nil {
		sshConn.Close()
		return nil, fmt.Errorf("start sftp subsystem: %w", err)
	}
	return &Client{SSH:sshConn,SFTP:sf}, nil
}

func authMethod(c store.Connection) (ssh.AuthMethod, error) {
	switch c.AuthType {
	case "password":
		if c.Password == "" { return nil, errors.New("saved password is empty") }
		return ssh.Password(c.Password), nil
	case "key":
		if strings.TrimSpace(c.PrivateKey) == "" { return nil, errors.New("saved private key is empty") }
		var signer ssh.Signer
		var err error
		if c.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(c.PrivateKey), []byte(c.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(c.PrivateKey))
		}
		if err != nil { return nil, fmt.Errorf("parse private key: %w", err) }
		return ssh.PublicKeys(signer), nil
	default:
		return nil, errors.New("unsupported authentication type")
	}
}

func (c *Client) Close() error {
	var errs []error
	if c.SFTP != nil { errs = append(errs, c.SFTP.Close()) }
	if c.SSH != nil { errs = append(errs, c.SSH.Close()) }
	return errors.Join(errs...)
}

func CleanRemote(p string) string {
	if strings.TrimSpace(p) == "" { return "/" }
	clean := path.Clean("/" + strings.TrimPrefix(p, "/"))
	return clean
}

func (c *Client) List(remotePath string) ([]Entry, error) {
	remotePath = CleanRemote(remotePath)
	infos, err := c.SFTP.ReadDir(remotePath)
	if err != nil { return nil, err }
	out := make([]Entry, 0, len(infos))
	for _, info := range infos {
		out = append(out, Entry{
			Name:info.Name(),
			Path:path.Join(remotePath, info.Name()),
			Size:info.Size(),
			Mode:info.Mode().String(),
			IsDir:info.IsDir(),
			ModTime:info.ModTime(),
		})
	}
	return out, nil
}

func (c *Client) Mkdir(remotePath string) error {
	return c.SFTP.MkdirAll(CleanRemote(remotePath))
}

func (c *Client) Rename(oldPath, newPath string) error {
	return c.SFTP.Rename(CleanRemote(oldPath), CleanRemote(newPath))
}

func (c *Client) Remove(remotePath string, recursive bool) error {
	remotePath = CleanRemote(remotePath)
	info, err := c.SFTP.Stat(remotePath)
	if err != nil { return err }
	if !info.IsDir() { return c.SFTP.Remove(remotePath) }
	if !recursive { return c.SFTP.RemoveDirectory(remotePath) }
	walker := c.SFTP.Walk(remotePath)
	var paths []string
	for walker.Step() {
		if walker.Err() != nil { return walker.Err() }
		paths = append(paths, walker.Path())
	}
	for i := len(paths)-1; i >= 0; i-- {
		p := paths[i]
		info, err := c.SFTP.Stat(p)
		if err != nil && os.IsNotExist(err) { continue }
		if err != nil { return err }
		if info.IsDir() {
			if err := c.SFTP.RemoveDirectory(p); err != nil { return err }
		} else if err := c.SFTP.Remove(p); err != nil { return err }
	}
	return nil
}

func (c *Client) Open(remotePath string) (io.ReadCloser, os.FileInfo, error) {
	remotePath = CleanRemote(remotePath)
	info, err := c.SFTP.Stat(remotePath)
	if err != nil { return nil,nil,err }
	if info.IsDir() { return nil,nil,errors.New("cannot open a directory as a file") }
	f, err := c.SFTP.Open(remotePath)
	return f, info, err
}

func (c *Client) Create(remotePath string) (io.WriteCloser, error) {
	remotePath = CleanRemote(remotePath)
	if err := c.SFTP.MkdirAll(path.Dir(remotePath)); err != nil { return nil,err }
	return c.SFTP.Create(remotePath)
}

func CopyFile(src *Client, srcPath string, dst *Client, dstPath string) (int64, error) {
	in, info, err := src.Open(srcPath)
	if err != nil { return 0, err }
	defer in.Close()
	out, err := dst.Create(dstPath)
	if err != nil { return 0, err }
	n, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil { return n, copyErr }
	if closeErr != nil { return n, closeErr }
	if info.Mode().Perm() != 0 {
		_ = dst.SFTP.Chmod(CleanRemote(dstPath), info.Mode().Perm())
	}
	return n, nil
}
