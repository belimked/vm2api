---
name: hostdzire-version-switch
description: "Deploy and verify a vm2api VERSION on HostDzire (kin.fkcodex.com). Use when switching the live control plane, rolling back a cutover, or the user says 部署到 hostdzire / 切换版本 / 切回上一版. Checks version, Docker slot identity, web availability, and a live conversation. Does not merge the PR or publish the release."
---

# HostDzire version switch

Deploy and verify one stack: public `https://kin.fkcodex.com`, SSH alias `hostdzire` (`23.80.83.15`).

Live code stays at `/opt/kin-gateway`. Do not install Compose at `/opt/vm2api`. Slot mounts are `/opt/kin-gateway/vms/...`.

This skill is the gate inside `skills/commit-pr-release`. It does not merge and it does not push a tag. Return the `verify-live.py` exit code to that flow.

## When to load

- Overlay the current checkout's `VERSION` onto live Node and `/var/www/kin-console`
- Roll back to a `.deploy-bak-vm2api-*` snapshot
- User asks to 切换 / 部署 / 切回 HostDzire

## Hard stops

- Never `docker rm` a `kin-*` container.
- Never change `KIN_PROJECT_ROOT` or the unit `WorkingDirectory` away from `/opt/kin-gateway`.
- Never overlay `src/config/routing.json`, `vms/`, `data/`, `.env`, or systemd secrets.
- Never print `KIN_API_KEY` or the admin password. Read them only inside the remote probe.
- Restart `kin-gateway.service` once. Leave `kin-gateway-go.service` (`:8787` in front, Node `:8788` behind).
- Keep `/var/www/kin-console/dl` pointed at `/var/www/kin-console-dl`.
- SSH only through ssh-skill:

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire "<cmd>"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire "<local>" "<remote>"
```

The public homepage returns 403 from the server itself. Check it from the operator machine.

## Layout

| Piece | Live path |
|---|---|
| Node | `127.0.0.1:8788`, `ExecStart=/usr/bin/node src/server.mjs` |
| Go front door | `:8787`, nginx `/api` `/v1` `/health` |
| Console | `/var/www/kin-console` |
| Wrap sample | `/opt/kin-gateway/share/wrap-cli` |
| Slots | `/opt/kin-gateway/vms/<id>/cli-home/.kin` |
| Admin env | systemd `Environment=` in `kin-gateway.service` and `kin-gateway.service.d/` |

## Forward

1. Snapshot slot identity **before** changing anything:

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire \
  "docker ps -a --filter name=kin- --format '{{.Names}}\t{{.ID}}\t{{.Status}}'"
```

Save the table to `/tmp/kin-before-<VERSION>.txt`. Drop the ssh-skill JSON wrapper; keep only `name<TAB>id<TAB>status` lines.

2. Pack from the repo root. The packer rebuilds `web/dist`. Do not reuse an older tarball after `VERSION` changes.

```
sh skills/hostdzire-version-switch/scripts/pack-overlay.sh
```

Writes `/tmp/vm2api-hostdzire-<VERSION>.tgz` with `src/server.mjs`, `src/lib`, `src/config/distill-rules.json`, `bin/kin-*`, `share/wrap-cli` (no `cli-dist` or `bun`), `web/dist`, and `VERSION`.

3. Upload and apply. Apply backs up first, then restarts Node once.

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "/tmp/vm2api-hostdzire-<VERSION>.tgz" "/tmp/vm2api-hostdzire-<VERSION>.tgz"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "skills/hostdzire-version-switch/scripts/remote-apply.sh" "/tmp/vm2api-remote-apply.sh"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire --timeout 180 \
  "sh /tmp/vm2api-remote-apply.sh <VERSION>"
```

Record `BAK=...`. Do not restart `kin-gateway` again in this cutover.

4. Sync slot CLIs only when `bin/kin-kernel` or `share/wrap-cli` changed relative to the backup. A control-plane-only change does not call `wrap-cli/sync` and does not restart slots. When a sync is required, `POST /api/panel/wrap-cli/sync` with `{"restart":true}` using the systemd key without printing it. `ok_count` must equal the listed VMs. If `kernel.json` ends up `root:root` `0600`, `chown` it to the `worker.json` owner. Never `docker rm` the slot.

5. Verify. This command is the gate. Exit 0 is required before anyone merges or tags.

```
python3 skills/hostdzire-version-switch/scripts/verify-live.py <VERSION> \
  --before /tmp/kin-before-<VERSION>.txt
```

Gates:

- `version_file` and panel `me.version` equal `<VERSION>`
- Node `/health` is `service=vm2api`
- panel login works and the VM list is non-empty
- `https://kin.fkcodex.com/` contains `<title>vm2api</title>` and `id="root"`
- every `kin-*` container is **Up**, and each pre-apply container id is unchanged
- `POST /v1/messages` with `claude-haiku-4-5` returns assistant text

If every Claude account is inside a quota or cooldown window that ends within 15 minutes, the script waits once and retries the conversation. A longer block, a 503, a missing page, or a recreated container fails the gate. Do not merge. Roll back if Node or the console is down.

## Rollback

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "skills/hostdzire-version-switch/scripts/remote-rollback.sh" "/tmp/vm2api-remote-rollback.sh"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire --timeout 180 \
  "sh /tmp/vm2api-remote-rollback.sh [BAK_DIR]"
```

Restores `server.mjs`, `src/lib`, distill rules, bins, `share/wrap-cli`, and `/var/www/kin-console` (keeps `dl`). Restarts Node once. Run `verify-live.py` against the restored version before calling the box healthy.

Known bak from the 1.2.5 cutover: `/opt/kin-gateway/.deploy-bak-vm2api-1.2.5-20260919T191637Z`.

## After either direction

- Do not `systemctl stop` without a start.
- Do not start a second Node restart.
- Telegram: `python3 /home/mci777/.omp/agent/hooks/tg_notify.py --task "..."`.
