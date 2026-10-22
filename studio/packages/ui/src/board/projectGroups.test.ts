import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "@amo-studio/protocol";
import { groupProjects, joinGroup, moveGroup } from "./projectGroups.js";

const group = (id: string, workspaceIds: string[]): ProjectGroup => ({ id, name: id, description: "", workspaceIds });
const groups = [group("client", ["a", "b"]), group("tools", ["c"])];
const projects = ["c", "b", "x", "a"].map((id) => ({ id }));

describe("项目分组", () => {
  it("splits the projects by group, keeping the order they come in", () => {
    const split = groupProjects(projects, groups);
    expect(split.groups.map((g) => [g.group.id, g.projects.map((p) => p.id)])).toEqual([
      ["client", ["b", "a"]],
      ["tools", ["c"]],
    ]);
    expect(split.loose.map((p) => p.id)).toEqual(["x"]);
  });

  it("moves a project into one group, or out of all of them", () => {
    expect(joinGroup(groups, "a", "tools").map((g) => g.workspaceIds)).toEqual([["b"], ["c", "a"]]);
    expect(joinGroup(groups, "x", "client").map((g) => g.workspaceIds)).toEqual([["a", "b", "x"], ["c"]]);
    expect(joinGroup(groups, "a", null).map((g) => g.workspaceIds)).toEqual([["b"], ["c"]]);
  });

  it("moves a group before or after another", () => {
    const three = [...groups, group("art", [])];
    expect(moveGroup(three, "art", "client", false).map((g) => g.id)).toEqual(["art", "client", "tools"]);
    expect(moveGroup(three, "client", "tools", true).map((g) => g.id)).toEqual(["tools", "client", "art"]);
    expect(moveGroup(three, "client", "nope", true).map((g) => g.id)).toEqual(["client", "tools", "art"]);
  });
});
