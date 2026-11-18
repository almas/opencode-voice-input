// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  DEFAULT_PREFS,
  MIN_AUDIO_BYTES,
  loadLang,
  loadPrefsBoolean,
  loadPrefsNumber,
  loadPrefsSource,
  loadPrefsValue,
} from "../src/index"

describe("prefs loaders", () => {
  it("trims strings and falls back on blanks", () => {
    expect(loadPrefsValue("  whisper-cli  ", "fb")).toBe("whisper-cli")
    expect(loadPrefsValue("   ", "fb")).toBe("fb")
    expect(loadPrefsValue(undefined, "fb")).toBe("fb")
    expect(loadPrefsValue(42, "fb")).toBe("fb")
  })

  it("clamps thread counts into 1..128", () => {
    expect(loadPrefsNumber(24, 1)).toBe(24)
    expect(loadPrefsNumber(24.7, 1)).toBe(25)
    expect(loadPrefsNumber(0, 1)).toBe(1)
    expect(loadPrefsNumber(-10, 1)).toBe(1)
    expect(loadPrefsNumber(5000, 1)).toBe(128)
    expect(loadPrefsNumber("abc", 7)).toBe(7)
    expect(loadPrefsNumber(NaN, 7)).toBe(7)
  })

  it("only accepts language-code shaped strings", () => {
    for (const ok of ["ja", "en", "auto", "ja-JP", "en-US"]) {
      expect(loadLang(ok, "ja")).toBe(ok)
    }
    // Anything else must not reach a shell argument or a whisper flag.
    for (const bad of ["J", "日本語", "ja_JP", "en US", "--model", "a".repeat(40)]) {
      expect(loadLang(bad, "ja")).toBe("ja")
    }
  })

  it("reads booleans strictly", () => {
    expect(loadPrefsBoolean(true, false)).toBe(true)
    expect(loadPrefsBoolean(false, true)).toBe(false)
    expect(loadPrefsBoolean("true", false)).toBe(false)
    expect(loadPrefsBoolean(undefined, true)).toBe(true)
  })

  it("keeps an explicit empty audio source (system default)", () => {
    expect(loadPrefsSource("", "alsa_output")).toBe("")
    expect(loadPrefsSource("  hw:1,0 ", "d")).toBe("hw:1,0")
    expect(loadPrefsSource(undefined, "d")).toBe("d")
  })

  it("ships safe defaults", () => {
    expect(DEFAULT_PREFS.lang).toBe("ja")
    expect(DEFAULT_PREFS.threads).toBeLessThanOrEqual(128)
    // A take shorter than this captured nothing; never send it to whisper.
    expect(MIN_AUDIO_BYTES).toBeGreaterThan(0)
  })
})
