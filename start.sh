#!/bin/sh
# Starts the app with the firewall port open, and closes the port when the app stops.
# Stop the app with Ctrl+C.
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
export PORT

if command -v firewall-cmd >/dev/null 2>&1 && [ "$(systemctl is-active firewalld 2>/dev/null)" = "active" ]; then
  # Not --permanent: the rule also disappears on reboot or firewall reload.
  sudo firewall-cmd --quiet --add-port="$PORT/tcp" && echo "Firewall: port $PORT opened."
  trap 'sudo firewall-cmd --quiet --remove-port="$PORT/tcp" && echo "Firewall: port $PORT closed."' EXIT
  trap 'exit 0' INT TERM HUP
fi

# Keep the laptop awake while the app runs.
if command -v systemd-inhibit >/dev/null 2>&1; then
  systemd-inhibit --what=sleep:idle:handle-lid-switch --who=VoteAttawhid --why="Vote counting in progress" node server.js
else
  node server.js
fi
