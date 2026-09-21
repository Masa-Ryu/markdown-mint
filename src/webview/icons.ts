/// <reference types="vite/client" />

import boldAsset from "../../assets/menu/common/bold.svg?raw";
import italicAsset from "../../assets/menu/common/italic.svg?raw";
import strikethroughAsset from "../../assets/menu/common/strikethrough.svg?raw";
import inlineCodeAsset from "../../assets/menu/common/inline-code.svg?raw";
import linkAsset from "../../assets/menu/common/link.svg?raw";
import imageAsset from "../../assets/menu/common/image.svg?raw";
import bulletListAsset from "../../assets/menu/common/bullet-list.svg?raw";
import orderedListAsset from "../../assets/menu/common/ordered-list.svg?raw";
import checklistAsset from "../../assets/menu/common/checklist.svg?raw";
import blockquoteAsset from "../../assets/menu/common/blockquote.svg?raw";
import codeBlockAsset from "../../assets/menu/common/code-block.svg?raw";
import tableAsset from "../../assets/menu/common/table.svg?raw";
import tableRowAboveAsset from "../../assets/menu/common/table-row-above.svg?raw";
import tableRowBelowAsset from "../../assets/menu/common/table-row-below.svg?raw";
import tableMoveUpAsset from "../../assets/menu/common/table-move-up.svg?raw";
import tableMoveDownAsset from "../../assets/menu/common/table-move-down.svg?raw";
import tableRowDeleteAsset from "../../assets/menu/common/table-row-delete.svg?raw";
import tableColumnLeftAsset from "../../assets/menu/common/table-column-left.svg?raw";
import tableColumnRightAsset from "../../assets/menu/common/table-column-right.svg?raw";
import tableMoveLeftAsset from "../../assets/menu/common/table-move-left.svg?raw";
import tableMoveRightAsset from "../../assets/menu/common/table-move-right.svg?raw";
import tableColumnDeleteAsset from "../../assets/menu/common/table-column-delete.svg?raw";
import tableAlignLeftAsset from "../../assets/menu/common/table-align-left.svg?raw";
import tableAlignCenterAsset from "../../assets/menu/common/table-align-center.svg?raw";
import tableAlignRightAsset from "../../assets/menu/common/table-align-right.svg?raw";
import tableNumberingAsset from "../../assets/menu/common/table-numbering.svg?raw";
import tableDeleteAsset from "../../assets/menu/common/table-delete.svg?raw";
import tableGripAsset from "../../assets/menu/common/table-grip.svg?raw";
import dividerAsset from "../../assets/menu/common/divider.svg?raw";
import formatAsset from "../../assets/menu/common/format.svg?raw";
import undoAsset from "../../assets/menu/common/undo.svg?raw";
import redoAsset from "../../assets/menu/common/redo.svg?raw";

export type ToolbarIconName =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inline-code"
  | "link"
  | "image"
  | "bullet-list"
  | "ordered-list"
  | "checklist"
  | "blockquote"
  | "code-block"
  | "table"
  | "table-row-above"
  | "table-row-below"
  | "table-move-up"
  | "table-move-down"
  | "table-row-delete"
  | "table-column-left"
  | "table-column-right"
  | "table-move-left"
  | "table-move-right"
  | "table-column-delete"
  | "table-align-left"
  | "table-align-center"
  | "table-align-right"
  | "table-numbering"
  | "table-delete"
  | "table-grip"
  | "divider"
  | "format"
  | "undo"
  | "redo";

const ICON_TEMPLATE_CACHE = new Map<ToolbarIconName, SVGSVGElement>();

const ICON_SOURCES: Readonly<Record<ToolbarIconName, string>> = {
  bold: boldAsset,
  italic: italicAsset,
  strikethrough: strikethroughAsset,
  "inline-code": inlineCodeAsset,
  link: linkAsset,
  image: imageAsset,
  "bullet-list": bulletListAsset,
  "ordered-list": orderedListAsset,
  checklist: checklistAsset,
  blockquote: blockquoteAsset,
  "code-block": codeBlockAsset,
  table: tableAsset,
  "table-row-above": tableRowAboveAsset,
  "table-row-below": tableRowBelowAsset,
  "table-move-up": tableMoveUpAsset,
  "table-move-down": tableMoveDownAsset,
  "table-row-delete": tableRowDeleteAsset,
  "table-column-left": tableColumnLeftAsset,
  "table-column-right": tableColumnRightAsset,
  "table-move-left": tableMoveLeftAsset,
  "table-move-right": tableMoveRightAsset,
  "table-column-delete": tableColumnDeleteAsset,
  "table-align-left": tableAlignLeftAsset,
  "table-align-center": tableAlignCenterAsset,
  "table-align-right": tableAlignRightAsset,
  "table-numbering": tableNumberingAsset,
  "table-delete": tableDeleteAsset,
  "table-grip": tableGripAsset,
  divider: dividerAsset,
  format: formatAsset,
  undo: undoAsset,
  redo: redoAsset,
};

function removeFormattingWhitespace(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 && !(child.textContent ?? "").trim()) {
      node.removeChild(child);
      continue;
    }
    removeFormattingWhitespace(child);
  }
}

export interface ToolbarIconOptions {
  className?: string;
  size?: number;
}

function getToolbarIconTemplate(name: ToolbarIconName): SVGSVGElement {
  const cached = ICON_TEMPLATE_CACHE.get(name);
  if (cached) return cached;

  const source = ICON_SOURCES[name];
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg") {
    throw new Error("Invalid Markdown Mint toolbar icon: " + name);
  }

  const template = document.importNode(root, true) as unknown as SVGSVGElement;
  removeFormattingWhitespace(template);
  ICON_TEMPLATE_CACHE.set(name, template);
  return template;
}

/**
 * Build a trusted repository icon as an inline SVG.
 *
 * SVGs are imported at build time, so rendering never performs a runtime
 * request. Theme-following assets declare `currentColor` in the SVG itself;
 * semantic accent colors remain explicit in their source assets.
 */
export function createToolbarIcon(
  name: ToolbarIconName,
  options: ToolbarIconOptions = {},
): SVGSVGElement {
  const svg = getToolbarIconTemplate(name).cloneNode(true) as SVGSVGElement;
  svg.setAttribute("class", options.className ?? "mm-toolbar-icon");
  svg.dataset.icon = name;
  svg.setAttribute("width", String(options.size ?? 20));
  svg.setAttribute("height", String(options.size ?? 20));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

export function appendToolbarIcon(
  button: HTMLElement,
  name: ToolbarIconName,
  label?: string,
  options?: ToolbarIconOptions,
): void {
  button.replaceChildren(createToolbarIcon(name, options));
  if (label) {
    const text = document.createElement("span");
    text.className = "mm-toolbar-button-label";
    text.textContent = label;
    button.append(text);
  }
}
