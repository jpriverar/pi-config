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

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
skills_parent="$repo/skills"
destination="$skills_parent/superpowers"
case "$destination" in
  "$repo/skills/superpowers") ;;
  *) echo "refusing unsafe destination: $destination" >&2; exit 1 ;;
esac
if [ -L "$destination" ]; then
  echo "refusing to replace symlink destination: $destination" >&2
  exit 1
fi

mkdir -p "$skills_parent"
tmp=$(mktemp -d)
staging=$(mktemp -d "$skills_parent/.superpowers.new.XXXXXX")
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
  safe_delete "$tmp" || true
  safe_delete "$staging" || true
  if [ -e "$backup" ]; then
    if [ -e "$destination" ]; then
      safe_delete "$backup" || true
    else
      echo "preserved previous vendor tree at $backup" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

git clone --depth 1 --branch "v$version" https://github.com/obra/superpowers.git "$tmp/superpowers"
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
if ! mv "$staging" "$destination"; then
  if [ -d "$backup" ] && [ ! -e "$destination" ]; then
    mv "$backup" "$destination"
  fi
  exit 1
fi
installed=1
safe_delete "$backup"

printf 'Superpowers v%s refreshed from https://github.com/obra/superpowers.git\n' "$version"
