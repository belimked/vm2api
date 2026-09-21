#!/usr/bin/env bash
# 合并上游 dofastted/vm2api 到我们的定制分支，并跑全套校验。
#
# 用法:
#   scripts/sync-upstream.sh              # 试合并 + 校验，不推送（默认，安全）
#   scripts/sync-upstream.sh --push       # 校验通过后推送到 origin
#
# 做什么:
#   1. 抓上游 main，报告新版本
#   2. 逐个检查我们的定制补丁上游修了没有
#   3. 试合并（不落地），列出冲突
#   4. 正式合并到定制分支
#   5. 六项校验: 语法 / 未声明变量 / 补丁完好 / 版本号一致 / 二进制哈希 / 测试基线
#   6. --push 时推送
#
# 不做什么: 不打 tag（你说了再打）、不部署、有冲突就停下等你手动解。
set -uo pipefail

# ── 配置 ────────────────────────────────────────────────────
UPSTREAM_URL="https://github.com/dofastted/vm2api.git"
CUSTOM_BRANCH="feat/slot-nic-and-hash-rotation"
MIRROR_BRANCH="main"                     # belimked/main = 上游纯镜像
BIOME="@biomejs/biome@2.5.11"
DO_PUSH=0
[ "${1:-}" = "--push" ] && DO_PUSH=1

