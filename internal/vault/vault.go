package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

type Vault struct {
	aead cipher.AEAD
}

func New(key []byte) (*Vault, error) {
	if len(key) != 32 {
		return nil, errors.New("vault key must be exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}
	return &Vault{aead: aead}, nil
}

func (v *Vault) Encrypt(plaintext []byte) (string, error) {
	if len(plaintext) == 0 {
		return "", nil
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	sealed := v.aead.Seal(nil, nonce, plaintext, nil)
	payload := append(nonce, sealed...)
	return base64.RawStdEncoding.EncodeToString(payload), nil
}

func (v *Vault) Decrypt(ciphertext string) ([]byte, error) {
	if ciphertext == "" {
		return nil, nil
	}
	payload, err := base64.RawStdEncoding.DecodeString(ciphertext)
	if err != nil {
		return nil, errors.New("invalid encrypted value")
	}
	if len(payload) < v.aead.NonceSize() {
		return nil, errors.New("encrypted value is truncated")
	}
	nonce, data := payload[:v.aead.NonceSize()], payload[v.aead.NonceSize():]
	plaintext, err := v.aead.Open(nil, nonce, data, nil)
	if err != nil {
		return nil, errors.New("encrypted value could not be decrypted")
	}
	return plaintext, nil
}
