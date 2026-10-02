package vault

import (
	"bytes"
	"testing"
)

func TestEncryptDecrypt(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	v, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("secret material")
	enc, err := v.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	if enc == string(plain) {
		t.Fatal("ciphertext matched plaintext")
	}
	got, err := v.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("got %q want %q", got, plain)
	}
}

func TestWrongKeyFails(t *testing.T) {
	a, _ := New(bytes.Repeat([]byte{1}, 32))
	b, _ := New(bytes.Repeat([]byte{2}, 32))
	enc, err := a.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Decrypt(enc); err == nil {
		t.Fatal("expected decryption failure")
	}
}
