// Works out topics' region shapes off the main thread (shapes.ts sends them, one message a topic, answered in turn), so
// the page's opening animation runs while they are computed (the user, 11-04).
import { topicShape, type TopicFrame, type WorldKind } from "./regions.js";

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ key: string; frame: TopicFrame; kind: WorldKind }>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => {
  const { key, frame, kind } = e.data;
  const t0 = performance.now();
  scope.postMessage({ key, shape: topicShape(frame, kind), ms: performance.now() - t0 });
};
