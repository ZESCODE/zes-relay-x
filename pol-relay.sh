#!/usr/bin/env bash
# pol-relay.sh - Start pol_relay.py with SKIP_AUTH enabled by default

# Set SKIP_AUTH to true unless already set
export POL_SKIP_AUTH="${POL_SKIP_AUTH:-true}"

# Optionally set a default port if not already set
export POL_RELAY_PORT="${POL_RELAY_PORT:-7179}"

# Optionally set upstream base and API key if needed
# export POL_UPSTREAM_BASE="https://gen.pollinations.ai/v1"
# export POL_API_KEY="your-key-here"

# Start the relay
echo "Starting POL relay with POL_SKIP_AUTH=$POL_SKIP_AUTH on port $POL_RELAY_PORT"
exec python3 pol_relay.py "$@"