#!/usr/bin/env bash
set -uo pipefail
exec "${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin board-new-card --entrypoint new-card --placement popup --focus
