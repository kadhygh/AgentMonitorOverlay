import { requestCardJson } from "./cardClient";
import type { TaskGroup } from "../focus/model";

export type TaskGroupCommand = { type: "create"; name: string; dragOnly: boolean }
  | { type: "update"; groupId: string; name: string; dragOnly: boolean }
  | { type: "delete"; groupId: string };
export interface TaskGroupOperation { operationId: string; expectedRevision: number; commands: TaskGroupCommand[] }
export interface TaskGroupSnapshot { schemaVersion: 1; revision: number; groups: TaskGroup[] }
export const updateTaskGroups = (operation: TaskGroupOperation) => requestCardJson<TaskGroupSnapshot>("http://127.0.0.1:17654/api/card-groups/commands", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation),
});
