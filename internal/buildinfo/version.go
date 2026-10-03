package buildinfo

// Version and Commit are replaced at build time with -ldflags.
// Development/source builds intentionally retain these readable defaults.
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)
