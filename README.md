# SimpleSCP

SimpleSCP is a self-hosted, Docker-first web file-transfer workspace for managing multiple SSH/SFTP servers from one browser. It follows a familiar two-pane workflow so saved servers can be opened side-by-side and files can be moved without bouncing through a desktop client.

SimpleSCP uses SFTP over SSH for file operations. The name describes the simple secure-copy workflow; remote hosts do not need the legacy scp executable.

## Current capabilities

- Saved SSH server profiles
- Retry and reconnect without re-entering credentials
- Password or SSH private-key authentication
- AES-256-GCM encryption for saved connection secrets
- Explicit SSH host-key fingerprint verification and pinning
- Per-user saved connection ownership
- Persistent SQLite storage
- Two-pane remote file browser
- Remote directory navigation
- Browser-to-server upload
- Server-to-browser download
- Create, rename, and recursively delete remote folders
- Direct server-to-server file copy streamed through SimpleSCP
- Session authentication with HttpOnly and SameSite cookies
- CSRF protection on state-changing requests
- Docker health check and non-root runtime
- Responsive dark web interface

## Quick start

1. Copy .env.example to .env.
2. Generate a 32-byte master key with: openssl rand -base64 32
3. Put that value in SIMPLE_SCP_MASTER_KEY.
4. Set SIMPLE_SCP_ADMIN_PASSWORD to a strong password of at least 12 characters.
5. Run: docker compose up -d --build
6. Open http://your-server:8080

For production behind HTTPS, set SIMPLE_SCP_COOKIE_SECURE=true.

The master key protects stored SSH passwords, private keys, and key passphrases. Back it up. Losing or changing it makes existing saved credentials unreadable.

## Configuration

SIMPLE_SCP_LISTEN defaults to :8080.

SIMPLE_SCP_DATA_DIR defaults to /data.

SIMPLE_SCP_MASTER_KEY is required and must be a base64-encoded 32-byte value.

SIMPLE_SCP_ADMIN_USER defaults to admin.

SIMPLE_SCP_ADMIN_PASSWORD is required on first startup and must be at least 12 characters.

SIMPLE_SCP_COOKIE_SECURE defaults to false and should be true when served through HTTPS.

SIMPLE_SCP_SESSION_TTL defaults to 24h.

SIMPLE_SCP_SSH_TIMEOUT defaults to 15s.

The bootstrap admin variables create the first account only when the user table is empty. They do not overwrite an existing account on restart.

## SSH host verification

SimpleSCP never silently accepts an unknown SSH host key.

On first connection, it probes the server and displays the SHA-256 host-key fingerprint. Verify that fingerprint against the server or another trusted source, then explicitly trust it. The fingerprint is pinned to that saved connection.

If the server later presents a different key, the connection is rejected instead of silently replacing the trusted fingerprint. Editing a saved host or port clears the previous fingerprint and requires verification again.

## Security model

Saved SSH secrets are encrypted before SQLite persistence. The encryption key is supplied at runtime and is not stored in the database.

Password hashes use bcrypt. Session tokens are random and only their SHA-256 hashes are stored. Session cookies are HttpOnly and SameSite Strict. State-changing API calls require a session-specific CSRF token.

The container runs as an unprivileged user and does not require Docker socket access, privileged mode, or host filesystem mounts.

For internet-facing deployments, use a TLS reverse proxy and enable secure cookies.

## Server-to-server transfers

Connect the left and right panes to different saved servers. Select a file in one pane and use Copy to send it to the current folder in the other pane.

The transfer path is:

source SSH/SFTP server -> SimpleSCP -> destination SSH/SFTP server

The file is streamed and does not need to be written to local disk first.

## Backup

Back up both the persistent /data volume and the exact SIMPLE_SCP_MASTER_KEY. A database backup without the matching master key cannot recover saved SSH credentials.

## Development

Requires Go 1.27.1 or newer.

Run:

go mod tidy

go test ./...

go run ./cmd/simplescp