# 我们的定制补丁: "标记文本:文件" —— grep 到即视为补丁在位
PATCHES=(
  "sendNotifyTest:src/lib/admin/panel-routes.mjs"          # 设置保存 / notify 导入
  "CLI_HOP_CACHE_TTL:src/lib/protocol/outbound-attempt.mjs" # #32 cli-hop 固定 5m
  "INCOMPLETE_ASSISTANT_MESSAGE:src/lib/core/errors.mjs"    # #32 保留上游错误原因
  "reconcileEgress:src/lib/vm/proxy-pool.mjs"               # #32 启动恢复出口
  "NIC_OUIS:src/lib/identity/workstation-profile.mjs"       # 槽位哈希 + 厂商 MAC
  "NPM_REGISTRY:Dockerfile"                                  # 大陆镜像源
)

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
ok(){   printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn(){ printf "  ${YEL}!${RST} %s\n" "$*"; }
die(){  printf "\n${RED}${BLD}✗ %s${RST}\n" "$*" >&2; exit 1; }
step(){ printf "\n${BLD}%s${RST}\n" "$*"; }

cd "$(git rev-parse --show-toplevel)" || die "不在 git 仓库里"

# 前置: 工作区必须干净，且在定制分支上
[ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，先处理干净再合并"
git checkout -q "$CUSTOM_BRANCH" || die "切不到 $CUSTOM_BRANCH"

# ── 1. 抓上游 ───────────────────────────────────────────────
step "① 抓取上游 $UPSTREAM_URL"
git fetch -q "$UPSTREAM_URL" main || die "fetch 上游失败"
git fetch -q --tags "$UPSTREAM_URL" 2>/dev/null || true
U=$(git rev-parse FETCH_HEAD)
UV=$(git show "${U}:VERSION" 2>/dev/null || echo "?")
CUR=$(cat VERSION)
ok "上游 main $(git rev-parse --short "$U")  VERSION=$UV"
ok "定制分支 $(git rev-parse --short HEAD)  VERSION=$CUR"
if git merge-base --is-ancestor "$U" HEAD; then
  ok "已包含上游全部提交，无需合并"; exit 0
fi
NEW=$(git rev-list --count HEAD.."$U")
ok "上游有 $NEW 个新提交"

# ── 2. 补丁体检 ─────────────────────────────────────────────
step "② 检查定制补丁上游修了没有"
for entry in "${PATCHES[@]}"; do
  mark="${entry%%:*}"; file="${entry#*:}"
  if git show "${U}:${file}" 2>/dev/null | grep -q -- "$mark"; then
    warn "上游 ${file} 已含 '${mark}' —— 合并后确认是否可丢弃我们的补丁"
  else
    ok "${mark} (${file##*/}) 仍需保留"
  fi
done

step "   上游是否改动了我们改过的文件"
touched=0
for entry in "${PATCHES[@]}"; do
  file="${entry#*:}"
  n=$(git rev-list --count "HEAD..${U}" -- "$file")
  [ "$n" -gt 0 ] && { printf "  ${YEL}★${RST} %-46s 上游改了 %s 次（潜在冲突）\n" "$file" "$n"; touched=1; }
done
[ "$touched" = 0 ] && ok "上游没碰任何我们改过的文件"

# ── 3. 试合并 ───────────────────────────────────────────────
step "③ 试合并（不落地）"
conflicts=$(git merge-tree --write-tree --name-only HEAD "$U" 2>/dev/null | tail -n +2 | grep -v '^$' || true)
if [ -n "$conflicts" ]; then
  printf "  ${YEL}以下文件会冲突，需手动解:${RST}\n"; echo "$conflicts" | sed 's/^/    /'
else
  ok "干净合并，无冲突"
fi

# ── 4. 正式合并 ─────────────────────────────────────────────
step "④ 合并"
git checkout -q "$MIRROR_BRANCH" && git merge -q --ff-only "$U" \
  || die "$MIRROR_BRANCH 不能 fast-forward 到上游（镜像分支被污染？）"
ok "$MIRROR_BRANCH → $(git rev-parse --short HEAD) ($(cat VERSION))"
git checkout -q "$CUSTOM_BRANCH"
if ! git merge --no-edit "$MIRROR_BRANCH"; then
  printf "\n${YEL}${BLD}合并有冲突，已停在冲突状态。${RST}\n"
  printf "手动解决后:  git add <文件> && git commit --no-edit\n"
  printf "然后重新跑:   scripts/sync-upstream.sh %s\n" "$([ $DO_PUSH = 1 ] && echo --push)"
  git --no-pager diff --name-only --diff-filter=U | sed 's/^/    冲突: /'
  exit 2
fi
ok "合并完成 → $(git rev-parse --short HEAD)  VERSION=$(cat VERSION)"

# ── 5. 六项校验 ─────────────────────────────────────────────
step "⑤ 校验"
FAIL=0

# 5.1 语法（git 看不到的语义冲突，如重复 import）
if find src -name '*.mjs' -print0 | xargs -0 -n1 node --check >/dev/null 2>&1; then
  ok "语法: src 全通过"
else
  find src -name '*.mjs' -print0 | xargs -0 -n1 node --check 2>&1 | grep -i "error" | head -5 | sed 's/^/    /'
  warn "语法检查失败"; FAIL=1
fi

# 5.2 未声明 / 重复声明变量
SCAN=$(mktemp); printf '%s' '{"files":{"includes":["src/**"]},"formatter":{"enabled":false},"assist":{"enabled":false},"linter":{"enabled":true,"rules":{"recommended":false,"correctness":{"noUndeclaredVariables":"error"}}}}' > "$SCAN"
if npx --yes "$BIOME" lint --config-path="$SCAN" src 2>&1 | grep -qE "undeclared|already been declared"; then
  npx --yes "$BIOME" lint --config-path="$SCAN" src 2>&1 | grep -E "undeclared|already been declared" | head -5 | sed 's/^/    /'
  warn "未声明/重复声明变量"; FAIL=1
else
  ok "未声明变量扫描: 干净"
fi
rm -f "$SCAN"

# 5.3 补丁完好
missing=""
for entry in "${PATCHES[@]}"; do
  mark="${entry%%:*}"; file="${entry#*:}"
  grep -q -- "$mark" "$file" 2>/dev/null || missing="$missing ${mark}"
done
if [ -z "$missing" ]; then ok "六个定制补丁全部完好"; else warn "补丁丢失:$missing"; FAIL=1; fi

# 5.4 版本号三处一致
V1=$(cat VERSION); V2=$(grep -oE '"version": *"[0-9.]+"' package.json | grep -oE '[0-9.]+' | head -1); V3=$(grep -oE 'vm2api:[0-9.]+' docker-compose.yml | cut -d: -f2 | head -1)
if [ "$V1" = "$V2" ] && [ "$V1" = "$V3" ]; then ok "版本号一致: $V1"; else warn "版本号不一致 VERSION=$V1 package=$V2 compose=$V3（上游发版疏漏）"; FAIL=1; fi

# 5.5 槽内二进制是否变化 → 是否需要 wrap-cli/sync
SYNC=0
for f in bin/kin-kernel bin/kin-codex-kernel bin/kin-cookie-auth share/wrap-cli/kin-kernel.bin share/wrap-cli/cli-node; do
  a=$(git rev-parse "${U}:$f" 2>/dev/null); b=$(git rev-parse "HEAD:$f" 2>/dev/null)
  [ "$a" != "$b" ] && SYNC=1
done
if [ "$SYNC" = 1 ]; then warn "槽内 kernel 已更新 → 部署后需 POST /api/panel/wrap-cli/sync"; else ok "槽内二进制未变 → 无需 wrap-cli/sync"; fi

# 5.6 测试基线: 我们不能比上游同版本多失败（新增测试文件除外）
step "   测试基线对比（vs 上游 $UV 原样）"
SP="${SCRATCH_DIR:-$(mktemp -d)}"; mkdir -p "$SP"
MINE="$SP/mine.txt"; BASE="$SP/base.txt"
npm run test:unit 2>&1 | grep -E "^not ok 1 - /" | sed 's|.*/test/unit/||' | sort > "$MINE"
WT="$SP/upstream-wt"
git worktree add -q --detach "$WT" "$U" 2>/dev/null \
  && ( cd "$WT" && npm run test:unit 2>&1 | grep -E "^not ok 1 - /" | sed 's|.*/test/unit/||' | sort ) > "$BASE" \
  && git worktree remove --force "$WT" 2>/dev/null
NEWFAIL=$(comm -13 "$BASE" "$MINE")
# 新增失败里，属于我们新加的测试文件（基线里不存在该文件）不算回归
REGRESS=""
for t in $NEWFAIL; do git show "${U}:test/unit/$t" >/dev/null 2>&1 && REGRESS="$REGRESS $t"; done
if [ -z "$REGRESS" ]; then
  ok "测试无回归（我们 $(wc -l < "$MINE") / 上游 $(wc -l < "$BASE")；差异均为新增测试文件）"
else
  warn "以下上游测试在我们分支上开始失败（真回归）:$REGRESS"; FAIL=1
fi

# ── 6. 结果 ─────────────────────────────────────────────────
step "⑥ 结果"
if [ "$FAIL" != 0 ]; then
  die "校验未全过，未推送。合并已在本地（$(git rev-parse --short HEAD)），修好后重跑。"
fi
ok "全部校验通过"
if [ "$DO_PUSH" = 1 ]; then
  git push origin "$CUSTOM_BRANCH" && ok "已推送 origin/$CUSTOM_BRANCH"
  printf "\n打 tag（想要时）:  git tag -a 'v%s+cus.<x.y.z>' -m '...' && git push origin 'refs/tags/v%s+cus.<x.y.z>'\n" "$V1" "$V1"
else
  printf "\n未推送（干跑）。确认无误后:  scripts/sync-upstream.sh --push\n"
fi
[ "$SYNC" = 1 ] && printf "${YEL}部署提醒: 这次要 wrap-cli/sync。${RST}\n"
printf "部署机:  git fetch --tags origin && git checkout <tag或分支> && docker compose up -d --build\n"
