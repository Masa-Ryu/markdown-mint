import { serializeCodeBlockMarkdown } from "../core/codeBlockSerialization";
import { codeControlIcon } from "../core/visualRendering";

export interface CodeBlockControlBinding {
  dispose(): void;
}

export interface CodeBlockControlOptions {
  /** A host-backed writer can be supplied by the dedicated Webview. */
  copyText?: (value: string) => Promise<boolean>;
  /** Read the current model when the block belongs to a rich editor. */
  getCodeText?: (block: HTMLElement) => string;
  readOnly?: boolean;
}

type ClipboardNavigator = Navigator & {
  clipboard?: { writeText(value: string): Promise<void> };
};

interface BlockState {
  readonly ownerDocument: Document;
  readonly expandButton: HTMLButtonElement | undefined;
  readonly previousFocus: Element | null;
  readonly previousTabIndex: string | null;
  readonly previousRole: string | null;
  readonly previousAriaLabel: string | null;
  backdrop?: HTMLDivElement;
  keydown?: (event: KeyboardEvent) => void;
  disposed: boolean;
}

const blockStates = new WeakMap<HTMLElement, BlockState>();
const lineNumberSyncFrames = new WeakMap<HTMLElement, number>();

function codeBlocksWithin(root: ParentNode): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  if (root instanceof Element && root.matches(".mm-code-block"))
    blocks.push(root as HTMLElement);
  blocks.push(...root.querySelectorAll<HTMLElement>(".mm-code-block"));
  return blocks;
}

function codeLineHeight(code: HTMLElement): number {
  const style = code.ownerDocument.defaultView?.getComputedStyle(code);
  const lineHeight = Number.parseFloat(style?.lineHeight ?? "");
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style?.fontSize ?? "");
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : 24;
}

interface TextNodeOffset {
  readonly node: Text;
  readonly from: number;
  readonly to: number;
}

function textNodeOffsets(root: HTMLElement): TextNodeOffset[] {
  const result: TextNodeOffset[] = [];
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(
    root,
    typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT,
  );
  let offset = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const to = offset + node.data.length;
    result.push({ node, from: offset, to });
    offset = to;
    current = walker.nextNode();
  }
  return result;
}

function textPointAt(
  entries: readonly TextNodeOffset[],
  requestedOffset: number,
): [Text, number] | undefined {
  if (entries.length === 0) return undefined;
  const total = entries.at(-1)?.to ?? 0;
  const offset = Math.max(0, Math.min(requestedOffset, total));
  for (const entry of entries) {
    if (offset <= entry.to)
      return [entry.node, Math.max(0, offset - entry.from)];
  }
  const last = entries.at(-1)!;
  return [last.node, last.node.data.length];
}

/**
 * Align logical line labels with wrapped source lines without creating one
 * label for each visual row. The Range measurement is a no-op in DOMs without
 * layout (for example jsdom), where the CSS line-height remains the fallback.
 */
export function syncCodeLineNumberHeights(block: HTMLElement): void {
  const numbers = block.querySelector<HTMLElement>(".mm-code-line-numbers");
  const code = block.querySelector<HTMLElement>(".mm-code-block-pre code");
  if (!numbers || !code) return;
  const spans = Array.from(numbers.querySelectorAll<HTMLElement>("span"));
  const wrapped = block.classList.contains("mm-code-wrap-lines");
  const lineHeight = codeLineHeight(code);
  if (!wrapped) {
    for (const span of spans) {
      span.style.removeProperty("height");
      span.style.removeProperty("min-height");
    }
    return;
  }

  const source = code.textContent ?? "";
  const lines = source.split(/\r\n|\r|\n/);
  const entries = textNodeOffsets(code);
  let offset = 0;
  for (const [index, span] of spans.entries()) {
    const line = lines[index] ?? "";
    const start = offset;
    const end = start + line.length;
    offset = end + (index < lines.length - 1 ? 1 : 0);
    let height = lineHeight;
    const startPoint = textPointAt(entries, start);
    const endPoint = textPointAt(entries, end);
    const range = code.ownerDocument.createRange();
    if (startPoint && endPoint) {
      try {
        range.setStart(startPoint[0], startPoint[1]);
        range.setEnd(endPoint[0], endPoint[1]);
        const rects =
          typeof range.getClientRects === "function"
            ? Array.from(range.getClientRects())
            : [];
        if (rects.length > 0) {
          const top = Math.min(...rects.map((rect) => rect.top));
          const bottom = Math.max(...rects.map((rect) => rect.bottom));
          if (Number.isFinite(top) && Number.isFinite(bottom))
            height = Math.max(lineHeight, bottom - top);
        }
      } catch {
        // A block can be removed between scheduling and measurement.
      }
    }
    span.style.minHeight = `${height}px`;
  }
}

