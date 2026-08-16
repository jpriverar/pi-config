#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi
version=$1
if ! printf '%s\n' "$version" | rg -q '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "invalid Superpowers version: $version" >&2
  exit 2
fi

case "$version" in
  6.3.0)
    expected_tag=86babb696875227929e85420f287d6309374b93f
    expected_commit=b36e0829c6d0140e93cfef2ca599b1b07d4a7797
    ;;
  *)
    echo "unsupported Superpowers version: $version; add a reviewed version mapping first" >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
skills_parent="$repo/skills"
if [ -L "$skills_parent" ]; then
  echo "refusing symlinked skills parent: $skills_parent" >&2
  exit 1
fi
mkdir -p "$skills_parent"
canonical_skills_parent=$(CDPATH= cd -- "$skills_parent" && pwd -P)
if [ "$canonical_skills_parent" != "$skills_parent" ]; then
  echo "refusing non-canonical skills parent: $skills_parent" >&2
  exit 1
fi
skills_parent=$canonical_skills_parent
destination="$skills_parent/superpowers"
case "$destination" in
  "$repo/skills/superpowers") ;;
  *) echo "refusing unsafe destination: $destination" >&2; exit 1 ;;
esac
if [ -L "$destination" ]; then
  echo "refusing to replace symlink destination: $destination" >&2
  exit 1
fi

lock="$skills_parent/.superpowers.refresh.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Superpowers refresh already in progress: $lock" >&2
  exit 1
fi
lock_held=1
tmp=
staging=
backup="$skills_parent/.superpowers.old.$$"
installed=0

safe_delete() {
  path=$1
  case "$path" in
    /tmp/*|/var/folders/*|/private/var/folders/*|"$skills_parent/.superpowers.new."*|"$skills_parent/.superpowers.old."*)
      if [ -e "$path" ]; then
        find "$path" -depth -delete
      fi
      ;;
    *) echo "refusing unsafe cleanup: $path" >&2; return 1 ;;
  esac
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$installed" -eq 0 ] && [ -d "$backup" ] && [ ! -e "$destination" ]; then
    mv "$backup" "$destination"
  fi
  if [ -n "$tmp" ]; then safe_delete "$tmp" || true; fi
  if [ -n "$staging" ]; then safe_delete "$staging" || true; fi
  if [ -e "$backup" ]; then
    if [ -e "$destination" ]; then
      safe_delete "$backup" || true
    else
      echo "preserved previous vendor tree at $backup" >&2
    fi
  fi
  if [ "$lock_held" -eq 1 ]; then
    rmdir "$lock" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

tmp=$(mktemp -d)
staging=$(mktemp -d "$skills_parent/.superpowers.new.XXXXXX")
git \
  -c http.lowSpeedLimit=1024 \
  -c http.lowSpeedTime=30 \
  clone --depth 1 --branch "v$version" \
  https://github.com/obra/superpowers.git "$tmp/superpowers"
actual_tag=$(git -C "$tmp/superpowers" rev-parse "v$version")
actual_commit=$(git -C "$tmp/superpowers" rev-parse "v$version^{}")
if [ "$actual_tag" != "$expected_tag" ]; then
  echo "Superpowers v$version tag mismatch: expected $expected_tag, got $actual_tag" >&2
  exit 1
fi
if [ "$actual_commit" != "$expected_commit" ]; then
  echo "Superpowers v$version commit mismatch: expected $expected_commit, got $actual_commit" >&2
  exit 1
fi

test -f "$tmp/superpowers/LICENSE"
rg -q 'MIT License' "$tmp/superpowers/LICENSE"
test -d "$tmp/superpowers/skills"
find "$tmp/superpowers/skills" -name SKILL.md -type f | rg -q .

cp -Rp "$tmp/superpowers/skills/." "$staging/"
cp -p "$tmp/superpowers/LICENSE" "$staging/LICENSE"
diff -qr "$tmp/superpowers/skills" "$staging" -x LICENSE
cmp "$tmp/superpowers/LICENSE" "$staging/LICENSE"

if [ -e "$backup" ]; then
  echo "refusing existing backup path: $backup" >&2
  exit 1
fi
if [ -d "$destination" ]; then
  mv "$destination" "$backup"
elif [ -e "$destination" ]; then
  echo "refusing non-directory destination: $destination" >&2
  exit 1
fi
# POSIX cannot replace a non-empty directory in one reader-atomic rename. The
# writer lock serializes maintainers; readers may observe this tiny rename gap.
if ! mv "$staging" "$destination"; then
  if [ -d "$backup" ] && [ ! -e "$destination" ]; then
    mv "$backup" "$destination"
  fi
  exit 1
fi
installed=1
safe_delete "$backup"

printf 'Superpowers v%s refreshed from https://github.com/obra/superpowers.git\n' "$version"
