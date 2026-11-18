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
        },
        required: ["lang", "threads", "whisperBin", "model"],
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
        },
      },
      output: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
        },
        required: ["lang", "threads", "whisperBin", "model"],
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export type Prefs = { lang: string; threads: number; whisperBin: string; model: string }
export type StartResult = { recording: boolean; startedAt: number }
export type StopResult = { text: string; seconds: number }
export type StatusResult = { recording: boolean; seconds: number; lastError: string }
