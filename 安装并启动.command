#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo "请先从 https://nodejs.org 安装 Node.js 24 或更高版本，再运行本文件。"
  read "?按回车退出…"
  exit 1
fi
npm ci --no-audit --no-fund
if [[ ! -f config.local.json ]]; then
  node cli.mjs setup
fi
node cli.mjs start
echo "工作台已启动。终端窗口可以关闭。"
