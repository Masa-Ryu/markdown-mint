import type { Node as PMNode } from "prosemirror-model";
import type { FootnoteDefinition, MarkdownSnapshot, Profile } from "../index";

/** Whether the active Markdown profile defines a portable heading fragment. */
export type HeadingAnchorVerification = "verified" | "unknown";

/**
 * One rendered heading occurrence.
 *
 * A ProseMirror node is not an occurrence identity: Details bodies may reuse
 * the same immutable node object at several positions. `renderRoot` and
 * `nodePath` therefore identify the rendered occurrence independently of the
 * node object, while `position` remains available for ordinary PM nodes.
 */
export interface HeadingAnchor {
  readonly occurrenceId: string;
  readonly renderRoot: string;
  readonly nodePath: readonly number[];
  readonly position: number | undefined;
  readonly displayText: string;
  /** Alias retained for callers that use the shorter text terminology. */
  readonly text: string;
  readonly level: number;
  readonly id: string;
  readonly verifiable: boolean;
  readonly verification: HeadingAnchorVerification;
}

/** Optional adapters used to inspect headings inside source-backed fragments. */
export interface HeadingAnchorCollectionOptions {
  /** Parse a nested rendered Markdown fragment with the active profile. */
  readonly parseFragment?: (
    source: string,
    profile: Profile,
  ) => Pick<MarkdownSnapshot, "doc">;
  /** Return the rendered body of a source-backed block, when it has one. */
  readonly fragmentSource?: (
    node: PMNode,
    profile: Profile,
  ) => string | undefined;
  /** Footnote bodies emitted after the main document. */
  readonly footnotes?: readonly Pick<FootnoteDefinition, "label" | "content">[];
}

/** Build a stable key for a rendered heading occurrence. */
export function headingOccurrenceId(
  renderRoot: string,
  nodePath: readonly number[],
): string {
  return `${renderRoot}|${nodePath.join("/")}`;
}

const emojiShortcodes: Record<string, string> = {
  tada: "🎉",
  party: "🎉",
  rocket: "🚀",
  warning: "⚠️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  checkered_flag: "🏁",
  construction: "🚧",
  x: "❌",
  cross_mark: "❌",
  bulb: "💡",
  memo: "📝",
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  blush: "😊",
  wink: "😉",
  heart: "❤️",
  sparkles: "✨",
  fire: "🔥",
  eyes: "👀",
  tada_dance: "💃",
};

/** Resolve the small emoji shortcode set shared by parsing and anchors. */
export function emojiForShortcode(value: string): string | undefined {
  return emojiShortcodes[value.toLowerCase()];
}

/** Convert a heading node to the text exposed by its rendered inline content. */
export function headingDisplayText(node: PMNode): string {
  let output = "";
  node.forEach((child) => {
    if (child.isText) output += child.text ?? "";
    else if (child.type.name === "image")
      output += String(child.attrs.alt ?? "");
    else if (child.type.name === "raw_inline") {
      const kind = String(child.attrs.kind ?? "");
      const source = String(child.attrs.source ?? "");
      if (kind === "emoji")
        // GitHub and GitLab derive the heading anchor from the shortcode name
        // (`:thumbsup:` -> `thumbsup`), even though the rendered heading shows
        // the corresponding emoji glyph.
        output += source.slice(1, -1) || source;
      else if (
        kind === "html-pair" &&
        typeof child.attrs.displayText === "string"
      )
        output += child.attrs.displayText;
      else if (kind !== "html-comment")
        output += source.replace(/<[^>]*>/g, "");
    } else output += headingDisplayText(child);
  });
  return output;
}

function isAnchorCharacter(value: string): boolean {
  return /[\p{L}\p{N}\p{M}]/u.test(value);
}

function githubSlugBase(value: string): string {
  let filtered = "";
  for (const character of value.toLowerCase()) {
    if (
      character === " " ||
      character === "-" ||
      character === "_" ||
      isAnchorCharacter(character)
    )
      filtered += character;
  }
  return filtered.replace(/ /g, "-") || "section";
}

function gitlabSlugBase(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .replace(/\s/gu, "-") || "section"
  );
}

