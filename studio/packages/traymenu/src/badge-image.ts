import { nativeImage, type NativeImage } from "electron";
import { countBadge, iconWithBadge } from "./badge.js";

// badge.ts's pixels as Electron images, at each scale Windows may ask for (16 px at 100 %, 20, 24, 32 at 200 %).

const SCALES = [
  [16, 1],
  [20, 1.25],
  [24, 1.5],
  [32, 2],
] as const;

const png = (px: Uint8Array, size: number) => nativeImage.createFromBitmap(Buffer.from(px.buffer, px.byteOffset, px.byteLength), { width: size, height: size }).toPNG();

/** The taskbar's overlay for `count` (BrowserWindow.setOverlayIcon); null for none. */
export function overlayImage(count: number): NativeImage | null {
  if (count <= 0) return null;
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of SCALES) image.addRepresentation({ scaleFactor, buffer: png(countBadge(size, count), size) });
  return image;
}

/**
 * A tray icon with `count` on it: `icons` maps a size (16, 20, 24, 32) to that size's PNG (the tools' assets/icon-N.png).
 * A size without its PNG is left out; with none, the badge alone.
 */
export function badgedImage(icons: ReadonlyMap<number, Buffer>, count: number): NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of SCALES) {
    const file = icons.get(size);
    if (!file) continue;
    const icon = nativeImage.createFromBuffer(file);
    const { width, height } = icon.getSize();
    if (width !== size || height !== size) continue;
    image.addRepresentation({ scaleFactor, buffer: png(iconWithBadge(new Uint8Array(icon.toBitmap()), size, count), size) });
  }
  return image.isEmpty() ? (overlayImage(count) ?? image) : image;
}
