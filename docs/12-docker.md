# Running in Docker

One container, two volumes, browser wizard. Works on any machine with Docker
— a NAS, a home server, a 64-bit Raspberry Pi running Docker, a Windows PC
with Docker Desktop.

## Quickstart

```bash
git clone https://github.com/brymitch56/troop-checkin.git
cd troop-checkin
docker compose up -d
```

Open `http://<host>:3000` — the first-run **setup wizard** configures
everything in the browser (troop identity, Trail Life / AHG / custom colors,
timezone, admin account). No files to edit.

Prefer the **prebuilt multi-arch image** (no local build, faster first
start)? In `docker-compose.yml`, replace `build: .` with
`image: ghcr.io/brymitch56/troop-checkin:latest` — published automatically
for every release (amd64 + arm64).

## How state is laid out

| Volume      | Contents                                             | Notes |
|-------------|------------------------------------------------------|-------|
| `tc-data`   | SQLite DB, signature images, nightly backups — the PII | This is what you back up |
| `tc-config` | The `.env` the wizard writes (via `ENV_FILE`)          | Kept separate so data backups never contain `CRED_KEY` |

The image runs as the non-root `node` user, restarts automatically
(`restart: unless-stopped`), and has a `/healthz` healthcheck built in
(`docker ps` shows `healthy`).

## Backups

The app writes its own nightly snapshots (03:15) to `backups/` **inside the
data volume** — the in-process scheduler needs no cron or systemd. Copy them
out host-side periodically:

```bash
docker run --rm -v troop-checkin_tc-data:/data -v "$PWD":/out \
  alpine sh -c 'cp -r /data/backups /out/tc-backups'
```

Or archive the whole volume (see the header of `docker-compose.yml`).

## Weekly roster sync

Save your portal credentials in Admin → Import, then set
`SCHEDULE_ROSTER_SYNC: weekly` in the compose file's `environment:` block
and `docker compose up -d` again. The fetch stages a pending import for
one-tap approval — it never commits by itself.

## HTTPS / remote access

Uncomment the `cloudflared` sidecar in `docker-compose.yml` (instructions
inline) — it gives leaders' phones HTTPS access away from the troop Wi-Fi
with no open ports. Full walkthrough: `docs/09-tunnel-setup.md`.

## Upgrading

```bash
git pull && docker compose up -d --build
```

Migrations run automatically on container start. Data and config live on the
volumes, so containers are disposable.

## Removing the app

```bash
docker compose down        # stop + remove the container (data/config KEPT)
docker compose down -v     # ALSO delete the volumes — all data, irreversibly
docker rmi troop-checkin   # remove the built image
```

Copy your backups out (see "Backups" above) before `down -v`.

## Multi-arch

The image builds for amd64 and arm64 from the same Dockerfile:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t troop-checkin .
```

better-sqlite3 ships prebuilt binaries for both, so no compiler is involved.
