import type { ReactNode } from "react";
import type { ChecklistItem, DecisionRequest, MailMessage, OptionalFeature, ScheduleProposal, StateSnapshot, TodoItem } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import type { Scope } from "../board/Board.js";

// What a feature hands the shell (ui/src/features.ts lists them): its pages ("views"), the top-bar tab that opens
// one, and panels it adds to other pages. The shell keeps the view in state and renders the one in front.

// `nav` changes when Focus asks for a session, so an already open task page re-opens on that session.
export type View =
  | { kind: "board" }
  | { kind: "canvas" }
  | { kind: "new"; topicId?: string }
  | { kind: "packs"; workspaceId: string }
  | { kind: "task"; taskId: string; sessionId?: string; nav?: number };

/** Live data several pages share, loaded once by the shell. */
export interface AppData {
  unreadMail: readonly MailMessage[];
  openDecisions: readonly DecisionRequest[];
  /** Open decisions per task. */
  decisionsByTask: ReadonlyMap<string, number>;
  checklist: readonly ChecklistItem[];
  proposals: readonly ScheduleProposal[];
  todos: readonly TodoItem[];
}

export interface ViewContext {
  link: HostLink;
  state: StateSnapshot;
  scope: Scope;
  data: AppData;
  /** Optional features turned off (设置 → 功能). */
  disabled: readonly OptionalFeature[];
  setView(view: View): void;
}

export interface ViewDef<K extends View["kind"] = View["kind"]> {
  kind: K;
  /** The optional feature it belongs to: gone while that is turned off. */
  feature?: OptionalFeature;
  /** A tab in the top bar: the view it opens in this scope, or null when it does not apply there. */
  tab?: { label: string; open(scope: Scope): View | null; /** Other views during which the tab shows as current. */ alsoFor?: View["kind"][] };
  render(view: Extract<View, { kind: K }>, ctx: ViewContext): ReactNode;
}

/** Any one feature's view, whatever its kind. */
export type AnyViewDef = { [K in View["kind"]]: ViewDef<K> }[View["kind"]];

/** Something a feature shows above the board. */
export interface BoardPanel {
  feature?: OptionalFeature;
  render(ctx: ViewContext): ReactNode;
}
