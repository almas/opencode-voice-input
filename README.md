# opencode-voice-input

Local speech-to-text for **OpenCode Desktop**: click the microphone button (or press `Ctrl+Shift+M` / `Cmd+Shift+M`), speak, and the transcript is inserted into the composer. Recording uses PipeWire, transcription runs entirely on your machine with **whisper.cpp** — no cloud STT, no API keys.

日本語版: [下の「日本語」セクション](#日本語) を参照してください。

## Features

- **Header toggle button** (waveform icon) with idle / recording / busy states, plus `mod+shift+m` keybind.
- **PipeWire capture** via `pw-record --rate 16000 --channels 1 --format s16`, stopped with SIGINT/SIGTERM.
- **Local whisper.cpp** transcription (`whisper-cli`, e.g. `large-v3-turbo`), tuned flags: `-l ja -t 24 -np -otxt`.
- **Inserts into the composer** through `ctx.screen.current()?.composer.insert(text)` — you review before sending.
- **Preferences** persisted server-side (`ctx.storage`, key `voice-input/prefs`): language (ja/en/auto), thread count, whisper binary path, model path.
- 300 s safety cap on a single recording; cancel button aborts without transcribing.

## Requirements (Ubuntu)

1. **PipeWire** with a microphone input source (`pw-record` must exist; not tested on PulseAudio-only).
2. **whisper.cpp** ≥ 1.7 with `whisper-cli`, plus a GGML model, e.g.:

```sh
# without root: download the Ubuntu debs and unpack into ~/.local
cd /tmp && apt-get download whisper-cpp libwhisper1 libggml0
for p in whisper-cpp libwhisper1 libggml0; do dpkg -x $p*.deb ~/.local; done
ln -sf ~/.local/usr/bin/whisper-cli ~/.local/bin/whisper-cli

# model (~1.6 GB)
mkdir -p ~/.local/share/whisper-models
curl -L -o ~/.local/share/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

The plugin resolves `~/.local/bin/whisper-cli` and `~/.local/share/whisper-models/ggml-large-v3-turbo.bin` by default, and exports `LD_LIBRARY_PATH` for the `~/.local/usr/lib` libs. Override both paths in the plugin settings panel.

> xrdp note: a plain xrdp session usually has **no PipeWire input source**, so recording must be tested in a real hardware session.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "github:YOUR_GITHUB/opencode-voice-input" }
    // or: "/absolute/path/to/opencode-voice-input"
  ]
}
```

Restart OpenCode Desktop.

## Build from source

```sh
npm install
npx tsc --noEmit
npx vite build   # -> dist/gui-experimental.cjs (the GUI half)
```

## How it works

```
GUI (gui.tsx)                      Server (index.ts)
  ctx.client.rpc(voiceInput/*) ->   /api/rpc/voice-input/<method>
  start / stop / cancel / status     pw-record -> SIGINT -> whisper-cli -> txt
```

- `start` spawns `pw-record` into a WAV file; `stop` SIGTERMs it, runs `whisper-cli` in-process-queued and returns the transcript; the GUI inserts it into the composer.
- `status` polls recording duration and job state for the button label.

## 日本語

OpenCode Desktop に **完全ローカル** の音声入力を追加するプラグインです。

- ヘッダーのマイクボタン（波形アイコン）または `Ctrl+Shift+M` で録音開始／停止。
- 録音は PipeWire（`pw-record`）、文字起こしは **whisper.cpp**（例: large-v3-turbo）でローカル実行。クラウド STT は使いません。
- 認識結果は即送信せず **composer に挿入**されるため、必ず内容を確認してから送信できます。
- 言語（ja/en/auto）・スレッド数・whisper のバイナリ/モデルパスは設定パネルから変更でき、サーバー側に保存されます。

前提: Ubuntu + PipeWire + whisper.cpp（非root導入手順は上の Requirements 参照）。xrdp セッションではマイク入力先が無いことがほとんどなので、実機でのテストが必要です。

## License

MIT
