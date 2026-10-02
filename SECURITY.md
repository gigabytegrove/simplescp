# Security

SimpleSCP handles SSH credentials and remote file access, so it should be deployed as a security-sensitive administration service.

## Production deployment requirements

- Put SimpleSCP behind HTTPS.
- Set SIMPLE_SCP_COOKIE_SECURE=true when users access it through HTTPS.
- Use a unique 32-byte master key generated from a cryptographically secure source.
- Prefer SIMPLE_SCP_MASTER_KEY_FILE over a plain environment variable when your runtime supports mounted secrets.
- After the first account is created, remove SIMPLE_SCP_ADMIN_PASSWORD or its secret file from the deployment.
- Restrict network access to the web interface with a firewall, VPN, private network, or trusted reverse proxy where practical.
- Back up the master key separately from the SQLite database.
- Never mount the Docker socket into the SimpleSCP container.
- Keep Dependabot and CI security checks enabled.

## Credential storage

Saved SSH passwords, private keys, and key passphrases are encrypted with AES-256-GCM before being stored in SQLite. The master encryption key is not stored in the database.

The database and the matching master key together grant access to stored connection credentials. Protect both accordingly.

## SSH host verification

SimpleSCP does not use an insecure accept-any-host-key callback.

The first connection displays the server's SHA-256 SSH host-key fingerprint. The trust operation verifies that the fingerprint still matches the exact value the user approved before it is persisted. A later host-key change causes the connection to fail.

## Web security controls

SimpleSCP uses:

- bcrypt password hashing
- random session tokens with only SHA-256 token hashes stored server-side
- HttpOnly, SameSite=Strict session cookies
- optional Secure cookies for HTTPS
- CSRF tokens for authenticated state-changing requests
- a separate CSRF token for the login form
- same-origin checks on unsafe browser requests
- login attempt throttling
- restrictive Content Security Policy
- no-store caching for authenticated and login responses
- request-size limits
- bounded concurrent file transfers

## Container security

The default Compose deployment:

- runs as a non-root user
- drops all Linux capabilities
- enables no-new-privileges
- uses a read-only root filesystem
- provides only a small noexec/nosuid temporary filesystem
- persists only the /data volume

## Remote-file safety

SimpleSCP refuses API attempts to recursively delete or rename the remote filesystem root. Uploads and server-to-server copies use temporary remote files and commit the destination only after the transfer completes, reducing the risk of leaving truncated destination files.

## Network trust boundary

An authenticated SimpleSCP user can intentionally open SSH connections to hosts reachable from the SimpleSCP container. That capability is fundamental to the product.

For that reason, do not grant SimpleSCP access to network segments that its authorized users should not be able to reach. In a future multi-user deployment, network segmentation remains an important security boundary even when application-level permissions are present.

## Vulnerability reporting

Do not publish credentials, private keys, database files, master keys, or exploitable security details in a public issue.

For security vulnerabilities, use GitHub's private vulnerability-reporting / Security Advisory workflow for this repository when available. Include:

- the affected SimpleSCP version or commit
- deployment details relevant to the issue
- clear reproduction steps
- expected and actual behavior
- impact and attack prerequisites
- any logs needed to understand the issue, with secrets removed

Use normal public issues for non-sensitive bugs, feature requests, documentation problems, and usability feedback.

## Security support expectations

The actively maintained branch is `main`, and published container images are built from commits that pass CI security gates.

Security fixes may require upgrading Go, SSH/SFTP libraries, SQLite, the container base image, or GitHub Actions dependencies. Dependabot is enabled to surface those updates.

Users running production deployments should prefer a pinned release tag once releases are published, keep the deployment current, and review release notes before upgrades.
