import { describe, expect, it } from "vitest";
import { openText, parseOpenArg, parseOpenValue } from "./open-arg.js";

// What the client is asked to open from its arguments (2026-11-23): --open=cowork:<id> / thread:<id>, and the older
// --open-thread <id>.

const exe = ["C:/AMO/中转/AMO 中转.exe"];

describe("parseOpenArg", () => {
  it("takes --open=cowork:<id> and --open=thread:<id>", () => {
    expect(parseOpenArg([...exe, "--open=cowork:t_0123abcd"])).toEqual({ kind: "cowork", id: "t_0123abcd" });
    expect(parseOpenArg([...exe, "--open=thread:t_9f"])).toEqual({ kind: "thread", id: "t_9f" });
  });

  it("takes the value as the next argument too", () => {
    expect(parseOpenArg([...exe, "--open", "cowork:t_1"])).toEqual({ kind: "cowork", id: "t_1" });
  });

  it("keeps --open-thread <id> (Studio's 在中转里打开 since 2026-11-05) as a thread", () => {
    expect(parseOpenArg([...exe, "--open-thread", "t_abc"])).toEqual({ kind: "thread", id: "t_abc" });
  });

  it("finds it among the other arguments (a second start's argv has Chromium's own)", () => {
    expect(parseOpenArg([...exe, "--server", "http://172.16.8.85:47120", "--allow-file-access-from-files", "--open=cowork:t_77", "--original-process-start-time=1"])).toEqual({ kind: "cowork", id: "t_77" });
  });

  it("the last one wins", () => {
    expect(parseOpenArg([...exe, "--open-thread", "t_old", "--open=cowork:t_new"])).toEqual({ kind: "cowork", id: "t_new" });
  });

  it("refuses other kinds, empty, long or odd ids, and nothing to open", () => {
    expect(parseOpenArg(exe)).toBeNull();
    expect(parseOpenArg([...exe, "--open="])).toBeNull();
    expect(parseOpenArg([...exe, "--open=cowork:"])).toBeNull();
    expect(parseOpenArg([...exe, "--open=task:t_1"])).toBeNull();
    expect(parseOpenArg([...exe, "--open=studio:d_1:s-1"])).toBeNull();
    expect(parseOpenArg([...exe, "--open=cowork:t_1/../x"])).toBeNull();
    expect(parseOpenArg([...exe, "--open=cowork:<b>"])).toBeNull();
    expect(parseOpenArg([...exe, `--open=cowork:${"a".repeat(81)}`])).toBeNull();
    expect(parseOpenArg([...exe, "--open"])).toBeNull();
    expect(parseOpenArg([...exe, "--open-thread"])).toBeNull();
    expect(parseOpenArg([...exe, "--open-thread", "--server"])).toBeNull();
    // an id with the kind's colon in it is not one
    expect(parseOpenValue("cowork:t_1:x")).toBeNull();
  });

  it("gives the content <kind>:<id>", () => {
    expect(openText({ kind: "cowork", id: "t_1" })).toBe("cowork:t_1");
  });
});
