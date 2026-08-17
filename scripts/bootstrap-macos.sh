#!/bin/bash
set -euo pipefail

fail() {
  printf 'personal Pi bootstrap: %s\n' "$1" >&2
  exit 1
}

run_profile_command() {
  local command=$1
  node "$RECONCILER" "$command" --agent-dir "$AGENT_DIR" --repo-dir "$REPO_ROOT"
}

[ "$(uname -s)" = "Darwin" ] || fail "macOS is required"
command -v brew >/dev/null 2>&1 || fail "Homebrew is required before bootstrapping Pi"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel) || \
  fail "cannot resolve the bootstrap repository"
[ -f "$REPO_ROOT/package.json" ] || fail "repository package.json is missing: $REPO_ROOT"

brew list --formula volta >/dev/null 2>&1 || brew install volta
brew list --formula beads >/dev/null 2>&1 || brew install beads

export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$PATH"
volta install node@22.19.0
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.1

AGENT_DIR="$HOME/.pi/agent"
RECONCILER="$REPO_ROOT/scripts/reconcile-personal-profile.mjs"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

run_profile_command validate
run_profile_command settings

pi install "$REPO_ROOT"
pi install npm:pi-mcp-adapter@2.26.0
pi install npm:pi-subagents@0.50.0
pi install npm:context-mode@1.0.169
pi install npm:pi-markdown-preview@0.14.1
pi install npm:@juicesharp/rpiv-ask-user-question@2.6.1

run_profile_command settings
run_profile_command verify

NODE_VERSION=$(node --version)
[ "$NODE_VERSION" = "v22.19.0" ] || \
  fail "expected node version v22.19.0, got $NODE_VERSION"
PI_VERSION=$(pi --version)
[ "$PI_VERSION" = "0.84.1" ] || \
  fail "expected pi version 0.84.1, got $PI_VERSION"

mkdir -p "$HOME/beads"
(
  cd "$HOME/beads"
  bd init --init-if-missing --non-interactive --prefix jp
)

node "$RECONCILER" shell --zshrc "$HOME/.zshrc"

printf '\nNext steps:\n'
printf '  /login\n'
printf '  /reload\n'
printf '  cd %s && git pull --ff-only\n' "$REPO_ROOT"
printf '\nRepository HEAD:\n'
git -C "$REPO_ROOT" rev-parse HEAD