export function scheduleCodeLineNumberSync(block: HTMLElement): void {
  const view = block.ownerDocument.defaultView;
  const previous = lineNumberSyncFrames.get(block);
  if (previous !== undefined) view?.cancelAnimationFrame(previous);
  if (view?.requestAnimationFrame) {
    const frame = view.requestAnimationFrame(() => {
      lineNumberSyncFrames.delete(block);
      if (block.isConnected) syncCodeLineNumberHeights(block);
    });
    lineNumberSyncFrames.set(block, frame);
  } else syncCodeLineNumberHeights(block);
}

interface CopyState {
  readonly generation: number;
  timer?: number;
}

const copyStates = new WeakMap<HTMLElement, CopyState>();
let nextMenuId = 0;

function fallbackCopy(value: string, ownerDocument: Document): boolean {
  const textarea = ownerDocument.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  ownerDocument.body?.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = ownerDocument.execCommand?.("copy") === true;
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

/** Copy without changing the ProseMirror selection or source document. */
export async function copyCodeText(
  value: string,
  ownerDocument: Document,
  transport?: (value: string) => Promise<boolean>,
): Promise<boolean> {
  if (transport) {
    try {
      return (await transport(value)) === true;
    } catch {
      return false;
    }
  }
  const clipboard = (
    ownerDocument.defaultView?.navigator as ClipboardNavigator | undefined
  )?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      return fallbackCopy(value, ownerDocument);
    }
  }
  return fallbackCopy(value, ownerDocument);
}

function setStatus(
  block: HTMLElement,
  button: HTMLButtonElement,
  state: "idle" | "pending" | "success" | "failure",
): void {
  button.dataset.mmCopyState = state === "idle" ? "" : state;
  const label = button.querySelector<HTMLElement>(".mm-code-action-label");
  if (label) {
    label.textContent =
      state === "pending"
        ? "Copying…"
        : state === "success"
          ? "Copied"
          : state === "failure"
            ? "Copy failed"
            : "Copy";
  }
  button.setAttribute(
    "aria-label",
    state === "pending"
      ? "Copying code"
      : state === "success"
        ? "Copied code"
        : state === "failure"
          ? "Copy failed. Try again"
          : "Copy code",
  );
  button.title =
    state === "success"
      ? "Copied"
      : state === "failure"
        ? "Copy failed. Try again"
        : "Copy code";
  const status = block.querySelector<HTMLElement>(".mm-code-status");
  if (status) {
    status.textContent =
      state === "success"
        ? "Copied code"
        : state === "failure"
          ? "Copy failed. Try again"
          : "";
  }
}

function setExpandedState(block: HTMLElement, expanded: boolean): void {
  block.classList.toggle("mm-code-block-expanded", expanded);
  block.dataset.mmCodeExpanded = expanded ? "true" : "false";
  const button = block.querySelector<HTMLButtonElement>(
    '[data-mm-code-action="expand"]',
  );
  if (!button) return;
  button.setAttribute("aria-label", expanded ? "Close code" : "Expand code");
  button.title = expanded ? "Close" : "Expand";
  button.dataset.mmExpanded = expanded ? "true" : "false";
  const label = button.querySelector<HTMLElement>(".mm-code-action-label");
  if (label) label.textContent = expanded ? "Close" : "Expand";
  const icon = button.querySelector<HTMLElement>(".mm-code-action-icon");
  if (icon) {
    icon.replaceChildren(
      block.ownerDocument
        .createRange()
        .createContextualFragment(
          codeControlIcon(expanded ? "close" : "expand"),
        ),
    );
  }
}

function closeMenu(block: HTMLElement): boolean {
  const menu = block.querySelector<HTMLElement>(".mm-code-menu");
  const button = block.querySelector<HTMLButtonElement>(
    '[data-mm-code-action="more"]',
  );
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  button?.setAttribute("aria-expanded", "false");
  return true;
}

function codeText(
  block: HTMLElement,
  options: CodeBlockControlOptions,
): string {
  return (
    options.getCodeText?.(block) ??
    block.querySelector(".mm-code-block-pre code")?.textContent ??
    ""
  );
}

