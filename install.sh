#!/bin/sh
set -eu
tool_source_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec node "$tool_source_dir/scripts/install.mjs" "$@"
