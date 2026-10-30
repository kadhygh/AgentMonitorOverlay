// 问题页 (2026-10-31, plans/issues.md): the person reports AMO's problems on the team server's /issues page (a line or
// two and screenshots); Studio's 值守 fetches them, fixes each in a session, answers on the issue and sets its status;
// 发布打包 on the page asks for a test build. Shared by the service, the page and Studio's Host.

export const ISSUE_STATUSES = ["new", "working", "asking", "fixed", "released", "stuck", "closed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  new: "新",
  working: "修复中",
  asking: "等你回答",
  fixed: "已修好，待发布",
  released: "已发布",
  stuck: "卡住了",
  closed: "不修了",
};

/** The tools an issue can be about (the platform's tool ids); "" = not said. */
export const ISSUE_TOOLS: Record<string, string> = {
  studio: "AMO Studio",
  notes: "AMO 便签",
  reviewer: "AMO Reviewer",
  platform: "AMO 平台",
  relay: "AMO 中转",
};

/** Pictures only (screenshots), each at most MAX_FILE_BYTES, a few per entry. */
export const ISSUE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ISSUE_IMAGES_PER_ENTRY = 8;

export interface IssueImage {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface IssueEntry {
  id: string;
  seq: number;
  author: string;
  /** Written by Studio's AI (值守's session), as the person's account. */
  ai: boolean;
  /** report: what the issue says first; comment: a word after it; status: only the status changed. */
  kind: "report" | "comment" | "status";
  body: string;
  images: IssueImage[];
  /** The status this entry set, if any. */
  status: IssueStatus | null;
  at: number;
}

export interface Issue {
  /** #1, #2… in the order they were reported. */
  number: number;
  title: string;
  author: string;
  status: IssueStatus;
  /** ISSUE_TOOLS id or "". */
  tool: string;
  /** The version the person had, as they gave it or the page filled it; "". */
  version: string;
  /** The test build it went out in ("Studio 0.9.17"); "". */
  fixedIn: string;
  /** Who works on it now, as 值守 says ("Opus 5.5 · 任务「问题 #3 …」"); "". */
  worker: string;
  createdAt: number;
  updatedAt: number;
  /** Goes up with every change of the issue (the service's change counter at that moment). */
  rev: number;
  entryCount: number;
  /** Whether the last entry is the person's (not the AI's): something for 值守 to read. */
  awaitsAi: boolean;
  /** Only when one issue is asked for. */
  entries?: IssueEntry[];
}

export interface IssueRelease {
  /** 发布打包 was clicked and is not done yet. */
  requestedAt: number | null;
  requestedBy: string;
  last: { version: string; at: number } | null;
}

/** GET /api/issues[?after=rev]: the issues changed after `after` (all without it), and the counter now. */
export interface IssueList {
  issues: Issue[];
  release: IssueRelease;
  rev: number;
}

export interface NewIssue {
  title?: string;
  body: string;
  tool?: string;
  version?: string;
  /** Ids from POST /api/issues/images, not yet used. */
  images?: string[];
}

export interface NewIssueEntry {
  body?: string;
  images?: string[];
  /** Written by the AI (Studio's 值守). */
  ai?: boolean;
  /** Changes the status with this entry. */
  status?: IssueStatus;
}

export interface IssuePatch {
  status?: IssueStatus;
  title?: string;
  fixedIn?: string;
  worker?: string;
}
