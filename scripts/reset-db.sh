#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will TRUNCATE every demo table." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./scripts/reset-db.sh" >&2
	exit 1
fi

cd "$(dirname "$0")/.."
. scripts/reset-lib.sh

echo "Truncating demo tables..."
truncate_demo_tables

echo "Done! All tables are empty."
