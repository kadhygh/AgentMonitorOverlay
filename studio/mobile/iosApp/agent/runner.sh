#!/bin/bash
# Run by launchd (com.amo.ios-build) in the desktop session while ~/amo-ios-build/queue has a job (submit-build.sh puts
# them there): one line "<studio/mobile folder> <version> <build> [--no-upload]". Each job's output goes to
# ~/amo-ios-build/jobs/<job>/output.log and its exit code to .../exit, where submit-build.sh follows it. Jobs run one
# after another; the job file is taken out first, so launchd does not start this again for it.
set -u
ROOT=$HOME/amo-ios-build
shopt -s nullglob
for job in "$ROOT"/queue/*.job; do
  name=$(basename "$job" .job)
  out=$ROOT/jobs/$name
  mkdir -p "$out"
  line=$(head -n 1 "$job")
  rm -f "$job"
  read -r mobile version build flag <<<"$line"
  # Only what submit-build.sh writes: a folder under ~/amo-ios-build, a version, a number, the one flag.
  case "$mobile" in "$ROOT"/*) ;; *) echo "不在 $ROOT 下：$mobile" >"$out/output.log"; echo 2 >"$out/exit"; continue ;; esac
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$build" =~ ^[0-9]+$ && ( -z "${flag:-}" || "$flag" = "--no-upload" ) ]]; then
    echo "任务不对：$line" >"$out/output.log"; echo 2 >"$out/exit"; continue
  fi
  bash "$mobile/iosApp/build-on-mac.sh" "$mobile" "$version" "$build" ${flag:+"$flag"} >"$out/output.log" 2>&1
  echo $? >"$out/exit"
done
# Job folders: the last 20.
( cd "$ROOT/jobs" && ls -1t | tail -n +21 | while read -r old; do rm -rf "$ROOT/jobs/$old"; done ) 2>/dev/null
exit 0
