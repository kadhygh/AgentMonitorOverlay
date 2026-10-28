import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { acceptDataDir, platformDataDir, readPortableConfig, resolveDataDir, writePortableConfig } from "./paths.js";

let root: string | undefined;
afterEach(() => {
  if (root) removeTempDir(root);
  root = undefined;
});
const portable = () => (root = mkdtempSync(join(tmpdir(), "amo-studio-test-paths-")));

describe("resolveDataDir", () => {
  it("uses studio/.data in development and the env var when set", () => {
    expect(resolveDataDir({ env: {}, portableDir: null, studioRoot: "D:\\studio" })).toEqual({ dataDir: join("D:\\studio", ".data"), source: "dev", configPath: null, firstRun: false });
    expect(resolveDataDir({ env: { AMO_STUDIO_DATA_DIR: "D:\\elsewhere" }, portableDir: null, studioRoot: "D:\\studio" })).toMatchObject({ dataDir: "D:\\elsewhere", source: "env", firstRun: false });
  });

  it("in the portable build, defaults to data/ next to the exe and asks on first run", () => {
    const dir = portable();
    expect(resolveDataDir({ env: {}, portableDir: dir, studioRoot: "x" })).toEqual({ dataDir: join(dir, "data"), source: "portable-default", configPath: join(dir, "amo-studio.json"), firstRun: true });
  });

  it("installed by AMO 平台: the data dir set there, read only by a platform-mode build, after the env var", () => {
    const dir = portable();
    const app = join(dir, "resources", "app");
    const home = join(dir, "amo-home");
    mkdirSync(app, { recursive: true });
    mkdirSync(home, { recursive: true });
    const env = { AMO_HOME: home };
    writeFileSync(join(home, "platform.json"), JSON.stringify({ studioDataDir: "D:\\AMO\\studio-data" }));
    writeFileSync(join(app, "package.json"), JSON.stringify({ amoBuild: { mode: "portable" } }));
    expect(platformDataDir(app, env)).toBeNull();
    writeFileSync(join(app, "package.json"), JSON.stringify({ amoBuild: { mode: "platform", runtime: "44.7.0" } }));
    expect(platformDataDir(app, env)).toBe("D:\\AMO\\studio-data");
    expect(resolveDataDir({ env, portableDir: dir, studioRoot: "x", platformDataDir: platformDataDir(app, env) })).toEqual({ dataDir: "D:\\AMO\\studio-data", source: "platform", configPath: join(dir, "amo-studio.json"), firstRun: false });
    expect(resolveDataDir({ env: { ...env, AMO_STUDIO_DATA_DIR: "D:\\given" }, portableDir: dir, studioRoot: "x", platformDataDir: "D:\\AMO\\studio-data" }).source).toBe("env");
    writeFileSync(join(home, "platform.json"), JSON.stringify({ studioDataDir: null }));
    expect(platformDataDir(app, env)).toBeNull();
  });

  it("uses the saved choice, relative paths against the exe's folder", () => {
    const dir = portable();
    writePortableConfig(join(dir, "amo-studio.json"), { dataDir: "my-data" });
    expect(resolveDataDir({ env: {}, portableDir: dir, studioRoot: "x" })).toMatchObject({ dataDir: join(dir, "my-data"), source: "config", firstRun: false });
    writePortableConfig(join(dir, "amo-studio.json"), { dataDir: "D:\\AMO\\data" });
    expect(resolveDataDir({ env: {}, portableDir: dir, studioRoot: "x" }).dataDir).toBe("D:\\AMO\\data");
  });

  it("treats a broken config as no choice", () => {
    const dir = portable();
    writeFileSync(join(dir, "amo-studio.json"), "{ nope");
    expect(readPortableConfig(join(dir, "amo-studio.json"))).toBeNull();
    expect(resolveDataDir({ env: {}, portableDir: dir, studioRoot: "x" }).firstRun).toBe(true);
    writeFileSync(join(dir, "amo-studio.json"), "\uFEFF{\"dataDir\":\"d\"}");
    expect(readPortableConfig(join(dir, "amo-studio.json"))).toEqual({ dataDir: "d" });
  });
});

describe("acceptDataDir", () => {
  it("creates the dir and saves it relative when it is inside the portable folder", () => {
    const dir = portable();
    expect(acceptDataDir(" my-data ", dir)).toEqual({ dataDir: join(dir, "my-data"), saved: "my-data" });
    expect(existsSync(join(dir, "my-data"))).toBe(true);
    const outside = `${dir}-outside`;
    try {
      expect(acceptDataDir(outside, dir)).toEqual({ dataDir: outside, saved: outside });
    } finally {
      removeTempDir(outside);
    }
  });
});
