import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_EXIT, marketingVersion, plan, withMarketingVersion } from "./ios-release.mjs";
import { studio } from "./amo-tools.mjs";

// The iOS app to TestFlight (2026-11-02, plans/ios.md): the version file release.mjs bumps, and the commands sent to
// the build Mac — only checked values go into its shell.

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("Version.xcconfig", () => {
  it("reads and writes MARKETING_VERSION, leaving the rest", () => {
    const text = "// note\nMARKETING_VERSION = 0.0.0\nCURRENT_PROJECT_VERSION = 1\n";
    expect(marketingVersion(text)).toBe("0.0.0");
    const next = withMarketingVersion(text, "0.1.0");
    expect(next).toBe("// note\nMARKETING_VERSION = 0.1.0\nCURRENT_PROJECT_VERSION = 1\n");
    expect(withMarketingVersion(text.replace(/\n/g, "\r\n"), "0.1.0")).toBe(next.replace(/\n/g, "\r\n"));
  });

  it("says when there is none", () => {
    expect(() => marketingVersion("CURRENT_PROJECT_VERSION = 1\n")).toThrow(/MARKETING_VERSION/);
  });

  it("the repository's file is readable", () => {
    expect(marketingVersion(readFileSync(join(studio, "mobile", "iosApp", "Version.xcconfig"), "utf8"))).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("plan", () => {
  it("unpacks one commit's studio/mobile in its own folder and queues its build for the agent", () => {
    const p = plan(SHA, "0.1.0", 2981);
    expect(p.archive).toEqual(["-c", "core.autocrlf=false", "archive", "--format=tar", SHA, "studio/mobile"]);
    expect(p.unpack).toBe("rm -rf ~/amo-ios-build/src/0123456789 && mkdir -p ~/amo-ios-build/src/0123456789 && tar -xf - -C ~/amo-ios-build/src/0123456789");
    expect(p.build).toBe("bash ~/amo-ios-build/src/0123456789/studio/mobile/iosApp/submit-build.sh ~/amo-ios-build/src/0123456789/studio/mobile 0.1.0 2981");
    expect(p.logs).toBe("amo-ios-build/logs/0.1.0-2981");
    expect(plan(SHA, "0.1.0", 2981, { upload: false }).build).toMatch(/ --no-upload$/);
  });

  it("refuses what could reach the remote shell", () => {
    expect(() => plan("HEAD", "0.1.0", 1)).toThrow(/提交号/);
    expect(() => plan(SHA, "0.1.0; rm -rf ~", 1)).toThrow(/版本号/);
    expect(() => plan(SHA, "0.1.0", "1 && x")).toThrow(/构建号/);
  });

  it("busy is build-on-mac.sh's first step", () => {
    const script = readFileSync(join(studio, "mobile", "iosApp", "build-on-mac.sh"), "utf8");
    expect(BUSY_EXIT).toBe(11);
    expect(script).toContain("exit $((10 + STEP))");
    expect(script).toMatch(/step 1 busy/);
  });
});
