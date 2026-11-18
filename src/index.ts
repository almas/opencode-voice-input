/**
 * Voice Input — the server half of the plugin.
 *
 * Registers the `voice-input` RPC domain: it records the default microphone
 * with pw-record (16 kHz mono s16 wav), transcribes the take with whisper-cli
 * (whisper.cpp) and returns the text, which the GUI inserts into the composer.
 * Recording state lives here, so every GUI window sees the same recorder.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import { Plugin } from "@opencode/plugin"
import { VoiceInputRpc, type Prefs, type StartResult, type StatusResult, type StopResult } from "./rpc"

const PREFS_KEY = "voice-input/prefs"
const MAX_RECORD_SECONDS = 300
/** 16 kHz mono s16 is 32 kB/s; anything under ~0.25 s captured nothing usable. */
const MIN_AUDIO_BYTES = 8000

const LOCAL = join(homedir(), ".local")
const LIB_DIR = join(LOCAL, "usr/lib/x86_64-linux-gnu")

function defaultWhisperBin(): string {
  const local = join(LOCAL, "bin/whisper-cli")
  return existsSync(local) ? local : "whisper-cli"
}

const DEFAULT_PREFS: Prefs = {
  lang: "ja",
  threads: 24,
  whisperBin: defaultWhisperBin(),
  model: join(LOCAL, "share/whisper-models/ggml-large-v3-turbo.bin"),
  beeps: true,
}

function loadPrefsValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function loadPrefsNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.min(128, Math.round(n)))
}

function loadLang(value: unknown, fallback: string): string {
  const lang = loadPrefsValue(value, fallback)
  return /^(auto|[a-z]{2}(-[A-Za-z]{2})?)$/.test(lang) ? lang : fallback
}

function loadPrefsBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

interface Active {
  child: ChildProcessByStdio<null, null, Readable>
  file: string
  startedAt: number
  stderr: string
  stopping: boolean
  timer: ReturnType<typeof setTimeout>
}

let active: Active | undefined
let lastError = ""

/** A recorded take whose transcription failed; kept on disk so the GUI can retry. */
interface LastTake {
  file: string
  seconds: number
}
let lastTake: LastTake | undefined

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  try {
    const json = JSON.stringify(error)
    if (json && json !== "{}") return json
  } catch {}
  return String(error)
}

function discardDirOf(file: string): void {
  try {
    rmSync(dirname(file), { recursive: true, force: true })
  } catch {}
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ask pw-record to close the wav, with a hard kill as a fallback. */
function terminate(rec: Active): Promise<void> {
  return new Promise((resolve) => {
    const child = rec.child
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const done = () => {
      clearTimeout(killer)
      resolve()
    }
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
      resolve()
    }, 2000)
    child.once("exit", done)
    try {
      child.kill("SIGINT")
    } catch {
      done()
    }
  })
}

function discard(rec: Active): void {
  try {
    unlinkSync(rec.file)
  } catch {}
  try {
    rmSync(dirname(rec.file), { recursive: true, force: true })
  } catch {}
}

/**
 * whisper.cpp hallucinates these phrases on silent or near-silent takes.
 * Dropping them keeps "no speech was recognized" honest instead of inserting
 * a polite sentence the user never said.
 */
const SILENCE_HALLUCINATION_RE =
  /(ご視聴(?:いただき)?ありがとうございました|ご清聴ありがとうございました|字幕ご協力ありがとうございました|日本語の字幕を確認しました|thanks?\s+for\s+watching!?)/gi

/** Bracketed non-speech markers whisper invents: 【音楽】（拍手）[Applause]. */
const NON_SPEECH_MARKER = /[【[(（［][^】\])］（）()]{0,16}[】\])）］]/g

