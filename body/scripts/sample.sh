#!/usr/bin/env bash
# sample.sh SECONDS name:pid ... — CPU %, ctx switches/s, IO, RSS/PSS per pid over a window
set -u
W=$1; shift
HZ=$(getconf CLK_TCK)
declare -A cpu0 cs0 rd0 wr0
snap() { local pid=$1
  local st=$(cat /proc/$pid/stat 2>/dev/null); [ -z "$st" ] && { echo "0 0 0 0"; return; }
  local cpu=$(echo "$st" | awk '{print $14+$15}')
  local cs=0; for t in /proc/$pid/task/*/status; do cs=$((cs + $(awk '/ctxt_switches/{s+=$2}END{print s+0}' $t 2>/dev/null))); done
  local rd=$(awk '/^read_bytes/{print $2}' /proc/$pid/io 2>/dev/null || echo 0); local wr=$(awk '/^write_bytes/{print $2}' /proc/$pid/io 2>/dev/null || echo 0)
  echo "$cpu $cs ${rd:-0} ${wr:-0}"; }
for a in "$@"; do p=${a#*:}; read c s r w <<<"$(snap $p)"; cpu0[$a]=$c; cs0[$a]=$s; rd0[$a]=$r; wr0[$a]=$w; done
E0=$(cat /sys/class/powercap/intel-rapl:0/energy_uj 2>/dev/null || echo 0)
read -r _ u0 n0 s0 i0 rest < /proc/stat
sleep $W
E1=$(cat /sys/class/powercap/intel-rapl:0/energy_uj 2>/dev/null || echo 0)
read -r _ u1 n1 s1 i1 rest < /proc/stat
printf "%-22s %7s %8s %8s %8s %8s %8s\n" name cpu% cs/s rdKB/s wrKB/s rssMB pssMB
for a in "$@"; do p=${a#*:}; n=${a%%:*}; read c s r w <<<"$(snap $p)"
  cpu=$(awk -v a=${cpu0[$a]} -v b=$c -v hz=$HZ -v w=$W 'BEGIN{printf "%.2f",(b-a)*100/hz/w}')
  cs=$(awk -v a=${cs0[$a]} -v b=$s -v w=$W 'BEGIN{printf "%.1f",(b-a)/w}')
  rd=$(awk -v a=${rd0[$a]} -v b=$r -v w=$W 'BEGIN{printf "%.1f",(b-a)/1024/w}')
  wr=$(awk -v a=${wr0[$a]} -v b=$w -v w=$W 'BEGIN{printf "%.1f",(b-a)/1024/w}')
  rss=$(awk '/^Rss:/{printf "%d",$2/1024}' /proc/$p/smaps_rollup 2>/dev/null); pss=$(awk '/^Pss:/{printf "%d",$2/1024}' /proc/$p/smaps_rollup 2>/dev/null)
  printf "%-22s %7s %8s %8s %8s %8s %8s\n" "$n" $cpu $cs $rd $wr "${rss:-?}" "${pss:-?}"
done
awk -v E0=$E0 -v E1=$E1 -v w=$W 'BEGIN{printf "RAPL pkg W: %.2f\n",(E1-E0)/1e6/w}'
awk -v u0=$u0 -v n0=$n0 -v s0=$s0 -v i0=$i0 -v u1=$u1 -v n1=$n1 -v s1=$s1 -v i1=$i1 'BEGIN{b=(u1-u0)+(n1-n0)+(s1-s0); t=b+(i1-i0); printf "system busy %% of all 16 threads: %.2f  (= %.2f cores)\n",b*100/t,b*16/t}'
