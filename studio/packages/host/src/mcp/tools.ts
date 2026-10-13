import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import { HostError, type HostService } from "../service.js";
import { NotFoundError, ReadModel } from "./read-model.js";

// The AMO MCP tools, defined once: the Host serves them over HTTP at /mcp (Codex sessions), and Claude sessions get the
// same tools in-process through the SDK, so no token has to reach the Claude CLI.
// Reading is open to every caller. Writing (stage 5) is scoped to the session behind the call: Claude's in-process
// server is bound to its session; a Codex thread carries its own token in a header (spikes/RESULTS.md section j).

export const AMO_MCP_NAME = "amo";
export const AMO_MCP_INSTRUCTIONS =
  "AMO Studio workbench. Work is organised as projects (workspaces), tasks (each in one project, optionally in one topic) and topics (专题: several tasks, possibly across projects, on one canvas, with their own coordinating sessions). Read the board, tasks, topics, session trees, projects and a topic's canvas; record progress notes and handoff summaries on your own task; leave and read mail between sessions, tasks and topics (the person decides when mail enters a conversation); ask the person for a decision (the answer comes back as mail); arrange your topic's canvas (groups, dependencies, which group a task is in) with the person's approval; read the project's extension packs (conventions, templates) and tick your own task's checklist.";

