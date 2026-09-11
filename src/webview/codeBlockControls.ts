/**
 * Shared controls used by code blocks in the rich editor and in the native
 * Markdown preview.  The document renderer owns the markup; this module only
 * wires the safe, display-only actions to that markup.
 */

export interface CodeBlockControlBinding {
  dispose(): void;
}

type ClipboardNavigator = Navigator & {
  clipboard?: {
    writeText(value: string): Promise<void>;
  };
};

type FullscreenElement = HTMLElement & {
  requestFullscreen?: () => Promise<void>;
};

type FullscreenDocument = Document & {
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
};

function fallbackCopy(value: string, ownerDocument: Document): void {
  const textarea = ownerDocument.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  ownerDocument.body?.append(textarea);
  textarea.select();
  try {
    ownerDocument.execCommand?.("copy");
  } finally {
    textarea.remove();
  }
}

/** Copy code without changing the ProseMirror selection or source document. */
export function copyCodeText(value: string, ownerDocument: Document): void {
  const clipboard = (
    ownerDocument.defaultView?.navigator as ClipboardNavigator | undefined
  )?.clipboard;
  if (clipboard?.writeText) {
    void clipboard
      .writeText(value)
      .catch(() => fallbackCopy(value, ownerDocument));
    return;
  }
  fallbackCopy(value, ownerDocument);
}

function setCopyState(button: HTMLButtonElement, copied: boolean): void {
  button.dataset.mmCopyState = copied ? "copied" : "";
  button.setAttribute("aria-label", copied ? "Copied code" : "Copy code");
  button.title = copied ? "Copied" : "Copy code";
}

function setExpandedState(block: HTMLElement, expanded: boolean): void {
  block.classList.toggle("mm-code-block-expanded", expanded);
  block.dataset.mmCodeExpanded = expanded ? "true" : "false";
  const button = block.querySelector<HTMLButtonElement>(
    '[data-mm-code-action="expand"]',
  );
  if (!button) return;
  button.setAttribute("aria-label", expanded ? "Collapse code" : "Expand code");
  button.title = expanded ? "Collapse" : "Expand";
  button.dataset.mmExpanded = expanded ? "true" : "false";
  const label = button.querySelector<HTMLElement>(".mm-code-action-label");
  if (label) label.textContent = expanded ? "Collapse" : "Expand";
  const icon = button.querySelector<HTMLElement>(".mm-code-action-icon");
  if (icon) icon.textContent = expanded ? "↙" : "⤢";
}

/** Toggle native fullscreen when available and retain a CSS expansion fallback. */
export function toggleCodeBlockFullscreen(block: HTMLElement): void {
  const ownerDocument = block.ownerDocument as FullscreenDocument;
  const fullscreen = ownerDocument.fullscreenElement;
  if (fullscreen === block) {
    const exit = ownerDocument.exitFullscreen;
    if (exit)
      void exit()
        .then(() => setExpandedState(block, false))
        .catch(() => setExpandedState(block, false));
    else setExpandedState(block, false);
    return;
  }

  const request = (block as FullscreenElement).requestFullscreen;
  if (request) {
    void request
      .call(block)
      .then(() => setExpandedState(block, true))
      .catch(() =>
        setExpandedState(
          block,
          !block.classList.contains("mm-code-block-expanded"),
        ),
      );
    return;
  }
  setExpandedState(block, !block.classList.contains("mm-code-block-expanded"));
}

function codeBlockFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".mm-code-block");
}

function codeText(block: HTMLElement): string {
  return block.querySelector("pre code")?.textContent ?? "";
}

function handleCodeAction(event: Event, ownerDocument: Document): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const actionButton = target.closest<HTMLButtonElement>(
    "[data-mm-code-action]",
  );
  if (!actionButton || actionButton.disabled) return;
  const block = codeBlockFromTarget(actionButton);
  if (!block) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const action = actionButton.dataset.mmCodeAction;
  if (action === "copy") {
    copyCodeText(codeText(block), ownerDocument);
    setCopyState(actionButton, true);
    ownerDocument.defaultView?.setTimeout(
      () => setCopyState(actionButton, false),
      1400,
    );
  } else if (action === "expand") {
    toggleCodeBlockFullscreen(block);
  }
}

/**
 * Bind event delegation once for a rendered preview root. This also powers
 * VS Code's native Markdown preview, where the HTML is static after render.
 */
export function enhanceCodeBlockControls(
  root: ParentNode,
): CodeBlockControlBinding {
  const ownerDocument =
    (root as Node & { ownerDocument?: Document }).ownerDocument ??
    (typeof document === "undefined" ? undefined : document);
  if (!ownerDocument) return { dispose: () => undefined };
  const listener = (event: Event): void =>
    handleCodeAction(event, ownerDocument);
  ownerDocument.addEventListener("click", listener);
  const fullscreenListener = (): void => {
    const active = (ownerDocument as FullscreenDocument).fullscreenElement;
    for (const block of Array.from(
      root.querySelectorAll<HTMLElement>(".mm-code-block"),
    ))
      setExpandedState(block, active === block);
  };
  ownerDocument.addEventListener("fullscreenchange", fullscreenListener);
  return {
    dispose: () => {
      ownerDocument.removeEventListener("click", listener);
      ownerDocument.removeEventListener("fullscreenchange", fullscreenListener);
    },
  };
}
