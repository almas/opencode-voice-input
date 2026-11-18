// @vitest-environment node
import { describe, expect, it } from "vitest"
import { stripSilenceHallucinations } from "../src/index"

describe("stripSilenceHallucinations", () => {
  it("empties pure whisper hallucinations", () => {
    for (const said of [
      "ご視聴ありがとうございました",
      "ご視聴いただきありがとうございました",
      "ご清聴ありがとうございました",
      "字幕ご協力ありがとうございました",
      "日本語の字幕を確認しました",
      "チャンネル登録よろしくお願いします",
      "Thanks for watching!",
      "thanks for watching",
    ]) {
      expect(stripSilenceHallucinations(said), said).toBe("")
    }
  })

  it("keeps real speech next to a hallucination", () => {
    expect(stripSilenceHallucinations("今日は天気がいいですね。ご視聴ありがとうございました")).toBe("今日は天気がいいですね。")
    expect(stripSilenceHallucinations("チャネル登録お願いします。会議は14時からです")).toContain("会議は14時からです")
  })

  it("drops invented non-speech markers", () => {
    expect(stripSilenceHallucinations("【音楽】")).toBe("")
    expect(stripSilenceHallucinations("（拍手）")).toBe("")
    expect(stripSilenceHallucinations("[Applause]")).toBe("")
    expect(stripSilenceHallucinations("了解です【音】了解です")).toBe("了解です了解です")
  })

  it("leaves ordinary text alone", () => {
    const plain = "プラグインのビルドが完了しました。テストを実行します。"
    expect(stripSilenceHallucinations(plain)).toBe(plain)
    // Code-looking speech must survive: brackets only vanish in marker shape.
    expect(stripSilenceHallucinations("app.tsx を直します")).toBe("app.tsx を直します")
  })

  it("trims orphan punctuation left behind", () => {
    expect(stripSilenceHallucinations("。ご視聴ありがとうございました、")).toBe("")
    expect(stripSilenceHallucinations("！はい、わかりました")).toBe("はい、わかりました")
  })

  it("does not blow up on long input", () => {
    const long = "あ".repeat(100_000)
    expect(stripSilenceHallucinations(long)).toBe(long)
  })
})
