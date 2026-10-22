import type { ViewItemKind } from "@amo-studio/protocol";
import type { ViewKindModule } from "./kind.js";
import { fileKind } from "./file.js";
import { gitKind } from "./git.js";
import { proposalKind } from "./proposal.js";

/** Every kind of 查看包 item the Host knows; a new kind is a module here and its view in the UI (viewpacks/kinds). */
export const VIEW_KIND_MODULES: { [K in ViewItemKind]: ViewKindModule<K> } = {
  file: fileKind,
  git: gitKind,
  proposal: proposalKind,
};