/** The session a tool call comes from, if Studio could tell. */
export interface McpCaller {
  sessionId: Id;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface AmoTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Reads only Studio's state (annotated readOnlyHint). */
  readOnly: boolean;
  /**
   * Runs without asking the person: reads, and writes that only touch the caller's own task. Codex gets
   * `tools.<name>.approval_mode = "approve"` for these; Claude lists them in allowedTools.
   */
  autoApprove: boolean;
  run(args: Record<string, unknown>): ToolResult;
}

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs a read and turns a missing id into a tool error the agent can read, instead of a protocol error. */
function answer(read: () => unknown): ToolResult {
  try {
    return json(read());
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof HostError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Runs a write for the caller; Studio's own refusals become readable tool errors. */
function write(caller: McpCaller | null, run: (caller: McpCaller) => unknown): ToolResult {
  if (!caller) return fail("这次调用没有 AMO 会话身份（例如由 Codex 自己派生的子 agent），只能使用只读工具。");
  try {
    return json(run(caller));
  } catch (err) {
    if (err instanceof HostError) return fail(err.message);
    throw err;
  }
}

/** Every AMO tool for one caller (null: reading only). */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  // schedule_propose exists only for the scheduler's own sessions.
  const scheduler = caller && service.isSchedulerSession(caller.sessionId) ? [proposeTool(service, caller)] : [];
  return [...amoTools(new ReadModel(service, caller)), ...writeTools(service, caller), ...scheduler];
}

function proposeTool(service: HostService, caller: McpCaller): AmoTool {
  return {
    name: "schedule_propose",
    title: "调度提案",
    description:
      "Propose starting work on a whole-picture todo: which workspace (id), which model (profileId), the new session's first message (prompt) and why now (reason). Nothing starts until the person approves; at most 3 proposals per round.",
    inputSchema: { todoId: z.string(), workspace: z.string().optional(), profileId: z.string(), prompt: z.string(), reason: z.string().optional() },
    readOnly: false,
    autoApprove: true,
    run: (args) =>
      write(caller, (c) => {
        const p = service.propose({ todoId: args.todoId, workspaceId: args.workspace, profileId: args.profileId, prompt: args.prompt, reason: args.reason }, c.sessionId);
        return { id: p.id, state: p.state, note: "Waiting for the person to approve on the board." };
      }),
  };
}


function writeTools(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ownTask = (c: McpCaller): Id => {
    const taskId = service.store.getSession(c.sessionId)!.taskId;
    if (!taskId) throw new HostError("bad_request", "你是专题会话，没有自己的任务：用 mailbox_send 给任务或它们的会话留言。");
    return taskId;
  };
  /** The topic whose canvas the caller may arrange: its own topic, or its task's. */
  const ownTopic = (c: McpCaller): Id => {
    const topic = service.topicOfSession(c.sessionId);
    if (!topic) throw new HostError("bad_request", "你的任务不在任何专题里，没有画布可以整理。");
    return topic.id;
  };
  const inOwnTopic = (c: McpCaller, ...taskIds: unknown[]) => {
    const topicId = ownTopic(c);
    for (const id of taskIds) {
      if (service.store.getTask(String(id))?.topicId !== topicId) throw new HostError("bad_request", `任务 ${String(id)} 不在你所在的专题里`);
    }
  };
  return [
    {
      name: "task_note_add",
      title: "记进度",
      description: "Add a short progress note to your own AMO task (what was done, what is next, what blocks). The person sees it on the task page. Cannot move the task between board columns.",
      inputSchema: { text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.addTaskNote(ownTask(c), { text: args.text, kind: "progress" }, c.sessionId)),
    },
    {
      name: "handoff_submit",
      title: "提交交接",
      description: "Submit a handoff summary for your own AMO task: what is done, what is left, where the relevant files are, and anything the next session must know.",
      inputSchema: { summary: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.addTaskNote(ownTask(c), { text: args.summary, kind: "handoff" }, c.sessionId)),
    },
    {
      name: "mailbox_send",
      title: "留言",
      description:
        "Leave a message for another AMO session (toSessionId), a task (toTaskId) or a topic (toTopicId); find ids with board_list, task_get, topic_get or session_tree. It does not enter their conversation by itself: the person decides when to forward it, and the recipient can read it with mailbox_read.",
      inputSchema: { toSessionId: z.string().optional(), toTaskId: z.string().optional(), toTopicId: z.string().optional(), text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const to =
            typeof args.toSessionId === "string"
              ? { kind: "session", sessionId: args.toSessionId }
              : typeof args.toTaskId === "string"
                ? { kind: "task", taskId: args.toTaskId }
                : typeof args.toTopicId === "string"
                  ? { kind: "topic", topicId: args.toTopicId }
                  : null;
          if (!to) throw new HostError("bad_request", "give toSessionId, toTaskId or toTopicId");
          const m = service.sendMail(c.sessionId, to, args.text);
          return { id: m.id, to: m.to, state: m.state };
        }),
    },
    {
      name: "canvas_group_create",
      title: "画布建组",
      description: "Create a group on your topic's canvas (optionally bound to a project, by id or name). Studio places it; the person approves first.",
      inputSchema: { title: z.string(), workspace: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => service.canvasCreateGroup(ownTopic(c), args)),
    },
    {
      name: "canvas_depend",
      title: "画布连依赖",
      description: "Record on your topic's canvas that toTaskId depends on fromTaskId (fromTaskId must finish first); both must be tasks of your topic. Refused if it would make a cycle. The person approves first.",
      inputSchema: { fromTaskId: z.string(), toTaskId: z.string() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.fromTaskId, args.toTaskId), service.canvasAddDependency(args.fromTaskId, args.toTaskId))),
    },
    {
      name: "canvas_place",
      title: "画布归组",
      description: "Put a task of your topic into a group on its canvas (groupId), or take it out of its group (omit groupId). Studio picks the position; the person approves first.",
      inputSchema: { taskId: z.string(), groupId: z.string().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => (inOwnTopic(c, args.taskId), service.canvasPlaceTask(args.taskId, args.groupId ?? null))),
    },
    {
      name: "checklist_check",
      title: "勾清单",
      description: "Tick (or untick with done=false) a step of your own task's checklist; find the item ids with task_get. The person sees who ticked it.",
      inputSchema: { itemId: z.string(), done: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const item = service.setChecklistDone(String(args.itemId), args.done !== false, c.sessionId);
          return { id: item.id, text: item.text, done: item.done };
        }),
    },
    {
      name: "decision_request",
      title: "请求决策",
      description:
        "Ask the person to decide something you should not decide alone (offer short options when you can). It is shown in the AMO workbench and the Focus window; it does not block your turn. The answer comes back to you as mail (mailbox_read).",
      inputSchema: { question: z.string(), options: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const d = service.requestDecisionFromSession(c.sessionId, args.question, args.options);
          return { id: d.id, state: d.state, note: "The answer will arrive as mail; read it with mailbox_read." };
        }),
    },
    {
      name: "mailbox_read",
      title: "读留言",
      description: "Read the unread messages left for you or for your task or topic (they are then marked read).",
      inputSchema: {},
      readOnly: false,
      autoApprove: true,
      run: () =>
        write(caller, (c) => {
          const title = (id: Id | null) => (id ? service.store.getSession(id)?.title || "会话" : "我（人）");
          return {
            // The text first: it is what the agent needs, the routing is context.
            messages: service.readMailFromSession(c.sessionId).map((m) => ({
              text: m.text,
              from: m.fromSessionId ? { sessionId: m.fromSessionId, title: title(m.fromSessionId), taskId: m.fromTaskId, topicId: m.fromTopicId ?? null } : "person",
              to: m.to,
              at: m.createdAt,
            })),
          };
        }),
    },
  ];
}

