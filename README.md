# HELMDECK archive stack

Self-contained receiver + viewer for the video/telemetry that operator stations
archive. Deploy as one Portainer stack. Rides its own ZeroTier member, so the
whole thing is reachable at a ZeroTier IP with nothing to configure on the host.

## Services

| service    | image                                    | role                                                    |
|------------|------------------------------------------|---------------------------------------------------------|
| `zerotier` | `zerotier/zerotier`                      | joins the ZT network; owns the network the others share |
| `mediamtx` | `bluenviron/mediamtx`                     | SRT ingest `:8890/udp`, records `publish:archive/<node>/<cam>` |
| `sink`     | `ghcr.io/vatsonio/helmdeck-archive-sink` | telemetry POST `:9410/tcp` -> per-session JSONL         |
| `ui`       | `ghcr.io/vatsonio/helmdeck-archive-ui`   | web viewer `:8080` (tree, playback, OSD, map, export)   |
| `diskring` | `debian:stable-slim`                     | prunes oldest when the volume passes 85%                |

`mediamtx`/`sink`/`ui` run inside the ZeroTier member's network, so `:8890`,
`:9410` and `:8080` are reachable over ZeroTier and NOT on the public NIC. Open
the UI at `http://<ZT_IP>:8080`.

The host publish is deliberately loopback only (`127.0.0.1:${UI_PORT:-18080}`).
The viewer has no authentication, so it must not sit on a public interface, and
a loopback bind also cannot collide with a neighbouring stack's port. For local
access without ZeroTier: `ssh -L 8080:127.0.0.1:18080 <host>`.

The `sink` and `ui` images are built by GitHub Actions and pushed to GHCR on every
push to `main`; the MediaMTX config and disk-ring script are inlined in the
compose, so the stack needs no repo files on the host.

## Deploy in Portainer

1. Portainer -> **Stacks** -> **Add stack** -> **Web editor**.
2. Paste `docker-compose.yml` verbatim. (Needs Docker Compose v2.23+ for inline
   `configs`; recent Portainer/Docker has it. If it complains, deploy via
   **Repository** instead, pointing at this repo.)
3. (Optional) set env `ZT_NETWORK` / `UI_PORT` if you changed them.
4. **Deploy.**

### One-time after first deploy
- **Make the two GHCR packages public** (so the host can pull without a login):
  GitHub -> your profile -> Packages -> `helmdeck-archive-sink` and
  `helmdeck-archive-ui` -> Package settings -> Change visibility -> Public.
  (Or add a GHCR pull secret to the Docker host.)
- **Authorize the ZeroTier member:** open ZeroTier Central -> network
  `88c5b1f339a56a50` -> the new member appears -> check **Auth**, and assign it the
  IP you want (or note the one it gets). **That IP is what gets hardcoded into the
  exe** as the archive target.

## Verify

```
# from a machine on the same ZeroTier net, using the member's ZT IP:
curl -X POST --data-binary $'{"t":1,"p":{}}\n' http://<ZT_IP>:9410/telemetry/NODE-TEST/sess1   # -> 204
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=25 -c:v libx265 -f mpegts \
  "srt://<ZT_IP>:8890?streamid=publish:archive/NODE-TEST/cam1"                                  # -> records
```
Then open `http://<ZT_IP>:8080` (or `http://<host>:8080`) - the recording shows in
the tree.

## Notes

- Recordings + telemetry are bind-mounted under `ARCHIVE_DIR` (default
  `/data/helmdeck-archive`, the big `/data` disk, NOT the small system disk). Set
  `ARCHIVE_DIR` if your large disk is elsewhere. **Check the mount before
  deploying**: `findmnt -T /data`. Docker creates a missing bind path silently, so
  an unmounted data disk means everything records onto the system disk instead.
- The ZeroTier identity lives in the `zt_identity` volume. Losing it changes this
  member's ZeroTier address, and that address is **hardcoded into every shipped
  exe**, so every station stops archiving until a new exe is built. Never tick
  "remove volumes" on a stack delete, and take the backup once, after the member
  is authorized:

  ```
  docker compose cp zerotier:/var/lib/zerotier-one/identity.secret ./zt-identity.bak
  ```

  Restoring on a new host: create the volume, copy `identity.secret` in, then
  start the stack; it comes up as the same member with the same IP.
- **After changing the `zerotier` service, recreate the whole stack**
  (`docker compose up -d --force-recreate`). `network_mode: service:zerotier`
  binds the other three to that container's network namespace by id; recreating
  it alone leaves them attached to a dead namespace, running but unreachable.
- Image tags are pinned. MediaMTX rejects unknown config keys outright and has
  renamed them before, so a floating tag can turn a redeploy into a crash loop.
  1.17.1+ is also required: it forbids path names that escape the recordings
  directory, and our path name comes from a publisher-supplied streamid.
- `diskring` only prunes when it can actually read `df` and when the data is
  ours. It refuses to act on an unreadable filesystem: the unguarded version
  deleted the entire archive when `df` returned nothing.
- H.265 plays in the browser only on an HEVC-capable browser; otherwise use the
  UI's Export MP4 (exported as `hvc1`, which QuickTime and Windows Media Player
  accept).
