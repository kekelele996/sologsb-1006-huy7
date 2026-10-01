#!/usr/bin/env bash
# 端到端逻辑验证：打包 Node 测试脚本并运行（验证两端分立、译法冻结、对账回滚、交接包）
set -euo pipefail
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild scripts/_harness.mts \
  --bundle --platform=node --format=esm \
  --outfile=node_modules/.cache-verify-bundle.mjs --log-level=warning
node node_modules/.cache-verify-bundle.mjs
