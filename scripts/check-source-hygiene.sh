#!/bin/bash

set -u
set -o pipefail

root=${1:-.}
cd "$root" || exit 1

pattern=$(printf 'TO%s|TB%s|待%s|待%s' DO D 定 补)
search_status=0
if command -v rg >/dev/null 2>&1; then
  rg -n "$pattern" . --glob '!tests/fixtures/**' && search_status=0 || search_status=$?
else
  grep -R -n -I -E "$pattern" . --exclude-dir=.git --exclude-dir=fixtures \
    && search_status=0 || search_status=$?
fi
case "$search_status" in
  0)
    printf 'source hygiene: unfinished markers found\n' >&2
    exit 1
    ;;
  1) ;;
  *)
    printf 'source hygiene: source search failed with status %d\n' "$search_status" >&2
    exit 1
    ;;
esac

found=$(find . -path './.git' -prune -o -type f -size 0 -print)
if [[ -n "$found" ]]; then
  printf 'source hygiene: empty files found:\n%s\n' "$found" >&2
  exit 1
fi
found=$(find . -path './.git' -prune -o \( -name '.DS_Store' -o -name '__pycache__' -o -name '*.pyc' \) -print)
if [[ -n "$found" ]]; then
  printf 'source hygiene: residue found:\n%s\n' "$found" >&2
  exit 1
fi
found=$(git ls-files -- .superpowers)
if [[ -n "$found" ]]; then
  printf 'source hygiene: tracked .superpowers paths found:\n%s\n' "$found" >&2
  exit 1
fi