function codeInfo(block: HTMLElement): string {
  return block.dataset.mmCodeInfo ?? block.dataset.language ?? "";
}

function setDisplayOption(
  block: HTMLElement,
  option: "wrap" | "line-numbers",
  enabled: boolean,
): void {
  const className =
    option === "wrap" ? "mm-code-wrap-lines" : "mm-code-hide-line-numbers";
  block.classList.toggle(className, option === "wrap" ? enabled : !enabled);
  block.dataset[option === "wrap" ? "mmCodeWrap" : "mmCodeLineNumbers"] =
    String(enabled);
  const item = block.querySelector<HTMLElement>(
    `[data-mm-code-menu-option="${option}"]`,
  );
  item?.setAttribute("aria-checked", String(enabled));
  item?.classList.toggle("is-checked", enabled);
  if (option === "wrap") scheduleCodeLineNumberSync(block);
}

function createMenu(block: HTMLElement): HTMLElement {
  const ownerDocument = block.ownerDocument;
  const menu = ownerDocument.createElement("div");
  menu.className = "mm-code-menu";
  menu.id = `mm-code-menu-${++nextMenuId}`;
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  const options: Array<{
    id: "wrap" | "line-numbers" | "markdown";
    label: string;
  }> = [
    { id: "wrap", label: "Wrap lines" },
    { id: "line-numbers", label: "Show line numbers" },
    { id: "markdown", label: "Copy as Markdown" },
  ];
  for (const option of options) {
    const item = ownerDocument.createElement("button");
    item.type = "button";
    item.className = "mm-code-menu-item";
    item.dataset.mmCodeMenuOption = option.id;
    item.setAttribute(
      "role",
      option.id === "markdown" ? "menuitem" : "menuitemcheckbox",
    );
    item.setAttribute("tabindex", "-1");
    item.textContent = option.label;
    menu.append(item);
  }
  block.querySelector(".mm-code-block-header")?.append(menu);
  setDisplayOption(block, "wrap", block.dataset.mmCodeWrap === "true");
  setDisplayOption(
    block,
    "line-numbers",
    block.dataset.mmCodeLineNumbers !== "false",
  );
  return menu;
}

function ensureStatus(block: HTMLElement): void {
  if (block.querySelector(".mm-code-status")) return;
  const status = block.ownerDocument.createElement("span");
  status.className = "mm-code-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  block.querySelector(".mm-code-block-header")?.append(status);
}

function beginCopy(block: HTMLElement): CopyState {
  const previous = copyStates.get(block);
  if (previous?.timer !== undefined)
    block.ownerDocument.defaultView?.clearTimeout(previous.timer);
  const state: CopyState = {
    generation: (previous?.generation ?? 0) + 1,
  };
  copyStates.set(block, state);
  return state;
}

function finishCopy(
  block: HTMLElement,
  button: HTMLButtonElement,
  state: CopyState,
  success: boolean,
  disposed: () => boolean,
): void {
  if (disposed() || copyStates.get(block) !== state) return;
  setStatus(block, button, success ? "success" : "failure");
  const timer = block.ownerDocument.defaultView?.setTimeout(
    () => {
      if (disposed() || copyStates.get(block) !== state) return;
      setStatus(block, button, "idle");
      delete state.timer;
    },
    success ? 1400 : 2200,
  );
  if (timer !== undefined) state.timer = timer;
}

