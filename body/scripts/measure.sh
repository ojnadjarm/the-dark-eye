#!/usr/bin/env bash
# measure.sh — the baseline table of PLAN-LOWRES.md §1 for the running body:
# CPU % per process, RSS + PSS, GPU render busy, RC6, fps, for one named state.
# bash + awk only. MEASURE_PROC=<dir> points the reads at a fixture (<dir>/t0,
# <dir>/t1 each holding a fake proc/ and sys/ tree) instead of the live machine.
# MEASURE_PIDS=<pid,pid,...> measures exactly those pids instead of the unit's
# cgroups — for a body run by hand, outside the unit.
set -euo pipefail

SECONDS_ARG=60
STATE=idle
ALLOW_SOUND=0
APPEND=0
FIX=${MEASURE_PROC:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASELINE=$HERE/BASELINE.md
CG_REL=fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice
CARD=card1
CONNECTOR=card1-HDMI-A-1
# the fixed paragraph the `speaking` state says: 45 words, no punctuation traps
SPEAK_TEXT="The eye keeps watch over a quiet room while the house sleeps and the \
screens go dark one by one. It counts the frames it draws and the cycles it burns \
so that later someone can read the numbers and decide what must be made smaller."

die() { echo "measure: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --seconds) SECONDS_ARG=${2:?} ; shift 2 ;;
    --state) STATE=${2:?} ; shift 2 ;;
    --allow-sound) ALLOW_SOUND=1 ; shift ;;
    --append) APPEND=1 ; shift ;;
    -h|--help) sed -n '2,5p' "$0" ; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case $STATE in idle|speaking|mic|tvoff) ;; *) die "unknown state: $STATE" ;; esac
case $STATE in
  speaking|mic) [ "$ALLOW_SOUND" = 1 ] || die "state '$STATE' needs --allow-sound (the owner may be asleep)" ;;
esac

if [ -n "$FIX" ]; then
  R0=$FIX/t0; R1=$FIX/t1
  [ -d "$R0" ] && [ -d "$R1" ] || die "MEASURE_PROC=$FIX has no t0/ and t1/"
else
  R0=; R1=
fi

# -- which processes are the body ------------------------------------------
proot() { if [ -n "$FIX" ]; then echo "$1/proc"; else echo /proc; fi; }
sroot() { if [ -n "$FIX" ]; then echo "$1/sys"; else echo /sys; fi; }

collect_pids() {
  local cg f
  if [ -n "${MEASURE_PIDS:-}" ]; then
    tr ', ' '\n\n' <<< "$MEASURE_PIDS" | grep -E '^[0-9]+$'
    return 0
  fi
  cg=$(sroot "$R0")/$CG_REL
  for f in "$cg/dark-eye.service/cgroup.procs" "$cg"/app-dark-eye-body-*.scope/cgroup.procs; do
    [ -r "$f" ] && cat "$f"
  done
  if [ -z "$FIX" ]; then
    pgrep -x eye-render || true
    pgrep -f canvas-app || true
  fi
  return 0
}

mapfile -t PIDS < <(collect_pids | sort -un)
[ ${#PIDS[@]} -gt 0 ] || die "no body process found — is dark-eye running?"

label_of() {
  local cmd=$1
  case $cmd in
    *--type=renderer*) echo renderer ;;
    *--type=gpu-process*) echo gpu-process ;;
    *audio.mojom*) echo "audio service" ;;
    *network.mojom*) echo "network service" ;;
    *node.mojom*|*voice.js*) echo "voice worker" ;;
    *src/main.js*) echo "node body" ;;
    *--type=zygote*) echo zygote ;;
    *--type=utility*) echo utility ;;
    *eye-render*) echo eye-render ;;
    *canvas-app*) echo canvas-app ;;
    *cli.js*) echo "node cli" ;;
    *bin/bash*) echo "unit shell" ;;
    *electron*) echo main ;;
    *) echo "${cmd%% *}" ;;
  esac
}

