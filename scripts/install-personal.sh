#!/usr/bin/env bash
# 把 dsh-msg9-kit 安装进本机个人 dsh 的 web profile（官方 dsh plugin add 路径）。
# 前置：已在插件目录构建（npm run build），dsh 在 PATH。
set -euo pipefail

# 从脚本位置向上找到 name=dsh-msg9-kit 的 package.json，因此脚本在
# monorepo 或独立仓库布局里都能运行。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR=""
DIR="$SCRIPT_DIR"
while [[ "$DIR" != "/" ]]; do
  if [[ -f "$DIR/package.json" ]] && grep -q '"dsh-msg9-kit"' "$DIR/package.json"; then
    PLUGIN_DIR="$DIR"
    break
  fi
  DIR="$(dirname "$DIR")"
done

if [[ -z "$PLUGIN_DIR" ]]; then
  echo "错误：找不到插件目录（本脚本需位于 dsh-msg9-kit 目录内）" >&2
  exit 1
fi

if [[ ! -f "$PLUGIN_DIR/lib/index.js" ]]; then
  echo "错误：未找到构建产物 lib/index.js，请先在插件目录执行 npm install && npm run build" >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误：未找到 dsh，请先安装 @deepseek-ai/dsh" >&2
  exit 1
fi

echo "安装 dsh-msg9-kit 到 web profile（${DSH_HOME:-$HOME/.dsh}/profiles/web）"
dsh plugin --profile web add "$PLUGIN_DIR"

echo
echo "校验组合树（打印包含 msg9-kit 的行）："
dsh --profile web --dump-config | grep -n "msg9-kit" || true

echo
echo "安装完成。重启 dsh web 后生效，然后："
echo "  · 侧栏底部面板行点 ✉ 图标 —— 看当前 workspace 的收件箱 / 发件箱 / 联系人"
echo "  · 在会话里让 agent 调用 msg9_inbox（首次会自动开通该 workspace 的收件箱）"
echo "  · 或输入 /msg9 查看当前身份与已登记的 workspace 收件箱"
