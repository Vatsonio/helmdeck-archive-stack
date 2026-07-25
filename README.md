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

`mediamtx`/`sink`/`ui` run inside the ZeroTier member's network, so `:8890` and
`:9410` are reachable ONLY over ZeroTier (never the public NIC). `:8080` is also
published on the host for convenience.

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

- Recordings + telemetry live in named Docker volumes (`archive_video`,
  `archive_telem`); the ZeroTier identity in `zt_identity` (keep it so the member
  IP is stable across restarts). To store the archive on a specific large disk,
  swap the named volumes for bind mounts.
- H.265 plays in the browser only on an HEVC-capable browser; otherwise use the
  UI's Export MP4.
