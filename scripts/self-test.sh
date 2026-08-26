#!/bin/bash

set -u
set -o pipefail
export PYTHONDONTWRITEBYTECODE=1

program="self-test.sh"
skill_root=$(cd "$(dirname "$0")/.." && pwd -P)
release_mode=0
list_stages=0
development_stages=(
  runtime-validation
  source-policy
  source-hygiene
  official-validation
  node-tests
  python-tests
  style-previews
  deck-parity
  html-build
  html-validation
  html-screenshots
  html-contact-sheet
  pptx-build
  pptx-render
  pptx-contact-sheet
)
release_stages=(
  runtime-validation
  source-policy
  source-hygiene
  official-validation
  installed-link
  installed-policy
  installed-validation
  clean-git-tree
  node-tests
  python-tests
  style-previews
  deck-parity
  html-build
  html-validation
  html-screenshots
  html-contact-sheet
  pptx-build
  pptx-render
  pptx-contact-sheet
  final-source-policy
  final-source-hygiene
  final-installed-link
  final-installed-policy
  final-installed-validation
  final-clean-git-tree
)

for argument in "$@"; do
  case "$argument" in
    --release) release_mode=1 ;;
    --list-stages) list_stages=1 ;;
    *) printf '%s: usage: bash scripts/self-test.sh [--release] [--list-stages]\n' "$program" >&2; exit 2 ;;
  esac
done
if [[ $release_mode -eq 1 ]]; then stages=("${release_stages[@]}"); else stages=("${development_stages[@]}"); fi
if [[ $list_stages -eq 1 ]]; then
  printf '%s\n' "${stages[@]}"
  exit 0
fi

dependency_output=""
if command -v load_workspace_dependencies >/dev/null 2>&1; then
  dependency_output=$(load_workspace_dependencies 2>/dev/null || true)
fi

dependency_path() {
  local pattern=$1
  printf '%s\n' "$dependency_output" | sed -n "s#.*\(/[^[:space:]\"']*$pattern\).*#\1#p" | head -n 1
}

runtime_root=${CODEX_RUNTIME_ROOT:-}
tool_path_overridden=0
[[ -n ${RENDER_TOOL_PATH:-} ]] && tool_path_overridden=1

node_bin=${node:-${NODE:-}}
python_bin=${python3:-${PYTHON:-}}
node_path=${NODE_PATH:-}
tool_path=${RENDER_TOOL_PATH:-}

if [[ -z "$node_bin" ]]; then node_bin=$(dependency_path '/node/bin/node'); fi
if [[ -z "$python_bin" ]]; then python_bin=$(dependency_path '/python/bin/python3'); fi
if [[ -z "$node_path" ]]; then node_path=$(dependency_path '/node/node_modules'); fi
if [[ -z "$tool_path" ]]; then tool_path=$(dependency_path '/bin/override'); fi

if [[ -n "$runtime_root" && -z "$node_bin" && -x "$runtime_root/node/bin/node" ]]; then node_bin="$runtime_root/node/bin/node"; fi
if [[ -n "$runtime_root" && -z "$python_bin" && -x "$runtime_root/python/bin/python3" ]]; then python_bin="$runtime_root/python/bin/python3"; fi
if [[ -z "$node_path" && -d "$skill_root/node_modules" ]]; then node_path="$skill_root/node_modules"; fi
if [[ -n "$runtime_root" && -z "$tool_path" && -d "$runtime_root/bin/override" ]]; then tool_path="$runtime_root/bin/override"; fi
if [[ -z "$node_bin" ]]; then node_bin=$(command -v node 2>/dev/null || true); fi
if [[ -z "$python_bin" ]]; then python_bin=$(command -v python3 2>/dev/null || true); fi

yaml_python="$python_bin"
yaml_pythonpath=${PYTHON_YAML_PATH:-${PYTHONPATH:-}}
if [[ -x "$yaml_python" ]] && ! env PYTHONPATH="$yaml_pythonpath" "$yaml_python" -c 'import yaml' >/dev/null 2>&1; then
  printf '%s: YAML support is unavailable; install PyYAML or set PYTHON_YAML_PATH\n' "$program" >&2
fi

creator=${SKILL_CREATOR:-}
if [[ -z "$creator" && -n ${CODEX_HOME:-} && -d "$CODEX_HOME/skills/.system/skill-creator" ]]; then
  creator="$CODEX_HOME/skills/.system/skill-creator"
fi
if [[ -z "$creator" && -d "$HOME/.codex/skills/.system/skill-creator" ]]; then
  creator="$HOME/.codex/skills/.system/skill-creator"
fi
quick_validate="$creator/scripts/quick_validate.py"

