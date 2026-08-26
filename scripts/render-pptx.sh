#!/bin/bash

set -o pipefail

program="render-pptx.sh"
manifest_name=".render-pptx-manifest"
manifest_magic="render-pptx-manifest-v1"
lock_name=".render-pptx.lock"
run_dir=""
lock_dir=""
backup_dir=""
publish_started=0
publish_complete=0
manifest_published=0
old_manifest_backed_up=0
published_files=()
previous_files=()

fail() {
  printf '%s: %s\n' "$program" "$1" >&2
  exit 1
}

contains_name() {
  local wanted=$1
  shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" == "$wanted" ]] && return 0
  done
  return 1
}

valid_owned_name() {
  [[ "$1" =~ ^page-[0-9]+\.png$ || "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$ ]]
}

check_physical_components() {
  local candidate=$1
  local current="/"
  local segment
  local old_ifs=$IFS
  IFS="/"
  read -r -a segments <<< "$candidate"
  IFS=$old_ifs
  for segment in "${segments[@]}"; do
    [[ -n "$segment" ]] || continue
    current="${current%/}/$segment"
    [[ ! -L "$current" ]] || fail "symlinked output ancestor is not allowed: $current"
    if [[ -e "$current" && ! -d "$current" ]]; then
      fail "output path component is not a directory: $current"
    fi
  done
}

prepare_output_directory() {
  local raw=$1
  local absolute
  [[ -n "$raw" && "$raw" != "." && "$raw" != ".." ]] || fail "refusing unsafe output directory: $raw"
  case "$raw" in
    //*) fail "refusing double-slash output path: $raw" ;;
  esac
  case "/$raw/" in
    */../*) fail "refusing root-equivalent or parent-traversing output path: $raw" ;;
  esac
  if [[ "$raw" == /* ]]; then
    absolute=$raw
  else
    absolute="$(pwd -P)/$raw"
  fi
  while [[ "$absolute" != "/" && "$absolute" == */ ]]; do absolute=${absolute%/}; done
  [[ "$absolute" != "/" ]] || fail "refusing root output directory"

  check_physical_components "$absolute"
  /bin/mkdir -p -- "$absolute" || fail "could not create output directory: $absolute"
  check_physical_components "$absolute"
  cd -P -- "$absolute" || fail "could not enter output directory: $absolute"
  output_dir=$(pwd -P)
  [[ "$output_dir" != "/" ]] || fail "refusing root output directory"
}

load_previous_manifest() {
  [[ ! -L "$manifest_name" ]] || fail "render manifest must not be a symbolic link"
  [[ -e "$manifest_name" ]] || return 0
  [[ -f "$manifest_name" ]] || fail "render manifest is not a regular file"

  local line
  local line_number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    if [[ $line_number -eq 1 ]]; then
      [[ "$line" == "$manifest_magic" ]] || fail "render manifest has an invalid header"
      continue
    fi
    [[ -n "$line" ]] || fail "render manifest contains an empty output name"
    valid_owned_name "$line" || fail "render manifest contains an unsafe output name: $line"
    contains_name "$line" "${previous_files[@]}" && fail "render manifest contains a duplicate output name: $line"
    [[ ! -L "$line" && -f "$line" ]] || fail "render manifest output is missing or unsafe: $line"
    previous_files+=("$line")
  done < "$manifest_name"
  [[ $line_number -gt 1 ]] || fail "render manifest contains no owned outputs"
}

rollback_publish() {
  local name
  if [[ $manifest_published -eq 1 && -f "$manifest_name" && ! -L "$manifest_name" ]]; then
    /bin/rm -f -- "$manifest_name"
  fi
  for name in "${published_files[@]}"; do
    if valid_owned_name "$name" && [[ -f "$name" && ! -L "$name" ]]; then
      /bin/rm -f -- "$name"
    fi
  done
  if [[ -n "$backup_dir" && -d "$backup_dir" && ! -L "$backup_dir" ]]; then
    for name in "${previous_files[@]}"; do
      if [[ -f "$backup_dir/$name" && ! -L "$backup_dir/$name" ]]; then
        /bin/mv -- "$backup_dir/$name" "$name" 2>/dev/null || true
      fi
    done
    if [[ $old_manifest_backed_up -eq 1 && -f "$backup_dir/$manifest_name" ]]; then
      /bin/mv -- "$backup_dir/$manifest_name" "$manifest_name" 2>/dev/null || true
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ $publish_started -eq 1 && $publish_complete -eq 0 ]]; then rollback_publish; fi
  if [[ -n "$run_dir" && -d "$run_dir" && ! -L "$run_dir" ]]; then
    /bin/rm -rf -- "$run_dir"
  fi
  if [[ -n "$lock_dir" && -d "$lock_dir" && ! -L "$lock_dir" ]]; then
    /bin/rm -f -- "$lock_dir/pid"
    /bin/rmdir -- "$lock_dir" 2>/dev/null || true
  fi
  exit "$status"
}

