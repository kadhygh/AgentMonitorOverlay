#!/bin/bash
# The iOS build on the build Mac (plans/ios.md「发布流程」): Kotlin framework → archive → .ipa → check → TestFlight.
# Windows runs it through ssh (scripts/ios-release.mjs, npm run release -- ios) on the code of one commit:
#   nice -n 10 bash build-on-mac.sh <studio/mobile folder> <version> <build number> [--no-upload]
# --no-upload stops after the .ipa (and the check, when the API key is there): for trying signing by hand.
# Every step logs to ~/amo-ios-build/logs/<version>-<build>/NN-<step>.log and stops the build when it fails; the exit
# code says where (10 + the step). It never makes, changes or removes certificates or profiles (they also sign the
# team's games), and never prints the API key: altool gets only its ID and finds the .p8 by itself.
# Signing (2026-11-03, the user, after wunaiyu tried it over ssh): with the distribution certificate and key already in
# Jenkins' jenkins-build keychain, unlocked the way Jenkins' own ~/.jenkins/bin/xcodebuild does it (its password file;
# only unlock — Jenkins never locks it again either, so the two do not get in each other's way). Nothing in that keychain
# or the search list changes, and the password is not copied anywhere. The private key cannot be exported, so there is
# no keychain of our own. The archive is built unsigned and step 5 signs the app with codesign --keychain and zips the
# .ipa itself, as Xcode's App Store export would.
set -u
MOBILE=$(cd "${1:?studio/mobile 目录}" && pwd)
VERSION=${2:?版本号}
BUILD=${3:?构建号}
UPLOAD=1
[ "${4:-}" = "--no-upload" ] && UPLOAD=0

ROOT=$HOME/amo-ios-build
RUN=$ROOT/runs/$VERSION-$BUILD
LOGS=$ROOT/logs/$VERSION-$BUILD
mkdir -p "$RUN" "$LOGS"
STEP=0
TOTAL=8

say() { printf '%s\n' "$*"; }
# step <n> <name> <title>: what follows runs as that step.
step() { STEP=$1; NAME=$2; LOG=$LOGS/$(printf '%02d' "$1")-$2.log; say "[$1/$TOTAL] $3"; }
fail() {
  say "✗ iOS 打包停在第 $STEP 步「$NAME」：$1"
  [ -f "$LOG" ] && { say "--- $LOG 最后 40 行 ---"; tail -n 40 "$LOG"; }
  exit $((10 + STEP))
}
# run <command…>: into this step's log; a failure stops the build.
run() { "$@" >>"$LOG" 2>&1 || fail "命令失败（退出码 $?）：$1，日志 $LOG"; }

step 1 busy "打包机忙不忙"
: >"$LOG"
if pgrep -f 'Unity.*-batchmode' >/dev/null; then fail "Unity 正在出包，稍后再试"; fi
# Another build (Unity's Xcode step, or another of ours); xcodebuild -downloadPlatform (a simulator download) is not one.
if pgrep -lf '^[^ ]*xcodebuild( |$)' | grep -v -- '-downloadPlatform' >>"$LOG"; then fail "已经有 xcodebuild 在跑，稍后再试"; fi
say "  空闲"

step 2 config "配置、密钥、描述文件和签名身份"
: >"$LOG"
CONFIG=$HOME/.amo-ios/config
[ -f "$CONFIG" ] || fail "没有 $CONFIG"
value() { sed -n "s/^$1=//p" "$CONFIG" | tail -n 1; }
ASC_KEY_ID=$(value ASC_KEY_ID)
ASC_ISSUER_ID=$(value ASC_ISSUER_ID)
JAVA_HOME=$(value JAVA_HOME)
export JAVA_HOME
[ -x "$JAVA_HOME/bin/java" ] || fail "JAVA_HOME 不对：$JAVA_HOME"
HAVE_KEY=0
if [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ] && [ -f "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" ]; then HAVE_KEY=1; fi
if [ $UPLOAD = 1 ] && [ $HAVE_KEY = 0 ]; then fail "上传要 App Store Connect API Key：~/.amo-ios/config 里的 ASC_KEY_ID、ASC_ISSUER_ID，和 ~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8"; fi
PROFILE=""
for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision; do
  [ -f "$f" ] || continue
  if security cms -D -i "$f" 2>/dev/null | grep -q '<string>AMOStudio_AppStore</string>'; then PROFILE=$f; break; fi
