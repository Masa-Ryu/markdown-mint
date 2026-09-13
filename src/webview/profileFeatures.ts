import { Fragment, type Node as PMNode, type Schema } from "prosemirror-model";
import {
  AllSelection,
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";

/** Profiles understood by the source feature palette. */
export type ProfileFeatureProfile = "github" | "gitlab" | "commonmark";

/** The source feature identifiers exposed to the toolbar. */
export type ProfileFeatureId =
  | "alert"
  | "details"
  | "math"
  | "mermaid"
  | "gitlab-toc"
  | "gitlab-description-list"
  | "gitlab-diff-added"
  | "gitlab-diff-removed";

export type ProfileFeatureKind = "block" | "inline";

export interface ProfileFeatureDefinition {
  readonly id: ProfileFeatureId;
  readonly label: string;
  readonly description: string;
  readonly kind: ProfileFeatureKind;
  readonly profiles: readonly ProfileFeatureProfile[];
}

/** Values accepted by the source builders and the insertion command. */
export interface ProfileFeatureValues {
  readonly alertType?: "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";
  readonly type?: "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";
  readonly summary?: string;
  readonly title?: string;
  readonly body?: string;
  readonly expression?: string;
  readonly source?: string;
  readonly text?: string;
  readonly term?: string;
  readonly definition?: string;
}

/** The minimal parser bridge required by the insertion command. */
export interface ProfileFeatureCore {
  readonly schema: Schema;
  parseMarkdown(
    source: string,
    profile: ProfileFeatureProfile,
  ): { doc: PMNode };
}

export const PROFILE_FEATURES: readonly ProfileFeatureDefinition[] = [
  {
    id: "alert",
    label: "Alert",
    description: "Insert a GitHub or GitLab callout alert.",
    kind: "block",
    profiles: ["github", "gitlab"],
  },
  {
    id: "details",
    label: "Details",
    description: "Insert a collapsible details block with a summary.",
    kind: "block",
    profiles: ["github", "gitlab"],
  },
  {
    id: "math",
    label: "Math",
    description: "Insert a display equation using the active profile syntax.",
    kind: "block",
    profiles: ["github", "gitlab"],
  },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    description: "Insert a Mermaid fenced diagram block.",
    kind: "block",
    profiles: ["github", "gitlab"],
  },
  {
    id: "gitlab-toc",
    label: "GitLab table of contents",
    description: "Insert GitLab's generated table of contents marker.",
    kind: "block",
    profiles: ["gitlab"],
  },
  {
    id: "gitlab-description-list",
    label: "GitLab description list",
    description: "Insert a GitLab term and description list entry.",
    kind: "block",
    profiles: ["gitlab"],
  },
  {
    id: "gitlab-diff-added",
    label: "GitLab added text",
    description: "Mark a selected text range as added text.",
    kind: "inline",
    profiles: ["gitlab"],
  },
  {
    id: "gitlab-diff-removed",
    label: "GitLab removed text",
    description: "Mark a selected text range as removed text.",
    kind: "inline",
    profiles: ["gitlab"],
  },
] as const;

function featureDefinition(
  feature: ProfileFeatureId | ProfileFeatureDefinition,
): ProfileFeatureDefinition | null {
  const id = typeof feature === "string" ? feature : feature.id;
  return PROFILE_FEATURES.find((candidate) => candidate.id === id) ?? null;
}

/** Return the feature rows that are valid for one profile. */
export function getProfileFeatures(
  profile: ProfileFeatureProfile,
): ProfileFeatureDefinition[] {
  if (profile === "commonmark") return [];
  return PROFILE_FEATURES.filter((feature) =>
    feature.profiles.includes(profile),
  );
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replaceAll(String.fromCharCode(0), "");
}

