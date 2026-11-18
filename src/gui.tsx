/**
 * Voice Input — the GUI half of the plugin.
 *
 * Visibility first: a small mic icon button sits right beside the composer's
 * send button, a floating overlay with a live level meter and timer runs while
 * recording, and transcription shows a partial caption that grows as it goes —
 * whisper segments are transcribed concurrently with the recording, so the
 * final text arrives almost instantly after you stop. Triggers: the mic
 * button or the header button, the palette command (mod+shift+m), and
 * silence-based auto-stop so one click is enough for a hands-free take.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import {
  Command,
  Plugin,
  SettingsPage,
  Slot,
  type MountedSession,
} from "@opencode/plugin/gui"
import { VoiceInputRpc, type Prefs, type SourceInfo, type SourcesResult, type StartResult, type StatusResult, type StopResult } from "./rpc"

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
  start(input?: object): Promise<unknown>
  stop(input?: object): Promise<unknown>
  retry(input?: object): Promise<unknown>
  discardTake(input?: object): Promise<unknown>
  cancel(input?: object): Promise<unknown>
  status(input?: object): Promise<unknown>
  sources(input?: object): Promise<unknown>
  prefs(input?: object): Promise<unknown>
  setPrefs(input: Partial<Prefs>): Promise<unknown>
}

const DEFAULT_PREFS: Prefs = { lang: "ja", threads: 24, whisperBin: "whisper-cli", model: "", source: "", beeps: true }

/** RMS above which we count the meter as "someone is speaking". */
const SPEAK_THRESHOLD = 0.012
/** Silence after detected speech that ends a take automatically (ms). */
const SILENCE_STOP_MS = 2500
/** Never heard speech by this point → the mic path is likely dead (ms). */
const NO_AUDIO_ABORT_MS = 15000
/** Guard so the silence auto-stop cannot fire during the first words. */
const MIN_TAKE_MS = 4000

const EQUALIZER_WEIGHTS = [0.5, 0.9, 0.65, 1, 0.75, 0.95, 0.6, 0.85, 0.45]

/** Microphone glyph shared by the composer button and the header button. */
const MIC_SVG =
  '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
  '<path d="M7 8.75a2.5 2.5 0 0 0 2.5-2.5V3a2.5 2.5 0 1 0-5 0v3.25A2.5 2.5 0 0 0 7 8.75Z" stroke="currentColor" stroke-width="1.1"/>' +
  '<path d="M3.4 6.5v.25a3.6 3.6 0 0 0 7.2 0V6.5M7 10.35v1.4M5.1 11.95h3.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' +
  "</svg>"

