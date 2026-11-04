// Text layers that share their font atlas on the GPU (11-04, measuring the wheel's dropped frames).
//
// deck.gl keeps one font atlas per font (a canvas, 1024×2048 here, about 8 MB) but every TextLayer uploads its own
// texture of it: at each new text layer, and at each text layer again whenever the atlas gains a glyph. The map has
// some thirty text layers (ground text, their SDF twins, the signs), so opening folded rounds at rest (new layers, a
// new glyph or two) cost 100–180 ms of texture uploads, and the GPU held thirty copies. Here the characters sublayer
// is given one texture per atlas (deck.gl uses a texture it is handed as it is, and never deletes one it did not make).
// Textures of atlases no layer uses any more are deleted by `sweepAtlases`.
import { TextLayer } from "@deck.gl/layers";
import type { Layer, LayerContext } from "@deck.gl/core";

/** luma.gl's device and texture, as deck.gl hands them out (luma.gl is not a direct dependency). */
export type Device = LayerContext["device"];
type Texture = ReturnType<Device["createTexture"]>;

type Atlas = { data: HTMLCanvasElement };
const SAMPLER = { minFilter: "linear", mipmapFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" } as const;
const made = new Map<Device, Map<Atlas, Texture>>();

function textureOf(device: Device, atlas: Atlas): Texture {
  let mine = made.get(device);
  if (!mine) made.set(device, (mine = new Map()));
  let tex = mine.get(atlas);
  if (!tex) {
    const { width, height } = atlas.data;
    // As deck.gl makes an icon atlas's texture (utils/texture.js): mipmapped, linear.
    tex = device.createTexture({ data: atlas.data, sampler: SAMPLER, mipLevels: device.getMipLevelCount(width, height) } as never);
    (tex as unknown as { generateMipmapsWebGL?: () => void }).generateMipmapsWebGL?.();
    mine.set(atlas, tex);
  }
  return tex;
}

function atlasOf(l: Layer): Atlas | null {
  return (l.state as { fontAtlasManager?: { atlas?: Atlas } } | null)?.fontAtlasManager?.atlas ?? null;
}

export class SharedAtlasTextLayer extends TextLayer {
  static layerName = "SharedAtlasTextLayer";

  getSubLayerProps(sublayerProps?: { id?: string; [k: string]: unknown }): Record<string, unknown> {
    const out = super.getSubLayerProps(sublayerProps as never) as Record<string, unknown>;
    const atlas = sublayerProps?.id === "characters" ? atlasOf(this as unknown as Layer) : null;
    const device = (this.context as { device?: Device } | undefined)?.device;
    if (atlas?.data && device) out.iconAtlas = textureOf(device, atlas);
    return out;
  }
}

/** Deletes the textures of atlases that none of `layers` (deck.gl's current layers) draws from. */
export function sweepAtlases(device: Device | undefined, layers: readonly Layer[]): number {
  const mine = device && made.get(device);
  if (!mine) return 0;
  const used = new Set(layers.map(atlasOf).filter(Boolean));
  let n = 0;
  for (const [atlas, tex] of mine)
    if (!used.has(atlas)) {
      tex.destroy();
      mine.delete(atlas);
      n++;
    }
  return n;
}

/** Atlas textures held (measuring). */
export function atlasTextures(device: Device | undefined): number {
  return (device && made.get(device)?.size) ?? 0;
}

/** The engine is gone (its GL context with it): forget its textures. */
export function forgetDevice(device: Device | undefined): void {
  if (device) made.delete(device);
}