export function toggleCodeBlockExpanded(block: HTMLElement): void {
  const current = blockStates.get(block);
  if (current && !current.disposed) {
    closeCodeBlockExpanded(block);
    return;
  }
  const ownerDocument = block.ownerDocument;
  const state: BlockState = {
    ownerDocument,
    expandButton:
      block.querySelector<HTMLButtonElement>(
        '[data-mm-code-action="expand"]',
      ) ?? undefined,
    previousFocus: ownerDocument.activeElement,
    previousTabIndex: block.getAttribute("tabindex"),
    previousRole: block.getAttribute("role"),
    previousAriaLabel: block.getAttribute("aria-label"),
    disposed: false,
  };
  const backdrop = ownerDocument.createElement("div");
  backdrop.className = "mm-code-focus-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.addEventListener("click", () => closeCodeBlockExpanded(block));
  ownerDocument.body?.append(backdrop);
  state.backdrop = backdrop;
  state.keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      // A language picker belongs to the editor NodeView and owns its own
      // Escape handling. Let it close before the surrounding dialog does.
      if (block.querySelector(".mm-code-language-menu:not([hidden])")) return;
      if (closeMenu(block)) {
        event.preventDefault();
        event.stopPropagation();
        block
          .querySelector<HTMLButtonElement>('[data-mm-code-action="more"]')
          ?.focus();
        return;
      }
      event.preventDefault();
      closeCodeBlockExpanded(block);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      block.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.closest("[hidden]"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const active = ownerDocument.activeElement;
    const index =
      active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      focusable.at(-1)?.focus();
    } else if (!event.shiftKey && index === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  };
  ownerDocument.addEventListener("keydown", state.keydown, true);
  blockStates.set(block, state);
  block.classList.add("mm-code-block-expanded");
  block.dataset.mmCodeExpanded = "true";
  block.setAttribute("role", "dialog");
  block.setAttribute("aria-modal", "true");
  block.setAttribute("aria-label", "Expanded code block");
  block.setAttribute("tabindex", "-1");
  setExpandedState(block, true);
  state.expandButton?.focus();
}

export function closeCodeBlockExpanded(block: HTMLElement): void {
  const state = blockStates.get(block);
  if (!state || state.disposed) return;
  state.disposed = true;
  if (state.keydown)
    state.ownerDocument.removeEventListener("keydown", state.keydown, true);
  state.backdrop?.remove();
  block.classList.remove("mm-code-block-expanded");
  block.dataset.mmCodeExpanded = "false";
  block.removeAttribute("aria-modal");
  if (state.previousRole === null) block.removeAttribute("role");
  else block.setAttribute("role", state.previousRole);
  if (state.previousAriaLabel === null) block.removeAttribute("aria-label");
  else block.setAttribute("aria-label", state.previousAriaLabel);
  if (state.previousTabIndex === null) block.removeAttribute("tabindex");
  else block.setAttribute("tabindex", state.previousTabIndex);
  setExpandedState(block, false);
  if (
    state.previousFocus instanceof HTMLElement &&
    state.previousFocus.isConnected
  )
    state.previousFocus.focus();
  blockStates.delete(block);
}

/** Backward-compatible name used by existing NodeView callers. */
export const toggleCodeBlockFullscreen = toggleCodeBlockExpanded;

function setMenuState(block: HTMLElement, open: boolean): void {
  const menu =
    block.querySelector<HTMLElement>(".mm-code-menu") ?? createMenu(block);
  menu.hidden = !open;
  const button = block.querySelector<HTMLButtonElement>(
    '[data-mm-code-action="more"]',
  );
  button?.setAttribute("aria-controls", menu.id);
  button?.setAttribute("aria-expanded", String(open));
  if (open)
    menu.querySelector<HTMLElement>("[data-mm-code-menu-option]")?.focus();
}

async function handleCodeAction(
  event: Event,
  block: HTMLElement,
  options: CodeBlockControlOptions,
  disposed: () => boolean,
): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const actionButton = target.closest<HTMLButtonElement>(
    "[data-mm-code-action]",
  );
  if (!actionButton || actionButton.disabled) return;
  const action = actionButton.dataset.mmCodeAction;
  event.preventDefault();
  event.stopPropagation();
  if (action === "more") {
    const menu = block.querySelector<HTMLElement>(".mm-code-menu");
    setMenuState(block, !menu || menu.hidden);
    return;
  }
  if (action === "expand") {
    toggleCodeBlockExpanded(block);
    return;
  }
  if (action !== "copy") return;
  ensureStatus(block);
  const value = codeText(block, options);
  const copyState = beginCopy(block);
  setStatus(block, actionButton, "pending");
  const success = await copyCodeText(
    value,
    block.ownerDocument,
    options.copyText,
  );
  finishCopy(block, actionButton, copyState, success, disposed);
}

