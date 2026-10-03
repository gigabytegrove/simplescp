package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gigabytegrove/simplescp/internal/store"
)

type desktopIdentity struct {
	UID      string
	Secret   string
	Name     string
	Platform string
	Arch     string
}

type desktopSyncInput struct {
	Roots []store.DesktopInventory `json:"roots"`
}

type desktopUpdateInput struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type desktopRootUpdateInput struct {
	Enabled bool `json:"enabled"`
}

type desktopACLInput struct {
	CanRead   bool `json:"can_read"`
	CanWrite  bool `json:"can_write"`
	CanRename bool `json:"can_rename"`
	CanDelete bool `json:"can_delete"`
}

type desktopTicket struct {
	DeviceID int64                     `json:"device_id"`
	UserID   int64                     `json:"user_id"`
	Expires  int64                     `json:"expires"`
	Roots    []store.DesktopRootAccess `json:"roots"`
}

type desktopAdminDevice struct {
	store.DesktopDevice
	Roots []desktopAdminRoot `json:"roots"`
}

type desktopAdminRoot struct {
	store.DesktopRoot
	ACLs []store.DesktopACL `json:"acls"`
}

func desktopIdentityFromRequest(r *http.Request) (desktopIdentity, error) {
	id := desktopIdentity{
		UID:      strings.TrimSpace(r.Header.Get("X-SimpleSCP-Desktop-ID")),
		Secret:   strings.TrimSpace(r.Header.Get("X-SimpleSCP-Desktop-Secret")),
		Name:     strings.TrimSpace(r.Header.Get("X-SimpleSCP-Desktop-Name")),
		Platform: strings.TrimSpace(r.Header.Get("X-SimpleSCP-Desktop-OS")),
		Arch:     strings.TrimSpace(r.Header.Get("X-SimpleSCP-Desktop-Arch")),
	}
	if id.UID == "" || id.Secret == "" {
		return desktopIdentity{}, errors.New("open this server through SimpleSCP Desktop")
	}
	if id.Name == "" { id.Name = "SimpleSCP Desktop" }
	return id, nil
}

func signDesktopTicket(secret string, payload desktopTicket) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil { return "", err }
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return body + "." + sig, nil
}

func (a *app) enrollDesktop(w http.ResponseWriter, r *http.Request) {
	identity, err := desktopIdentityFromRequest(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	var input desktopSyncInput
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid desktop inventory")
			return
		}
	}

	sess, _ := sessionFrom(r)
	device, err := a.store.EnrollDesktop(sess.UserID, identity.UID, identity.Secret, identity.Name, identity.Platform, identity.Arch)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }
	if len(input.Roots) > 0 {
		if err := a.store.SyncDesktopRoots(device.ID, input.Roots); err != nil {
			writeError(w, http.StatusInternalServerError, "unable to save desktop locations")
			return
		}
	}
	roots, _ := a.store.EffectiveDesktopRoots(device.ID, sess.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"device":device,"roots":roots})
}

func (a *app) desktopAccess(w http.ResponseWriter, r *http.Request) {
	identity, err := desktopIdentityFromRequest(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	device, secret, err := a.store.GetDesktopByIdentity(identity.UID, identity.Secret)
	if err != nil {
		writeError(w, http.StatusForbidden, "desktop is not enrolled")
		return
	}
	if !device.Enabled {
		writeError(w, http.StatusForbidden, "desktop is disabled")
		return
	}

	sess, _ := sessionFrom(r)
	roots, err := a.store.EffectiveDesktopRoots(device.ID, sess.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to resolve desktop access")
		return
	}
	payload := desktopTicket{
		DeviceID: device.ID,
		UserID: sess.UserID,
		Expires: time.Now().UTC().Add(5*time.Minute).Unix(),
		Roots: roots,
	}
	ticket, err := signDesktopTicket(secret, payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to create desktop access token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device": device,
		"roots": roots,
		"ticket": ticket,
		"expires": payload.Expires,
	})
}

