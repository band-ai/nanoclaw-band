#!/usr/bin/env bash
# Preflight for /add-band: confirm the checkout carries the generic core seams
# the Band payload rides. Each seam is looked up by SYMBOL across its source
# tree, never by file path, so moving a seam between fork-owned and upstream
# files (src/channels/adapter.ts <-> src/fork/channel-adapter.ts, ...) cannot
# turn into a false "STOP". Run from the repo root.
#
# Exit 0 = every seam present; exit 1 = at least one missing (names printed).
set -u

missing=0
seam() { # <description> <symbol> <dir>...
  local desc=$1 symbol=$2
  shift 2
  if ! grep -rqF --include='*.ts' -- "$symbol" "$@" 2>/dev/null; then
    echo "MISSING: $desc ($symbol under: $*)"
    missing=1
  fi
}

seam "channel-migration registry" registerChannelMigrations src/db/migrations
seam "delivery-ack capability" supportsDeliveryAck src/channels src/fork
seam "graceful-stop capability" needsGracefulStop src/channels src/fork
seam "inbound route results" InboundRouteResult src/channels src/fork
seam "channel container-config registry" registerChannelContainerConfig src/channels
seam "agent-scoped container-config registry" registerAgentContainerConfig src/channels
seam "userVisibleTools contribution" userVisibleTools src/providers src/fork
seam "extra MCP servers contribution" mcpServers src/providers src/fork
seam "container lifecycle hooks" registerStopHook container/agent-runner/src
seam "extra MCP server assembly" addExtraMcpServers container/agent-runner/src

if [ "$missing" = 0 ]; then
  echo "seams: present — base is ready"
else
  echo "seams: STOP — base lacks the channel seams"
fi
exit "$missing"
