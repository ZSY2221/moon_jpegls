#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 ]]; then
  echo 'Usage: stream_pipeline.sh MOONJLS INPUT.pgm OUTPUT.jls RECONSTRUCTION.pgm' >&2
  exit 2
fi

cli=$1
input=$2
compressed=$3
reconstructed=$4

# noclobber protects the output opened by shell redirection; the CLI uses CreateNew.
set -o noclobber
"$cli" encode-pgm 0 "$input" - 257 |
  tee >("$cli" decode - "$reconstructed" pgm 127) > "$compressed"
wait "$!"
"$cli" verify "$compressed" 17
