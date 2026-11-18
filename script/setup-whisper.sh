#!/usr/bin/env bash
# Install whisper.cpp + a GGML model for the OpenCode Voice Input plugin —
# fully user-local, no root/sudo needed. Ubuntu/Debian with apt; other
# distros should build whisper.cpp from source (see README "Build from source").
#
#   ./script/setup-whisper.sh                # installs large-v3-turbo (~1.6 GB)
#   ./script/setup-whisper.sh medium          # a smaller model instead
#
# Installs into:
#   ~/.local/usr/          binaries + shared libraries (from distro debs)
#   ~/.local/bin/whisper-cli                  symlink the plugin looks for
#   ~/.local/share/whisper-models/            GGML model files
set -euo pipefail

MODEL="${1:-large-v3-turbo}"
LOCAL="${HOME}/.local"
LIB_DIR="${LOCAL}/usr/lib/x86_64-linux-gnu"
MODEL_DIR="${LOCAL}/share/whisper-models"
MODEL_FILE="${MODEL_DIR}/ggml-${MODEL}.bin"

log() { printf '\033[1;36m[setup-whisper]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup-whisper]\033[0m %s\n' "$*" >&2; exit 1; }

command -v dpkg-deb >/dev/null || die "dpkg-deb not found — build whisper.cpp from source instead (see README)."

# --- 1. download + unpack the debs into ~/.local (no root) -------------------

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
cd "${TMP}"

# Package names differ slightly across Ubuntu/Debian releases (whisper-cpp vs
# whisper.cpp, t64 suffix or not) — try each candidate and keep what downloads.
download() {
  local name
  for name in "$@"; do
    if apt-get download "${name}" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

log "downloading packages (apt-get download, no root)…"
fetch() {
  # $1 = required? (1/0), rest = package-name candidates
  local req="$1"; shift
  if ! download "$@"; then
    if [ "${req}" = 1 ]; then
      die "could not download any of: $* — is apt configured and the universe repository enabled?"
    fi
    log "optional packages not available, skipping: $* (fine if whisper-cli still runs)"
  fi
}

fetch 1 whisper.cpp whisper-cpp
fetch 1 libwhisper1 libwhisper1t64
fetch 1 libggml0 libggml0t64
fetch 0 libmpg123-0t64 libmpg123-0
fetch 0 libout123-0t64 libout123-0
fetch 0 libsyn123-0t64 libsyn123-0
fetch 0 libsdl2-2.0-0 libsdl2-2.0-0t64

log "unpacking into ${LOCAL} …"
for deb in ./*.deb; do
  dpkg-deb -x "${deb}" "${LOCAL}"
done

# --- 2. symlink whisper-cli where the plugin looks for it --------------------
mkdir -p "${LOCAL}/bin"
ln -sf "${LOCAL}/usr/bin/whisper-cli" "${LOCAL}/bin/whisper-cli"
log "linked ${LOCAL}/bin/whisper-cli"

# --- 3. model download ---------------------------------------------------------
mkdir -p "${MODEL_DIR}"
if [ -s "${MODEL_FILE}" ]; then
  log "model already present: ${MODEL_FILE} ($(du -h "${MODEL_FILE}" | cut -f1))"
else
  url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"
  log "downloading ${url} — this is ~1.6 GB for large-v3-turbo, be patient…"
  if command -v curl >/dev/null; then
    curl -L --fail -C - -o "${MODEL_FILE}" "${url}"
  elif command -v wget >/dev/null; then
    wget -c -O "${MODEL_FILE}" "${url}"
  else
    rm -f "${MODEL_FILE}"
    die "neither curl nor wget found — download ${url} to ${MODEL_FILE} manually."
  fi
fi

# --- 4. smoke test --------------------------------------------------------------
log "verifying…"
LD_LIBRARY_PATH="${LIB_DIR}" "${LOCAL}/bin/whisper-cli" --help >/dev/null \
  || die "whisper-cli runs but --help failed — check 'ldd ${LOCAL}/usr/bin/whisper-cli' with LD_LIBRARY_PATH=${LIB_DIR}"
log "whisper-cli OK"

size_bytes=$(stat -c %s "${MODEL_FILE}" 2>/dev/null || echo 0)
[ "${size_bytes}" -gt 100000000 ] || die "model file looks too small (${size_bytes} bytes) — re-download it."
log "model OK: ${MODEL_FILE} ($(du -h "${MODEL_FILE}" | cut -f1))"

log "done. The plugin defaults already point at these paths; then run ./script/check-prereqs.sh"
