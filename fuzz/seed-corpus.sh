#!/usr/bin/env bash
# Fills fuzz/corpus/<target>/ with small files from conformance/ and examples/datasets/. Run from
# anywhere; re-running adds only what is missing. The corpus is not committed (fuzz/.gitignore):
# the seeds are these files, and libFuzzer grows the rest.
set -euo pipefail
cd "$(dirname "$0")/.."
max=16384 # bytes: small seeds mutate faster
out=fuzz/corpus

put() { # put <target> <source file> <prefix byte as octal, or empty>
  local dir="$out/$1" name
  mkdir -p "$dir"
  name=$(printf '%s' "$2" | tr '/' '_')
  if [ -n "${3:-}" ]; then
    { printf "\\$3"; cat "$2"; } >"$dir/$name"
  else
    cp "$2" "$dir/$name"
  fi
}

selector() { # the parse_graph / detect_format selector byte for a file name
  case "$1" in
    *.jsonld) echo 001 ;; *.json) echo 000 ;; *.ttl) echo 002 ;; *.nt) echo 003 ;;
    *.nq) echo 004 ;; *.trig) echo 005 ;; *.owl | *.rdf) echo 006 ;; *.obo) echo 007 ;;
    *) echo 010 ;;
  esac
}

while IFS= read -r f; do
  base=$(basename "$f")
  case "$base" in
    *.ttl | *.nt | *.nq | *.trig | *.owl | *.rdf | *.obo | *.jsonld)
      put parse_graph "$f" "$(selector "$base")"
      put parse_graph "$f" 010 # auto-detection
      put detect_format "$f" 000
      ;;
    delta.json | delta.inverse.json) put delta "$f" "" ;;
    diff.json) put diff_from_json "$f" ""; put unpack_diff_json "$f" "" ;;
    diff.packed.json) put unpack_diff_json "$f" ""; put diff_from_json "$f" "" ;;
    before.json | after.json | graph.before.json | graph.after.json)
      put parse_graph "$f" 000
      put json_parse "$f" ""
      ;;
    *.json) put json_parse "$f" "" ;;
  esac
done < <(find conformance examples/datasets -type f -size -"${max}"c | LC_ALL=C sort)

# Before/after pairs for the diff target, joined with a NUL.
for before in $(find conformance/cases -name before.json -size -"${max}"c | LC_ALL=C sort); do
  after="$(dirname "$before")/after.json"
  [ -f "$after" ] || continue
  mkdir -p "$out/diff"
  { cat "$before"; printf '\0'; cat "$after"; } >"$out/diff/$(printf '%s' "$before" | tr '/' '_')"
done
find "$out" -type f | wc -l | xargs echo "seeds:"
