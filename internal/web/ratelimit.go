package web

import (
	"context"
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

func (l *loginLimiter) set(maxAttempts int, window time.Duration) {
	l.mu.Lock()
	l.maxAttempts = maxAttempts
	l.window = window
	l.attempts = make(map[string][]time.Time)
	l.mu.Unlock()
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

type transferLimiter struct {
	mu      sync.Mutex
	limit   int
	active  int
	changed chan struct{}
}

func newTransferLimiter(limit int) *transferLimiter {
	return &transferLimiter{limit: limit, changed: make(chan struct{})}
}

func (l *transferLimiter) setLimit(limit int) {
	l.mu.Lock()
	l.limit = limit
	close(l.changed)
	l.changed = make(chan struct{})
	l.mu.Unlock()
}

func (l *transferLimiter) acquire(ctx context.Context) bool {
	for {
		l.mu.Lock()
		if l.active < l.limit {
			l.active++
			l.mu.Unlock()
			return true
		}
		wait := l.changed
		l.mu.Unlock()

		select {
		case <-ctx.Done():
			return false
		case <-wait:
		}
	}
}

func (l *transferLimiter) release() {
	l.mu.Lock()
	if l.active > 0 {
		l.active--
	}
	close(l.changed)
	l.changed = make(chan struct{})
	l.mu.Unlock()
}
