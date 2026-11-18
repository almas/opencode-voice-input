/**
 * Voice Input — RPC contract shared by the server and GUI halves.
 *
 * Plain JSON Schema literals: the server validates input and output with
 * them, and the GUI types its client proxy from the same definition.
 */
import type { Rpc } from "@opencode/schema/rpc"

export const VoiceInputRpc = {
  id: "voice-input",
  methods: {
    // Start recording from the default microphone (pw-record).
    start: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          recording: { type: "boolean" },
          startedAt: { type: "number" },
        },
        required: ["recording"],
      },
    },
    // Stop recording, transcribe with whisper.cpp and return the text.
    stop: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["text"],
      },
    },
    // Re-transcribe the take whose previous transcription failed.
    retry: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["text"],
      },
    },
    // Drop the kept-over failed take without retrying.
    discardTake: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: { discarded: { type: "boolean" } },
        required: ["discarded"],
      },
    },
    // Stop recording and throw the audio away.
    cancel: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: { cancelled: { type: "boolean" } },
        required: ["cancelled"],
      },
    },
    // Recorder state, so a fresh GUI window can resync.
    status: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          recording: { type: "boolean" },
          seconds: { type: "number" },
          lastError: { type: "string" },
          hasLastTake: { type: "boolean" },
        },
        required: ["recording"],
      },
    },
    // User preferences.
    prefs: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          beeps: { type: "boolean" },
        },
        required: ["lang", "threads", "whisperBin", "model", "beeps"],
      },
    },
    setPrefs: {
      input: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          beeps: { type: "boolean" },
        },
      },
      output: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          beeps: { type: "boolean" },
        },
        required: ["lang", "threads", "whisperBin", "model", "beeps"],
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export type Prefs = { lang: string; threads: number; whisperBin: string; model: string; beeps: boolean }
export type StartResult = { recording: boolean; startedAt: number }
export type StopResult = { text: string; seconds: number }
export type StatusResult = { recording: boolean; seconds: number; lastError: string; hasLastTake: boolean }