# One snapshot: per-pid cpu ticks and memory, per-drm-client render ns, GPU sysfs.
snap() {
  local root=$1 P S p ticks rss pss cmd
  P=$(proot "$root"); S=$(sroot "$root")
  for p in "${PIDS[@]}"; do
    [ -r "$P/$p/stat" ] || continue
    ticks=$(sed 's/^.*) //' "$P/$p/stat" | awk '{print $12+$13}')
    echo "S $p $ticks"
    rss=0; pss=0
    if [ -r "$P/$p/smaps_rollup" ]; then
      read -r rss pss < <(awk '/^Rss:/{r=$2} /^Pss:/{s=$2} END{print r+0, s+0}' "$P/$p/smaps_rollup")
    elif [ -r "$P/$p/status" ]; then
      rss=$(awk '/^VmRSS:/{print $2}' "$P/$p/status")
    fi
    echo "M $p $rss $pss"
    cmd=$(tr '\0' ' ' < "$P/$p/cmdline" 2>/dev/null || true)
    echo "L $p $(label_of "$cmd") ($p)"
    if [ -d "$P/$p/fdinfo" ]; then
      awk '/^drm-client-id:/{c=$2} /^drm-engine-render:/{ if(c!="") print "G " c " " $2; c="" }' \
        "$P/$p/fdinfo"/* 2>/dev/null || true
    fi
  done
  [ -r "$S/class/drm/$CARD/power/rc6_residency_ms" ] &&
    echo "R $(cat "$S/class/drm/$CARD/power/rc6_residency_ms")"
  [ -r "$S/class/drm/$CARD/gt_act_freq_mhz" ] &&
    echo "F $(cat "$S/class/drm/$CARD/gt_act_freq_mhz")"
  return 0
}

# -- the run ---------------------------------------------------------------
jrnl() { journalctl --user -u dark-eye --since "$1" --no-pager -o cat 2>/dev/null || true; }

WAITED=0
if [ -z "$FIX" ] && [ "$STATE" = idle ]; then
  # idle means nothing has spoken or listened for 20 s
  for _ in $(seq 1 12); do
    if [ -z "$(jrnl '20 seconds ago' | grep -E 'audio chunk seq=|mic (open|closed)')" ]; then break; fi
    sleep 5; WAITED=$((WAITED + 5))
  done
fi

T0=$(date +%s)
SNAP0=$(mktemp); SNAP1=$(mktemp)
trap 'rm -f "$SNAP0" "$SNAP1"' EXIT
snap "$R0" > "$SNAP0"

if [ -n "$FIX" ]; then
  ELAPSED=$SECONDS_ARG
else
  case $STATE in
    speaking)
      eye speak "$SPEAK_TEXT" >/dev/null
      last=$(date +%s)
      while [ $(( $(date +%s) - T0 )) -lt "$SECONDS_ARG" ]; do
        sleep 1
        [ -n "$(jrnl '2 seconds ago' | grep 'audio chunk seq=')" ] && last=$(date +%s)
        [ $(( $(date +%s) - last )) -ge 2 ] && break
      done
      ;;
    mic)
      eye mic on >/dev/null
      sleep 20
      eye mic off >/dev/null
      ;;
    *) sleep "$SECONDS_ARG" ;;
  esac
  ELAPSED=$(( $(date +%s) - T0 ))
  [ "$ELAPSED" -gt 0 ] || ELAPSED=1
fi
snap "$R1" > "$SNAP1"

# -- fps, from the renderer's own stats lines -------------------------------
FPS="n/a"
if [ -n "$FIX" ]; then
  [ -r "$FIX/journal.txt" ] && FPSSRC=$(cat "$FIX/journal.txt") || FPSSRC=""
else
  FPSSRC=$(jrnl "@$T0" | grep -E 'renderer: fps=|eye-render fps=' || true)
fi
if [ -n "$FPSSRC" ]; then
  FPS=$(echo "$FPSSRC" | awk -F'fps=' '/fps=/{split($2,a," "); f+=a[1]; n++}
    END{ if(n) printf "%.1f", f/n }')
  MSF=$(echo "$FPSSRC" | awk '
    /msAvg=/ { split($0,x,"msAvg="); split(x[2],a," "); split($0,y,"msMax="); s+=a[1]; if(y[2]+0>m) m=y[2]+0; n++; next }
    /ms=/ { split($0,x,"ms="); split(x[2],a,"[/ ]"); s+=a[1]; if(a[2]+0>m) m=a[2]+0; n++ }
    END{ if(n) printf " (ms %.1f avg, %.1f max)", s/n, m }')
  FPS="$FPS$MSF"
fi

# -- the table --------------------------------------------------------------
report() {
  echo "state: $STATE · window: ${ELAPSED}s · pids: ${#PIDS[@]}${WAITED:+ · idle wait: ${WAITED}s}"
  echo
  echo "| Process | CPU % of one core | RSS MB | PSS MB |"
  echo "|---|---|---|---|"
  awk -v tck="$(getconf CLK_TCK)" -v el="$ELAPSED" '
    FNR==NR {
      if ($1=="S") s0[$2]=$3
      else if ($1=="G") g0[$2]=$3
      else if ($1=="R") r0=$2
      else if ($1=="L") { $1=""; p=$2; $2=""; sub(/^  */,""); lab[p]=$0 }
      next
    }
    $1=="S" { s1[$2]=$3 }
    $1=="M" { rss[$2]=$3; pss[$2]=$4 }
    $1=="G" { g1[$2]=$3 }
    $1=="R" { r1=$2 }
    $1=="F" { fq=$2 }
    END {
      n=0
      for (p in s1) {
        if (!(p in s0)) continue
        cpu = (s1[p]-s0[p]) / tck / el * 100
        row[n]=sprintf("%012.4f|%s|%.1f|%.0f|%.0f", 10000-cpu, lab[p], cpu, rss[p]/1024, pss[p]/1024)
        n++
        tc+=cpu; tr+=rss[p]; tp+=pss[p]
        if (lab[p] ~ /^voice worker/) { vc+=cpu; vr+=rss[p]; vp+=pss[p] }
      }
      for (i=0;i<n;i++) for (j=i+1;j<n;j++) if (row[j]<row[i]) { x=row[i]; row[i]=row[j]; row[j]=x }
      for (i=0;i<n;i++) { split(row[i], f, "|"); printf "| %s | %s | %s | %s |\n", f[2], f[3], f[4], f[5] }
      printf "| **body total** | **%.1f** | %.0f | %.0f |\n", tc, tr/1024, tp/1024
      printf "| **body total (excl. voice worker)** | **%.1f** | %.0f | %.0f |\n", tc-vc, (tr-vr)/1024, (tp-vp)/1024
      gb=0
      for (c in g1) if (c in g0) gb += g1[c]-g0[c]
      printf "\ngpu render busy: %.2f %%\n", gb / (el*1e9) * 100
      if (r1!="") printf "rc6: %.0f %%\n", (r1-r0)/(el*1000)*100
      if (fq!="") printf "gt_act_freq: %s MHz\n", fq
    }
  ' "$SNAP0" "$SNAP1"
  echo "fps: $FPS"
  if [ "$STATE" = tvoff ]; then
    S=$(sroot "$R1")
    echo "$CONNECTOR: status=$(cat "$S/class/drm/$CONNECTOR/status" 2>/dev/null || echo ?)" \
         "dpms=$(cat "$S/class/drm/$CONNECTOR/dpms" 2>/dev/null || echo ?)" \
         "enabled=$(cat "$S/class/drm/$CONNECTOR/enabled" 2>/dev/null || echo ?)"
  fi
}

OUT=$(report)
echo "$OUT"
if [ "$APPEND" = 1 ]; then
  { echo; echo "## $(date '+%Y-%m-%d %H:%M') — state=$STATE, ${ELAPSED}s"; echo; echo "$OUT"; } >> "$BASELINE"
  echo "appended to $BASELINE" >&2
fi
