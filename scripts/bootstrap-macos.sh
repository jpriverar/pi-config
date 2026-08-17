#!/bin/bash
set -euo pipefail

fail() {
  printf 'personal Pi bootstrap: %s\n' "$1" >&2
  exit 1
}

run_step() {
  local step=$1
  shift
  "$@" >/dev/null || fail "$step failed"
}

run_profile_command() {
  local command=$1
  node "$RECONCILER" "$command" --agent-dir "$AGENT_DIR" --repo-dir "$REPO_ROOT"
}

check_agent_dir_preflight() {
  if [ -L "$AGENT_DIR" ]; then
    fail "Cannot use symlinked personal Pi agent directory at $AGENT_DIR"
  fi

  if [ -e "$AGENT_DIR" ] && [ ! -d "$AGENT_DIR" ]; then
    fail "Cannot use non-directory personal Pi agent directory at $AGENT_DIR"
  fi
}

check_settings_preflight() {
  local file_path=$1
  local package_count
  local package_index
  local source
  local work_marker=data

  [ -f "$file_path" ] || return 0

  /usr/bin/plutil -convert json -o - "$file_path" >/dev/null 2>&1 ||
    fail "Cannot parse personal Pi settings at $file_path"

  work_marker="${work_marker}dog"
  package_count=$(
    /usr/bin/plutil -extract packages raw -expect array -o - "$file_path" \
      2>/dev/null
  ) || return 0

  package_index=0
  while [ "$package_index" -lt "$package_count" ]; do
    if ! source=$(
      /usr/bin/plutil -extract "packages.$package_index" raw -expect string -o - \
        "$file_path" 2>/dev/null
    ); then
      package_index=$((package_index + 1))
      continue
    fi

    if [ "$source" = "$REPO_ROOT" ]; then
      package_index=$((package_index + 1))
      continue
    fi

    case "$source" in
      npm:*|git:github.com/*|https://github.com/*)
        case "$source" in
          *"$work_marker"*)
            fail "Forbidden work-only package source at package index $package_index in $file_path"
            ;;
        esac
        ;;
      *)
        fail "Unsupported local package source at package index $package_index in $file_path"
        ;;
    esac

    package_index=$((package_index + 1))
  done
}

check_mcp_preflight() {
  local file_path=$1
  local file_json
  local work_marker=data

  [ -f "$file_path" ] || return 0

  work_marker="${work_marker}dog"
  file_json=$(
    /usr/bin/plutil -convert json -o - "$file_path" 2>/dev/null
  ) || fail "Cannot parse personal Pi MCP configuration at $file_path"
  case "$file_json" in
    *"$work_marker"*) fail "Forbidden work-only MCP configuration at $file_path" ;;
  esac
}

run_profile_preflight() {
  check_agent_dir_preflight
  check_settings_preflight "$AGENT_DIR/settings.json"
  check_mcp_preflight "$AGENT_DIR/mcp.json"
}

ensure_formula() {
  local formula=$1

  if ! brew list --formula "$formula" >/dev/null 2>&1; then
    run_step "Homebrew install $formula" brew install "$formula"
  fi
}

snapshot_settings() {
  SETTINGS_PATH="$AGENT_DIR/settings.json"
  SETTINGS_SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/personal-pi-settings.XXXXXX") ||
    fail "cannot create settings snapshot"

  if [ -f "$SETTINGS_PATH" ]; then
    SETTINGS_EXISTED=1
    cp "$SETTINGS_PATH" "$SETTINGS_SNAPSHOT" ||
      fail "cannot snapshot settings at $SETTINGS_PATH"
    return
  fi

  SETTINGS_EXISTED=0
}

cleanup_settings_snapshot() {
  if [ -n "${SETTINGS_SNAPSHOT:-}" ] && [ -e "$SETTINGS_SNAPSHOT" ]; then
    rm -f "$SETTINGS_SNAPSHOT" ||
      fail "cannot remove settings snapshot $SETTINGS_SNAPSHOT"
  fi
}

restore_settings() {
  if [ "$SETTINGS_EXISTED" -eq 1 ]; then
    cp "$SETTINGS_SNAPSHOT" "$SETTINGS_PATH" ||
      fail "cannot restore settings at $SETTINGS_PATH"
  elif [ -f "$SETTINGS_PATH" ]; then
    rm -f "$SETTINGS_PATH" ||
      fail "cannot remove settings at $SETTINGS_PATH"
  fi

  cleanup_settings_snapshot
}

reconcile_packages() {
  local source

  run_step "settings reconciliation" run_profile_command settings
  run_step "Pi install $REPO_ROOT" pi install "$REPO_ROOT"

  for source in \
    "npm:pi-mcp-adapter@2.26.0" \
    "npm:pi-subagents@0.50.0" \
    "npm:context-mode@1.0.169" \
    "npm:pi-markdown-preview@0.14.1" \
    "npm:@juicesharp/rpiv-ask-user-question@2.6.1"
  do
    run_step "Pi install $source" pi install "$source"
  done

  run_step "settings reconciliation" run_profile_command settings
  run_step "package verification" run_profile_command verify
}

[ "$(uname -s)" = "Darwin" ] || fail "macOS is required"
command -v brew >/dev/null 2>&1 || fail "Homebrew is required before bootstrapping Pi"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel) || \
  fail "cannot resolve the bootstrap repository"
[ -f "$REPO_ROOT/package.json" ] || fail "repository package.json is missing: $REPO_ROOT"

AGENT_DIR="$HOME/.pi/agent"
RECONCILER="$REPO_ROOT/scripts/reconcile-personal-profile.mjs"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

run_profile_preflight
ensure_formula volta
ensure_formula beads

export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$PATH"
run_step "Volta install node@22.19.0" volta install node@22.19.0
run_step "npm install @earendil-works/pi-coding-agent@0.84.1" \
  npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.1

run_step "profile validation" run_profile_command validate
snapshot_settings
if ! (reconcile_packages); then
  restore_settings
  exit 1
fi
cleanup_settings_snapshot

NODE_VERSION=$(node --version)
[ "$NODE_VERSION" = "v22.19.0" ] || \
  fail "expected node version v22.19.0, got $NODE_VERSION"
PI_VERSION=$(pi --version)
[ "$PI_VERSION" = "0.84.1" ] || \
  fail "expected pi version 0.84.1, got $PI_VERSION"

mkdir -p "$HOME/beads"
(
  cd "$HOME/beads"
  run_step "Beads initialization" \
    bd init --init-if-missing --non-interactive --prefix jp
)

run_step "shell reconciliation" \
  node "$RECONCILER" shell --zshrc "$HOME/.zshrc"

printf '\nNext steps:\n'
printf '  1. start a new shell or source ~/.zshrc\n'
printf '  2. launch pi\n'
printf '  3. run /login and choose a personal provider\n'
printf '  4. configure personal MCP servers later if desired\n'
printf '  5. use git pull --ff-only in this checkout and /reload to consume future code/resource updates\n'
printf '\nRepository HEAD:\n'
git -C "$REPO_ROOT" rev-parse HEAD
