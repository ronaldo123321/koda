#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 2
fi

if [[ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]]; then
  echo "a unified cgroup v2 mount is required" >&2
  exit 1
fi

mapfile -t membership < <(awk -F: '$1 == "0" && $2 == "" { print $3 }' /proc/self/cgroup)
if [[ ${#membership[@]} -ne 1 || ${membership[0]} != /* || ${membership[0]} == *..* ]]; then
  echo "the current cgroup v2 membership is invalid" >&2
  exit 1
fi

readonly delegated_root="/sys/fs/cgroup${membership[0]}"
if [[ ! -d "$delegated_root" || ! -w "$delegated_root/cgroup.subtree_control" ]]; then
  echo "the current cgroup is not a writable delegated root" >&2
  exit 1
fi
if ! grep -qw pids "$delegated_root/cgroup.controllers"; then
  echo "the delegated root does not expose the pids controller" >&2
  exit 1
fi
if ! grep -qw pids "$delegated_root/cgroup.subtree_control"; then
  echo +pids > "$delegated_root/cgroup.subtree_control"
fi

readonly probe="$delegated_root/koda-preflight-$$"
mkdir -- "$probe"
probe_pid=""
cleanup() {
  if [[ -n "$probe_pid" ]]; then
    kill "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
  fi
  if [[ -d "$probe" ]]; then
    echo 1 > "$probe/cgroup.kill" 2>/dev/null || true
    rmdir -- "$probe" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo 4 > "$probe/pids.max"
if [[ "$(< "$probe/pids.max")" != "4" ]]; then
  echo "pids.max did not retain the exact requested limit" >&2
  exit 1
fi
for control in cgroup.procs cgroup.events cgroup.kill pids.current; do
  if [[ ! -f "$probe/$control" ]]; then
    echo "missing cgroup control: $control" >&2
    exit 1
  fi
done

sleep 30 &
probe_pid=$!
echo "$probe_pid" > "$probe/cgroup.procs"
if ! grep -qx "$probe_pid" "$probe/cgroup.procs"; then
  echo "the probe process did not enter its cgroup" >&2
  exit 1
fi
if [[ "$(< "$probe/pids.current")" -lt 1 ]]; then
  echo "pids.current did not account for the probe process" >&2
  exit 1
fi

echo 1 > "$probe/cgroup.kill"
wait "$probe_pid" 2>/dev/null || true
probe_pid=""
for _ in {1..50}; do
  if grep -qx 'populated 0' "$probe/cgroup.events"; then
    rmdir -- "$probe"
    trap - EXIT
    echo "delegated cgroup v2 pids and kill controls passed"
    exit 0
  fi
  sleep 0.1
done
echo "the probe cgroup remained populated after cgroup.kill" >&2
exit 1