publish_run() {
  local new_manifest="$run_dir/$manifest_name"
  local name
  local source
  backup_dir="$run_dir/.previous"
  /bin/mkdir -- "$backup_dir" || fail "could not create render publish backup"

  for name in "${new_files[@]}"; do
    valid_owned_name "$name" || fail "renderer produced an unsafe output name: $name"
    if [[ -e "$name" || -L "$name" ]]; then
      contains_name "$name" "${previous_files[@]}" \
        || fail "refusing to overwrite unrelated output file: $output_dir/$name"
    fi
  done

  publish_started=1
  for name in "${previous_files[@]}"; do
    /bin/mv -- "$name" "$backup_dir/$name" || fail "could not stage previous render output: $name"
  done
  if [[ -f "$manifest_name" ]]; then
    /bin/mv -- "$manifest_name" "$backup_dir/$manifest_name" || fail "could not stage previous render manifest"
    old_manifest_backed_up=1
  fi
  for name in "${new_files[@]}"; do
    source="$run_dir/$name"
    /bin/mv -- "$source" "$name" || fail "could not publish render output: $name"
    published_files+=("$name")
  done
  /bin/mv -- "$new_manifest" "$manifest_name" || fail "could not publish render manifest"
  manifest_published=1
  publish_complete=1
  /bin/rm -rf -- "$backup_dir"
  backup_dir=""
}

if [[ $# -ne 2 ]]; then
  fail "usage: render-pptx.sh /path/to/deck.pptx /path/to/output-directory"
fi

input_file=$1
requested_output=$2

soffice_bin=$(command -v soffice 2>/dev/null) || fail "required tool 'soffice' was not found on PATH"
pdftoppm_bin=$(command -v pdftoppm 2>/dev/null) || fail "required tool 'pdftoppm' was not found on PATH"

if [[ "$input_file" != /* ]]; then input_file="$(pwd -P)/$input_file"; fi
[[ -f "$input_file" ]] || fail "input PPTX is not a file: $input_file"
case "$input_file" in
  *.[Pp][Pp][Tt][Xx]) ;;
  *) fail "input file must use the .pptx extension: $input_file" ;;
esac
input_name=${input_file##*/}
input_stem=${input_name%.*}
[[ "$input_stem" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fail "input PPTX filename must use safe characters: $input_name"

prepare_output_directory "$requested_output"
if ! /bin/mkdir -- "$lock_name" 2>/dev/null; then
  fail "render already in progress for output directory (lock exists): $output_dir"
fi
lock_dir="$output_dir/$lock_name"
trap cleanup EXIT
trap 'exit 130' INT TERM
printf '%s\n' "$$" > "$lock_dir/pid" || fail "could not record render lock owner"

load_previous_manifest
run_dir=$(/usr/bin/mktemp -d "$output_dir/.render-pptx.run.XXXXXX") \
  || fail "could not create isolated render directory"
[[ -d "$run_dir" && ! -L "$run_dir" ]] || fail "isolated render directory is unsafe"

pdf_name="$input_stem.pdf"
pdf_file="$run_dir/$pdf_name"
if ! "$soffice_bin" --headless --convert-to pdf --outdir "$run_dir" "$input_file"; then
  fail "LibreOffice conversion failed for: $input_file"
fi
[[ -s "$pdf_file" ]] || fail "LibreOffice did not produce the expected PDF: $pdf_file"

if ! "$pdftoppm_bin" -png -scale-to-x 1600 -scale-to-y -1 "$pdf_file" "$run_dir/page"; then
  fail "PNG rendering failed for: $pdf_file"
fi

shopt -s nullglob
rendered_pages=("$run_dir"/page-*.png)
((${#rendered_pages[@]})) || fail "PNG rendering produced no pages for: $pdf_file"
new_files=("$pdf_name")
for page in "${rendered_pages[@]}"; do
  [[ -s "$page" && ! -L "$page" ]] || fail "PNG rendering produced an empty or unsafe page: $page"
  page_name=${page##*/}
  valid_owned_name "$page_name" || fail "PNG renderer produced an unsafe page name: $page_name"
  new_files+=("$page_name")
done

{
  printf '%s\n' "$manifest_magic"
  printf '%s\n' "${new_files[@]}"
} > "$run_dir/$manifest_name" || fail "could not write render manifest"

publish_run
printf '%s\n' "$output_dir"
