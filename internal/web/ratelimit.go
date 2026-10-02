package web

import (
	"sync"
	"time"
)

type loginLimiter struct {
	mu          sync.Mutex
	maxAttempts int
	window      time.Duration
	attempts    map[string][]time.Time
}

func newLoginLimiter(maxAttempts int, window time.Duration) *loginLimiter {
	return &loginLimiter{
		maxAttempts: maxAttempts,
		window:      window,
		attempts:    make(map[string][]time.Time),
	}
}

func (l *loginLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := now.Add(-l.window)
	existing := l.attempts[key]
	filtered := existing[:0]
	for _, ts := range existing {
		if ts.After(cutoff) {
			filtered = append(filtered, ts)
		}
	}
	if len(filtered) >= l.maxAttempts {
		l.attempts[key] = filtered
		return false
	}
	filtered = append(filtered, now)
	l.attempts[key] = filtered

	if len(l.attempts) > 4096 {
		for k, values := range l.attempts {
			keep := values[:0]
			for _, ts := range values {
				if ts.After(cutoff) {
					keep = append(keep, ts)
				}
			}
			if len(keep) == 0 {
				delete(l.attempts, k)
			} else {
				l.attempts[k] = keep
			}
		}
	}

	return true
}

func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.attempts, key)
	l.mu.Unlock()
}
