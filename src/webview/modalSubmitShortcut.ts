const INSERT_DIALOG_SELECTOR = [
  "dialog.mm-table-dialog",
  "dialog.mm-profile-feature-dialog",
  'dialog[aria-labelledby="mm-link-dialog-title"]',
  'dialog[aria-labelledby="mm-image-dialog-title"]',
].join(", ");

function usesMacPrimaryModifier(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

function hasSubmitModifier(event: KeyboardEvent, platform: string): boolean {
  if (usesMacPrimaryModifier(platform))
    return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && !event.metaKey;
}

/**
 * Submit insertion/editing dialogs with the platform primary modifier + Enter
 * without affecting confirmation or recovery dialogs.
 *
 * macOS uses Command+Enter. Windows/Linux use Ctrl+Enter.
 *
 * Listen on the owning document in the capture phase so controls inside a
 * modal cannot accidentally hide the shortcut by stopping keydown bubbling.
 * Submission is deferred until the key event finishes dispatching so a modal's
 * own key handler can update its current selection first (for example, the
 * table-size grid).
 */
export function installModalSubmitShortcut(
  root: Document | HTMLElement = document,
  platform = typeof navigator !== "undefined" ? navigator.platform : "",
): () => void {
  const ownerDocument = root instanceof Document ? root : root.ownerDocument;
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (
      event.key !== "Enter" ||
      !hasSubmitModifier(event, platform) ||
      event.altKey ||
      event.shiftKey ||
      event.isComposing ||
      event.repeat
    )
      return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (root instanceof HTMLElement && !root.contains(target)) return;

    const dialog = target.closest<HTMLDialogElement>(INSERT_DIALOG_SELECTOR);
    if (!dialog?.open) return;

    const form = dialog.querySelector<HTMLFormElement>("form");
    if (!form) return;
    const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"]:not(:disabled), input[type="submit"]:not(:disabled)',
    );
    if (!submitter) return;

    event.preventDefault();
    queueMicrotask(() => {
      if (!dialog.open || !dialog.isConnected || !form.isConnected) return;
      if (submitter.disabled || !submitter.isConnected) return;
      if (typeof form.requestSubmit === "function") form.requestSubmit(submitter);
      else submitter.click();
    });
  };

  ownerDocument.addEventListener("keydown", onKeyDown, true);
  return () => ownerDocument.removeEventListener("keydown", onKeyDown, true);
}
