# SimpleSCP

SimpleSCP is a self-hosted web-based multi-server SSH/SFTP file-transfer system. It gives you a familiar two-pane workflow for saving servers, reconnecting quickly, browsing remote filesystems, uploading and downloading files, and copying files directly between remote servers.

SimpleSCP uses SFTP over SSH for remote file operations. Remote systems do not need the legacy `scp` executable.

## Features

- Saved SSH/SFTP server profiles
- Password and SSH private-key authentication
- Encrypted saved connection secrets
- SSH host-key fingerprint verification and pinning
- Two-pane remote file browser
- Browser-to-server uploads
- Server-to-browser downloads
- Direct server-to-server file transfers
- Create, rename, and recursively delete remote folders
- Persistent SQLite data
- Per-user connection ownership
- Hardened session and CSRF handling
- Login throttling and transfer resource limits
- Non-root, read-only Docker runtime
- Multi-architecture container images for amd64 and arm64
- Automated dependency vulnerability scanning

## Recommended installation: Docker Compose

Docker Compose is the primary deployment method. You do **not** need to clone the repository or build SimpleSCP locally.

Create a directory for the deployment:

```bash
mkdir -p simplescp
cd simplescp
```

Download the public Compose file and environment template:

```bash
curl -fsSLO https://raw.githubusercontent.com/gigabytegrove/simplescp/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/gigabytegrove/simplescp/main/.env.example -o .env
```

Generate a master encryption key:

```bash
openssl rand -base64 32
```

Edit `.env` and set at minimum:

```dotenv
SIMPLE_SCP_MASTER_KEY=PASTE_THE_GENERATED_KEY_HERE
SIMPLE_SCP_ADMIN_USER=admin
SIMPLE_SCP_ADMIN_PASSWORD=SET_A_STRONG_PASSWORD
```

Start SimpleSCP:

```bash
docker compose pull
docker compose up -d
```

Open:

```text
http://YOUR-SERVER:8080
```

Check status:

```bash
docker compose ps
docker compose logs -f simplescp
```

Update later with:

```bash
docker compose pull
docker compose up -d
```

The public container image is:

```text
ghcr.io/gigabytegrove/simplescp:latest
```

Set `SIMPLE_SCP_VERSION` in `.env` if you want to pin a specific release instead of tracking `latest`.

## Production HTTPS

For anything exposed beyond a trusted local network, put SimpleSCP behind an HTTPS reverse proxy and set:

```dotenv
SIMPLE_SCP_COOKIE_SECURE=true
```

When secure cookies are enabled, SimpleSCP also sends HSTS.

The web interface should ideally be restricted by firewall, VPN, private network, or another trusted access layer in addition to application authentication.

## Secrets

The master key protects saved SSH passwords, private keys, and private-key passphrases. Losing the master key makes those encrypted credentials unrecoverable.

For production, mounted secret files are preferred:

```dotenv
SIMPLE_SCP_MASTER_KEY_FILE=/run/secrets/simplescp_master_key
SIMPLE_SCP_ADMIN_PASSWORD_FILE=/run/secrets/simplescp_admin_password
```

If `SIMPLE_SCP_ADMIN_PASSWORD` is present, SimpleSCP keeps the configured administrator account synchronized with that password on startup. This makes container redeploys deterministic even when the persistent database volume already exists. Remove the variable after bootstrap if you do not want startup-time password synchronization.

Back up the exact master key separately from the database.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIMPLE_SCP_VERSION` | `latest` | Container image tag used by Compose |
| `SIMPLE_SCP_PORT` | `8080` | Host port published by Compose |
| `SIMPLE_SCP_LISTEN` | `:8080` | Internal HTTP listen address |
| `SIMPLE_SCP_DATA_DIR` | `/data` | Persistent application data |
| `SIMPLE_SCP_MASTER_KEY` | required | Base64-encoded 32-byte credential encryption key |
| `SIMPLE_SCP_MASTER_KEY_FILE` | empty | Mounted-file alternative for the master key |
| `SIMPLE_SCP_ADMIN_USER` | `admin` | Initial administrator username |
| `SIMPLE_SCP_ADMIN_PASSWORD` | first boot required | Initial administrator password; when present, synchronizes the configured admin credential at startup |
| `SIMPLE_SCP_ADMIN_PASSWORD_FILE` | empty | Mounted-file alternative for the initial password |
| `SIMPLE_SCP_COOKIE_SECURE` | `false` | Require HTTPS-only session cookies |
| `SIMPLE_SCP_SESSION_TTL` | `24h` | Session lifetime |
| `SIMPLE_SCP_SSH_TIMEOUT` | `15s` | SSH connection timeout |
| `SIMPLE_SCP_MAX_UPLOAD_BYTES` | `10737418240` | Maximum HTTP upload body size |
| `SIMPLE_SCP_MAX_CONCURRENT_TRANSFERS` | `4` | Concurrent transfer limit |
| `SIMPLE_SCP_LOGIN_MAX_ATTEMPTS` | `5` | Login attempts allowed per username/IP window |
| `SIMPLE_SCP_LOGIN_WINDOW` | `15m` | Login throttling window |

## SSH host verification

SimpleSCP never silently accepts an unknown SSH host key.

On the first connection, SimpleSCP displays the server's SHA-256 SSH host-key fingerprint. Verify it against the server or another trusted source before approving it.

The exact approved fingerprint is pinned. If the server later presents a different key, SimpleSCP rejects the connection rather than automatically replacing the trusted fingerprint.

Editing a saved host or port clears the previous fingerprint and requires verification again.

## Transfer integrity

Uploads and server-to-server copies are written to temporary files on the destination first. The final path is committed only after the transfer succeeds, which avoids leaving a normal-looking truncated destination file after a failed transfer.

SimpleSCP refuses destructive requests that attempt to delete or rename remote `/`.

## Backup

Back up both:

- the persistent `simplescp_data` volume
- the exact SimpleSCP master key

A database backup without its matching master key cannot decrypt saved SSH credentials.

## Security

See [SECURITY.md](SECURITY.md) for the security model, supported deployment assumptions, and vulnerability-reporting process.

CI runs tests, `go vet`, `govulncheck`, a native build, and a Docker build. Known reachable Go vulnerabilities fail the pipeline.

Please do not post exploitable vulnerabilities, credentials, private keys, database files, or master keys in a public issue.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing expectations, security requirements, and pull-request guidance.

For normal deployment, use Docker Compose rather than building from source.

## Development from source

Source builds are for development and contribution, not the normal deployment path.

Requires Go 1.27.1 or newer.

```bash
go mod tidy
go test ./...
go run ./cmd/simplescp
```

To build a local development image:

```bash
docker build -t simplescp:dev .
```


## Automatic updates

SimpleSCP can update itself from GitHub without rebuilding the Docker container.

By default, `SIMPLE_SCP_AUTO_UPDATE=true`. Source/main builds follow the automatically published `edge` release generated from the latest successful `main` workflow. Tagged production builds follow the latest stable GitHub release.

The running container checks for updates every 15 minutes by default, verifies the published SHA-256 checksum, stages the new executable under `/data/update/`, and gracefully restarts. The immutable container launcher automatically starts the updated executable from the persistent `/data` volume.

Configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `SIMPLE_SCP_AUTO_UPDATE` | `true` | Automatically check, verify, install, and restart onto GitHub-published updates |
| `SIMPLE_SCP_AUTO_UPDATE_INTERVAL` | `15m` | Update polling interval (minimum 5 minutes) |

This updater does not require the Docker socket, Watchtower, a sidecar, or a second Docker container.
