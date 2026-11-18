/**
 * Voice Input — the server half of the plugin.
 *
 * Registers the `voice-input` RPC domain: it records the default microphone
 * with pw-record (16 kHz mono s16 wav), transcribes the take with whisper-cli
 * (whisper.cpp) and returns the text, which the GUI inserts into the composer.
 * Recording state lives here, so every GUI window sees the same recorder.
 */
import { execFile } from "node:child_process"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import { Plugin } from "@opencode/plugin"
import { VoiceInputRpc, type Prefs, type SourceInfo, type SourcesResult, type StartResult, type StatusResult, type StopResult } from "./rpc"

const PREFS_KEY = "voice-input/prefs"
const MAX_RECORD_SECONDS = 300
/** 16 kHz mono s16 is 32 kB/s; anything under ~0.25 s captured nothing usable. */
export const MIN_AUDIO_BYTES = 8000

const LOCAL = join(homedir(), ".local")
const LIB_DIR = join(LOCAL, "usr/lib/x86_64-linux-gnu")

function defaultWhisperBin(): string {
  const local = join(LOCAL, "bin/whisper-cli")
  return existsSync(local) ? local : "whisper-cli"
}

export const DEFAULT_PREFS: Prefs = {
  lang: "ja",
  threads: 24,
  whisperBin: defaultWhisperBin(),
  model: join(LOCAL, "share/whisper-models/ggml-large-v3-turbo.bin"),
  source: "",
  beeps: true,
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout)
    })
  })
}

export function loadPrefsValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

export function loadPrefsNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.min(128, Math.round(n)))
}

export function loadLang(value: unknown, fallback: string): string {
  const lang = loadPrefsValue(value, fallback)
  return /^(auto|[a-z]{2}(-[A-Za-z]{2})?)$/.test(lang) ? lang : fallback
}

export function loadPrefsBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** Empty is meaningful here: "use the system default source". */
export function loadPrefsSource(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback
}

interface Active {
  child: ChildProcessByStdio<null, null, Readable>
  file: string
  startedAt: number
  stderr: string
  stopping: boolean
  timer: ReturnType<typeof setTimeout>
  worker?: SegmentWorker
}

/** Segment length for recording-time transcription (16 kHz mono s16 = 32 kB/s). */
const SEGMENT_BYTES = 16_000 * 2 * 8
/** Only re-transcribe the pending tail once it reaches ~2 s of audio. */
const MIN_TAIL_BYTES = 16_000 * 2 * 2
const BYTES_PER_SAMPLE = 2

/** Byte offset where the s16 samples start in a pw-record wav (44 for canonical headers). */
export function findWavDataOffset(buf: Buffer): number {
  for (let i = 12; i + 8 <= buf.length; ) {
    const id = buf.toString("latin1", i, i + 4)
    const size = buf.readUInt32LE(i + 4)
    if (id === "data") return i + 8
    if (size > 0x1000_0000) break
    i += 8 + size + (size % 2)
  }
  return 44
}

/** Transcribe one slice; -sns keeps short slices free of invented noise tags. */
function runSegment(wav: string, prefs: Prefs): Promise<string> {
  return transcribe(wav, prefs, ["-sns"])
}

/** Read `from`..`to` bytes of PCM samples, counted from the start of the data chunk. */
export function readWavSlice(file: string, from: number, to: number): Buffer {
  const whole = readFileSync(file)
  const dataOffset = findWavDataOffset(whole)
  const start = Math.min(whole.length, dataOffset + from)
  const end = Math.min(whole.length, dataOffset + to)
  if (end <= start) return Buffer.alloc(0)
  return whole.subarray(start, end)
}

