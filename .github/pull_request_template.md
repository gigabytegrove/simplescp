## Summary

Describe what changed and why.

## Testing

- [ ] `go test ./...`
- [ ] `go vet ./...`
- [ ] `govulncheck ./...`
- [ ] Docker image builds successfully
- [ ] Relevant UI behavior tested manually, if applicable

## Security review

- [ ] No credentials, keys, tokens, internal hostnames, or sensitive logs are included
- [ ] SSH host-key verification is not weakened
- [ ] Authentication / CSRF / session protections are not weakened
- [ ] Path validation and destructive-operation safeguards are preserved
- [ ] Documentation/configuration updated if security or deployment behavior changed

## Notes

Anything reviewers should pay particular attention to.
