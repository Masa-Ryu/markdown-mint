/// <reference types="vite/client" />

import boldAsset from "../../assets/menu/bold.svg?raw";
import italicAsset from "../../assets/menu/italic.svg?raw";
import strikethroughAsset from "../../assets/menu/strikethrough.svg?raw";
import inlineCodeAsset from "../../assets/menu/inline-code.svg?raw";
import linkAsset from "../../assets/menu/link.svg?raw";
import imageAsset from "../../assets/menu/image.svg?raw";
import bulletListAsset from "../../assets/menu/bullet-list.svg?raw";
import orderedListAsset from "../../assets/menu/ordered-list.svg?raw";
import checklistAsset from "../../assets/menu/checklist.svg?raw";
import blockquoteAsset from "../../assets/menu/blockquote.svg?raw";
import codeBlockAsset from "../../assets/menu/code-block.svg?raw";
import tableAsset from "../../assets/menu/table.svg?raw";
import tableRowAboveAsset from "../../assets/menu/table-row-above.svg?raw";
import tableRowBelowAsset from "../../assets/menu/table-row-below.svg?raw";
import tableRowDeleteAsset from "../../assets/menu/table-row-delete.svg?raw";
import tableColumnLeftAsset from "../../assets/menu/table-column-left.svg?raw";
import tableColumnRightAsset from "../../assets/menu/table-column-right.svg?raw";
import tableColumnDeleteAsset from "../../assets/menu/table-column-delete.svg?raw";
import tableAlignLeftAsset from "../../assets/menu/table-align-left.svg?raw";
import tableAlignCenterAsset from "../../assets/menu/table-align-center.svg?raw";
import tableAlignRightAsset from "../../assets/menu/table-align-right.svg?raw";
import tableNumberingAsset from "../../assets/menu/table-numbering.svg?raw";
import tableDeleteAsset from "../../assets/menu/table-delete.svg?raw";
import dividerAsset from "../../assets/menu/divider.svg?raw";
import formatAsset from "../../assets/menu/format.svg?raw";
import undoAsset from "../../assets/menu/undo.svg?raw";
import redoAsset from "../../assets/menu/redo.svg?raw";

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
  | "table-row-delete"
  | "table-column-left"
  | "table-column-right"
  | "table-column-delete"
  | "table-align-left"
  | "table-align-center"
  | "table-align-right"
  | "table-numbering"
  | "table-delete"
  | "divider"
  | "format"
  | "undo"
  | "redo";

const FIXED_ICON_COLOR = /#111827/gi;
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
  "table-row-delete": tableRowDeleteAsset,
  "table-column-left": tableColumnLeftAsset,
  "table-column-right": tableColumnRightAsset,
  "table-column-delete": tableColumnDeleteAsset,
  "table-align-left": tableAlignLeftAsset,
  "table-align-center": tableAlignCenterAsset,
  "table-align-right": tableAlignRightAsset,
  "table-numbering": tableNumberingAsset,
  "table-delete": tableDeleteAsset,
  divider: dividerAsset,
  format: formatAsset,
  undo: undoAsset,
  redo: redoAsset,
};

function replaceFixedColors(svg: SVGSVGElement): void {
  const elements = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (!FIXED_ICON_COLOR.test(attribute.value)) continue;
      FIXED_ICON_COLOR.lastIndex = 0;
      element.setAttribute(
        attribute.name,
        attribute.value.replace(FIXED_ICON_COLOR, "currentColor"),
      );
    }
  }
}

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
  replaceFixedColors(template);
  removeFormattingWhitespace(template);
  ICON_TEMPLATE_CACHE.set(name, template);
  return template;
}

/**
 * Build a trusted repository icon as an inline SVG.
 *
 * SVGs are imported at build time, so rendering never performs a runtime
 * request. The supplied files use a fixed design color; converting that color
 * to currentColor keeps the same shapes usable in every VS Code theme.
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
