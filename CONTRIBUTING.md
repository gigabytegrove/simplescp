# Contributing to SimpleSCP

Thanks for helping improve SimpleSCP.

SimpleSCP is security-sensitive software: it stores encrypted SSH credentials, opens SSH connections to remote systems, and performs destructive file operations. Contributions should preserve that threat model rather than treating security as a later cleanup step.

## Before opening a pull request

- Search existing issues and pull requests first.
- Keep changes focused and explain the user-visible reason for the change.
- Do not include real credentials, SSH keys, hostnames, production addresses, database files, or master keys in commits, screenshots, fixtures, or logs.
- Do not weaken SSH host-key verification, CSRF protections, authentication controls, path validation, or container hardening to make a feature easier to implement.
- Preserve Docker Compose as the primary deployment path.
- Avoid adding shell execution or arbitrary command execution unless the project explicitly decides to support that capability.

## Development

Requires Go 1.27.1 or newer.

```bash
go mod tidy
go test ./...
go vet ./...
go run ./cmd/simplescp
```

To validate known reachable Go vulnerabilities:

```bash
go install golang.org/x/vuln/cmd/govulncheck@v1.8.0
govulncheck ./...
```

To build the development container:

```bash
docker build -t simplescp:dev .
```

## Pull request expectations

A pull request should:

- describe the problem and the change
- identify security implications when applicable
- include tests for behavior that can be reasonably tested
- keep `go.mod` and `go.sum` clean and reproducible
- avoid unrelated formatting or dependency churn
- update documentation when behavior, configuration, deployment, or security assumptions change

CI must pass before a change is considered ready.

## UI contributions

SimpleSCP intentionally uses a focused two-pane transfer-client interface.

UI changes should preserve:

- clear left/right server context
- obvious SSH trust state
- compact file-management controls
- keyboard and mouse usability
- responsive layouts
- a flat visual style without excessive decorative gradients
- accessible labels and usable focus states

## Security issues

Do not open a public issue for an exploitable vulnerability.

Use the repository's private GitHub Security Advisory / vulnerability-reporting workflow when available. See [SECURITY.md](SECURITY.md).