export function encodeWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE((sampleRate * channels * 2) | 0, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function joinJa(a: string, b: string): string {
  if (!a.trim()) return b.trim()
  if (!b.trim()) return a.trim()
  return `${a.trim()} ${b.trim()}`
}

/**
 * Streams transcription while you speak.
 *
 * pw-record keeps writing the wav for the whole take, so the worker slices the
 * bytes recorded so far into segments and runs whisper-cli on each one in a
 * queue, in order. When you stop, only the tail slice is left to process,
 * which removes the wait for re-transcribing the whole take. A slice error
 * never loses the take: the final pass still runs on the complete wav.
 */
class SegmentWorker {
  private stable = ""
  private tentative = ""
  private cursor = 0
  private started = new Set<number>()
  private queue: Promise<void> = Promise.resolve()
  private lastSize = -1
  private stopped = false

  constructor(
    private readonly file: string,
    private readonly prefs: () => Promise<Prefs>,
  ) {}

  get stableText(): string {
    return this.stable
  }

  /** Live caption: completed segments plus the tentative tail pass. */
  get caption(): string {
    return joinJa(this.stable, this.tentative)
  }

  /** Called by the status poller: transcribe any newly recorded audio. */
  async progress(): Promise<void> {
    if (this.stopped) return
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    const body = Math.max(0, size - 44)
    if (body === this.lastSize) return
    this.lastSize = body
    const start = Math.floor(this.cursor / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
    const end = Math.floor(body / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
    // Keep a partial for the audio that full segments do not cover yet.
    if (end - start >= MIN_TAIL_BYTES) {
      const from = Math.max(start, end - SEGMENT_BYTES)
      this.enqueue(from, end, true)
    }
    while (this.cursor + SEGMENT_BYTES <= end) {
      const to = this.cursor + SEGMENT_BYTES
      this.enqueue(this.cursor, to, false)
      this.cursor = to
    }
  }

  /** Stop recording-time work, process the tail, and return the full text. */
  async finish(): Promise<string> {
    this.stopped = true
    await this.progress()
    this.queue = this.queue.then(async () => {
      let size = 0
      try {
        size = statSync(this.file).size
      } catch {}
      const body = Math.max(0, size - 44)
      const end = Math.floor(body / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
      const start = Math.floor(this.cursor / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
      if (end - start >= MIN_AUDIO_BYTES) {
        try {
          this.tentative = await this.run(start, end, false)
        } catch {
          this.tentative = ""
        }
      }
      this.stable = joinJa(this.stable, this.tentative)
      this.tentative = ""
    })
    await this.queue
    return joinJa(this.stable, this.tentative)
  }

  kill(): void {
    this.stopped = true
  }

  private enqueue(from: number, to: number, tentative: boolean): void {
    if (this.stopped) return
    const key = tentative ? -1 : from
    if (this.started.has(key)) return
    this.started.add(key)
    if (!tentative) for (const other of [...this.started]) if (other >= 0 && other < from) this.started.delete(other)
    this.queue = this.queue.then(async () => {
      if (this.stopped && tentative) return
      const text = await this.run(from, to, tentative)
      if (tentative) this.tentative = text
      else {
        this.stable = joinJa(this.stable, text)
        this.tentative = ""
      }
    })
  }

  private async run(from: number, to: number, tentative: boolean): Promise<string> {
    const prefs = await this.prefs()
    const slice = join(dirname(this.file), `seg-${tentative ? "tail" : from}.wav`)
    try {
      const pcm = readWavSlice(this.file, from, to)
      if (!pcm || pcm.length < MIN_AUDIO_BYTES) return ""
      writeFileSync(slice, encodeWav(pcm, 16_000, 1))
      let text = await runSegment(slice, prefs)
      if (!text && tentative) text = stripSilenceHallucinations(await transcribe(this.file, prefs))
      return text
    } catch (error) {
      // A slice that fails must not break the queue; stop()'s final pass on
      // the complete wav still covers everything the slice missed.
      if (tentative) return ""
      throw error
    } finally {
      try {
        unlinkSync(slice)
      } catch {}
    }
  }
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
  /(ご視聴(?:いただき)?ありがとうございました|ご清聴ありがとうございました|字幕ご協力ありがとうございました|日本語の字幕を確認しました|チャンネル登録(?:を)?(?:お願いします|よろしくお願いします)?|thanks?\s+for\s+watching!?)/gi

/** Bracketed non-speech markers whisper invents: 【音楽】（拍手）[Applause]. */
const NON_SPEECH_MARKER = /[【[(（［][^】\])］（）()]{0,16}[】\])）］]/g

export function stripSilenceHallucinations(text: string): string {
  const out = text.replace(SILENCE_HALLUCINATION_RE, "").replace(NON_SPEECH_MARKER, "")
  // Leading orphans go entirely; a trailing run collapses to one character so
  // a real sentence-ending "。" survives while leftovers like "。、" shrink.
  return out
    .replace(/^[\s。、．!！？?,;:]+/, "")
    .replace(/[。、．!！？?,;:]{2,}$/, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function transcribe(wav: string, prefs: Prefs, extraArgs: string[] = []): Promise<string> {
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
      ["-m", prefs.model, "-f", wav, "-l", prefs.lang, "-t", String(prefs.threads), "-np", ...extraArgs, "-otxt", "-of", out],
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
          source: loadPrefsSource(stored.source, DEFAULT_PREFS.source),
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
      const source = (await load()).source
      const dir = mkdtempSync(join(tmpdir(), "opencode-voice-input-"))
      const file = join(dir, "take.wav")
      const child = spawn(
        "pw-record",
        [
          "--rate",
          "16000",
          "--channels",
          "1",
          "--format",
          "s16",
          "--latency",
          "50ms",
          ...(source ? ["--target", source] : []),
          file,
        ],
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
        worker: new SegmentWorker(file, load),
        timer: setTimeout(() => {
          if (active === rec && !rec.stopping) {
            rec.stopping = true
            active = undefined
            rec.worker?.kill()
            void terminate(rec).then(() => {
              // Keep the long take instead of losing it: the GUI offers 再試行.
              if (lastTake) discardDirOf(lastTake.file)
              lastTake = { file: rec.file, seconds: MAX_RECORD_SECONDS }
              lastError = `上限の${MAX_RECORD_SECONDS}秒に達したため録音を停止しました。再試行で文字起こしできます。`
            })
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
        rec.worker?.kill()
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
        // Use the segments already transcribed during recording; only the
        // tail is processed now. If the worker hit any trouble, fall back to
        // one whisper pass over the whole wav so the take is never lost.
        let text = ""
        if (rec.worker) {
          try {
            text = await rec.worker.finish()
          } catch {
            text = ""
          }
        }
        if (!text) text = await transcribe(rec.file, prefs)
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
      rec.worker?.kill()
      await terminate(rec)
      discard(rec)
      return { cancelled: true }
    }

    /** List PipeWire capture sources so the settings page can offer a picker. */
    const listSources = async (): Promise<SourcesResult> => {
      const [dump, meta] = await Promise.all([
        runCommand("pw-dump", []),
        runCommand("pw-metadata", ["-n", "default"]),
      ])
      let defaultName = ""
      const match = meta.match(/default\.audio\.source'\s+value:'(\{[^']*\})'/)
      const payload = match?.[1]
      if (payload) {
        try {
          const parsed = JSON.parse(payload) as { name?: unknown }
          if (typeof parsed.name === "string") defaultName = parsed.name
        } catch {}
      }
      if (!dump) return { sources: [] }
      try {
        const nodes = JSON.parse(dump) as Array<Record<string, any>>
        const sources: SourceInfo[] = []
        for (const node of nodes) {
          const props = (node?.info?.props ?? {}) as Record<string, any>
          if (props["media.class"] !== "Audio/Source") continue
          const name = String(props["node.name"] ?? "")
          const id = Number(node?.id ?? 0)
          if (!name || !Number.isFinite(id) || id <= 0) continue
          sources.push({
            id,
            name,
            description: String(props["node.description"] ?? props["node.nick"] ?? name),
            default: name === defaultName,
          })
        }
        return { sources }
      } catch {
        return { sources: [] }
      }
    }

    await ctx.rpc.register(VoiceInputRpc, {
      start,
      stop,
      retry,
      discardTake,
      cancel,
      sources: listSources,
      status: async (): Promise<StatusResult> => {
        const worker = active?.worker
        if (worker) await worker.progress().catch(() => {})
        return {
          recording: active !== undefined,
          seconds: active ? (Date.now() - active.startedAt) / 1000 : 0,
          lastError,
          hasLastTake: lastTake !== undefined,
          partial: active ? worker?.caption ?? "" : "",
          partialStable: active ? worker?.stableText ?? "" : "",
        }
      },
      prefs: async () => await load(),
      setPrefs: async (raw) => {
        const input = (raw ?? {}) as Partial<Prefs>
        const current = await load()
        const next: Prefs = {
          lang: input.lang === undefined ? current.lang : loadLang(input.lang, current.lang),
          threads: input.threads === undefined ? current.threads : loadPrefsNumber(input.threads, current.threads),
          whisperBin: input.whisperBin === undefined ? current.whisperBin : loadPrefsValue(input.whisperBin, current.whisperBin),
          model: input.model === undefined ? current.model : loadPrefsValue(input.model, current.model),
          source: input.source === undefined ? current.source : loadPrefsSource(input.source, current.source),
          beeps: input.beeps === undefined ? current.beeps : loadPrefsBoolean(input.beeps, current.beeps),
        }
        await ctx.storage.set(PREFS_KEY, { ...next })
        return next
      },
    })
  },
})