/**
 * CommonMark does not define automatic heading fragments. Keep Markdown
 * Mint's historical display-only shape for this profile, but do not perform
 * lossy Unicode decomposition or claim that the result is a CommonMark
 * standard anchor.
 */
function commonmarkSlugBase(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "section";
}

/** Return the profile-specific base before document-wide collision handling. */
export function headingSlugBase(value: string, profile: Profile): string {
  if (profile === "gitlab") return gitlabSlugBase(value);
  if (profile === "commonmark") return commonmarkSlugBase(value);
  return githubSlugBase(value);
}

class AnchorAllocator {
  private readonly used = new Set<string>();
  private readonly nextSuffix = new Map<string, number>();

  public constructor(private readonly profile: Profile) {}

  public allocate(baseText: string): string {
    const base = headingSlugBase(baseText, this.profile);
    let suffix = this.nextSuffix.get(base) ?? 0;
    let candidate = suffix === 0 ? base : `${base}-${suffix}`;
    while (this.used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.nextSuffix.set(base, suffix);
    this.used.add(candidate);
    return candidate;
  }
}

/** Return the render-root id used for a source-backed fragment. */
export function headingFragmentRoot(path: readonly number[]): string {
  return `fragment:${path.length > 0 ? path.join(".") : "root"}`;
}

/** Return the render-root id used for a rendered footnote body. */
export function headingFootnoteRoot(label: string): string {
  return `footnote:${encodeURIComponent(label)}`;
}

/** Return a nested source-fragment root without colliding with its parent. */
export function nestedHeadingFragmentRoot(
  parentRoot: string,
  path: readonly number[],
): string {
  return parentRoot === "document"
    ? headingFragmentRoot(path)
    : `${parentRoot}/${headingFragmentRoot(path)}`;
}

function headingLevel(node: PMNode): number {
  return Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
}

/**
 * Collect every heading that the shared renderer can emit, in rendered
 * document order. Source-backed Alert/Details fragments are included when
 * the caller supplies the two small adapters above.
 */
export function collectHeadingAnchors(
  snapshot: Pick<MarkdownSnapshot, "doc">,
  profile: Profile = "github",
  options: HeadingAnchorCollectionOptions = {},
): HeadingAnchor[] {
  const allocator = new AnchorAllocator(profile);
  const anchors: HeadingAnchor[] = [];
  const verification: HeadingAnchorVerification =
    profile === "commonmark" ? "unknown" : "verified";

  const visit = (
    node: PMNode,
    nodePath: readonly number[],
    position: number | undefined,
    renderRoot: string,
  ): void => {
    if (node.type.name === "heading") {
      const displayText = headingDisplayText(node);
      const id = allocator.allocate(displayText);
      anchors.push({
        occurrenceId: headingOccurrenceId(renderRoot, nodePath),
        renderRoot,
        nodePath: [...nodePath],
        position,
        displayText,
        text: displayText,
        level: headingLevel(node),
        id,
        verifiable: verification === "verified",
        verification,
      });
    }

    if (
      node.type.name === "raw_block" &&
      options.fragmentSource &&
      options.parseFragment
    ) {
      const source = options.fragmentSource(node, profile);
      if (source !== undefined) {
        try {
          const fragment = options.parseFragment(source, profile);
          visit(
            fragment.doc,
            nodePath,
            undefined,
            nestedHeadingFragmentRoot(renderRoot, nodePath),
          );
        } catch {
          // A source-backed fragment that cannot be parsed is not a heading
          // occurrence. The outer raw block remains source-preserving.
        }
      }
    }

    let childIndex = 0;
    const contentStart =
      position === undefined
        ? undefined
        : position + (node.type.name === "doc" ? 0 : 1);
    node.forEach((child, offset) => {
      visit(
        child,
        [...nodePath, childIndex],
        contentStart === undefined ? undefined : contentStart + offset,
        renderRoot,
      );
      childIndex += 1;
    });
  };

  visit(snapshot.doc, [], 0, "document");
  for (const footnote of options.footnotes ?? []) {
    try {
      const fragment = options.parseFragment?.(footnote.content, profile);
      if (fragment)
        visit(fragment.doc, [], undefined, headingFootnoteRoot(footnote.label));
    } catch {
      // A malformed footnote body remains source-preserving and has no
      // collectable heading occurrence.
    }
  }
  return anchors;
}
