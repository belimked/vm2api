#!/usr/bin/env python3
"""Verify a HostDzire cutover. Prints PASS/FAIL lines. Exits 0 only if every gate passes.

Never prints KIN_API_KEY, admin password, or session tokens.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

SSH = Path.home() / ".codex/skills/ssh-skill/scripts/ssh_execute.py"
PUBLIC = "https://kin.fkcodex.com/"
MAX_WAIT_S = 15 * 60

REMOTE = r"""
import json, os, subprocess, urllib.request
env = {}
paths = ["/etc/systemd/system/kin-gateway.service"]
drop = "/etc/systemd/system/kin-gateway.service.d"
if os.path.isdir(drop):
    paths += [os.path.join(drop, name) for name in sorted(os.listdir(drop))]
for path in paths:
    for line in open(path):
        row = line.strip()
        if not row.startswith("Environment="):
            continue
        rest = row.split("=", 1)[1].strip().strip('"')
        if "=" not in rest:
            continue
        key, value = rest.split("=", 1)
        env[key] = value

def call(method, path, payload=None, headers=None, timeout=70):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request("http://127.0.0.1:8788" + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")

version = open("/opt/kin-gateway/VERSION").read().strip()
health_status, health_raw = call("GET", "/health")
health = json.loads(health_raw)
login_status, login_raw = call(
    "POST",
    "/api/panel/login",
    {"username": env.get("KIN_ADMIN_USER", ""), "password": env.get("KIN_ADMIN_PASSWORD", "")},
)
login = json.loads(login_raw)
token = login.get("token") or ""
me_status, me_raw = call("GET", "/api/panel/me", headers={"Authorization": "Bearer " + token})
me = json.loads(me_raw)
vms_status, vms_raw = call("GET", "/api/panel/vms", headers={"Authorization": "Bearer " + token})
vms_doc = json.loads(vms_raw)
items = ((vms_doc.get("data") or {}).get("items")) or []
slots = []
for item in items:
    av = item.get("availability") or {}
    slots.append({
        "id": item.get("id"),
        "platform": item.get("platform"),
        "status": item.get("status"),
        "accept": av.get("accept"),
        "reason": av.get("reason"),
        "until": av.get("until"),
    })
msg_status, msg_raw = call(
    "POST",
    "/v1/messages",
    {
        "model": "claude-haiku-4-5",
        "max_tokens": 32,
        "messages": [{"role": "user", "content": "Reply with the single word pong."}],
    },
    headers={
        "Authorization": "Bearer " + env.get("KIN_API_KEY", ""),
        "anthropic-version": "2023-06-01",
    },
)
msg = json.loads(msg_raw)
text = ""
for block in msg.get("content") or []:
    if isinstance(block, dict) and block.get("type") == "text":
        text += block.get("text") or ""
err = msg.get("error") or {}
ps = subprocess.check_output(
    ["docker", "ps", "-a", "--filter", "name=kin-", "--format", "{{.Names}}\t{{.ID}}\t{{.Status}}"],
    text=True,
)
containers = []
for line in ps.splitlines():
    name, cid, status = (line.split("\t") + ["", "", ""])[:3]
    if name.startswith("kin-"):
        containers.append({"name": name, "id": cid, "status": status})
print(json.dumps({
    "version": version,
    "health_status": health_status,
    "service": health.get("service"),
    "login_ok": login_status == 200 and login.get("ok") is True,
    "me_version": me.get("version"),
    "vm_count": len(items),
    "slots": slots,
    "messages_status": msg_status,
    "messages_text": (text or err.get("message") or "")[:120],
    "containers": containers,
}))
"""


def gate(ok, name, detail):
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    return bool(ok)


def ssh_probe():
    proc = subprocess.run(
        [sys.executable, str(SSH), "hostdzire", "--timeout", "120", "python3 - <<'PY'\n" + REMOTE + "\nPY"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(1)
    wrapper = json.loads(proc.stdout)
    if not wrapper.get("success"):
        sys.stderr.write(wrapper.get("stderr") or "remote probe failed")
        raise SystemExit(1)
    return json.loads(wrapper["stdout"])


def load_before(path):
    rows = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        name, cid, status = (line.split("\t") + ["", "", ""])[:3]
        if name:
            rows[name] = (cid, status)
    return rows


def soonest_until(slots, now_ms):
    waits = []
    for slot in slots:
        if slot.get("platform") != "anthropic" or slot.get("accept"):
            continue
        until = slot.get("until")
        if isinstance(until, (int, float)) and until > now_ms:
            waits.append(until)
    return min(waits) if waits else None


def conversation_ok(report):
    text = report.get("messages_text") or ""
    return report.get("messages_status") == 200 and bool(text) and "负载过高" not in text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument("--before", help="tab-separated name, id, status captured before apply")
    args = parser.parse_args()
    if not SSH.is_file():
        raise SystemExit(f"missing ssh-skill: {SSH}")

    report = ssh_probe()
    ok = True
    ok &= gate(report["version"] == args.version, "version_file", report["version"])
    ok &= gate(
        report["health_status"] == 200 and report["service"] == "vm2api",
        "health",
        f"{report['health_status']} {report['service']}",
    )
    ok &= gate(report["login_ok"] and report["me_version"] == args.version, "panel", str(report["me_version"]))
    ok &= gate(report["vm_count"] > 0, "vms", str(report["vm_count"]))

    page = subprocess.check_output(["curl", "-fsS", "--max-time", "20", PUBLIC], text=True)
    ok &= gate("<title>vm2api</title>" in page and 'id="root"' in page, "web", PUBLIC)
    containers = {row["name"]: row for row in report["containers"]}
    up = [name for name, row in containers.items() if str(row["status"]).startswith("Up")]
    ok &= gate(len(containers) > 0 and len(up) == len(containers), "docker_up", f"{len(up)}/{len(containers)}")
    if args.before:
        before = load_before(args.before)
        same = []
        for name, (cid, _status) in before.items():
            live = containers.get(name)
            same.append(bool(live) and str(live["id"]).startswith(cid) and str(live["status"]).startswith("Up"))
        ok &= gate(bool(before) and all(same), "docker_identity", f"{sum(same)}/{len(before)} unchanged")
    else:
        ok &= gate(False, "docker_identity", "missing --before snapshot")

    if not conversation_ok(report):
        until = soonest_until(report["slots"], time.time() * 1000)
        wait_s = None if until is None else (until / 1000) - time.time() + 5
        if wait_s is not None and 0 < wait_s <= MAX_WAIT_S:
            print(f"WAIT conversation: retry in {int(wait_s)}s")
            time.sleep(wait_s)
            report = ssh_probe()
    text = report.get("messages_text") or ""
    ok &= gate(conversation_ok(report), "conversation", f"{report.get('messages_status')} {text}")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
