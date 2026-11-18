/**
 * Voice Input — the GUI half of the plugin.
 *
 * Visibility first: a pill above the composer shows the recorder state at all
 * times, a floating overlay with a live level meter and timer runs while
 * recording, and whisper transcription has its own busy state. Triggers: the
 * pill or header button, the palette command (mod+shift+m), and silence-based
 * auto-stop so one click is enough for a hands-free take.
 */
import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import {
  Command,
  ComposerPill,
  Plugin,
  SettingsPage,
  Slot,
  type MountedSession,
} from "@opencode/plugin/gui"
import { VoiceInputRpc, type Prefs, type StartResult, type StatusResult, type StopResult } from "./rpc"

/** The host components we use; the public types keep the registry open, so we type the calls. */
interface IconProps {
  name: string
  size?: "small" | "normal" | "large"
  class?: string
  style?: JSX.CSSProperties
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

/** RMS above which we count the meter as "someone is speaking". */
const SPEAK_THRESHOLD = 0.012
/** Silence after detected speech that ends a take automatically (ms). */
const SILENCE_STOP_MS = 2500
/** Never heard speech by this point → the mic path is likely dead (ms). */
const NO_AUDIO_ABORT_MS = 15000
/** Guard so the silence auto-stop cannot fire during the first words. */
const MIN_TAKE_MS = 4000

const EQUALIZER_WEIGHTS = [0.5, 0.9, 0.65, 1, 0.75, 0.95, 0.6, 0.85, 0.45]

const STYLE_ID = "voice-input-style"

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
@keyframes vi-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.2 } }
@keyframes vi-spin { to { transform: rotate(360deg) } }
@keyframes vi-eq { 0%, 100% { transform: scaleY(0.25) } 50% { transform: scaleY(1) } }
.vi-eq-bar { transform-origin: bottom; animation: vi-eq 900ms ease-in-out infinite }
`
  document.head.appendChild(style)
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return String(error)
}

export default Plugin.define({
  i18n: {
    en: {
      "voice-input.name": "Voice Input",
      "voice-input.pill.idle": "Voice Input",
      "voice-input.pill.recording": "Recording",
      "voice-input.pill.busy": "Transcribing…",
      "voice-input.action.start": "Record and transcribe voice",
      "voice-input.action.stop": "Stop recording and transcribe",
      "voice-input.action.busy": "Transcribing…",
      "voice-input.command.toggle": "Voice Input: start/stop recording",
      "voice-input.command.cancel": "Voice Input: cancel recording",
      "voice-input.overlay.recording": "Recording…",
      "voice-input.overlay.transcribing": "Transcribing with whisper…",
      "voice-input.overlay.hint": "Click Stop, press the shortcut again, or stay silent to finish",
      "voice-input.overlay.noAudio": "No audio from the mic — check the mic itself and RDP mic redirection",
      "voice-input.overlay.noMeter": "Level meter unavailable (app mic access denied) — use Stop manually",
      "voice-input.overlay.stop": "Stop & transcribe",
      "voice-input.overlay.cancel": "Cancel",
      "voice-input.overlay.autoCancelled": "No audio detected; recording cancelled",
      "voice-input.overlay.autoStopped": "Silence detected; transcribing",
      "voice-input.inserted": "Transcription inserted",
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
      "voice-input.pill.idle": "音声入力",
      "voice-input.pill.recording": "録音中",
      "voice-input.pill.busy": "文字起こし中…",
      "voice-input.action.start": "音声を録音して文字起こし",
      "voice-input.action.stop": "録音を停止して文字起こし",
      "voice-input.action.busy": "文字起こし中…",
      "voice-input.command.toggle": "音声入力：録音を開始／停止",
      "voice-input.command.cancel": "音声入力：録音を中止",
      "voice-input.overlay.recording": "録音中…",
      "voice-input.overlay.transcribing": "whisperで文字起こし中…（モデル起動に時間がかかります）",
      "voice-input.overlay.hint": "停止ボタン・ショートカット・無音で自動終了",
      "voice-input.overlay.noAudio": "マイク音声が検出できません — マイク本体とRDPのマイクリダイレクション設定を確認してください",
      "voice-input.overlay.noMeter": "レベル表示不可（アプリのマイク権限なし）— 停止は手動でお願いします",
      "voice-input.overlay.stop": "停止して文字起こし",
      "voice-input.overlay.cancel": "中止",
      "voice-input.overlay.autoCancelled": "音声が検出されなかったため録音を中止しました",
      "voice-input.overlay.autoStopped": "無音を検出して文字起こしを開始します",
      "voice-input.inserted": "文字起こしを挿入しました",
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
    injectStyles()

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

    // ---------- live level meter (client-side, optional) ----------
    const [level, setLevel] = createSignal(0)
    const [meterAvailable, setMeterAvailable] = createSignal(false)
    const [noAudio, setNoAudio] = createSignal(false)
    let meterStop: (() => void) | undefined

    const stopMeter = () => {
      meterStop?.()
      meterStop = undefined
      setLevel(0)
      setNoAudio(false)
    }

    const startMeter = async (onSilence: () => void, onNoAudio: () => void) => {
      stopMeter()
      let stream: MediaStream | undefined
      try {
        if (!navigator.mediaDevices?.getUserMedia) return
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
      } catch (error) {
        console.warn("[voice-input] mic level meter unavailable", error)
        setMeterAvailable(false)
        return
      }
      setMeterAvailable(true)
      const AudioCtor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const audioContext = new AudioCtor()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)

      const startedAt = Date.now()
      let heard = false
      let lastLoudAt = startedAt
      let closed = false
      let raf = 0

      const frame = () => {
        if (closed) return
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i++) {
          const sample = buffer[i] ?? 0
          sum += sample * sample
        }
        const rms = Math.sqrt(sum / buffer.length)
        setLevel(Math.min(1, rms * 6))
        const now = Date.now()
        if (rms > SPEAK_THRESHOLD) {
          if (!heard) setNoAudio(false)
          heard = true
          lastLoudAt = now
        } else {
          if (!heard && now - startedAt > 3000) setNoAudio(true)
          if (!heard && now - startedAt > NO_AUDIO_ABORT_MS) {
            closed = true
            onNoAudio()
            return
          }
          if (heard && now - lastLoudAt > SILENCE_STOP_MS && now - startedAt > MIN_TAKE_MS) {
            closed = true
            onSilence()
            return
          }
        }
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)

      meterStop = () => {
        closed = true
        cancelAnimationFrame(raf)
        stream?.getTracks().forEach((track) => track.stop())
        void audioContext.close().catch(() => {})
      }
      onCleanup(() => meterStop?.())
    }

    createEffect(() => {
      if (state() !== "recording") stopMeter()
    })

    // ---------- actions ----------
    const insert = (text: string) => {
      const screen = ctx.screen.current()
      if (!screen) {
        ctx.toast.show({ title: ctx.t("voice-input.no-session"), variant: "default" })
        return
      }
      const existing = screen.composer.text()
      const needsSpace = existing.length > 0 && !/\s$/.test(existing)
      screen.composer.insert(needsSpace ? ` ${text}` : text)
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
      ctx.toast.show({ title: ctx.t("voice-input.inserted"), description: preview, variant: "success" })
    }

    let finishing = false

    const startRecording = async () => {
      if (state() !== "idle") return
      try {
        const result = (await rpc.start()) as StartResult
        if (result.recording) {
          setState("recording")
          setElapsed(0)
          void startMeter(
            () => {
              // Silence after speech: finish the take.
              ctx.toast.show({ title: ctx.t("voice-input.overlay.autoStopped"), variant: "default" })
              void stopAndTranscribe()
            },
            () => {
              // Dead mic path: do not keep a silent take running.
              void cancelRecording(ctx.t("voice-input.overlay.autoCancelled"))
            },
          )
        }
      } catch (error) {
        setState("idle")
        ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
      }
    }

    const stopAndTranscribe = async () => {
      if (state() !== "recording" || finishing) return
      finishing = true
      stopMeter()
      setState("busy")
      try {
        const result = (await rpc.stop()) as StopResult
        const text = result.text.trim()
        if (text) insert(text)
        else ctx.toast.show({ title: ctx.t("voice-input.empty"), variant: "default" })
      } catch (error) {
        ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
      } finally {
        finishing = false
        setState("idle")
        setElapsed(0)
      }
    }

    const cancelRecording = async (notice?: string) => {
      const wasRecording = state() === "recording"
      stopMeter()
      setState("idle")
      setElapsed(0)
      if (!wasRecording) return
      try {
        await rpc.cancel()
      } catch (error) {
        console.error("[voice-input] cancel", error)
      }
      if (notice) ctx.toast.show({ title: notice, variant: "default" })
    }

    const toggle = () => {
      if (state() === "idle") void startRecording()
      else if (state() === "recording") void stopAndTranscribe()
    }

    // ---------- keyboard ----------
    onMount(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || state() === "idle") return
        event.stopPropagation()
        void cancelRecording()
      }
      window.addEventListener("keydown", onKeyDown, { capture: true })
      onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
    })

    // ---------- commands ----------
    ctx.add(Command, {
      id: "voice-input.toggle",
      get title() {
        return ctx.t("voice-input.command.toggle")
      },
      keywords: "voice mic dictation stt microphone",
      section: "prompt",
      bind: "mod+shift+m",
      run: () => toggle(),
    })
    ctx.add(Command, {
      id: "voice-input.cancel",
      get title() {
        return ctx.t("voice-input.command.cancel")
      },
      section: "prompt",
      run: () => void cancelRecording(),
    })

    // ---------- composer pill: always-visible state ----------
    ctx.add(ComposerPill, {
      id: "voice-input",
      order: 5,
      show: () => {
        const current = state()
        if (current === "recording") {
          return {
            icon: "stop" as const,
            tone: "danger" as const,
            label: `${ctx.t("voice-input.pill.recording")} ${formatClock(elapsed())}`,
            title: ctx.t("voice-input.action.stop"),
            run: toggle,
          }
        }
        if (current === "busy") {
          return {
            icon: "refresh" as const,
            tone: "warning" as const,
            label: ctx.t("voice-input.pill.busy"),
            title: ctx.t("voice-input.action.busy"),
          }
        }
        return {
          icon: "outline-wave-audio" as const,
          label: ctx.t("voice-input.pill.idle"),
          title: ctx.t("voice-input.action.start"),
          run: toggle,
        }
      },
    })

    // ---------- header button ----------
    ctx.add(Slot, {
      at: "session.header",
      order: 36,
      render: (props: HeaderProps) => (
        <Show when={props.active}>
          <button
            type="button"
            title={
              state() === "recording"
                ? `${ctx.t("voice-input.action.stop")} ${formatClock(elapsed())}`
                : state() === "busy"
                  ? ctx.t("voice-input.action.busy")
                  : ctx.t("voice-input.action.start")
            }
            aria-label={ctx.t("voice-input.action.start")}
            onClick={toggle}
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
            <Icon
              name={state() === "busy" ? "refresh" : state() === "recording" ? "stop" : "outline-wave-audio"}
              size="small"
            />
          </button>
        </Show>
      ),
    })

    // ---------- floating overlay ----------
    const overlayCardStyle: JSX.CSSProperties = {
      display: "flex",
      "flex-direction": "column",
      gap: "10px",
      padding: "14px 18px",
      "border-radius": "12px",
      background: "Canvas",
      color: "CanvasText",
      border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
      "box-shadow": "0 10px 36px rgba(0, 0, 0, 0.35)",
      "font-size": "13px",
      "min-width": "340px",
    }
    const buttonStyle: JSX.CSSProperties = {
      display: "inline-flex",
      "align-items": "center",
      gap: "6px",
      padding: "6px 12px",
      "border-radius": "8px",
      border: "1px solid color-mix(in srgb, CanvasText 22%, transparent)",
      background: "color-mix(in srgb, CanvasText 8%, transparent)",
      color: "inherit",
      cursor: "pointer",
      "font-size": "13px",
    }

    function Equalizer() {
      return (
        <div style={{ display: "flex", "align-items": "flex-end", gap: "3px", height: "30px" }}>
          {EQUALIZER_WEIGHTS.map((weight, index) => (
            <Show
              when={meterAvailable() && state() === "recording"}
              fallback={
                <div
                  class="vi-eq-bar"
                  style={{
                    width: "4px",
                    height: "30px",
                    "border-radius": "2px",
                    "animation-delay": `${index * 90}ms`,
                    background: state() === "recording" ? "#e5484d" : "color-mix(in srgb, CanvasText 45%, transparent)",
                  }}
                />
              }
            >
              <div
                style={{
                  width: "4px",
                  "border-radius": "2px",
                  "min-height": "4px",
                  height: `${4 + level() * 26 * weight}px`,
                  "transition": "height 60ms linear",
                  background: "#e5484d",
                }}
              />
            </Show>
          ))}
        </div>
      )
    }

    function Overlay() {
      return (
        <Portal mount={document.body}>
          <Show when={state() !== "idle"}>
            <div
              style={{
                position: "fixed",
                bottom: "96px",
                left: "50%",
                transform: "translateX(-50%)",
                "z-index": "2147483000",
              }}
            >
              <div style={overlayCardStyle}>
                <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                  <Show when={state() === "recording"}>
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        "border-radius": "50%",
                        background: "#e5484d",
                        animation: "vi-pulse 1s ease-in-out infinite",
                      }}
                    />
                    <span style={{ "font-weight": "600", "font-variant-numeric": "tabular-nums" }}>
                      {ctx.t("voice-input.overlay.recording")} {formatClock(elapsed())}
                    </span>
                    <Equalizer />
                  </Show>
                  <Show when={state() === "busy"}>
                    <span style={{ display: "inline-flex", animation: "vi-spin 1.2s linear infinite" }}>
                      <Icon name="refresh" size="normal" />
                    </span>
                    <span style={{ "font-weight": "600" }}>{ctx.t("voice-input.overlay.transcribing")}</span>
                  </Show>
                </div>
                <Show when={state() === "recording"}>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => void stopAndTranscribe()}
                      style={{ ...buttonStyle, background: "#e5484d", color: "#fff", border: "none" }}
                    >
                      <Icon name="stop" size="small" />
                      {ctx.t("voice-input.overlay.stop")}
                    </button>
                    <button type="button" onClick={() => void cancelRecording()} style={buttonStyle}>
                      <Icon name="close-small" size="small" />
                      {ctx.t("voice-input.overlay.cancel")}
                      <span style={{ opacity: "0.55" }}>Esc</span>
                    </button>
                  </div>
                  <div style={{ opacity: "0.65" }}>
                    <Show when={!noAudio()} fallback={<span style={{ color: "#e5484d" }}>{ctx.t("voice-input.overlay.noAudio")}</span>}>
                      {ctx.t("voice-input.overlay.hint")}
                      <Show when={!meterAvailable()}> · {ctx.t("voice-input.overlay.noMeter")}</Show>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Portal>
      )
    }
    Overlay()

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