done
[ -n "$PROFILE" ] || fail "打包机上没有描述文件 AMOStudio_AppStore"
KEYCHAIN=$HOME/Library/Keychains/jenkins-build.keychain-db
KEYCHAIN_PW=$HOME/.jenkins/secrets/build-keychain-password
[ -f "$KEYCHAIN" ] && [ -r "$KEYCHAIN_PW" ] || fail "没有 Jenkins 的钥匙串 $KEYCHAIN 或它的密码文件 $KEYCHAIN_PW"
security unlock-keychain -p "$(cat "$KEYCHAIN_PW")" "$KEYCHAIN" >>"$LOG" 2>&1 || fail "解不开 $KEYCHAIN（密码文件 $KEYCHAIN_PW 是不是过时了）"
IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Apple Distribution: .*(D39JR23NC7)"$/\1/p' | head -n 1)
[ -n "$IDENTITY" ] || fail "$KEYCHAIN 里没有 Apple Distribution (D39JR23NC7) 的签名身份"
say "  描述文件、签名身份都在$([ $HAVE_KEY = 1 ] && echo '，API Key 在' || echo '；没有 API Key，只打包不校验')"

step 3 kotlin "编译共用的 Kotlin 代码（Shared.framework）"
: >"$LOG"
cd "$MOBILE" || fail "没有 $MOBILE"
chmod +x gradlew
# Kotlin/Native's release link needs more than gradle.properties' 2 GB (it ran out on 2026-11-02); only here, on the
# command line, so the Android build and the Mac's own Gradle settings (Unity's) stay as they are. Xcode's build phase
# passes the same.
run ./gradlew --no-daemon --max-workers=2 "-Dorg.gradle.jvmargs=-Xmx6g -Dfile.encoding=UTF-8" :shared:linkReleaseFrameworkIosArm64

step 4 archive "xcodebuild archive（先不签名）"
: >"$LOG"
ARCHIVE=$RUN/AMOStudio.xcarchive
rm -rf "$ARCHIVE"
run xcodebuild archive -project "$MOBILE/iosApp/iosApp.xcodeproj" -scheme iosApp -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$RUN/DerivedData" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO

step 5 export "签名、打成 .ipa"
: >"$LOG"
EXPORT=$RUN/export
rm -rf "$EXPORT"
mkdir -p "$EXPORT/Payload"
run ditto "$ARCHIVE/Products/Applications/AMOStudio.app" "$EXPORT/Payload/AMOStudio.app"
APP=$EXPORT/Payload/AMOStudio.app
cp "$PROFILE" "$APP/embedded.mobileprovision"
# What Xcode's App Store export signs with: the app id and team from the profile, no debugging, TestFlight allowed.
security cms -D -i "$PROFILE" >"$EXPORT/profile.plist" 2>>"$LOG" || fail "读不了描述文件 $PROFILE"
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$EXPORT/profile.plist" 2>>"$LOG")
[ "$APP_ID" = "D39JR23NC7.com.gorilla.amo" ] || fail "描述文件的 App ID 不是 D39JR23NC7.com.gorilla.amo：$APP_ID"
cat >"$EXPORT/entitlements.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$APP_ID</string>
<key>com.apple.developer.team-identifier</key><string>D39JR23NC7</string>
<key>get-task-allow</key><false/>
<key>beta-reports-active</key><true/>
</dict></plist>
EOF
security unlock-keychain -p "$(cat "$KEYCHAIN_PW")" "$KEYCHAIN" >>"$LOG" 2>&1 || fail "解不开 $KEYCHAIN"
# Anything nested first (none today: Shared is a static framework), then the app.
for nested in "$APP"/Frameworks/*; do
  [ -e "$nested" ] && run codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp "$nested"
done
run codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp --entitlements "$EXPORT/entitlements.plist" --generate-entitlement-der "$APP"
run codesign --verify --strict --verbose=2 "$APP"
IPA=$EXPORT/AMOStudio.ipa
( cd "$EXPORT" && zip -qry "$IPA" Payload ) >>"$LOG" 2>&1 || fail "打 .ipa 失败"
say "  $IPA"

step 6 validate "让苹果校验这个包"
: >"$LOG"
if [ $HAVE_KEY = 1 ]; then
  run xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  say "  通过"
else
  say "  跳过：没有 API Key"
fi

step 7 upload "上传到 TestFlight"
: >"$LOG"
if [ $UPLOAD = 1 ]; then
  run xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  say "  已上传：$VERSION ($BUILD)，苹果处理完（通常十几分钟）会出现在 TestFlight 里"
else
  say "  跳过（--no-upload）"
fi

step 8 cleanup "清理旧的构建"
: >"$LOG"
# Keep the last 3 builds' sources and DerivedData, the last 20 logs; never fail the build for it.
( cd "$ROOT/runs" 2>/dev/null && ls -1t | tail -n +4 | while read -r old; do rm -rf "$ROOT/runs/$old"; done ) >>"$LOG" 2>&1
( cd "$ROOT/src" 2>/dev/null && ls -1t | tail -n +4 | while read -r old; do rm -rf "$ROOT/src/$old"; done ) >>"$LOG" 2>&1
( cd "$ROOT/logs" 2>/dev/null && ls -1t | tail -n +21 | while read -r old; do rm -rf "$ROOT/logs/$old"; done ) >>"$LOG" 2>&1
say "✓ iOS $VERSION ($BUILD) 完成"