export function amoTools(model: ReadModel): AmoTool[] {
  return [
    {
      name: "board_list",
      title: "看板",
      description: "Tasks on the AMO board (most recently active first, archived ones left out) with their column, status, project and topic. Filter by project (id or name), topic (id or title) or column.",
      inputSchema: { workspace: z.string().optional(), topic: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.boardList(args as { workspace?: string; topic?: string; column?: "todo" | "doing" | "review" | "done" })),
    },
    {
      name: "topic_list",
      title: "专题",
      description: "Topics (专题): each groups tasks, possibly across projects, on its own canvas and has its own coordinating sessions. Archived topics are left out.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => answer(() => model.topicList()),
    },
    {
      name: "topic_get",
      title: "专题详情",
      description: "One topic (id or title; your own topic when omitted): its projects, its tasks with status, its own sessions with an excerpt of their latest reply, and its canvas as an outline.",
      inputSchema: { topic: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.topicGet(args.topic === undefined ? undefined : String(args.topic))),
    },
    {
      name: "task_get",
      title: "任务详情",
      description: "One task: its latest handoff summary, column, status, project, topic, the tasks it depends on and that depend on it, its canvas group, recent progress notes and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.taskGet(String(args.taskId))),
    },
    {
      name: "session_tree",
      title: "会话树",
      description: "A task's sessions as a tree (main sessions, branches, subagents) with an excerpt of each one's latest reply.",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.sessionTree(String(args.taskId))),
    },
    {
      name: "project_context",
      title: "项目信息",
      description: "Registered projects (name, path, open tasks) and the common folder where work without a project runs. With a project (id or name), that project and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.projectContext(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "pack_list",
      title: "扩展包",
      description:
        "The project's extension packs (.amo/packs in a workspace, id or name; all workspaces when omitted): their documents (conventions, pitfalls), task templates and session presets. Read a document with pack_doc.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.packList(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "pack_doc",
      title: "扩展包文档",
      description: "One document of an extension pack (ids from pack_list), as markdown.",
      inputSchema: { workspace: z.string(), pack: z.string(), doc: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.packDoc(String(args.workspace), String(args.pack), String(args.doc))),
    },
    {
      name: "canvas_read",
      title: "画布",
      description: "A topic's canvas as structure, without coordinates (your own topic's when no topic id or title is given): groups with their tasks and notes, ungrouped items, tasks not placed yet, and dependencies. Returns a readable outline and the same data as JSON.",
      inputSchema: { topic: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => {
        try {
          const { outline, json: data } = model.canvasRead(args.topic === undefined ? undefined : String(args.topic));
          return { content: [{ type: "text", text: outline }, { type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          if (err instanceof NotFoundError || err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
  ];
}
