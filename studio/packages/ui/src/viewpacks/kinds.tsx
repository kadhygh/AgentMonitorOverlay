import type { JSX } from "react";
import type { StateSnapshot, ViewItem, ViewItemKind, ViewPack, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { FileItemView } from "./FileItemView.js";
import { GitItemView } from "./GitItemView.js";
import { ProposalItemView } from "./ProposalItemView.js";

// Every kind of 查看包 item the window shows (2026-10-23): its icon in the list and its view on the right. A new kind
// is an entry here and its module on the Host (features/viewpacks/kinds).

export interface ItemViewProps<K extends ViewItemKind> {
  link: HostLink;
  state: StateSnapshot;
  pack: ViewPack;
  workspace: Workspace;
  item: Extract<ViewItem, { kind: K }>;
  /** Changes with every open of the pack: a file is read again. */
  nonce: string;
  /** In front (the window's keys are its own). */
  active: boolean;
}

interface KindView<K extends ViewItemKind> {
  /** Its word in the list's tooltip. */
  word: string;
  icon: JSX.Element;
  View(props: ItemViewProps<K>): JSX.Element;
}

export const VIEW_KIND_VIEWS: { [K in ViewItemKind]: KindView<K> } = {
  file: {
    word: "文件",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 1.5h5l3.5 3.5v9.5h-8.5z" />
        <path d="M9 1.5V5h3.5" />
      </svg>
    ),
    View: (p) => <FileItemView {...p} />,
  },
  git: {
    word: "Git 改动",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="5" cy="4" r="1.6" />
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="11" cy="8" r="1.6" />
        <path d="M5 5.6v4.8M6.4 4.6c3 .6 3.4 1.6 3.4 2.2" />
      </svg>
    ),
    View: (p) => <GitItemView {...p} />,
  },
  proposal: {
    word: "改动预览",
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 1.5h5l3.5 3.5v9.5h-8.5z" strokeDasharray="2 1.6" />
        <path d="M6 9h4M8 7v4" />
      </svg>
    ),
    View: (p) => <ProposalItemView {...p} />,
  },
};
