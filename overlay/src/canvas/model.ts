export interface CanvasNode { id: string; kind: "task" | "note"; x: number; y: number; width: number; height: number; sessionId?: string; text?: string }
export interface CanvasEdge { id: string; source: string; target: string }
export interface Viewport { x: number; y: number; zoom: number }
export interface CanvasDocument { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: Viewport }
export interface CanvasBoard { schemaVersion: 1; id: "default"; revision: number; updatedAt: string | null; document: CanvasDocument }
export const emptyDocument = (): CanvasDocument => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const coordinate = (value: number) => clamp(value, -100000, 100000);
export function worldPoint(x: number, y: number, viewport: Viewport) { return { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom }; }
export function zoomAt(viewport: Viewport, x: number, y: number, zoom: number): Viewport {
  const point = worldPoint(x, y, viewport);
  const next = clamp(zoom, .2, 2);
  return { x: coordinate(x - point.x * next), y: coordinate(y - point.y * next), zoom: next };
}
export function visibleNode(node: CanvasNode, viewport: Viewport, width: number, height: number) {
  const x = node.x * viewport.zoom + viewport.x, y = node.y * viewport.zoom + viewport.y;
  return x + node.width * viewport.zoom >= -120 && y + node.height * viewport.zoom >= -120 && x <= width + 120 && y <= height + 120;
}
export function removeNode(document: CanvasDocument, id: string): CanvasDocument {
  return { ...document, nodes: document.nodes.filter(n => n.id !== id), edges: document.edges.filter(e => e.source !== id && e.target !== id) };
}
export function connectNodes(document: CanvasDocument, source: string, target: string, id: string): CanvasDocument {
  if (source === target || document.edges.length >= 1000 || !document.nodes.some(n => n.id === source) || !document.nodes.some(n => n.id === target) || document.edges.some(e => e.source === source && e.target === target)) return document;
  return { ...document, edges: [...document.edges, { id, source, target }] };
}
export function edgePath(source: CanvasNode, target: CanvasNode) {
  const x = source.x + source.width, y = source.y + source.height / 2;
  const tx = target.x, ty = target.y + target.height / 2;
  const bend = Math.max(70, Math.abs(tx - x) / 2);
  return `M ${x} ${y} C ${x + bend} ${y}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}
