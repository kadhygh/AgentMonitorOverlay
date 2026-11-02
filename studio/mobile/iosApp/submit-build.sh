#!/bin/bash
# What ssh runs (scripts/ios-release.mjs): queues the build for com.amo.ios-build, which runs build-on-mac.sh in the
# desktop session (codesign needs the login keychain), prints its output as it comes and exits with its exit code.
#   bash submit-build.sh <studio/mobile folder> <version> <build number> [--no-upload]
# 9: the agent is not there (install it: node scripts/ios-release.mjs --install-agent) or did not take the job.
set -u
MOBILE=$(cd "${1:?studio/mobile 目录}" && pwd)
VERSION=${2:?版本号}
BUILD=${3:?构建号}
FLAG=${4:-}
ROOT=$HOME/amo-ios-build
if ! launchctl print "gui/$(id -u)/com.amo.ios-build" >/dev/null 2>&1; then
  echo "✗ 打包机上没有装 com.amo.ios-build（在 Windows 上跑 node scripts/ios-release.mjs --install-agent），或者桌面没有登录"
  exit 9
fi
NAME=$VERSION-$BUILD-$(date +%Y%m%d%H%M%S)
OUT=$ROOT/jobs/$NAME
mkdir -p "$ROOT/queue" "$ROOT/jobs"
printf '%s %s %s %s\n' "$MOBILE" "$VERSION" "$BUILD" "$FLAG" >"$ROOT/queue/$NAME.tmp"
mv "$ROOT/queue/$NAME.tmp" "$ROOT/queue/$NAME.job"

# Taken within a minute (launchd starts the runner at once; another build of ours ahead of it waits its turn).
waited=0
while [ ! -f "$OUT/output.log" ]; do
  if [ -f "$ROOT/queue/$NAME.job" ] && [ $waited -ge 60 ] && ! pgrep -f 'amo-ios-build/agent/runner.sh' >/dev/null; then
    rm -f "$ROOT/queue/$NAME.job"
    echo "✗ com.amo.ios-build 一分钟没接这个任务（看 $ROOT/agent/agent.log）"
    exit 9
  fi
  sleep 2; waited=$((waited + 2))
done
# Its output as it grows, until the exit code is written.
shown=0
while :; do
  done_=0; [ -f "$OUT/exit" ] && done_=1
  size=$(wc -c <"$OUT/output.log" | tr -d ' ')
  if [ "$size" -gt "$shown" ]; then tail -c +$((shown + 1)) "$OUT/output.log" | head -c $((size - shown)); shown=$size; fi
  [ $done_ = 1 ] && break
  sleep 2
done
exit "$(cat "$OUT/exit")"
