const INSERT_DIALOG_SELECTOR = [
  "dialog.mm-table-dialog",
  "dialog.mm-profile-feature-dialog",
  'dialog[aria-labelledby="mm-link-dialog-title"]',
  'dialog[aria-labelledby="mm-image-dialog-title"]',
].join(", ");

/**
 * Submit insertion/editing dialogs with Ctrl+Enter without affecting
 * confirmation or recovery dialogs.
 */
export function installModalSubmitShortcut(
  root: Document | HTMLElement = document,
): () => void {
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (
      event.key !== "Enter" ||
      !event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      event.repeat
    )
      return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const dialog = target.closest<HTMLDialogElement>(INSERT_DIALOG_SELECTOR);
    if (!dialog?.open) return;

    const form = dialog.querySelector<HTMLFormElement>("form");
    if (!form) return;
    const submitter = form.querySelector<
      HTMLButtonElement | HTMLInputElement
    >(
      'button[type="submit"]:not(:disabled), input[type="submit"]:not(:disabled)',
    );
    if (!submitter) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof form.requestSubmit === "function") form.requestSubmit(submitter);
    else submitter.click();
  };

  root.addEventListener("keydown", onKeyDown);
  return () => root.removeEventListener("keydown", onKeyDown);
}
