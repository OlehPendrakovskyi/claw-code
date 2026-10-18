#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pinned packaging and publishing tools (roadmap REL-7). `pnpm exec` runs the installed package
# binaries (dev dependencies), so pass the binary name, not a version spec it cannot resolve.
# `vsce` alone would resolve the deprecated `vsce` package, not `@vscode/vsce`.
VSCE="vsce"
OVSX="ovsx"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

if [[ -z "${VSCE_PAT:-}" ]]; then
  echo "VSCE_PAT is not set. Add it to .env or export it." >&2
  exit 1
fi

if [[ -z "${OVSX_TOKEN:-}" ]]; then
  echo "OVSX_TOKEN is not set. Add it to .env or export it." >&2
  exit 1
fi

cd "${ROOT_DIR}"
echo "Running prepublish build..."
pnpm run vscode:prepublish

VERSION="$(node -p "require('./package.json').version")"
EXT_NAME="$(node -p "require('./package.json').name")"
VSIX_PATH="out/${EXT_NAME}-${VERSION}.vsix"

echo "Packaging VSIX to ${VSIX_PATH}..."
pnpm exec "${VSCE}" package --no-dependencies -o "${VSIX_PATH}"

echo "Publishing to VS Code Marketplace (vsce)..."
pnpm exec "${VSCE}" publish --packagePath "${VSIX_PATH}" -p "${VSCE_PAT}"

echo "Publishing to Open VSX (ovsx)..."
pnpm exec "${OVSX}" publish --packagePath "${VSIX_PATH}" -p "${OVSX_TOKEN}"

PUBLISHER="$(node -p "require('./package.json').publisher")"

echo "Publish complete."
echo "Summary:"
echo "VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.${EXT_NAME}"
echo "Open VSX: https://open-vsx.org/extension/${PUBLISHER}/${EXT_NAME}"