func (a *app) desktopHeartbeat(w http.ResponseWriter, r *http.Request) {
	identity, err := desktopIdentityFromRequest(r)
	if err != nil { writeError(w, http.StatusBadRequest, err.Error()); return }

	device, _, err := a.store.GetDesktopByIdentity(identity.UID, identity.Secret)
	if err != nil {
		writeError(w, http.StatusForbidden, "desktop is not enrolled")
		return
	}
	var input desktopSyncInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid desktop heartbeat")
		return
	}
	if err := a.store.SyncDesktopRoots(device.ID, input.Roots); err != nil {
		writeError(w, http.StatusInternalServerError, "unable to update desktop inventory")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled":device.Enabled})
}

func (a *app) adminDesktops(w http.ResponseWriter, r *http.Request) {
	devices, err := a.store.ListDesktops()
	if err != nil { writeError(w, http.StatusInternalServerError, "unable to load desktops"); return }
	users, err := a.store.ListUsers()
	if err != nil { writeError(w, http.StatusInternalServerError, "unable to load users"); return }

	out := make([]desktopAdminDevice,0,len(devices))
	for _, device := range devices {
		item := desktopAdminDevice{DesktopDevice:device}
		roots, rootErr := a.store.ListDesktopRoots(device.ID)
		if rootErr != nil { writeError(w, http.StatusInternalServerError, "unable to load desktop locations"); return }
		item.Roots = make([]desktopAdminRoot,0,len(roots))
		for _, root := range roots {
			acls, aclErr := a.store.ListDesktopACLs(root.ID)
			if aclErr != nil { writeError(w, http.StatusInternalServerError, "unable to load desktop ACLs"); return }
			item.Roots = append(item.Roots, desktopAdminRoot{DesktopRoot:root,ACLs:acls})
		}
		out = append(out,item)
	}
	writeJSON(w,http.StatusOK,map[string]any{"desktops":out,"users":users})
}

func (a *app) adminUpdateDesktop(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid desktop id"); return }
	var input desktopUpdateInput
	if err := decodeJSON(r,&input); err != nil { writeError(w,http.StatusBadRequest,"invalid desktop settings"); return }
	if err := a.store.UpdateDesktop(id,input.Name,input.Enabled); err != nil {
		writeError(w,http.StatusBadRequest,err.Error()); return
	}
	device, err := a.store.GetDesktop(id)
	if err != nil { writeError(w,http.StatusInternalServerError,"unable to load desktop"); return }
	writeJSON(w,http.StatusOK,map[string]any{"device":device})
}

func (a *app) adminDeleteDesktop(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid desktop id"); return }
	if err := a.store.DeleteDesktop(id); err != nil { writeError(w,http.StatusBadRequest,err.Error()); return }
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) adminUpdateDesktopRoot(w http.ResponseWriter, r *http.Request) {
	deviceID, err := parseID(r)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid desktop id"); return }
	rootID, err := strconv.ParseInt(r.PathValue("rootID"),10,64)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid location id"); return }
	var input desktopRootUpdateInput
	if err := decodeJSON(r,&input); err != nil { writeError(w,http.StatusBadRequest,"invalid location settings"); return }
	if err := a.store.UpdateDesktopRoot(deviceID,rootID,input.Enabled); err != nil { writeError(w,http.StatusBadRequest,err.Error()); return }
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) adminSetDesktopACL(w http.ResponseWriter, r *http.Request) {
	deviceID, err := parseID(r)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid desktop id"); return }
	rootID, err := strconv.ParseInt(r.PathValue("rootID"),10,64)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid location id"); return }
	userID, err := strconv.ParseInt(r.PathValue("userID"),10,64)
	if err != nil { writeError(w,http.StatusBadRequest,"invalid user id"); return }
	var input desktopACLInput
	if err := decodeJSON(r,&input); err != nil { writeError(w,http.StatusBadRequest,"invalid ACL"); return }
	acl := store.DesktopACL{
		RootID:rootID,UserID:userID,
		CanRead:input.CanRead,CanWrite:input.CanWrite,CanRename:input.CanRename,CanDelete:input.CanDelete,
	}
	if err := a.store.SetDesktopACL(deviceID,rootID,userID,acl); err != nil {
		writeError(w,http.StatusBadRequest,err.Error()); return
	}
	writeJSON(w,http.StatusOK,map[string]any{"acl":acl})
}
