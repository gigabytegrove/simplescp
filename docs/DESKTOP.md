# SimpleSCP Server + Desktop

SimpleSCP uses a two-part architecture for native local-computer access.

## SimpleSCP Server

The Server runs in Docker and is the control plane. It manages:

- users and authenticated sessions
- saved SSH/SFTP connections
- enrolled SimpleSCP Desktop machines
- desktop online/offline inventory
- discovered Windows drives and Linux mounts
- per-location enable/disable policy
- per-user filesystem ACLs
- update management and audit-ready device metadata

Administrators manage Desktop systems from the **Desktops** button in the Server header.

## SimpleSCP Desktop

SimpleSCP Desktop is a user-launched Windows/Linux application. It is not a Windows service, Linux daemon, background agent, Docker sidecar, or privileged server process.

While Desktop is open it:

1. binds a loopback-only local endpoint
2. opens the configured SimpleSCP Server through that local application endpoint
3. identifies the desktop to the Server
4. enumerates native local drives/mounts
5. checks in filesystem inventory while running
6. receives short-lived ACL tickets from the Server for the signed-in user
7. enforces those ACLs locally before allowing filesystem operations

Closing Desktop removes local filesystem access.

## Native locations

On Windows, Desktop enumerates logical disks including fixed disks, removable media, optical devices, and mapped network drives where available.

On Linux, Desktop exposes the root filesystem and non-pseudo mounted filesystems discovered from the active mount table.

The Local Computer pane opens at **This PC** and uses these native locations. The old browser-granted Local Roots implementation has been removed.

## ACLs

ACLs are defined per user and per discovered location:

- Read
- Write
- Rename
- Delete

The Server signs a short-lived access ticket containing only the locations and permissions available to the logged-in user. Desktop verifies that ticket locally for each native filesystem request.

## Release artifacts

Live releases publish:

- `simplescp-linux-amd64`
- `simplescp-linux-arm64`
- `simplescp-desktop-windows-amd64.exe`
- `simplescp-desktop-windows-arm64.exe`
- `simplescp-desktop-linux-amd64`
- `simplescp-desktop-linux-arm64`
- `SHA256SUMS`
