/**
 * Voice Input — the GUI half of the plugin.
 *
 * A microphone button in the session header (and palette commands) toggles the
 * server-side recorder: pw-record captures the mic, whisper.cpp transcribes,
 * and the result is inserted into the composer at the caret.
 */
import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Command, Plugin, SettingsPage, Slot, type MountedSession } from "@opencode/plugin/gui"
import { VoiceInputRpc, type Prefs, type StartResult, type StatusResult, type StopResult } from "./rpc"

/** The host components we use; the public types keep the registry open, so we type the calls. */
interface IconProps {
  name: string
  size?: "small" | "normal" | "large"
  class?: string
}

/** `SlotMap["session.header"]`: the session and active fields are reactive getters. */
interface HeaderProps {
  readonly screen: unknown
  readonly session: MountedSession
  readonly active: boolean
  readonly compact: boolean
}

interface RpcLike {
  start(): Promise<unknown>
  stop(): Promise<unknown>
  cancel(): Promise<unknown>
  status(): Promise<unknown>
  prefs(): Promise<unknown>
  setPrefs(input: Partial<Prefs>): Promise<unknown>
}

const DEFAULT_PREFS: Prefs = { lang: "ja", threads: 24, whisperBin: "whisper-cli", model: "" }

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return String(error)
}

