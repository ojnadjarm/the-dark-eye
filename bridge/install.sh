#!/usr/bin/env bash
# install.sh — wire The Dark Eye into this machine: the `eye` client on PATH,
# the /eye skill for every Claude session, and the body's systemd user service.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SRC/.." && pwd)"
BIN="$HOME/.local/bin"
SKILL="$HOME/.claude/skills/eye"
UNITS="$HOME/.config/systemd/user"
WPCONF="$HOME/.config/wireplumber/wireplumber.conf.d"
UDEV=/etc/udev/rules.d/90-dark-eye-ptt.rules

mkdir -p "$BIN" "$SKILL" "$UNITS" "$WPCONF"
ln -sfn "$SRC/eye.sh" "$BIN/eye"
ln -sfn "$SRC/SKILL.md" "$SKILL/SKILL.md"
ln -sfn "$REPO/body/dark-eye.service" "$UNITS/dark-eye.service"
ln -sfn "$REPO/body/dark-eye-failed.service" "$UNITS/dark-eye-failed.service"
ln -sfn "$REPO/body/dark-eye-ptt.service" "$UNITS/dark-eye-ptt.service"
systemctl --user daemon-reload
systemctl --user enable dark-eye.service
systemctl --user enable dark-eye-ptt.service

# mpris-proxy hands AVRCP to BlueZ over D-Bus, so the earbud keys never reach the
# evdev node the push-to-talk sidecar reads. It has to be stopped and masked.
systemctl --user stop mpris-proxy.service 2>/dev/null || true
systemctl --user mask mpris-proxy.service

# The sidecar needs the AVRCP node and /dev/uinput without sudo.
if ! sed "s/@USER@/$USER/g" "$REPO/body/linux/90-dark-eye-ptt.rules" | cmp -s - "$UDEV"; then
  sed "s/@USER@/$USER/g" "$REPO/body/linux/90-dark-eye-ptt.rules" | sudo tee "$UDEV" >/dev/null
  sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=input --subsystem-match=misc
fi

# WirePlumber: no HFP autoswitch, no fake call on the buds (see the drop-in). A
# WirePlumber restart drops the buds' A2DP/AVRCP links; reconnecting brings them back.
if [ ! "$WPCONF/50-dark-eye-ptt.conf" -ef "$REPO/body/linux/50-dark-eye-ptt.conf" ]; then
  ln -sfn "$REPO/body/linux/50-dark-eye-ptt.conf" "$WPCONF/50-dark-eye-ptt.conf"
  systemctl --user restart wireplumber.service
  sleep 3
  bluetoothctl devices Connected | awk '{print $2}' | xargs -r -n1 bluetoothctl connect >/dev/null
fi
systemctl --user restart dark-eye-ptt.service

echo "eye        -> $BIN/eye"
echo "/eye skill -> $SKILL/SKILL.md"
echo "service    -> $UNITS/dark-eye.service (enabled)"
echo "ptt        -> $UNITS/dark-eye-ptt.service (enabled, mpris-proxy masked)"
echo "wireplumber-> $WPCONF/50-dark-eye-ptt.conf, udev -> $UDEV"
echo "Start it with: systemctl --user start dark-eye"
