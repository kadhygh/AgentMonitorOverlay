// What a file's icon shows (Git Review's list, after Fork's): a coloured badge with a short label for languages and
// formats, or a drawn shape for images, plain text and anything unknown. Colours are the languages' usual ones.

export type FileShape = "image" | "text" | "doc";

export type FileKind = { badge: string; bg: string; fg?: string } | { shape: FileShape };

const DARK_TEXT = "#22201c";

const badge = (label: string, bg: string, fg?: string): FileKind => ({ badge: label, bg, ...(fg ? { fg } : {}) });

const BY_EXT: Record<string, FileKind> = {};
const add = (exts: string, kind: FileKind) => exts.split(" ").forEach((e) => (BY_EXT[e.toLowerCase()] = kind));

add("cs csx", badge("C#", "#68217a"));
add("ts tsx mts cts", badge("TS", "#3178c6"));
add("js jsx mjs cjs", badge("JS", "#e8cf4a", DARK_TEXT));
add("py pyw pyi", badge("PY", "#3572a5"));
add("lua", badge("LU", "#2c2d72"));
add("go", badge("GO", "#00a7d0"));
add("rs", badge("RS", "#b7410e"));
add("java", badge("JV", "#b07219"));
add("kt kts", badge("KT", "#7f52ff"));
add("c h", badge("C", "#555c66"));
add("cpp cc cxx hpp hh hxx inl", badge("C+", "#d6336c"));
add("swift", badge("SW", "#f05138"));
add("rb", badge("RB", "#cc342d"));
add("php", badge("PH", "#4f5d95"));
add("shader hlsl glsl cginc compute usf ush", badge("SH", "#4b6a88"));
add("html htm", badge("<>", "#e34c26"));
add("css scss sass less", badge("#", "#663399"));
add("vue", badge("V", "#41b883", DARK_TEXT));
add("md mdx markdown", badge("MD", "#55606e"));
add("json jsonc json5", badge("{}", "#d9a12b", DARK_TEXT));
add("yml yaml", badge("YM", "#c2410c"));
add("toml", badge("TM", "#9c4221"));
add("ini cfg conf env editorconfig properties", badge("CF", "#6b7280"));
add("xml xaml xsd plist", badge("XM", "#0063b1"));
add("csproj vcxproj sln props targets", badge("VS", "#5c2d91"));
add("ps1 psm1 psd1", badge(">_", "#2b5797"));
add("bat cmd", badge(">_", "#4d4d4d"));
add("sh bash zsh fish", badge(">_", "#3b7a4f"));
add("sql", badge("DB", "#336791"));
add("csv tsv xls xlsx xlsm", badge("XL", "#1d6f42"));
add("pdf", badge("PDF", "#b30b00"));
add("zip 7z rar gz tgz tar xz", badge("ZIP", "#8a6d3b"));
add("dll exe pdb so dylib lib a o obj bin wasm", badge("01", "#6b6f76"));
add("unity prefab asset mat anim controller overrideController physicMaterial asmdef asmref unitypackage", badge("U", "#3d4450"));
add("meta", badge("U", "#8d877c"));
add("png jpg jpeg gif bmp tga psd webp ico svg tif tiff exr hdr", { shape: "image" });
add("txt log", { shape: "text" });

const BY_NAME: Record<string, FileKind> = {
  ".gitignore": badge("GI", "#f05033"),
  ".gitattributes": badge("GI", "#f05033"),
  ".gitmodules": badge("GI", "#f05033"),
  dockerfile: badge("DK", "#2496ed"),
  makefile: badge("MK", "#6d8086"),
  license: { shape: "text" },
};

/** The icon of a file name (or path). */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  const dot = name.lastIndexOf(".");
  return (dot > 0 && BY_EXT[name.slice(dot + 1)]) || { shape: "doc" };
}
