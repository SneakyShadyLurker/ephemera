#!/usr/bin/env bash
# Writes the next migration for apps/server/src/persistence/schema.ts with
# drizzle-kit on demand (not a dependency). It runs outside the workspace:
# inside it npx finds the workspace's drizzle-orm and skips installing its
# own, which drizzle-kit then cannot import across Bun's isolated layout.
# Usage: bun run db:generate -- --name <migration_name>
set -euo pipefail

server="$(cd "$(dirname "$0")/../apps/server" && pwd)"
# The drizzle-orm the lockfile installed, so migrations follow the server's ORM.
orm="$(cd "$server" && bun -p 'require("drizzle-orm/package.json").version')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ln -s "$server/drizzle" "$work/drizzle"
cat >"$work/drizzle.config.ts" <<EOF
export default {
  dialect: "sqlite",
  schema: "$server/src/persistence/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
};
EOF

cd "$work"
npx --yes -p drizzle-kit@0.31.11 -p "drizzle-orm@$orm" drizzle-kit generate --config ./drizzle.config.ts "$@"
