package sshclient

import "testing"

func TestCleanRemote(t *testing.T) {
	tests := map[string]string{
		"":              "/",
		"/":             "/",
		"/var/www":      "/var/www",
		"var/www":       "/var/www",
		"/var/../tmp//x": "/tmp/x",
		"../../etc":     "/etc",
	}
	for input, want := range tests {
		if got := CleanRemote(input); got != want {
			t.Fatalf("CleanRemote(%q)=%q want %q", input, got, want)
		}
	}
}
