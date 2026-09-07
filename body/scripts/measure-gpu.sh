#!/usr/bin/env bash
# measure-gpu.sh — one 60 s window for a renderer under test: CPU % of a core,
# RSS and PSS for that process, plus system GPU busy (from RC6), mean GPU
# frequency and package power (RAPL). With no command it measures the machine
# as it stands (baseline). bash + awk + sudo for RAPL only.
# Prints name|cpu%|rssMB|pssMB|gpuBusy%|procGpu%|MHz|pkgW|coreW|uncoreW.
set -euo pipefail

SECS=${SECS:-60}
SETTLE=${SETTLE:-6}
NAME=${1:?usage: measure-gpu.sh <name> [command...]}
shift || true

CARD=/sys/class/drm/card1
GT=$CARD/gt/gt0
RAPL=/sys/class/powercap/intel-rapl:0/energy_uj
RAPL_CORE=/sys/class/powercap/intel-rapl:0:0/energy_uj
RAPL_UNCORE=/sys/class/powercap/intel-rapl:0:1/energy_uj

energy() { sudo -n cat "$1" 2>/dev/null || echo 0; }
rc6() { cat "$CARD/power/rc6_residency_ms"; }
ticks() { [ -r "/proc/$1/stat" ] && sed 's/^.*) //' "/proc/$1/stat" | awk '{print $12+$13}' || echo 0; }
rss() { awk '/^VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null || echo 0; }
pss() { awk '/^Pss:/{print $2}' "/proc/$1/smaps_rollup" 2>/dev/null || echo 0; }
gpu_ns() {
  [ -d "/proc/$1/fdinfo" ] || { echo 0; return; }
  awk '/^drm-engine-render:/{s+=$2} END{print s+0}' /proc/"$1"/fdinfo/* 2>/dev/null || echo 0
}

PID=
if [ $# -gt 0 ]; then
  "$@" >/tmp/measure-$NAME.log 2>&1 &
  PID=$!
fi
sleep "$SETTLE"
[ -n "$PID" ] && { kill -0 "$PID" 2>/dev/null || { echo "$NAME: the process died — see /tmp/measure-$NAME.log" >&2; exit 1; }; }

E0=$(energy $RAPL); K0=$(energy $RAPL_CORE); U0=$(energy $RAPL_UNCORE); R0=$(rc6); T0=$(date +%s%N)
[ -n "$PID" ] && { C0=$(ticks "$PID"); G0=$(gpu_ns "$PID"); } || { C0=0; G0=0; }

FSUM=0; FN=0
for _ in $(seq 1 "$SECS"); do
  sleep 1
  FSUM=$((FSUM + $(cat "$GT/rps_act_freq_mhz")))
  FN=$((FN + 1))
done

E1=$(energy $RAPL); K1=$(energy $RAPL_CORE); U1=$(energy $RAPL_UNCORE); R1=$(rc6); T1=$(date +%s%N)
[ -n "$PID" ] && { C1=$(ticks "$PID"); G1=$(gpu_ns "$PID"); M=$(rss "$PID"); S=$(pss "$PID"); } || { C1=0; G1=0; M=0; S=0; }
[ -n "$PID" ] && kill "$PID" 2>/dev/null || true

awk -v n="$NAME" -v e0="$E0" -v e1="$E1" -v r0="$R0" -v r1="$R1" -v t0="$T0" -v t1="$T1" \
    -v k0="$K0" -v k1="$K1" -v u0="$U0" -v u1="$U1" -v c0="$C0" -v c1="$C1" -v g0="$G0" -v g1="$G1" -v m="$M" -v s="$S" -v fs="$FSUM" -v fn="$FN" \
    -v tck="$(getconf CLK_TCK)" 'BEGIN{
  el=(t1-t0)/1e9
  cpu=(c1-c0)/tck/el*100
  gpuproc=(g1-g0)/(el*1e9)*100
  busy=100-(r1-r0)/(el*1000)*100
  w=(e1>e0)?(e1-e0)/1e6/el:0
  wk=(k1>k0)?(k1-k0)/1e6/el:0
  wu=(u1>u0)?(u1-u0)/1e6/el:0
  printf "%s|%.1f|%.0f|%.0f|%.2f|%.2f|%.0f|%.2f|%.2f|%.3f\n", n, cpu, m/1024, s/1024, busy, gpuproc, fs/fn, w, wk, wu
}'