export default Plugin.define({
  i18n: {
    en: {
      "voice-input.name": "Voice Input",
      "voice-input.action.start": "Record and transcribe voice",
      "voice-input.action.stop": "Stop recording and transcribe",
      "voice-input.action.busy": "Transcribing…",
      "voice-input.command.toggle": "Voice Input: start/stop recording",
      "voice-input.command.cancel": "Voice Input: cancel recording",
      "voice-input.empty": "No speech was recognized",
      "voice-input.error": "Voice input failed",
      "voice-input.no-session": "Open a session to insert dictated text.",
      "voice-input.settings.title": "Voice Input",
      "voice-input.settings.lang": "Recognition language (ISO code, e.g. ja)",
      "voice-input.settings.threads": "whisper threads",
      "voice-input.settings.bin": "whisper-cli path",
      "voice-input.settings.model": "whisper model path",
      "voice-input.settings.hint":
        "Records with pw-record and transcribes locally with whisper.cpp. Use a smaller model if transcription feels slow.",
    },
    ja: {
      "voice-input.name": "音声入力",
      "voice-input.action.start": "音声を録音して文字起こし",
      "voice-input.action.stop": "録音を停止して文字起こし",
      "voice-input.action.busy": "文字起こし中…",
      "voice-input.command.toggle": "音声入力：録音を開始／停止",
      "voice-input.command.cancel": "音声入力：録音を中止",
      "voice-input.empty": "音声を認識できませんでした",
      "voice-input.error": "音声入力でエラーが発生しました",
      "voice-input.no-session": "セッションを開くと、文字起こし結果を挿入できます。",
      "voice-input.settings.title": "音声入力",
      "voice-input.settings.lang": "認識言語（ISOコード、例: ja）",
      "voice-input.settings.threads": "whisperスレッド数",
      "voice-input.settings.bin": "whisper-cliのパス",
      "voice-input.settings.model": "whisperモデルのパス",
      "voice-input.settings.hint":
        "pw-recordで録音し、whisper.cppでローカルに文字起こしします。処理が遅い場合は小さいモデルに変更してください。",
    },
  },
  setup(ctx) {
    const rpc = ctx.client.rpc(VoiceInputRpc) as unknown as RpcLike
    const Icon = (ctx.ui as unknown as { Icon: (props: IconProps) => JSX.Element }).Icon

    // ---------- preferences ----------
    const [prefs, setPrefs] = createSignal<Prefs>({ ...DEFAULT_PREFS })
    void rpc
      .prefs()
      .then((value) => setPrefs(value as Prefs))
      .catch((error) => console.error("[voice-input] prefs", error))

    const savePrefs = async (patch: Partial<Prefs>) => {
      const next = { ...prefs(), ...patch }
      setPrefs(next)
      try {
        setPrefs((await rpc.setPrefs(next)) as Prefs)
      } catch (error) {
        console.error("[voice-input] setPrefs", error)
        ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
      }
    }

    // ---------- recorder state ----------
    const [state, setState] = createSignal<"idle" | "recording" | "busy">("idle")
    const [elapsed, setElapsed] = createSignal(0)
    const ticker = setInterval(() => {
      if (state() !== "recording") return
      void rpc
        .status()
        .then((value) => {
          const status = value as StatusResult
          setElapsed(status.recording ? Math.floor(status.seconds) : 0)
        })
        .catch(() => {})
    }, 1000)
    onCleanup(() => clearInterval(ticker))

    // Resync a freshly loaded window with a recorder another window started.
    void rpc
      .status()
      .then((value) => {
        const status = value as StatusResult
        if (status.recording) setState("recording")
      })
      .catch(() => {})

    const insert = (text: string) => {
      const screen = ctx.screen.current()
      if (!screen) {
        ctx.toast.show({ title: ctx.t("voice-input.no-session"), variant: "default" })
        return
      }
      const existing = screen.composer.text()
      const needsSpace = existing.length > 0 && !/\s$/.test(existing)
      screen.composer.insert(needsSpace ? ` ${text}` : text)
    }

    const toggle = async () => {
      const current = state()
      if (current === "busy") return
      if (current === "idle") {
        try {
          const result = (await rpc.start()) as StartResult
          setState(result.recording ? "recording" : "idle")
          if (result.recording) setElapsed(0)
        } catch (error) {
          setState("idle")
          ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
        }
        return
      }
      setState("busy")
      try {
        const result = (await rpc.stop()) as StopResult
        const text = result.text.trim()
        if (text) insert(text)
        else ctx.toast.show({ title: ctx.t("voice-input.empty"), variant: "default" })
      } catch (error) {
        ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
      } finally {
        setState("idle")
        setElapsed(0)
      }
    }

    const cancel = async () => {
      if (state() === "idle") return
      try {
        await rpc.cancel()
      } catch (error) {
        console.error("[voice-input] cancel", error)
      }
      setState("idle")
      setElapsed(0)
    }

    // ---------- commands ----------
    ctx.add(Command, {
      id: "voice-input.toggle",
      get title() {
        return ctx.t("voice-input.command.toggle")
      },
      keywords: "voice mic dictation stt microphone",
      section: "prompt",
      bind: "mod+shift+m",
      run: () => void toggle(),
    })
    ctx.add(Command, {
      id: "voice-input.cancel",
      get title() {
        return ctx.t("voice-input.command.cancel")
      },
      section: "prompt",
      run: () => void cancel(),
    })

    // ---------- header button ----------
    ctx.add(Slot, {
      at: "session.header",
      order: 36,
      render: (props: HeaderProps) => (
        <Show when={props.active}>
          <button
            type="button"
            class="vi-header-button"
            title={
              state() === "recording"
                ? `${ctx.t("voice-input.action.stop")} ${elapsed()}s`
                : state() === "busy"
                  ? ctx.t("voice-input.action.busy")
                  : ctx.t("voice-input.action.start")
            }
            aria-label={ctx.t("voice-input.action.start")}
            onClick={() => void toggle()}
            style={{
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              height: "24px",
              padding: "0 6px",
              background: "transparent",
              border: "none",
              "border-radius": "4px",
              cursor: "pointer",
              color: state() === "recording" ? "#e5484d" : "inherit",
            }}
          >
            <Icon name={state() === "busy" ? "refresh" : state() === "recording" ? "stop" : "waveform"} size="small" />
          </button>
        </Show>
      ),
    })

    // ---------- settings ----------
    ctx.add(SettingsPage, {
      id: "voice-input",
      get title() {
        return ctx.t("voice-input.settings.title")
      },
      icon: "waveform",
      render: () => <SettingsView />,
    })

    function SettingsView() {
      const fieldStyle = { padding: "4px 8px", "min-width": "320px", "max-width": "480px" }
      const labelStyle = { display: "flex", "flex-direction": "column", gap: "6px" } as const
      return (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "4px 0", "font-size": "13px" }}>
          <label style={labelStyle}>
            <span>{ctx.t("voice-input.settings.lang")}</span>
            <select
              value={prefs().lang}
              onChange={(event) => void savePrefs({ lang: event.currentTarget.value })}
              style={{ "align-self": "flex-start", padding: "4px 8px" }}
            >
              <option value="ja">ja（日本語）</option>
              <option value="en">en（英語）</option>
              <option value="auto">auto（自動検出）</option>
            </select>
          </label>
          <label style={labelStyle}>
            <span>
              {ctx.t("voice-input.settings.threads")} — {prefs().threads}
            </span>
            <input
              type="range"
              min={1}
              max={64}
              step={1}
              value={prefs().threads}
              onInput={(event) => void savePrefs({ threads: Number(event.currentTarget.value) })}
              style={{ "align-self": "flex-start", width: "240px" }}
            />
          </label>
          <label style={labelStyle}>
            <span>{ctx.t("voice-input.settings.bin")}</span>
            <input
              type="text"
              value={prefs().whisperBin}
              onInput={(event) => setPrefs({ ...prefs(), whisperBin: event.currentTarget.value })}
              onChange={(event) => void savePrefs({ whisperBin: event.currentTarget.value })}
              style={fieldStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>{ctx.t("voice-input.settings.model")}</span>
            <input
              type="text"
              value={prefs().model}
              onInput={(event) => setPrefs({ ...prefs(), model: event.currentTarget.value })}
              onChange={(event) => void savePrefs({ model: event.currentTarget.value })}
              style={fieldStyle}
            />
          </label>
          <span style={{ opacity: "0.65" }}>{ctx.t("voice-input.settings.hint")}</span>
        </div>
      )
    }
  },
})