function singleLine(value: string | undefined, fallback: string): string {
  const normalized = normalizeText(value).replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function multiline(value: string | undefined): string {
  return normalizeText(value).trim();
}

function escapedHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fenceFor(source: string): string {
  let longest = 0;
  for (const match of source.matchAll(/`+/g))
    longest = Math.max(longest, match[0]?.length ?? 0);
  return "`".repeat(Math.max(3, longest + 1));
}

const ALERT_TYPES = new Set<NonNullable<ProfileFeatureValues["alertType"]>>([
  "NOTE",
  "TIP",
  "IMPORTANT",
  "WARNING",
  "CAUTION",
]);

function alertSource(values: ProfileFeatureValues): string {
  const candidate = normalizeText(values.alertType ?? values.type)
    .trim()
    .toUpperCase();
  const marker = ALERT_TYPES.has(
    candidate as NonNullable<ProfileFeatureValues["alertType"]>,
  )
    ? candidate
    : "NOTE";
  const body = multiline(values.body ?? values.source);
  const lines = body ? body.split("\n") : [""];
  return [`> [!${marker}]`, ...lines.map((line) => `> ${line}`)].join("\n");
}

function detailsSource(values: ProfileFeatureValues): string | null {
  const rawSummary = singleLine(values.summary ?? values.title, "");
  if (!rawSummary) return null;
  const summary = escapedHtmlText(rawSummary);
  // Preserve the body byte-for-byte. The parser validates the generated raw
  // block before insertion, so an unbalanced tag is rejected instead of
  // rewriting a literal tag inside a fenced code sample.
  const body = multiline(values.body ?? values.source);
  return [
    "<details>",
    `<summary>${summary}</summary>`,
    "",
    body,
    "",
    "</details>",
  ].join("\n");
}

function mathSource(
  values: ProfileFeatureValues,
  profile: ProfileFeatureProfile,
): string | null {
  const expression = multiline(
    values.expression ?? values.body ?? values.source,
  );
  if (!expression) return null;
  if (profile === "gitlab") {
    const fence = fenceFor(expression);
    return `${fence}math\n${expression}\n${fence}`;
  }
  return `$$\n${expression}\n$$`;
}

function mermaidSource(values: ProfileFeatureValues): string | null {
  const diagram = multiline(values.source ?? values.body);
  if (!diagram) return null;
  const fence = fenceFor(diagram);
  return `${fence}mermaid\n${diagram}\n${fence}`;
}

function descriptionListSource(values: ProfileFeatureValues): string | null {
  const term = singleLine(values.term, "Term");
  const definition = multiline(
    values.definition ?? values.body ?? values.source,
  );
  if (!definition) return null;
  const lines = definition.split("\n").map((line) => `: ${line}`);
  return `${term}\n${lines.join("\n")}`;
}

function diffText(values: ProfileFeatureValues): string | null {
  const text = normalizeText(values.text ?? values.body ?? values.source);
  // Inline diff syntax is single-line. Keep repeated internal spaces and tabs
  // intact so the selected text is not silently changed by the dialog.
  if (!text || /[\r\n]/.test(text)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // GitLab's inline-diff delimiters are not nestable. Reject the ambiguous
  // forms instead of silently changing the selected user's text. All other
  // characters stay literal so the renderer can escape them exactly once.
  if (/\{[+-]|[+-]\}/.test(trimmed)) return null;
  return trimmed;
}

/** Build source for a palette feature, or null when its values are unsafe/empty. */
export function buildProfileFeatureSource(
  feature: ProfileFeatureId | ProfileFeatureDefinition,
  values: ProfileFeatureValues = {},
  profile: ProfileFeatureProfile = "github",
): string | null {
  const definition = featureDefinition(feature);
  if (!definition || !definition.profiles.includes(profile)) return null;
  switch (definition.id) {
    case "alert":
      return alertSource(values);
    case "details":
      return detailsSource(values);
    case "math":
      return mathSource(values, profile);
    case "mermaid":
      return mermaidSource(values);
    case "gitlab-toc":
      return "[[_TOC_]]";
    case "gitlab-description-list":
      return descriptionListSource(values);
    case "gitlab-diff-added": {
      const text = diffText(values);
      return text ? `{+ ${text} +}` : null;
    }
    case "gitlab-diff-removed": {
      const text = diffText(values);
      return text ? `{- ${text} -}` : null;
    }
  }
}

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function parsedFeatureNodes(
  core: ProfileFeatureCore,
  source: string,
  profile: ProfileFeatureProfile,
  definition: ProfileFeatureDefinition,
): PMNode[] | null {
  let parsed: { doc: PMNode };
  try {
    parsed = core.parseMarkdown(source, profile);
  } catch {
    return null;
  }
  const nodes = childrenOf(parsed.doc);
  if (definition.kind === "inline") return nodes;
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  if (
    node.type.name !== "raw_block" &&
    !(definition.id === "details" && node.type.name === "details")
  )
    return null;
  // A parser recovery node or a prematurely closed details range must never
  // turn the requested snippet into different source. Requiring an exact raw
  // source also keeps fenced literal details bodies source-preserving.
  if (String(node.attrs.source ?? "") !== source) return null;
  const kind = String(node.attrs.kind ?? "");
  const expected =
    definition.id === "alert"
      ? "alert"
      : definition.id === "details"
        ? "details"
        : definition.id === "math"
          ? "math-block"
          : definition.id === "mermaid"
            ? "protected-fence"
            : definition.id;
  const matchesMathFence =
    definition.id === "math" && kind === "protected-fence";
  return kind === expected || matchesMathFence ? nodes : null;
}

function topLevelBlock(
  state: EditorState,
): { node: PMNode; pos: number; end: number } | null {
  const selection = state.selection;
  if (selection instanceof AllSelection) return null;
  if (selection instanceof NodeSelection) {
    // A raw block selected as a node has a depth-zero resolved position. Keep
    // it intact and insert the next feature after its top-level boundary.
    if (selection.$from.depth !== 0) return null;
    const node = state.doc.nodeAt(selection.from);
    if (!node || node !== selection.node) return null;
    return { node, pos: selection.from, end: selection.to };
  }
  if (selection.$from.depth < 1) return null;
  const node = selection.$from.node(1);
  return {
    node,
    pos: selection.$from.before(1),
    end: selection.$from.after(1),
  };
}

type TopLevelBlockSpan = { node: PMNode; pos: number; end: number };

type PureTopLevelTextSelection = {
  start: TopLevelBlockSpan;
  end: TopLevelBlockSpan;
  fromOffset: number;
  toOffset: number;
};

function isEditableTopLevelTextblock(node: PMNode): boolean {
  return node.type.name === "paragraph" || node.type.name === "heading";
}

function pureTopLevelTextSelection(
  state: EditorState,
): PureTopLevelTextSelection | null {
  const selection = state.selection;
  if (
    !(selection instanceof TextSelection) ||
    selection.$from.depth !== 1 ||
    selection.$to.depth !== 1 ||
    !isEditableTopLevelTextblock(selection.$from.parent) ||
    !isEditableTopLevelTextblock(selection.$to.parent)
  )
    return null;

  const spans: TopLevelBlockSpan[] = [];
  state.doc.forEach((node, pos) => {
    const end = pos + node.nodeSize;
    const overlaps = selection.empty
      ? selection.from >= pos && selection.from <= end
      : selection.from < end && selection.to > pos;
    if (overlaps) spans.push({ node, pos, end });
  });
  if (
    spans.length === 0 ||
    spans.some((span) => !isEditableTopLevelTextblock(span.node))
  )
    return null;
  const start = spans[0]!;
  const end = spans[spans.length - 1]!;
  if (
    start.node !== selection.$from.node(1) ||
    end.node !== selection.$to.node(1)
  )
    return null;
  return {
    start,
    end,
    fromOffset: selection.from - selection.$from.start(1),
    toOffset: selection.to - selection.$to.start(1),
  };
}

function findNodePosition(doc: PMNode, target: PMNode): number {
  let result = -1;
  doc.descendants((node, position) => {
    if (node === target) {
      result = position;
      return false;
    }
    return true;
  });
  return result;
}

function paragraphFor(schema: Schema): PMNode | null {
  const paragraph = schema.nodes.paragraph;
  return paragraph ? paragraph.create() : null;
}

function placeCaretAfterBlock(tr: Transaction, inserted: PMNode): void {
  const position = findNodePosition(tr.doc, inserted);
  if (position < 0) return;
  let after = position + inserted.nodeSize;
  const next = tr.doc.nodeAt(after);
  if (!next || !isEditableTopLevelTextblock(next)) {
    const paragraph = paragraphFor(tr.doc.type.schema);
    if (!paragraph) return;
    tr.insert(after, paragraph);
  }
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1));
  } catch {
    // Keep ProseMirror's mapped selection for an unusual custom schema.
  }
}

function applyBlockFeature(
  state: EditorState,
  nodes: PMNode[],
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const top = topLevelBlock(state);
  const inserted = nodes[0];
  if (!top || !inserted || nodes.length !== 1) return false;
  if (state.schema !== inserted.type.schema) return false;
  const tr = state.tr;
  const pureSelection = pureTopLevelTextSelection(state);
  if (pureSelection) {
    const parts: PMNode[] = [];
    if (pureSelection.fromOffset > 0)
      parts.push(pureSelection.start.node.cut(0, pureSelection.fromOffset));
    parts.push(...nodes);
    if (pureSelection.toOffset < pureSelection.end.node.content.size)
      parts.push(
        pureSelection.end.node.cut(
          pureSelection.toOffset,
          pureSelection.end.node.content.size,
        ),
      );
    tr.replaceWith(
      pureSelection.start.pos,
      pureSelection.end.end,
      Fragment.fromArray(parts),
    );
  } else {
    // The insertion point is after the whole top-level block. This keeps raw
    // blocks out of tables and lists even when the selection is nested inside.
    tr.insert(top.end, Fragment.fromArray(nodes));
  }
  if (!dispatch) return true;
  placeCaretAfterBlock(tr, inserted);
  dispatch(tr.scrollIntoView());
  return true;
}

function rawInlineFeatureNode(nodes: PMNode[], schema: Schema): PMNode | null {
  if (nodes.length !== 1 || nodes[0]!.type.schema !== schema) return null;
  const block = nodes[0]!;
  if (block.type.name !== "paragraph" || block.childCount !== 1) return null;
  const inline = block.firstChild;
  return inline?.type.name === "raw_inline" ? inline : null;
}

function applyInlineFeature(
  state: EditorState,
  node: PMNode,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const selection = state.selection;
  if (
    !(selection instanceof TextSelection) ||
    selection.$from.parent !== selection.$to.parent ||
    selection.$from.parent.type.name === "code_block"
  )
    return false;
  const parent = selection.$from.parent;
  if (!parent.inlineContent) return false;
  const from = selection.from - selection.$from.start(selection.$from.depth);
  const to = selection.to - selection.$from.start(selection.$from.depth);
  let textOnly = true;
  parent.nodesBetween(from, to, (child) => {
    if (!child.isText) textOnly = false;
  });
  if (!textOnly) return false;
  if (!dispatch) return true;
  const tr = state.tr.replaceSelectionWith(node, true).scrollIntoView();
  dispatch(tr);
  return true;
}

/**
 * Create a profile-aware source feature command for a ProseMirror editor.
 * The caller owns the dialog; this command only validates, parses, and
 * inserts the resulting source-preserving PM atom in one transaction.
 */
export function createProfileFeatureCommand(
  core: ProfileFeatureCore,
  profile: ProfileFeatureProfile,
  feature: ProfileFeatureId | ProfileFeatureDefinition,
  values: ProfileFeatureValues = {},
): Command {
  return (state, dispatch) => {
    if (state.schema !== core.schema) return false;
    const definition = featureDefinition(feature);
    if (!definition || !definition.profiles.includes(profile)) return false;
    const source = buildProfileFeatureSource(definition, values, profile);
    if (!source) return false;
    const nodes = parsedFeatureNodes(core, source, profile, definition);
    if (!nodes) return false;
    if (definition.kind === "inline") {
      const node = rawInlineFeatureNode(nodes, state.schema);
      return node ? applyInlineFeature(state, node, dispatch) : false;
    }
    return applyBlockFeature(state, nodes, dispatch);
  };
}