function stripSilenceHallucinations(text: string): string {
  const out = text.replace(SILENCE_HALLUCINATION_RE, "").replace(NON_SPEECH_MARKER, "")
  // Orphaned punctuation left behind by the removals.
  return out.replace(/^[\s。、．!！？?,;:]+|[\s。、．!！？?,;:]+$/g, "").replace(/\s+/g, " ").trim()
}

function transcribe(wav: string, prefs: Prefs): Promise<string> {
  return new Promise((resolve, reject) => {
    if (prefs.model !== "" && !existsSync(prefs.model)) {
      reject(new Error(`whisperモデルが見つかりません: ${prefs.model}`))
      return
    }
    const out = `${wav}-text`
    const env: NodeJS.ProcessEnv = { ...process.env }
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${LIB_DIR}:${env.LD_LIBRARY_PATH}` : LIB_DIR
    const child = spawn(
      prefs.whisperBin,
      ["-m", prefs.model, "-f", wav, "-l", prefs.lang, "-t", String(prefs.threads), "-np", "-otxt", "-of", out],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    )
    let err = ""
    child.stderr.on("data", (chunk) => {
      if (err.length < 4000) err += String(chunk)
    })
    child.on("error", (error) => reject(new Error(`whisper-cliを起動できませんでした: ${error.message}`)))
    child.on("exit", (code) => {
      try {
        if (code !== 0) {
          reject(new Error(`whisper-cliが失敗しました (exit ${code}): ${err.trim().slice(-300)}`))
          return
        }
        resolve(stripSilenceHallucinations(readFileSync(`${out}.txt`, "utf8").replace(/\s+/g, " ")))
      } catch {
        resolve("")
      } finally {
        try {
          unlinkSync(`${out}.txt`)
        } catch {}
      }
    })
  })
}

export default Plugin.define({
  id: "voice-input",
  async setup(ctx) {
    const load = async (): Promise<Prefs> => {
      try {
        const stored = (await ctx.storage.get(PREFS_KEY)) as Partial<Prefs> | undefined
        if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
        return {
          lang: loadLang(stored.lang, DEFAULT_PREFS.lang),
          threads: loadPrefsNumber(stored.threads, DEFAULT_PREFS.threads),
          whisperBin: loadPrefsValue(stored.whisperBin, DEFAULT_PREFS.whisperBin),
          model: loadPrefsValue(stored.model, DEFAULT_PREFS.model),
          beeps: loadPrefsBoolean(stored.beeps, DEFAULT_PREFS.beeps),
        }
      } catch {
        return { ...DEFAULT_PREFS }
      }
    }

    const start = async (): Promise<StartResult> => {
      if (active) return { recording: true, startedAt: active.startedAt }
      lastError = ""
      if (lastTake) {
        discardDirOf(lastTake.file)
        lastTake = undefined
      }
      const dir = mkdtempSync(join(tmpdir(), "opencode-voice-input-"))
      const file = join(dir, "take.wav")
      const child = spawn(
        "pw-record",
        ["--rate", "16000", "--channels", "1", "--format", "s16", "--latency", "50ms", file],
        { stdio: ["ignore", "ignore", "pipe"] },
      )
      let spawnError: string | undefined
      child.on("error", (error) => {
        spawnError = error.message
      })
      const rec: Active = {
        child,
        file,
        startedAt: Date.now(),
        stderr: "",
        stopping: false,
        timer: setTimeout(() => {
          if (active === rec && !rec.stopping) {
            rec.stopping = true
            active = undefined
            lastError = `上限の${MAX_RECORD_SECONDS}秒に達したため録音を停止しました`
            void terminate(rec).then(() => discard(rec))
          }
        }, MAX_RECORD_SECONDS * 1000),
      }
      child.stderr!.on("data", (chunk) => {
        if (rec.stderr.length < 2000) rec.stderr += String(chunk)
      })
      child.on("exit", () => {
        clearTimeout(rec.timer)
        if (active === rec && !rec.stopping) {
          active = undefined
          lastError = `録音が予期せず終了しました (${String(child.exitCode ?? child.signalCode)}) ${rec.stderr.trim().slice(-200)}`.trim()
          discard(rec)
        }
      })
      active = rec
      // pw-record exits almost immediately when PipeWire has no capture source.
      await wait(300)
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        active = undefined
        clearTimeout(rec.timer)
        discard(rec)
        throw new Error(
          spawnError
            ? `pw-recordを起動できませんでした: ${spawnError}（マイク/音声入力デバイスがありません）`
            : `pw-recordがすぐに終了しました (${String(child.exitCode ?? child.signalCode)})${rec.stderr.trim() ? `: ${rec.stderr.trim().slice(-200)}` : ""}`,
        )
      }
      return { recording: true, startedAt: rec.startedAt }
    }

    const stop = async (): Promise<StopResult> => {
      const rec = active
      if (!rec) return { text: "", seconds: 0 }
      active = undefined
      rec.stopping = true
      clearTimeout(rec.timer)
      const seconds = Math.max(0, (Date.now() - rec.startedAt) / 1000)
      await terminate(rec)
      let size = 0
      try {
        size = statSync(rec.file).size
      } catch {}
      if (size < MIN_AUDIO_BYTES) {
        discard(rec)
        lastError = "録音データが空でした（マイクが検出できないか、入力音量が低すぎます）"
        return { text: "", seconds }
      }
      try {
        const prefs = await load()
        const text = await transcribe(rec.file, prefs)
        lastError = ""
        discard(rec)
        return { text, seconds }
      } catch (error) {
        // Keep the wav so the GUI's "再試行" can run whisper again.
        lastError = errorText(error)
        if (lastTake) discardDirOf(lastTake.file)
        lastTake = { file: rec.file, seconds }
        return { text: "", seconds }
      }
    }

    /** Re-run transcription on the take whose previous attempt failed. */
    const retry = async (): Promise<StopResult> => {
      const take = lastTake
      if (!take) return { text: "", seconds: 0 }
      try {
        const prefs = await load()
        const text = await transcribe(take.file, prefs)
        lastError = ""
        lastTake = undefined
        discardDirOf(take.file)
        return { text, seconds: take.seconds }
      } catch (error) {
        lastError = errorText(error)
        return { text: "", seconds: take.seconds }
      }
    }

    /** Drop a kept-over failed take without retrying it. */
    const discardTake = async (): Promise<{ discarded: boolean }> => {
      if (!lastTake) return { discarded: false }
      discardDirOf(lastTake.file)
      lastTake = undefined
      lastError = ""
      return { discarded: true }
    }

    const cancel = async (): Promise<{ cancelled: boolean }> => {
      const rec = active
      if (!rec) return { cancelled: false }
      active = undefined
      rec.stopping = true
      clearTimeout(rec.timer)
      await terminate(rec)
      discard(rec)
      return { cancelled: true }
    }

    await ctx.rpc.register(VoiceInputRpc, {
      start,
      stop,
      retry,
      discardTake,
      cancel,
      status: async (): Promise<StatusResult> => ({
        recording: active !== undefined,
        seconds: active ? (Date.now() - active.startedAt) / 1000 : 0,
        lastError,
        hasLastTake: lastTake !== undefined,
      }),
      prefs: async () => await load(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await load()
        const next: Prefs = {
          lang: input.lang === undefined ? current.lang : loadLang(input.lang, current.lang),
          threads: input.threads === undefined ? current.threads : loadPrefsNumber(input.threads, current.threads),
          whisperBin: input.whisperBin === undefined ? current.whisperBin : loadPrefsValue(input.whisperBin, current.whisperBin),
          model: input.model === undefined ? current.model : loadPrefsValue(input.model, current.model),
          beeps: input.beeps === undefined ? current.beeps : loadPrefsBoolean(input.beeps, current.beeps),
        }
        await ctx.storage.set(PREFS_KEY, { ...next })
        return next
      },
    })
  },
})
