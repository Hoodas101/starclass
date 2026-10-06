#!/usr/bin/env bash
#
# 在桌面创建「星课 StarClass」入口 —— 安装后双击即可进入系统。
#
# 用法：
#   bash tools/create-desktop-entry.sh [端口]      # 默认取 $PORT 或 3001
#
# 行为：
#   · macOS：在桌面生成 「星课 StarClass.app」（双击 → 服务未启动则先启动 → 打开浏览器）
#   · Linux：在桌面生成 「星课 StarClass.desktop」（同上，用 xdg-open）
#   · Windows(Git Bash)：在桌面生成 「星课 StarClass.url」 快捷方式
#
# 幂等：已存在则覆盖重建。失败以非零码退出，调用方（deploy.sh）应容忍。
set -u

PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-${PORT:-3001}}"
URL="http://localhost:${PORT}"
APP_NAME="星课 StarClass"
ICON_PNG="${PROJ_DIR}/deploy/app-icon.png"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PROJ_DIR}/package.json" | head -n 1)"
VERSION="${VERSION:-1.0}"

# 桌面目录：优先 ~/Desktop，中文系统回退 ~/桌面
DESKTOP="${HOME}/Desktop"
[ -d "$DESKTOP" ] || DESKTOP="${HOME}/桌面"
if [ ! -d "$DESKTOP" ]; then
  echo "⚠️  未找到桌面目录（$HOME/Desktop），跳过创建入口"
  exit 1
fi

# 启动器逻辑（三个平台共用同一段语义）：健康检查失败则先拉起服务，再打开浏览器
health_check() { command -v curl >/dev/null 2>&1 && curl -s -m 2 "${URL}/api/health" >/dev/null 2>&1; }

case "$(uname -s)" in
  Darwin)
    APP="${DESKTOP}/${APP_NAME}.app"
    rm -rf "$APP" 2>/dev/null || true
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

    cat > "$APP/Contents/MacOS/launch" <<EOF
#!/bin/bash
URL="${URL}"
PROJ="${PROJ_DIR}"
if ! /usr/bin/curl -s -m 2 "\$URL/api/health" >/dev/null 2>&1; then
  if [ -x "\$PROJ/start-all.sh" ]; then
    ( cd "\$PROJ" && nohup bash start-all.sh >/dev/null 2>&1 & )
    for _ in \$(seq 1 25); do
      /usr/bin/curl -s -m 2 "\$URL/api/health" >/dev/null 2>&1 && break
      sleep 1
    done
  fi
fi
/usr/bin/open "\$URL"
EOF
    chmod +x "$APP/Contents/MacOS/launch"

    # 图标：PNG → .icns（sips + iconutil 均为 macOS 自带；失败则用系统默认图标）
    if [ -f "$ICON_PNG" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
      TMPD="$(mktemp -d)"
      SET="$TMPD/icon.iconset"
      mkdir -p "$SET"
      for s in 16 32 64 128 256 512; do
        sips -z "$s" "$s" "$ICON_PNG" --out "$SET/icon_${s}x${s}.png" >/dev/null 2>&1
        sips -z "$((s * 2))" "$((s * 2))" "$ICON_PNG" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
      done
      iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1
      rm -rf "$TMPD"
    fi

    cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>local.starclass.launcher</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
    touch "$APP"
    echo "✅ 桌面入口已创建：${APP}"
    ;;

  Linux)
    FILE="${DESKTOP}/${APP_NAME}.desktop"
    cat > "$FILE" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=教培 / 健身机构一体化管理系统
Exec=bash -c 'if ! curl -s -m 2 ${URL}/api/health >/dev/null 2>&1; then (cd "${PROJ_DIR}" && nohup bash start-all.sh >/dev/null 2>&1 &); sleep 6; fi; xdg-open ${URL}'
Icon=${ICON_PNG}
Terminal=false
Categories=Office;
EOF
    chmod +x "$FILE"
    # GNOME 需标记为受信任，否则双击会被拦
    command -v gio >/dev/null 2>&1 && gio set "$FILE" metadata::trusted true >/dev/null 2>&1
    echo "✅ 桌面入口已创建：${FILE}"
    ;;

  MINGW*|MSYS*|CYGWIN*)
    FILE="${DESKTOP}/${APP_NAME}.url"
    printf '[InternetShortcut]\r\nURL=%s\r\n' "$URL" > "$FILE"
    echo "✅ 桌面入口已创建：${FILE}（Windows 请先运行 deploy.sh 启动服务）"
    ;;

  *)
    echo "⚠️  未识别的系统（$(uname -s)），跳过创建桌面入口"
    exit 1
    ;;
esac

health_check || echo "ℹ️  提示：当前服务未运行，双击桌面入口时会自动尝试启动。"
exit 0
