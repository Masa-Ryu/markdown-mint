import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FILE_AUTOCOMPLETE_DEBOUNCE_MS,
  FileAutocomplete,
} from "../../src/webview/fileAutocomplete";
import type { WorkspaceFileCandidate } from "../../src/shared/workspaceFileSearch";

function candidate(
  fileName: string,
  relativePath = `./${fileName}`,
): WorkspaceFileCandidate {
  return {
    fileName,
    directory: "docs/",
    relativePath,
  };
}

function dispatchInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchKey(
  input: HTMLInputElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  input.dispatchEvent(event);
  return event;
}

function dispatchPointer(target: Element, type: "pointermove" | "pointerdown") {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

function createAutocomplete(
  onSelect: (candidate: WorkspaceFileCandidate) => void = () => undefined,
  onEnter?: () => void,
): { input: HTMLInputElement; autocomplete: FileAutocomplete } {
  const input = document.createElement("input");
  document.body.append(input);
  const autocomplete = new FileAutocomplete({
    input,
    debounceMs: 0,
    onQuery: () => undefined,
    onSelect,
    ...(onEnter ? { onEnter } : {}),
  });
  autocomplete.open();
  input.focus();
  return { input, autocomplete };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("FileAutocomplete active candidate interaction", () => {
  it("dispatches the default search without the legacy 75ms debounce", () => {
    expect(DEFAULT_FILE_AUTOCOMPLETE_DEBOUNCE_MS).toBe(0);
    const onQuery = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);
    const autocomplete = new FileAutocomplete({
      input,
      onQuery,
    });
    autocomplete.open();

    dispatchInput(input, "h");

    expect(onQuery).toHaveBeenCalledWith("h");
    autocomplete.dispose();
  });

  it("separates loading, results, and empty states", () => {
    const { input, autocomplete } = createAutocomplete();
    dispatchInput(input, "h");
    const popup = document.querySelector<HTMLElement>(".mm-file-autocomplete")!;

    expect(popup.dataset.searchState).toBe("loading");
    expect(popup.querySelector(".mm-file-autocomplete-loading")).not.toBeNull();
    expect(popup.querySelector(".mm-file-autocomplete-empty")).toBeNull();

    autocomplete.setCandidates([candidate("alpha.md")]);
    expect(popup.dataset.searchState).toBe("results");
    expect(popup.querySelector(".mm-file-autocomplete-loading")).toBeNull();
    expect(popup.querySelector(".mm-file-autocomplete-option")).not.toBeNull();

    autocomplete.setCandidates([]);
    expect(popup.dataset.searchState).toBe("empty");
    expect(popup.querySelector(".mm-file-autocomplete-loading")).toBeNull();
    expect(popup.querySelector(".mm-file-autocomplete-empty")).not.toBeNull();
    expect(
      popup.parentElement?.querySelector<HTMLElement>(
        ".mm-file-autocomplete-footer",
      )?.textContent,
    ).toBe("Enter a path or URL manually.");
    autocomplete.dispose();
  });

  it("records the input-to-render timing phases", () => {
    const timing = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);
    const autocomplete = new FileAutocomplete({
      input,
      onQuery: () => undefined,
      onSearchTiming: timing,
    });
    autocomplete.open();

    dispatchInput(input, "h");
    autocomplete.setCandidates([candidate("alpha.md")]);

    expect(timing.mock.calls.map(([phase]) => phase)).toEqual([
      "input",
      "search-dispatch",
      "host-result",
      "dom-update",
    ]);
    autocomplete.dispose();
  });

  it("keeps keyboard and pointer selection in one activeIndex", () => {
    const { input, autocomplete } = createAutocomplete();
    dispatchInput(input, "h");
    const files = [candidate("alpha.md"), candidate("beta.md")];
    autocomplete.setCandidates(files);
    const options = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mm-file-autocomplete-option",
        ),
      );

    dispatchPointer(options()[0]!, "pointermove");
    expect(document.querySelectorAll(".is-active")).toHaveLength(1);
    expect(options()[0]?.classList.contains("is-active")).toBe(true);

    dispatchKey(input, "ArrowDown");
    expect(document.querySelectorAll(".is-active")).toHaveLength(1);
    expect(options()[1]?.classList.contains("is-active")).toBe(true);
    expect(input).toBe(document.activeElement);

    // A real pointer move, rather than the pointer's stationary location,
    // is what switches the active candidate back to the first option.
    dispatchPointer(options()[0]!, "pointermove");
    expect(document.querySelectorAll(".is-active")).toHaveLength(1);
    expect(options()[0]?.classList.contains("is-active")).toBe(true);
    autocomplete.dispose();
  });

  it("updates active presentation without rebuilding candidate DOM", () => {
    const { input, autocomplete } = createAutocomplete();
    dispatchInput(input, "h");
    autocomplete.setCandidates([candidate("alpha.md"), candidate("beta.md")]);
    const popup = document.querySelector<HTMLElement>(".mm-file-autocomplete")!;
    const first = popup.querySelector<HTMLButtonElement>(
      '[data-mm-file-autocomplete-option="0"]',
    )!;
    const second = popup.querySelector<HTMLButtonElement>(
      '[data-mm-file-autocomplete-option="1"]',
    )!;
    const replaceChildren = vi.spyOn(popup, "replaceChildren");

    dispatchKey(input, "ArrowDown");

    expect(replaceChildren).not.toHaveBeenCalled();
    expect(popup.querySelectorAll(".is-active")).toHaveLength(1);
    expect(first.isConnected).toBe(true);
    expect(second.isConnected).toBe(true);
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(second.id);
    expect(
      popup.parentElement?.querySelector<HTMLElement>(
        ".mm-file-autocomplete-footer",
      )?.textContent,
    ).toBe("./beta.md");

    dispatchPointer(first, "pointermove");
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(first.classList.contains("is-active")).toBe(true);
    expect(second.classList.contains("is-active")).toBe(false);
    autocomplete.dispose();
  });

  it("preserves the active candidate when async results are refreshed", () => {
    const { input, autocomplete } = createAutocomplete();
    dispatchInput(input, "h");
    const firstResults = [candidate("alpha.md"), candidate("beta.md")];
    autocomplete.setCandidates(firstResults);
    dispatchKey(input, "ArrowDown");

    autocomplete.setCandidates([
      candidate("gamma.md"),
      candidate("beta.md"),
      candidate("delta.md"),
    ]);
    expect(
      document.querySelector<HTMLButtonElement>(
        ".mm-file-autocomplete-option.is-active",
      )?.textContent,
    ).toContain("beta.md");
    autocomplete.dispose();
  });

  it("confirms only the active candidate on Enter and supports pointer clicks", () => {
    const selected = vi.fn();
    const { input, autocomplete } = createAutocomplete(selected);
    dispatchInput(input, "h");
    autocomplete.setCandidates([candidate("alpha.md"), candidate("beta.md")]);
    dispatchKey(input, "ArrowDown");
    const enter = dispatchKey(input, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(selected).toHaveBeenCalledWith(candidate("beta.md"));

    dispatchInput(input, "h");
    autocomplete.setCandidates([candidate("alpha.md"), candidate("beta.md")]);
    const option = document.querySelector<HTMLButtonElement>(
      ".mm-file-autocomplete-option:nth-child(2)",
    );
    expect(option).not.toBeNull();
    option!.click();
    expect(selected).toHaveBeenLastCalledWith(candidate("beta.md"));
    autocomplete.dispose();
  });

  it("blocks Enter while loading and allows manual Enter after an empty result", () => {
    const selected = vi.fn();
    const onEnter = vi.fn();
    const { input, autocomplete } = createAutocomplete(selected, onEnter);

    dispatchInput(input, "ho");
    expect(autocomplete.isSearchPending()).toBe(true);

    for (const init of [{}, { ctrlKey: true }, { metaKey: true }]) {
      const enter = dispatchKey(input, "Enter", init);
      expect(enter.defaultPrevented).toBe(true);
    }
    expect(selected).not.toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();

    // A late result only updates the candidates. It must not replay the
    // Enter that was ignored while the request was pending.
    autocomplete.setCandidates([candidate("hoge.pdf")]);
    expect(selected).not.toHaveBeenCalled();
    expect(autocomplete.isSearchPending()).toBe(false);

    dispatchKey(input, "Enter");
    expect(selected).toHaveBeenCalledWith(candidate("hoge.pdf"));

    dispatchInput(input, "./missing.md");
    autocomplete.setCandidates([]);
    expect(autocomplete.isSearchPending()).toBe(false);
    dispatchKey(input, "Enter");
    expect(onEnter).toHaveBeenCalledTimes(1);
    autocomplete.dispose();
  });

  it("does not apply an IME Enter and can submit a manual destination", () => {
    const onEnter = vi.fn();
    const { input, autocomplete } = createAutocomplete(
      () => undefined,
      onEnter,
    );
    dispatchInput(input, "https://example.com");
    const composing = dispatchKey(input, "Enter", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(onEnter).not.toHaveBeenCalled();

    dispatchKey(input, "Enter");
    expect(onEnter).toHaveBeenCalledTimes(1);
    autocomplete.dispose();
  });

  it("delegates Escape so a selected-text picker can restore its bookmark", () => {
    const onEscape = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);
    const autocomplete = new FileAutocomplete({
      input,
      debounceMs: 0,
      onQuery: () => undefined,
      onEscape,
    });
    autocomplete.open();
    dispatchInput(input, "h");
    autocomplete.setCandidates([candidate("alpha.md")]);
    const escape = dispatchKey(input, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
    autocomplete.dispose();
  });
});
