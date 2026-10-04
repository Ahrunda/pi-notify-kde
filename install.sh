#!/bin/sh
# Install (or re-sync) notify-kde as a plain file in the pi extensions directory.
#
#   ./install.sh
#
# The previous file, if any, is copied to notify-kde.ts.bak first.
# Undo:  rm ~/.pi/agent/extensions/notify-kde.ts
# Respects PI_AGENT_DIR if you keep your pi state somewhere else.
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dir="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"
dst="$dir/notify-kde.ts"

mkdir -p "$dir"

if [ -f "$dst" ]; then
	cp "$dst" "$dst.bak"
	echo "previous file backed up -> $dst.bak"
fi

cp "$here/extensions/notify-kde.ts" "$dst"
echo "installed -> $dst"
echo
echo "next: run '/notify-kde test' inside pi, or restart pi, to load it."
echo "config: ~/.pi/agent/notify-kde.json    log: ~/.cache/pi/notify-kde.log"