/** Stop square shown while a take is recording. */
const STOP_SVG =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 3H3V13H13V3Z" fill="currentColor"/></svg>'

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
@keyframes vi-mic-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
button[data-oc-voice-mic="1"] svg, .vi-header-icon svg { width: 16px; height: 16px }
button[data-oc-voice-mic="1"][data-recording="1"] { animation: vi-mic-pulse 1.2s ease-in-out infinite; color: #e5484d }
`
  document.head.appendChild(style)
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/**
 * Flatten anything thrown by the SDK into readable text. The client throws
 * plain objects (ApiError/RpcError shapes), which would otherwise render as
 * `[object Object]` in toasts and in the app log.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>
    const parts: string[] = []
    if (typeof e._tag === "string") parts.push(e._tag)
    else if (typeof e.name === "string" && e.name) parts.push(e.name)
    if (typeof e.type === "string" && e.type) parts.push(e.type)
    if (typeof e.message === "string" && e.message && !parts.includes(e.message)) parts.push(e.message)
    if (typeof e.status === "number" && e.status) parts.push(`HTTP ${e.status}`)
    if (parts.length) return parts.join(": ").slice(0, 300)
    try {
      const json = JSON.stringify(error)
      if (json && json !== "{}") return json.slice(0, 300)
    } catch {
      // circular — fall through
    }
  }
  return String(error)
}

/**
 * The GUI bundle can mount before the server half of the plugin answers RPC
 * (a cold service boot registers both halves in sequence), so startup reads
 * retry with a gentle backoff instead of leaving defaults silently in place.
 * A service restart plus SDK reconnect can take ~20s, so the schedule covers
 * roughly 30 seconds before giving up.
 */
async function retryRpc<T>(label: string, call: () => Promise<T>, attempts = 10, baseDelayMs = 800): Promise<T | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt === attempts) {
        console.error(`[voice-input] ${label} failed: ${errorText(error)}`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(baseDelayMs * attempt, 5000)))
    }
  }
  return undefined
}

/** Short confirmation tone so recording state is audible, not just visible. */
function playBeep(kind: "start" | "stop") {
  try {
    const AudioCtor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return
    const audioContext = new AudioCtor()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = "sine"
    oscillator.frequency.value = kind === "start" ? 880 : 523.25
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    gain.gain.exponentialRampToValueAtTime(0.05, audioContext.currentTime + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.1)
    oscillator.stop(audioContext.currentTime + 0.11)
    oscillator.onended = () => void audioContext.close().catch(() => {})
  } catch {
    // Audio feedback is a nicety; never let it break the recorder.
  }
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
      "voice-input.overlay.meterOther":
        "The level meter only follows the system default mic, so silence auto-stop is off for this device — press Stop yourself",
      "voice-input.overlay.stop": "Stop & transcribe",
      "voice-input.overlay.cancel": "Cancel",
      "voice-input.overlay.autoCancelled": "No audio detected; recording cancelled",
      "voice-input.overlay.autoStopped": "Silence detected; transcribing",
      "voice-input.inserted": "Transcription inserted",
      "voice-input.empty": "No speech was recognized",
      "voice-input.error": "Voice input failed",
      "voice-input.pill.error": "Voice input: last attempt failed",
      "voice-input.pill.failed": "Voice input: failed — retry",
      "voice-input.action.retry": "Retry transcribing the kept recording",
      "voice-input.overlay.failed": "Transcription failed",
      "voice-input.overlay.failedHint": "The recording is kept — retry once the cause is fixed, or discard it",
      "voice-input.overlay.retry": "Retry",
      "voice-input.overlay.dismiss": "Discard",
      "voice-input.retryFailed": "Retry failed — the recording is still kept",
      "voice-input.command.copy-last": "Voice Input: copy last transcription",
      "voice-input.copied": "Transcription copied to clipboard",
      "voice-input.copy-none": "Nothing to copy yet — record something first",
      "voice-input.no-session": "Open a session to insert dictated text.",
      "voice-input.settings.title": "Voice Input",
      "voice-input.settings.lang": "Recognition language (ISO code, e.g. ja)",
      "voice-input.settings.source": "Microphone (capture source)",
      "voice-input.settings.sourceDefault": "System default",
      "voice-input.settings.sourceNone": "No capture sources found — check PipeWire",
      "voice-input.settings.threads": "whisper threads",
      "voice-input.settings.bin": "whisper-cli path",
      "voice-input.settings.model": "whisper model path",
      "voice-input.settings.beeps": "Play a short tone when recording starts and stops",
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
      "voice-input.overlay.meterOther":
        "レベル表示はシステム既定のマイクのみ対応のため、このデバイスでは無音の自動停止をオフにしています — 手動で停止してください",
      "voice-input.overlay.stop": "停止して文字起こし",
      "voice-input.overlay.cancel": "中止",
      "voice-input.overlay.autoCancelled": "音声が検出されなかったため録音を中止しました",
      "voice-input.overlay.autoStopped": "無音を検出して文字起こしを開始します",
      "voice-input.inserted": "文字起こしを挿入しました",
      "voice-input.empty": "音声を認識できませんでした",
      "voice-input.error": "音声入力でエラーが発生しました",
      "voice-input.pill.error": "音声入力: 直前に失敗",
      "voice-input.pill.failed": "音声入力: 失敗 — 再試行できます",
      "voice-input.action.retry": "保持中の録音を再度文字起こし",
      "voice-input.overlay.failed": "文字起こしに失敗しました",
      "voice-input.overlay.failedHint": "録音音声は保持されています。原因を解消して再試行するか、閉じると破棄します",
      "voice-input.overlay.retry": "再試行",
      "voice-input.overlay.dismiss": "破棄",
      "voice-input.retryFailed": "再試行も失敗しました — 録音は保持中です",
      "voice-input.command.copy-last": "音声入力: 直前の文字起こしをコピー",
      "voice-input.copied": "クリップボードにコピーしました",
      "voice-input.copy-none": "コピーできる文字起こしはまだありません",
      "voice-input.no-session": "セッションを開くと、文字起こし結果を挿入できます。",
      "voice-input.settings.title": "音声入力",
      "voice-input.settings.lang": "認識言語（ISOコード、例: ja）",
      "voice-input.settings.source": "マイク（入力デバイス）",
      "voice-input.settings.sourceDefault": "システム既定",
      "voice-input.settings.sourceNone": "入力デバイスが見つかりません（PipeWireを確認してください）",
      "voice-input.settings.threads": "whisperスレッド数",
      "voice-input.settings.bin": "whisper-cliのパス",
      "voice-input.settings.model": "whisperモデルのパス",
      "voice-input.settings.beeps": "録音の開始・終了時に短い音を鳴らす",
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
    void retryRpc("prefs", () => rpc.prefs({})).then((value) => {
      if (value) setPrefs(value as Prefs)
    })

    const savePrefs = async (patch: Partial<Prefs>) => {
      const next = { ...prefs(), ...patch }
      setPrefs(next)
      try {
        setPrefs((await rpc.setPrefs(next)) as Prefs)
      } catch (error) {
        console.error(`[voice-input] setPrefs failed: ${errorText(error)}`)
        ctx.toast.show({ title: ctx.t("voice-input.error"), description: errorText(error), variant: "error" })
      }
    }

    // ---------- recorder state ----------
    const [state, setState] = createSignal<"idle" | "recording" | "busy" | "failed">("idle")
    const [elapsed, setElapsed] = createSignal(0)
    const [lastError, setLastError] = createSignal<string>()
    const [partial, setPartial] = createSignal("")
    const ticker = setInterval(() => {
      if (state() !== "recording" || finishing) return
      void rpc
        .status()
        .then((value) => {
          const status = value as StatusResult
          if (!status.recording && !finishing) {
            // The take ended elsewhere (another window, or the recorder died): reflect it here.
            setState("idle")
            setElapsed(0)
            setPartial("")
            stopMeter()
            if (status.lastError) setLastError(status.lastError)
            return
          }
          setElapsed(status.recording ? Math.floor(status.seconds) : 0)
          // Live caption: the server transcribes segments while we record.
          const caption = status.partial ?? status.partialStable
          if (caption !== undefined) setPartial(caption)
        })
        .catch(() => {})
    }, 1000)
    onCleanup(() => clearInterval(ticker))

    // Resync a freshly loaded window with a recorder another window started, and
    // surface any earlier failure — retries because the RPC side may boot after the GUI.
    void retryRpc("status", () => rpc.status({})).then((value) => {
      if (!value) return
      const status = value as StatusResult
      if (status.recording && state() === "idle") setState("recording")
      // A take whose transcription failed is kept on disk: reopen the retry prompt.
      else if (!status.recording && status.hasLastTake && state() === "idle") setState("failed")
      if (status.lastError) setLastError(status.lastError)
    })

    // ---------- live level meter (client-side, optional) ----------
    const [level, setLevel] = createSignal(0)
    const [meterAvailable, setMeterAvailable] = createSignal(false)
    const [meterOther, setMeterOther] = createSignal(false)
    const [noAudio, setNoAudio] = createSignal(false)
    let meterStop: (() => void) | undefined

    const stopMeter = () => {
      meterStop?.()
      meterStop = undefined
      setLevel(0)
      setNoAudio(false)
      setMeterOther(false)
    }

    const startMeter = async (onSilence: () => void, onNoAudio: () => void) => {
      stopMeter()
      let stream: MediaStream | undefined
      // The recorder honours the picked PipeWire node; the browser meter can
      // only follow a device it knows. Watch the same mic when possible, and
      // otherwise leave auto-stop off rather than listening to another one.
      let constraint: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      const wanted = prefs().source
      if (wanted !== "") {
        try {
          const [sourceList, devices] = await Promise.all([
            rpc.sources({}) as Promise<SourcesResult>,
            navigator.mediaDevices.enumerateDevices(),
          ])
          const info = sourceList.sources.find((entry) => entry.name === wanted)
          const match = info
            ? devices.find(
                (device) =>
                  device.kind === "audioinput" &&
                  device.label !== "" &&
                  (device.label === info.description || device.label.includes(info.description)),
              )
            : undefined
          if (match?.deviceId) {
            constraint = { ...constraint, deviceId: { exact: match.deviceId } }
          } else {
            console.warn("[voice-input] meter cannot follow the selected source; auto-stop disabled")
            setMeterOther(true)
            setMeterAvailable(false)
            return
          }
        } catch (error) {
          console.warn(`[voice-input] meter source lookup failed: ${errorText(error)}`)
          setMeterOther(true)
          setMeterAvailable(false)
          return
        }
      }
      try {
        if (!navigator.mediaDevices?.getUserMedia) return
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraint })
      } catch (error) {
        console.warn(`[voice-input] mic level meter unavailable: ${errorText(error)}`)
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
    let lastTranscript = ""

    const copyToClipboard = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (error) {
        console.error(`[voice-input] clipboard failed: ${errorText(error)}`)
        return false
      }
    }

    const insert = async (text: string) => {
      lastTranscript = text
      const screen = ctx.screen.current()
      if (!screen) {
        // Never lose a take: with no open composer the text goes to the clipboard instead.
        if (await copyToClipboard(text)) {
          ctx.toast.show({
            title: ctx.t("voice-input.no-session"),
            description: ctx.t("voice-input.copied"),
            variant: "default",
          })
        } else {
          ctx.toast.show({ title: ctx.t("voice-input.no-session"), variant: "default" })
        }
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
      if (prefs().beeps) playBeep("start")
      try {
        const result = (await rpc.start({})) as StartResult
        if (result.recording) {
          setLastError(undefined)
          setState("recording")
          setElapsed(0)
          setPartial("")
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
      if (prefs().beeps) playBeep("stop")
      finishing = true
      stopMeter()
      setState("busy")
      try {
        // A lost reply (service restart mid-take) must not lose the take: the
        // server keeps the audio either way, so retry the call before giving up.
        const result = (await retryRpc("stop", () => rpc.stop({}), 4, 1200)) as StopResult | undefined
        if (!result) throw new Error(ctx.t("voice-input.error"))
        const text = result.text.trim()
        if (text) {
          setLastError(undefined)
          await insert(text)
        } else {
          // Empty text is either a retryable failure (audio kept) or a silent take.
          const info = (await rpc.status({}).catch(() => undefined)) as StatusResult | undefined
          if (info?.lastError) setLastError(info.lastError)
          if (info?.hasLastTake) setState("failed")
          else {
            const notice = info?.lastError || ctx.t("voice-input.empty")
            setLastError(notice)
            ctx.toast.show({ title: notice, variant: "default" })
          }
        }
      } catch (error) {
        // Transport failed with the take still on disk — show 再試行, never cancel.
        const message = errorText(error)
        setLastError(message)
        setState("failed")
      } finally {
        finishing = false
        if (state() === "busy") setState("idle")
        setElapsed(0)
      }
    }

    /** Re-transcribe the kept-over take from the failed state. */
    const retryFromFailure = async () => {
      if (finishing) return
      finishing = true
      setState("busy")
      let delegated = false
      try {
        const info = (await retryRpc("status", () => rpc.status({}), 4, 1200)) as StatusResult | undefined
        if (info?.recording) {
          // The recorder is actually still running: finish that take instead.
          delegated = true
          finishing = false
          setState("recording")
          void stopAndTranscribe()
          return
        }
        const result = (await retryRpc("retry", () => rpc.retry({}), 4, 1200)) as StopResult | undefined
        const text = result?.text.trim() ?? ""
        if (text) {
          setLastError(undefined)
          await insert(text)
          setState("idle")
        } else {
          const fresh = (await rpc.status({}).catch(() => undefined)) as StatusResult | undefined
          if (fresh?.lastError) setLastError(fresh.lastError)
          ctx.toast.show({ title: ctx.t("voice-input.retryFailed"), variant: "error" })
          setState("failed")
        }
      } catch (error) {
        setLastError(errorText(error))
        setState("failed")
      } finally {
        finishing = false
        if (!delegated && state() === "busy") setState("failed")
      }
    }

    /** Acknowledge the failure: drop the kept audio and return to idle. */
    const dismissFailure = async () => {
      setState("idle")
      setElapsed(0)
      setLastError(undefined)
      try {
        await rpc.discardTake({})
      } catch (error) {
        console.error(`[voice-input] discardTake failed: ${errorText(error)}`)
      }
    }

    const cancelRecording = async (notice?: string) => {
      const wasRecording = state() === "recording"
      stopMeter()
      setState("idle")
      setElapsed(0)
      if (!wasRecording) return
      try {
        await rpc.cancel({})
      } catch (error) {
        console.error(`[voice-input] cancel failed: ${errorText(error)}`)
      }
      if (notice) ctx.toast.show({ title: notice, variant: "default" })
    }

    /** Re-copy the last take — useful when the insert landed nowhere useful. */
    const copyLast = async () => {
      if (!lastTranscript) {
        ctx.toast.show({ title: ctx.t("voice-input.copy-none"), variant: "default" })
        return
      }
      if (await copyToClipboard(lastTranscript)) {
        ctx.toast.show({ title: ctx.t("voice-input.copied"), description: lastTranscript.slice(0, 60), variant: "success" })
      } else {
        ctx.toast.show({ title: ctx.t("voice-input.error"), variant: "error" })
      }
    }

    const toggle = () => {
      if (state() === "idle") void startRecording()
      else if (state() === "recording") void stopAndTranscribe()
      else if (state() === "failed") void retryFromFailure()
    }

    // ---------- keyboard ----------
    onMount(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || state() === "idle") return
        event.stopPropagation()
        if (state() === "failed") void dismissFailure()
        else void cancelRecording()
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
    ctx.add(Command, {
      id: "voice-input.copy-last",
      get title() {
        return ctx.t("voice-input.command.copy-last")
      },
      keywords: "voice dictation clipboard copy transcript",
      section: "prompt",
      run: () => void copyLast(),
    })

    // ---------- composer control: a mic icon beside send ----------
    // The host icon dictionary has no microphone glyph and a declarative pill
    // cannot host a custom SVG, so this is a host-styled icon button injected
    // as the send button's sibling — the same DOM approach the tts plugin uses
    // for its per-message buttons. It copies the submit button's own classes,
    // so it matches both the tall and the compact composer footers, and shows
    // a red stop square (pulsing) while recording.
    // The microphone glyph is the module-level MIC_SVG, shared with the
    // header button so both controls look identical.
    onMount(() => {
      const MIC_SELECTOR = 'button[data-oc-voice-mic="1"]'
      const syncMic = () => {
        const found = Array.from(
          document.querySelectorAll<HTMLElement>('[data-action="composer-submit"]'),
        )
        // Treat the innermost node as the real submit button when a wrapper
        // and the button itself both carry the attribute.
        const submits = found.filter((el) => !found.some((other) => other !== el && el.contains(other)))

        // One mic per composer footer, at most.
        const footers = new Map<HTMLElement, HTMLElement>()
        for (const submit of submits) {
          const footer = submit.parentElement
          if (footer && !footers.has(footer)) footers.set(footer, submit)
        }

        // Prune mics whose footer lost its submit button (the host rebuilt the
        // composer) and any extras that slipped into the same footer; this is
        // what used to leave two mic buttons beside send.
        const kept = new Set<HTMLElement>()
        for (const mic of Array.from(document.querySelectorAll<HTMLButtonElement>(MIC_SELECTOR))) {
          const host = mic.parentElement
          if (!host || !footers.has(host) || kept.has(host)) {
            mic.remove()
            continue
          }
          kept.add(host)
        }

        for (const [footer, submit] of footers) {
          let button = footer.querySelector<HTMLButtonElement>(MIC_SELECTOR)
          if (!button) {
            button = document.createElement("button")
            button.type = "button"
            button.dataset.ocVoiceMic = "1"
            button.className = submit.className
            button.style.flex = "none"
            if (submit.className.includes("size-7")) {
              // Compact composer: shrink below the copied tall-button classes.
              button.style.width = "28px"
              button.style.height = "28px"
              button.style.padding = "4px"
              button.style.borderRadius = "6px"
            }
            footer.insertBefore(button, submit)
          }
          if (button.nextElementSibling !== submit) footer.insertBefore(button, submit)
          const recording = state() === "recording"
          const icon = recording ? STOP_SVG : MIC_SVG
          if (button.dataset.icon !== icon) {
            button.dataset.icon = icon
            button.innerHTML = icon
          }
          button.dataset.recording = recording ? "1" : "0"
          const title = recording
            ? `${ctx.t("voice-input.action.stop")} ${formatClock(elapsed())}`
            : state() === "busy"
              ? ctx.t("voice-input.pill.busy")
              : state() === "failed"
                ? lastError() || ctx.t("voice-input.action.retry")
                : ctx.t("voice-input.action.start")
          if (button.title !== title) {
            button.title = title
            button.setAttribute("aria-label", title)
          }
        }
      }

      let queued = false
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          syncMic()
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      const clock = window.setInterval(syncMic, 1000)
      const onClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null
        if (!target?.closest?.('button[data-oc-voice-mic="1"]')) return
        event.preventDefault()
        event.stopPropagation()
        void toggle()
      }
      window.addEventListener("click", onClick, true)
      syncMic()
      onCleanup(() => {
        observer.disconnect()
        window.clearInterval(clock)
        window.removeEventListener("click", onClick, true)
        for (const button of Array.from(document.querySelectorAll('button[data-oc-voice-mic="1"]')))
          button.remove()
      })
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
                  : state() === "failed"
                    ? ctx.t("voice-input.action.retry")
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
              color: state() === "recording" || state() === "failed" ? "#e5484d" : "inherit",
            }}
          >
            <Show
              when={state() === "busy" || state() === "failed"}
              fallback={<span class="vi-header-icon" innerHTML={state() === "recording" ? STOP_SVG : MIC_SVG} />}
            >
              <Icon name="refresh" size="small" />
            </Show>
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
                  <Show when={state() === "failed"}>
                    <span style={{ display: "inline-flex", color: "#e5484d" }}>
                      <Icon name="close-small" size="normal" />
                    </span>
                    <span style={{ "font-weight": "600", color: "#e5484d" }}>{ctx.t("voice-input.overlay.failed")}</span>
                  </Show>
                </div>
                <Show when={partial()}>
                  <div
                    style={{
                      "margin-top": "2px",
                      "max-width": "460px",
                      "font-size": "12px",
                      opacity: "0.75",
                      display: "-webkit-box",
                      "-webkit-line-clamp": "3",
                      "-webkit-box-orient": "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {partial()}
                  </div>
                </Show>
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
                      <Show when={!meterAvailable()}> · {meterOther() ? ctx.t("voice-input.overlay.meterOther") : ctx.t("voice-input.overlay.noMeter")}</Show>
                    </Show>
                  </div>
                </Show>
                <Show when={state() === "failed"}>
                  <Show when={lastError()}>
                    <div style={{ color: "#e5484d", "white-space": "pre-wrap", "max-width": "460px", "font-size": "12px" }}>
                      {lastError()}
                    </div>
                  </Show>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => void retryFromFailure()}
                      style={{ ...buttonStyle, background: "#e5484d", color: "#fff", border: "none" }}
                    >
                      <Icon name="refresh" size="small" />
                      {ctx.t("voice-input.overlay.retry")}
                    </button>
                    <button type="button" onClick={() => void dismissFailure()} style={buttonStyle}>
                      <Icon name="close-small" size="small" />
                      {ctx.t("voice-input.overlay.dismiss")}
                      <span style={{ opacity: "0.55" }}>Esc</span>
                    </button>
                  </div>
                  <div style={{ opacity: "0.65" }}>{ctx.t("voice-input.overlay.failedHint")}</div>
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
      const [sources, setSources] = createSignal<SourceInfo[]>([])
      const [sourcesLoaded, setSourcesLoaded] = createSignal(false)
      onMount(() => {
        void rpc
          .sources()
          .then((value) => {
            const result = value as SourcesResult
            setSources(Array.isArray(result?.sources) ? result.sources : [])
            setSourcesLoaded(true)
          })
          .catch(() => setSourcesLoaded(true))
      })
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
            <span>{ctx.t("voice-input.settings.source")}</span>
            <select
              value={prefs().source}
              onChange={(event) => void savePrefs({ source: event.currentTarget.value })}
              style={{ "align-self": "flex-start", padding: "4px 8px", "max-width": "480px" }}
            >
              <option value="">{ctx.t("voice-input.settings.sourceDefault")}</option>
              <For each={sources()}>
                {(source) => (
                  <option value={source.name}>
                    {source.description}
                    {source.default ? " ★" : ""}
                  </option>
                )}
              </For>
            </select>
            <Show when={sourcesLoaded() && sources().length === 0}>
              <span style={{ opacity: "0.65" }}>{ctx.t("voice-input.settings.sourceNone")}</span>
            </Show>
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
          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input
              type="checkbox"
              checked={prefs().beeps}
              onChange={(event) => void savePrefs({ beeps: event.currentTarget.checked })}
            />
            <span>{ctx.t("voice-input.settings.beeps")}</span>
          </label>
          <span style={{ opacity: "0.65" }}>{ctx.t("voice-input.settings.hint")}</span>
        </div>
      )
    }
  },
})
