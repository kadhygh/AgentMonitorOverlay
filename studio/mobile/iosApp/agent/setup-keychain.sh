#!/bin/bash
# The iOS builds' own keychain on the build Mac (2026-11-02, the user: leave Jenkins' jenkins-build keychain alone).
# Run once, by the person, in Terminal on the Mac (it asks for the .p12's password; nobody else sees it):
#   bash setup-keychain.sh <the .p12 exported from Keychain Access: Apple Distribution: Wu Naiyu (D39JR23NC7)>
# It makes ~/amo-ios-build/signing.keychain-db with a random password kept in ~/.amo-ios/keychain-password (600, only
# this keychain's, not the login password), imports the certificate and key, and lets codesign use them without a
# dialog. It does NOT stay in the keychain search list: Jenkins' builds never see it (the same identity twice in the
# list could make their signing ambiguous); build-on-mac.sh names it to codesign directly.
set -euo pipefail
P12=${1:?用法：bash setup-keychain.sh <导出的 .p12>}
[ -f "$P12" ] || { echo "没有这个文件：$P12"; exit 1; }
KC=$HOME/amo-ios-build/signing.keychain-db
PWFILE=$HOME/.amo-ios/keychain-password
[ -e "$KC" ] && { echo "已经有 $KC 了（要重建先删掉它和 $PWFILE）"; exit 1; }

umask 077
mkdir -p "$HOME/.amo-ios" "$HOME/amo-ios-build"
# The search list as it is now, put back afterwards: create-keychain adds the new one to it.
LIST=()
while IFS= read -r line; do line=${line#*\"}; LIST+=("${line%\"}"); done < <(security list-keychains -d user)

LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 >"$PWFILE"
chmod 600 "$PWFILE"
PW=$(cat "$PWFILE")
security create-keychain -p "$PW" "$KC"
security list-keychains -d user -s "${LIST[@]}"
# No auto-lock, not locked on sleep: builds unlock it themselves anyway.
security set-keychain-settings "$KC"
security unlock-keychain -p "$PW" "$KC"

read -rsp "p12 的密码：" P12PW; echo
security import "$P12" -k "$KC" -P "$P12PW" -f pkcs12 -T /usr/bin/codesign
unset P12PW
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null

echo
security find-identity -v -p codesigning "$KC"
echo "搜索列表（应该跟原来一样，没有 signing.keychain-db）："
security list-keychains -d user
echo "好了。导出的 $P12 可以删掉了。"