raw_temp_root=${SELF_TEST_TEMP_ROOT:-}
if [[ -z "$raw_temp_root" && -d /private/tmp && ! -L /private/tmp ]]; then
  raw_temp_root=/private/tmp
fi
if [[ -z "$raw_temp_root" && -x "$python_bin" ]]; then
  raw_temp_root=$("$python_bin" -c 'import os, tempfile; print(os.path.realpath(tempfile.gettempdir()))' 2>/dev/null || true)
fi
if [[ -z "$raw_temp_root" ]]; then
  raw_temp_root=${TMPDIR:-/tmp}
fi

temp_root=""
if [[ "$raw_temp_root" == /* && -d "$raw_temp_root" && ! -L "$raw_temp_root" ]]; then
  logical_temp=$(cd "$raw_temp_root" 2>/dev/null && pwd -L)
  physical_temp=$(cd "$raw_temp_root" 2>/dev/null && pwd -P)
  if [[ "$logical_temp" == "$physical_temp" ]]; then temp_root=$physical_temp; fi
fi
if [[ -z "$temp_root" ]]; then
  printf '%s: temporary root must be an existing physical absolute directory: %s\n' "$program" "$raw_temp_root" >&2
  exit 1
fi

work_root=$(/usr/bin/mktemp -d "$temp_root/sherry-skill-self-test.XXXXXX") || exit 1
cleanup() {
  case "$work_root" in
    "$temp_root"/sherry-skill-self-test.*)
      [[ -d "$work_root" && ! -L "$work_root" ]] && /bin/rm -rf -- "$work_root"
      ;;
  esac
}
on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup
  exit "$rc"
}
on_signal() {
  local rc=$1
  trap - EXIT INT TERM
  cleanup
  exit "$rc"
}
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

preview_root="$work_root/style-previews"
html_file="$work_root/deck.html"
html_pages="$work_root/html-pages"
html_diagnostics="$work_root/html-diagnostics.json"
html_sheet="$work_root/html-contact-sheet.png"
parity_manifest="$work_root/parity-manifest.json"
pptx_file="$work_root/deck.pptx"
pptx_pages="$work_root/pptx-pages"
pptx_diagnostics="$work_root/pptx-diagnostics.json"
pptx_sheet="$work_root/pptx-contact-sheet.png"
run_bin="$work_root/run-bin"
passed=0
failed=0
attempted=0

run_stage() {
  local name=$1
  shift
  attempted=$((attempted + 1))
  printf 'RUN  %s\n' "$name"
  if "$@"; then
    printf 'PASS %s\n' "$name"
    passed=$((passed + 1))
    return 0
  fi
  printf 'FAIL %s\n' "$name" >&2
  failed=$((failed + 1))
  printf 'SUMMARY PASS=%d FAIL=%d ATTEMPTED=%d TOTAL=%d\n' "$passed" "$failed" "$attempted" "${#stages[@]}"
  return 1
}

runtime_validation() {
  [[ -n "$node_bin" && -x "$node_bin" ]] || { printf 'runtime validation: Node executable is unavailable: %s\n' "$node_bin" >&2; return 1; }
  [[ -n "$python_bin" && -x "$python_bin" ]] || { printf 'runtime validation: Python executable is unavailable: %s\n' "$python_bin" >&2; return 1; }
  [[ -n "$node_path" ]] || { printf 'runtime validation: Node modules path is unavailable\n' >&2; return 1; }
  if ! env NODE_PATH="$node_path" "$node_bin" -e 'require.resolve("playwright"); require.resolve("pptxgenjs")' >/dev/null 2>&1; then
    printf 'runtime validation: Node modules must resolve Playwright and PptxGenJS from NODE_PATH=%s\n' "$node_path" >&2
    return 1
  fi
  if [[ $tool_path_overridden -eq 1 ]]; then
    soffice_bin="$tool_path/soffice"
    pdftoppm_bin="$tool_path/pdftoppm"
  else
    soffice_bin=""
    pdftoppm_bin=""
    [[ -x "$tool_path/soffice" ]] && soffice_bin="$tool_path/soffice"
    [[ -x "$tool_path/pdftoppm" ]] && pdftoppm_bin="$tool_path/pdftoppm"
    [[ -n "$soffice_bin" ]] || soffice_bin=$(command -v soffice 2>/dev/null || true)
    [[ -n "$pdftoppm_bin" ]] || pdftoppm_bin=$(command -v pdftoppm 2>/dev/null || true)
  fi
  if [[ ! -x "$soffice_bin" || ! -x "$pdftoppm_bin" ]]; then
    printf 'runtime validation: render tools soffice and pdftoppm must be executable in %s\n' "$tool_path" >&2
    return 1
  fi
  soffice_bin=$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$soffice_bin")
  pdftoppm_bin=$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$pdftoppm_bin")
  if [[ ! -x "$soffice_bin" || ! -x "$pdftoppm_bin" ]]; then
    printf 'runtime validation: resolved render tool targets must remain executable\n' >&2
    return 1
  fi
  printf -v soffice_command '%q' "$soffice_bin"
  printf -v pdftoppm_command '%q' "$pdftoppm_bin"
  soffice_wrapper_line="exec $soffice_command \"\$@\""
  pdftoppm_wrapper_line="exec $pdftoppm_command \"\$@\""
  /bin/mkdir -m 700 "$run_bin" || return 1
  printf '#!/bin/bash\n%s\n' "$soffice_wrapper_line" > "$run_bin/soffice" || return 1
  printf '#!/bin/bash\n%s\n' "$pdftoppm_wrapper_line" > "$run_bin/pdftoppm" || return 1
  /bin/chmod 700 "$run_bin/soffice" "$run_bin/pdftoppm" || return 1
  [[ -x "$yaml_python" ]] && env PYTHONPATH="$yaml_pythonpath" "$yaml_python" -c 'import yaml' >/dev/null 2>&1 \
    || { printf 'runtime validation: no YAML-capable Python is available\n' >&2; return 1; }
  [[ -f "$quick_validate" ]] || { printf 'runtime validation: official validator is unavailable: %s\n' "$quick_validate" >&2; return 1; }
}

validate_render_targets() {
  [[ -x "$soffice_bin" && -x "$pdftoppm_bin" ]] \
    || { printf 'render tools are no longer executable\n' >&2; return 1; }
  [[ -f "$run_bin/soffice" && ! -L "$run_bin/soffice" && -x "$run_bin/soffice" ]] \
    && /usr/bin/cmp -s "$run_bin/soffice" <(printf '#!/bin/bash\n%s\n' "$soffice_wrapper_line") \
    || { printf 'approved soffice run wrapper changed\n' >&2; return 1; }
  [[ -f "$run_bin/pdftoppm" && ! -L "$run_bin/pdftoppm" && -x "$run_bin/pdftoppm" ]] \
    && /usr/bin/cmp -s "$run_bin/pdftoppm" <(printf '#!/bin/bash\n%s\n' "$pdftoppm_wrapper_line") \
    || { printf 'approved pdftoppm run wrapper changed\n' >&2; return 1; }
}

check_policy() {
  local yaml_file=$1
  env PYTHONPATH="$yaml_pythonpath" "$yaml_python" -c '
import pathlib, sys, yaml
path = pathlib.Path(sys.argv[1])
data = yaml.safe_load(path.read_text(encoding="utf-8"))
if not isinstance(data, dict) or data.get("policy", {}).get("allow_implicit_invocation") is not False:
    raise SystemExit(f"{path}: policy.allow_implicit_invocation must be exactly false")
' "$yaml_file"
}

source_hygiene() {
  /bin/bash scripts/check-source-hygiene.sh "$skill_root"
}

installed_link() {
  [[ -L "$install_target" ]] || { printf 'installed link is missing or not a symlink: %s\n' "$install_target" >&2; return 1; }
  [[ -e "$install_target" ]] || { printf 'dangling install target: %s\n' "$install_target" >&2; return 1; }
  [[ "$(readlink "$install_target")" == "$skill_root" ]] \
    || { printf 'installed link must point exactly to %s\n' "$skill_root" >&2; return 1; }
  [[ "$(cd "$install_target" && pwd -P)" == "$skill_root" ]] \
    || { printf 'installed link resolves to the wrong source\n' >&2; return 1; }
}

clean_git_tree() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { printf 'working tree is not a Git checkout\n' >&2; return 1; }
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] \
    || { printf 'working tree is not clean\n' >&2; git status --short >&2; return 1; }
}

render_previews() {
  SKILL_ROOT="$skill_root" OUTPUT_ROOT="$preview_root" NODE_PATH="$node_path" "$node_bin" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    import { renderStylePreviews } from "./scripts/generate-style-previews.mjs";
    await renderStylePreviews({ skillRoot: process.env.SKILL_ROOT, outputRoot: process.env.OUTPUT_ROOT });
    const files = fs.readdirSync(process.env.OUTPUT_ROOT)
      .map((name) => path.join(process.env.OUTPUT_ROOT, name, "preview.png"))
      .filter((file) => fs.existsSync(file) && fs.statSync(file).size >= 10000);
    if (files.length !== 6) throw new Error(`Expected six style previews, found ${files.length}`);
  '
}

count_pngs() {
  local directory=$1
  local expected=$2
  local count
  count=$(find "$directory" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')
  [[ "$count" == "$expected" ]]
}

build_html() {
  NODE_PATH="$node_path" "$node_bin" scripts/build-single-html.mjs \
    --project tests/fixtures/html-project --output "$html_file"
}
verify_parity() {
  NODE_PATH="$node_path" "$node_bin" scripts/verify-deck-parity.mjs \
    --project tests/fixtures/parity-project --manifest "$parity_manifest" \
    && "$node_bin" -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value.ok !== true || value.slideCount !== 2 || value.slides.length !== 2) process.exit(1);
    ' "$parity_manifest"
}
validate_html() { NODE_PATH="$node_path" "$node_bin" scripts/validate-html.mjs "$html_file"; }
render_html() {
  NODE_PATH="$node_path" "$node_bin" scripts/render-screenshots.mjs \
    --html "$html_file" --output "$html_pages" > "$html_diagnostics" \
    && count_pngs "$html_pages" 3 \
    && "$node_bin" -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value.length !== 3 || value.some((page) => page.blank || page.blankRatio >= 0.9995
        || page.overflow.length || page.clipped.length || page.imageFailures.length)) process.exit(1);
    ' "$html_diagnostics"
}
make_html_sheet() {
  "$python_bin" scripts/make-contact-sheet.py --input "$html_pages" --output "$html_sheet" \
    --columns 2 && [[ -s "$html_sheet" ]]
}
build_pptx() {
  NODE_PATH="$node_path" "$node_bin" scripts/build-pptx.mjs \
    --model tests/fixtures/deck-model.json --style ai-research-journal --output "$pptx_file"
}
render_pptx() {
  validate_render_targets \
    && PATH="$run_bin${PATH:+:$PATH}" /bin/bash scripts/render-pptx.sh "$pptx_file" "$pptx_pages" \
    && count_pngs "$pptx_pages" 12 \
    && "$node_bin" scripts/inspect-rendered-pages.mjs "$pptx_pages"/page-*.png > "$pptx_diagnostics" \
    && "$node_bin" -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value.ok !== true || value.pageCount !== 12
        || value.pages.some((page) => page.contentRatio <= 0.0015 || page.colorBucketCount < 2)) process.exit(1);
    ' "$pptx_diagnostics"
}
make_pptx_sheet() {
  "$python_bin" scripts/make-contact-sheet.py --input "$pptx_pages" --output "$pptx_sheet" \
    --columns 3 && [[ -s "$pptx_sheet" ]]
}

install_target=${SKILL_INSTALL_TARGET:-${CODEX_HOME:-$HOME/.codex}/skills/sherry-skillforhtml2026}
cd "$skill_root" || exit 1
run_stage runtime-validation runtime_validation || exit 1
run_stage source-policy check_policy "$skill_root/agents/openai.yaml" || exit 1
run_stage source-hygiene source_hygiene || exit 1
run_stage official-validation env PYTHONPATH="$yaml_pythonpath" "$yaml_python" "$quick_validate" . || exit 1
if [[ $release_mode -eq 1 ]]; then
  run_stage installed-link installed_link || exit 1
  run_stage installed-policy check_policy "$install_target/agents/openai.yaml" || exit 1
  run_stage installed-validation env PYTHONPATH="$yaml_pythonpath" "$yaml_python" "$quick_validate" "$install_target" || exit 1
  run_stage clean-git-tree clean_git_tree || exit 1
fi
run_stage node-tests env PYTHONDONTWRITEBYTECODE=1 NODE_PATH="$node_path" RENDER_TOOL_PATH="$tool_path" "$node_bin" --test tests/*.test.mjs || exit 1
run_stage python-tests env PYTHONDONTWRITEBYTECODE=1 "$python_bin" -m unittest discover -s tests -p 'test_*.py' -v || exit 1
run_stage style-previews render_previews || exit 1
run_stage deck-parity verify_parity || exit 1
run_stage html-build build_html || exit 1
run_stage html-validation validate_html || exit 1
run_stage html-screenshots render_html || exit 1
run_stage html-contact-sheet make_html_sheet || exit 1
run_stage pptx-build build_pptx || exit 1
run_stage pptx-render render_pptx || exit 1
run_stage pptx-contact-sheet make_pptx_sheet || exit 1
if [[ $release_mode -eq 1 ]]; then
  run_stage final-source-policy check_policy "$skill_root/agents/openai.yaml" || exit 1
  run_stage final-source-hygiene source_hygiene || exit 1
  run_stage final-installed-link installed_link || exit 1
  run_stage final-installed-policy check_policy "$install_target/agents/openai.yaml" || exit 1
  run_stage final-installed-validation env PYTHONPATH="$yaml_pythonpath" "$yaml_python" "$quick_validate" "$install_target" || exit 1
  run_stage final-clean-git-tree clean_git_tree || exit 1
fi

printf 'SUMMARY PASS=%d FAIL=%d TOTAL=%d\n' "$passed" "$failed" "${#stages[@]}"
