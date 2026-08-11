#!/usr/bin/env bash
# install.sh — install the /eye skill into Claude Code (user scope, WSL side).
# After this, ANY Claude Code session in any project can join the Eye by
# typing /eye (or being asked to "connect to the eye").
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/eye"

mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"

echo "Installed /eye skill -> $DEST/SKILL.md"
echo "Open any Claude Code session and type /eye to join the Eye."
