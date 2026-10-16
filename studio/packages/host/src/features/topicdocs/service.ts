import { TOPIC_DOC_BODY_MAX, TOPIC_DOC_TITLE_MAX, type Id, type TopicDoc } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * Topics' documents (stage 16, from the stage 15 design): strictly about driving the topic's tasks — the plan, the
 * decisions, how the parts fit. The person writes them on the topic's canvas page; agents read them (MCP), and a
 * 主控 of the topic may write them too.
 */
export class TopicDocsFeature extends Feature {
  list(topicId: Id): TopicDoc[] {
    this.requireTopic(topicId);
    return this.store.listTopicDocs(topicId);
  }

  get(id: Id): TopicDoc {
    const doc = this.store.getTopicDoc(id);
    if (!doc) throw new HostError("not_found", `topic document ${id} not found`);
    return doc;
  }

  create(topicId: Id, input: { title?: unknown; body?: unknown } | undefined): TopicDoc {
    const topic = this.requireLiveTopic(topicId);
    const at = new Date().toISOString();
    const doc: TopicDoc = { id: newId("tdoc"), topicId: topic.id, title: title(input?.title, true)!, body: body(input?.body) ?? "", createdAt: at, updatedAt: at };
    this.store.putTopicDoc(doc);
    this.publish({ type: "topicdoc.upserted", doc });
    return doc;
  }

  update(id: Id, patch: { title?: unknown; body?: unknown } | undefined): TopicDoc {
    const current = this.get(id);
    if (this.requireTopic(current.topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const nextTitle = title(patch?.title, false);
    const nextBody = body(patch?.body);
    const doc: TopicDoc = { ...current, ...(nextTitle !== undefined ? { title: nextTitle } : {}), ...(nextBody !== undefined ? { body: nextBody } : {}), updatedAt: new Date().toISOString() };
    this.store.putTopicDoc(doc);
    this.publish({ type: "topicdoc.upserted", doc });
    return doc;
  }

  remove(id: Id): void {
    const current = this.get(id);
    if (this.requireTopic(current.topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    this.store.deleteTopicDoc(id);
    this.publish({ type: "topicdoc.removed", topicId: current.topicId, docId: id });
  }
}

function title(v: unknown, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new HostError("bad_request", "a document needs a title");
  if (t.length > TOPIC_DOC_TITLE_MAX) throw new HostError("bad_request", `a title is limited to ${TOPIC_DOC_TITLE_MAX} characters`);
  return t;
}

function body(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HostError("bad_request", "body must be text");
  if (v.length > TOPIC_DOC_BODY_MAX) throw new HostError("bad_request", `a document is limited to ${TOPIC_DOC_BODY_MAX} characters`);
  return v;
}
