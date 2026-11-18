#!/usr/bin/env bash
# Environment check for the OpenCode Voice Input plugin — read-only, prints
# OK / NG lines with hints. Run this first if recording or transcription fails:
#
#   ./script/check-prereqs.sh
set -uo pipefail

LOCAL="${HOME}/.local"
LIB_DIR="${LOCAL}/usr/lib/x86_64-linux-gnu"
WHISPER="${LOCAL}/bin/whisper-cli"
MODEL="${LOCAL}/share/whisper-models/ggml-large-v3-turbo.bin"

ok()  { printf '  \033[1;32mOK\033[0m   %s\n' "$*"; }
warn(){ printf '  \033[1;33mWARN\033[0m %s\n' "$*"; }
ng()  { printf '  \033[1;31mNG\033[0m   %s\n' "$*"; }

status=0

echo "== PipeWire / 録音 =="
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v pw-record >/dev/null 2>&1; then
  ok "pw-record あり ($(command -v pw-record))"
else
  ng "pw-record がありません — \`sudo apt install pipewire-bin\`（PipeWire 必須）"
  status=1
fi
if command -v wpctl >/dev/null 2>&1; then
  if wpctl status >/dev/null 2>&1; then
    ok "PipeWire デーモン応答あり"
    srcs="$(wpctl status 2>/dev/null | sed -n '/Sources:/,/^\s*$/p' | grep -c '\[' || true)"
    if [ "${srcs}" -ge 1 ] 2>/dev/null; then
      ok "入力ソースが ${srcs} 個見つかります（\`wpctl status\` で確認、\`wpctl set-default <ID>\` で既定に）"
    else
      warn "入力ソースが見当たりません — マイク接続 / xrdp ならオーディオリダイレクトを有効に"
    fi
  else
    ng "PipeWire に接続できません（XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}）— デスクトップセッションで実行していますか？"
    status=1
  fi
else
  warn "wpctl がありません（pipewire-bin 同梱）— 状態確認のみスキップ"
fi

echo "== whisper.cpp =="
if [ -x "${WHISPER}" ]; then
  bin="${WHISPER}"
elif command -v whisper-cli >/dev/null 2>&1; then
  bin="$(command -v whisper-cli)"
else
  ng "whisper-cli が見つかりません — ./script/setup-whisper.sh を実行してください"
  status=1
  bin=""
fi
if [ -n "${bin}" ]; then
  if LD_LIBRARY_PATH="${LIB_DIR}:${LD_LIBRARY_PATH:-}" "${bin}" --help >/dev/null 2>&1; then
    ok "whisper-cli 起動 OK (${bin})"
  else
    ng "whisper-cli が起動できません — ライブラリ不足の可能性: \`LD_LIBRARY_PATH=${LIB_DIR} ldd ${bin}\` を確認"
    status=1
  fi
fi

echo "== モデル =="
if [ -s "${MODEL}" ]; then
  size=$(stat -c %s "${MODEL}" 2>/dev/null || echo 0)
  if [ "${size}" -gt 100000000 ]; then
    ok "モデルあり ${MODEL} ($(du -h "${MODEL}" | cut -f1))"
  else
    ng "モデルが壊れています（${size} バイト）— 再ダウンロード: ./script/setup-whisper.sh"
    status=1
  fi
else
  ng "モデルがありません — ./script/setup-whisper.sh（既定で large-v3-turbo）"
  status=1
fi

echo "== ディスク =="
free_kb=$(df -Pk "${LOCAL}" | awk 'NR==2 {print $4}')
if [ "${free_kb:-0}" -ge 2000000 ]; then
  ok "空き容量 ~$((free_kb / 1024 / 1024)) GB（モデル+録音用に 2 GB 以上推奨）"
else
  warn "空き容量が ${free_kb:-0} KB しかありません — 録音ファイルとモデル用に容量を空けてください"
fi

echo
if [ "${status}" -eq 0 ]; then
  printf '\033[1;32mすべて問題なし\033[0m — OpenCode Desktop を再起動（サービスごと）して音声入力を試してください。\n'
else
  printf '\033[1;31mNG を修正してください\033[0m — 設定手順: ./script/setup-whisper.sh / README の Requirements 参照。\n'
fi
exit "${status}"