function handleMenuAction(
  event: Event,
  block: HTMLElement,
  options: CodeBlockControlOptions,
  disposed: () => boolean,
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const item = target.closest<HTMLButtonElement>("[data-mm-code-menu-option]");
  if (!item || item.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const option = item.dataset.mmCodeMenuOption;
  if (option === "wrap") {
    setDisplayOption(block, "wrap", block.dataset.mmCodeWrap !== "true");
    return;
  }
  if (option === "line-numbers") {
    setDisplayOption(
      block,
      "line-numbers",
      block.dataset.mmCodeLineNumbers !== "true",
    );
    return;
  }
  if (option !== "markdown") return;
  ensureStatus(block);
  const copyButton = block.querySelector<HTMLButtonElement>(
    '[data-mm-code-action="copy"]',
  );
  if (!copyButton) return;
  const copyState = beginCopy(block);
  setStatus(block, copyButton, "pending");
  void copyCodeText(
    serializeCodeBlockMarkdown(codeText(block, options), codeInfo(block)),
    block.ownerDocument,
    options.copyText,
  ).then((success) => {
    finishCopy(block, copyButton, copyState, success, disposed);
  });
  closeMenu(block);
}

/** Bind delegated actions to one rendered root; disposing removes every listener. */
export function enhanceCodeBlockControls(
  root: ParentNode,
  options: CodeBlockControlOptions = {},
): CodeBlockControlBinding {
  const ownerDocument =
    (root as Node & { ownerDocument?: Document }).ownerDocument ??
    (typeof document === "undefined" ? undefined : document);
  const eventTarget = root as unknown as EventTarget;
  if (!ownerDocument || typeof eventTarget.addEventListener !== "function")
    return { dispose: () => undefined };
  let disposed = false;
  const pointerEventTarget: EventTarget =
    root instanceof Element ? ownerDocument : eventTarget;
  const blockFor = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element
      ? target.closest<HTMLElement>(".mm-code-block")
      : null;
  const clickListener = (event: Event): void => {
    const block = blockFor(event.target);
    if (!block || !(root as Node).contains?.(block)) return;
    const element = event.target as Element;
    if (element.closest("[data-mm-code-action]"))
      void handleCodeAction(event, block, options, () => disposed);
    else handleMenuAction(event, block, options, () => disposed);
  };
  const pointerListener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".mm-code-menu")) return;
    for (const block of codeBlocksWithin(root)) {
      if (block.contains(target)) continue;
      if (block.querySelector<HTMLElement>(".mm-code-menu:not([hidden])"))
        closeMenu(block);
    }
  };
  const keydownListener = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target;
    if (!(target instanceof Element)) return;
    const menu = target.closest<HTMLElement>(".mm-code-menu");
    if (!menu || !(root as Node).contains?.(menu)) return;
    const block = blockFor(menu);
    if (!block) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("[data-mm-code-menu-option]"),
    );
    const index = items.indexOf(target.closest("button") as HTMLButtonElement);
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeMenu(block);
      block
        .querySelector<HTMLButtonElement>('[data-mm-code-action="more"]')
        ?.focus();
      return;
    }
    if (keyboardEvent.key !== "ArrowDown" && keyboardEvent.key !== "ArrowUp")
      return;
    keyboardEvent.preventDefault();
    const next =
      keyboardEvent.key === "ArrowDown"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  eventTarget.addEventListener("click", clickListener);
  pointerEventTarget.addEventListener("pointerdown", pointerListener);
  eventTarget.addEventListener("keydown", keydownListener);
  for (const block of codeBlocksWithin(root)) {
    ensureStatus(block);
    if (!block.dataset.mmCodeWrap) block.dataset.mmCodeWrap = "false";
    if (!block.dataset.mmCodeLineNumbers)
      block.dataset.mmCodeLineNumbers = "true";
    if (block.querySelector('[data-mm-code-action="more"]')) {
      const more = block.querySelector<HTMLButtonElement>(
        '[data-mm-code-action="more"]',
      )!;
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      const menu =
        block.querySelector<HTMLElement>(".mm-code-menu") ?? createMenu(block);
      more.setAttribute("aria-controls", menu.id);
    }
    scheduleCodeLineNumberSync(block);
  }
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      eventTarget.removeEventListener("click", clickListener);
      pointerEventTarget.removeEventListener("pointerdown", pointerListener);
      eventTarget.removeEventListener("keydown", keydownListener);
      for (const block of codeBlocksWithin(root)) {
        closeCodeBlockExpanded(block);
        const frame = lineNumberSyncFrames.get(block);
        if (frame !== undefined)
          ownerDocument.defaultView?.cancelAnimationFrame(frame);
        lineNumberSyncFrames.delete(block);
        const copyState = copyStates.get(block);
        if (copyState?.timer !== undefined)
          ownerDocument.defaultView?.clearTimeout(copyState.timer);
        copyStates.delete(block);
      }
    },
  };
}
