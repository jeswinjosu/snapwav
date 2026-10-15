#!/usr/bin/env bash
# Build a signed APK with only the command-line Android tools (no Gradle, no Android Studio).
# This is how the release APK attached to the first release was produced.
#
# Requirements (Debian/Ubuntu):  sudo apt install aapt apksigner zipalign dalvik-exchange android-sdk-platform-23 default-jdk
# Signing (required):            SNAPWAV_KEYSTORE=path/to/key.jks SNAPWAV_KEY_ALIAS=snapwav \
#                                SNAPWAV_KEYSTORE_PASSWORD=... SNAPWAV_KEY_PASSWORD=... ./build-without-gradle.sh
# Run `python3 ../web/build.py` first if you changed the web app.
set -euo pipefail
cd "$(dirname "$0")"

BT=${BUILD_TOOLS:-/usr/lib/android-sdk/build-tools/debian}
JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
: "${SNAPWAV_KEYSTORE:?set SNAPWAV_KEYSTORE to your .jks file}"
: "${SNAPWAV_KEY_ALIAS:?set SNAPWAV_KEY_ALIAS}"
: "${SNAPWAV_KEYSTORE_PASSWORD:?set SNAPWAV_KEYSTORE_PASSWORD}"
export SNAPWAV_KEY_PASSWORD=${SNAPWAV_KEY_PASSWORD:-$SNAPWAV_KEYSTORE_PASSWORD}

APP_ID=$(sed -nE "s/.*applicationId '([^']+)'.*/\1/p" app/build.gradle)
VERSION_NAME=$(sed -nE "s/.*versionName '([^']+)'.*/\1/p" app/build.gradle)
VERSION_CODE=$(sed -nE "s/.*versionCode ([0-9]+).*/\1/p" app/build.gradle)
MIN_SDK=$(sed -nE "s/.*minSdk ([0-9]+).*/\1/p" app/build.gradle)
TARGET_SDK=$(sed -nE "s/.*targetSdk ([0-9]+).*/\1/p" app/build.gradle)

OUT=build/sdkless
rm -rf "$OUT" && mkdir -p "$OUT/classes"

# Gradle reads package/version/SDK levels from build.gradle; aapt needs them in the manifest.
python3 - "$APP_ID" "$VERSION_CODE" "$VERSION_NAME" "$MIN_SDK" "$TARGET_SDK" <<'PY'
import sys
app, code, name, mn, tg = sys.argv[1:]
src = open('app/src/main/AndroidManifest.xml').read()
tag = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
assert tag in src
new = (f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{app}" '
       f'android:versionCode="{code}" android:versionName="{name}">\n'
       f'    <uses-sdk android:minSdkVersion="{mn}" android:targetSdkVersion="{tg}" />')
open('build/sdkless/AndroidManifest.xml', 'w').write(src.replace(tag, new))
PY

echo "→ compiling Java"
javac -source 8 -target 8 -Xlint:-options -bootclasspath "$JAR" -classpath "$JAR" -d "$OUT/classes" \
  $(find app/src/main/java -name '*.java')

echo "→ dexing"
"$BT/dx" --dex --min-sdk-version="$MIN_SDK" --output="$OUT/classes.dex" "$OUT/classes"

echo "→ packaging resources and assets"
"$BT/aapt" package -f -M "$OUT/AndroidManifest.xml" -S app/src/main/res -A app/src/main/assets \
  -I "$JAR" -F "$OUT/unsigned.apk" -0 arsc
(cd "$OUT" && "$BT/aapt" add -f unsigned.apk classes.dex >/dev/null)

echo "→ aligning and signing"
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
mkdir -p build/outputs
APK="build/outputs/snapwav-$VERSION_NAME.apk"
apksigner sign --ks "$SNAPWAV_KEYSTORE" --ks-key-alias "$SNAPWAV_KEY_ALIAS" \
  --ks-pass env:SNAPWAV_KEYSTORE_PASSWORD --key-pass env:SNAPWAV_KEY_PASSWORD \
  --min-sdk-version "$MIN_SDK" --out "$APK" "$OUT/aligned.apk"
apksigner verify --min-sdk-version "$MIN_SDK" "$APK"
echo "✓ $APK"
