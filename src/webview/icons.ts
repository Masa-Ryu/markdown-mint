/// <reference types="vite/client" />

import boldAsset from "../../assets/bold.svg?raw";
import italicAsset from "../../assets/italic.svg?raw";
import strikethroughAsset from "../../assets/strikethrough.svg?raw";
import inlineCodeAsset from "../../assets/inline-code.svg?raw";
import linkAsset from "../../assets/link.svg?raw";
import imageAsset from "../../assets/image.svg?raw";
import bulletListAsset from "../../assets/bullet-list.svg?raw";
import orderedListAsset from "../../assets/ordered-list.svg?raw";
import checklistAsset from "../../assets/checklist.svg?raw";
import blockquoteAsset from "../../assets/blockquote.svg?raw";
import codeBlockAsset from "../../assets/code-block.svg?raw";
import tableAsset from "../../assets/table.svg?raw";
import tableRowAboveAsset from "../../assets/table-row-above.svg?raw";
import tableRowBelowAsset from "../../assets/table-row-below.svg?raw";
import tableRowDeleteAsset from "../../assets/table-row-delete.svg?raw";
import tableColumnLeftAsset from "../../assets/table-column-left.svg?raw";
import tableColumnRightAsset from "../../assets/table-column-right.svg?raw";
import tableColumnDeleteAsset from "../../assets/table-column-delete.svg?raw";
import tableAlignLeftAsset from "../../assets/table-align-left.svg?raw";
import tableAlignCenterAsset from "../../assets/table-align-center.svg?raw";
import tableAlignRightAsset from "../../assets/table-align-right.svg?raw";
import tableNumberingAsset from "../../assets/table-numbering.svg?raw";
import tableDeleteAsset from "../../assets/table-delete.svg?raw";
import dividerAsset from "../../assets/divider.svg?raw";
import formatAsset from "../../assets/format.svg?raw";
import undoAsset from "../../assets/undo.svg?raw";
import redoAsset from "../../assets/redo.svg?raw";

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
