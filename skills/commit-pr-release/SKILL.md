---
name: commit-pr-release
description: "Ship vm2api through one ordered flow: commit on a branch, open a PR, deploy and verify on HostDzire, merge only after verification, then publish the GitHub release. Use when the user says commit, PR, 合并, release, 发版, 发布, or asks to ship a VERSION. A normal code commit always opens a PR and does not land on main by itself."
---

# Commit, PR, then release

One flow. Do not reorder it. Do not merge or tag before HostDzire verification passes.

Load `skills/hostdzire-version-switch/SKILL.md` before the deploy step. That skill owns packing, apply, rollback, and the live checks.

## Order

1. Branch from current `origin/main`. One concern per commit. Do not commit on `main`.
2. Push the branch and open a PR. Leave it **unmerged**.
3. Deploy that branch's tree to HostDzire and run `verify-live.py`. This step is required when the PR changes runtime code (`src/`, `web/`, `bin/`, `worker/`, `share/wrap-cli`, `VERSION`, `CHANGELOG.md`).
4. Merge the PR only after `verify-live.py` exits 0.
5. On the merged `main` commit, tag `v<VERSION>` and publish the release. Never retag.

Docs-only or skill-only PRs (`skills/`, `docs/`, markdown that does not ship in the overlay) still open a PR. Skip steps 3 and 5 unless the user explicitly asked to deploy or release. Do not bump `VERSION` for those.

## Commit

- Stage only the files for that concern. Never stage `.gitignore`, `AGENTS.md`, `worker/bin/`, `docs/benchmarks.zip`, `issues/`, `plan/`, or `web/src/features/vm/openai-quota-actions.tsx` unless the user names that file.
- Run `git status -sb` after `git add`. The staged set must match the concern.
- Message shape: `fix(pool): ...`, `feat(web): ...`, or `release: cut vX.Y.Z`.
- A version cut is its own commit and touches only `VERSION` and `CHANGELOG.md`. The changelog entry states whether a deployed machine needs `wrap-cli/sync`.
- `VERSION` is the only app version. The tag must be `v` plus that exact string.

## Pull request

```
git push -u origin HEAD
gh pr create --base main --head <branch> --title "..." --body "..."
```

Do not `gh pr merge` in this step. The PR body lists the version, the HostDzire backup path once deploy has run, and the `verify-live.py` result once it exists.

## Deploy gate

Run the HostDzire skill against the **unmerged** branch checkout. The overlay's `VERSION` is the version under test.

Required gates, all of them, from `skills/hostdzire-version-switch/scripts/verify-live.py`:

- version file and `GET /api/panel/me` version
- Node health `service=vm2api`
- panel login and a non-empty VM list
- public web: `<title>vm2api</title>` and `id="root"`
- every `kin-*` container still **Up** with the same container id as the pre-apply snapshot
- one live conversation returns assistant text

Exit 0 is the only pass. A 503, a recreated container, a version mismatch, or a dead console is a fail. On fail: do not merge, do not tag, and roll back with the HostDzire skill if the live box is unhealthy.

## Merge

Only after the gate exits 0:

```
gh pr merge <N> --merge
git fetch origin main && git checkout main && git pull --ff-only origin main
```

Confirm `HEAD` contains the verified version commit and `VERSION` still matches the version that passed the gate. If `main` moved, stop.

## Release

```
git tag v$(tr -d ' \n' < VERSION)
git push origin v$(tr -d ' \n' < VERSION)
```

Wait until the `release` workflow succeeds. Then set the notes from the changelog. Do not delete or move the tag.

```
gh release edit vX.Y.Z --notes "..."
```

Notes are the changelog section for that version, plus the link to `CHANGELOG.md`. Confirm the release is not a draft and lists the linux binaries.

Notify: `python3 /home/mci777/.omp/agent/hooks/tg_notify.py --task "..."`.

## Stop

- Do not push a tag from an unmerged branch.
- Do not deploy a dirty tree. The deployed files are the branch commits.
- Do not `docker rm` a `kin-*` container while verifying.
- Do not print `KIN_API_KEY` or the admin password.
