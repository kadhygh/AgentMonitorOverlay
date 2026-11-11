import { describe, expect, it } from "vitest";
import { nativeImageKind } from "./saveFile.js";

describe("nativeImageKind", () => {
  it("knows PNG and JPEG by their first bytes, nothing else (those are turned into PNG first)", () => {
    expect(nativeImageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(nativeImageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(nativeImageKind(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(nativeImageKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(nativeImageKind(new TextEncoder().encode("RIFF....WEBP"))).toBeNull();
    expect(nativeImageKind(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});
