import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { encodeWav, findWavDataOffset, joinJa, readWavSlice } from "../src/index"

describe("findWavDataOffset", () => {
  it("finds the data chunk in a canonical pw-record header", () => {
    const pcm = Buffer.alloc(320, 7)
    const offset = findWavDataOffset(encodeWav(pcm, 16_000, 1))
    expect(offset).toBe(44)
  })

  it("skips extra chunks before data", () => {
    const header = Buffer.alloc(44 + 16)
    header.write("RIFF", 0)
    header.write("LIST", 12)
    header.writeUInt32LE(8, 16)
    header.write("INFO", 20)
    header.write("info", 24)
    header.writeUInt32LE(0, 28)
    header.write("data", 44)
    header.writeUInt32LE(4, 48)
    expect(findWavDataOffset(header)).toBe(52)
  })

  it("falls back to 44 without a data chunk", () => {
    expect(findWavDataOffset(Buffer.alloc(20))).toBe(44)
  })
})

describe("encodeWav / readWavSlice round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "vi-wav-test-"))
  const pcm = Buffer.alloc(16_000 * 2)
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i / 2) % 1000, i)
  const file = join(dir, "take.wav")
  writeFileSync(file, encodeWav(pcm, 16_000, 1))

  it("reads slices by data-relative offsets", () => {
    expect(readWavSlice(file, 0, 4).equals(pcm.subarray(0, 4))).toBe(true)
    expect(readWavSlice(file, 1000, 2000).equals(pcm.subarray(1000, 2000))).toBe(true)
  })

  it("clamps past the end and yields empty on inverted ranges", () => {
    expect(readWavSlice(file, pcm.length - 4, pcm.length + 10_000).length).toBe(4)
    expect(readWavSlice(file, 500, 500).length).toBe(0)
  })

  it("writes a 16 kHz mono s1le header", () => {
    const wav = encodeWav(Buffer.alloc(100), 16_000, 1)
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF")
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(100)
    expect(wav.length).toBe(144)
  })

  it("cleans up", () => rmSync(dir, { recursive: true, force: true }))
})

describe("joinJa", () => {
  it("joins segment texts with a single space and trims", () => {
    expect(joinJa("おはよう ", " 天気だね")).toBe("おはよう 天気だね")
    expect(joinJa("", "これだけ")).toBe("これだけ")
    expect(joinJa("これだけ", "   ")).toBe("これだけ")
    expect(joinJa("", "")).toBe("")
  })
})
