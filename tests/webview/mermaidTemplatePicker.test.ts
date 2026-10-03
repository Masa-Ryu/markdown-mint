import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidTemplatePicker } from "../../src/webview/mermaidTemplatePicker";

afterEach(() => document.body.replaceChildren());

describe("Mermaid template listbox", () => {
  it("selects candidates with arrows without applying or submitting the enclosing form", () => {
    const select = vi.fn();
    const picker = new MermaidTemplatePicker({ select });
    const form = document.createElement("form");
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submit);
    form.append(picker.element);
    document.body.append(form);
    picker.open();
    expect(picker.list.querySelectorAll('[role="option"]')).toHaveLength(13);
    expect(picker.list.querySelectorAll('[role="group"]')).toHaveLength(10);
    expect(picker.element.querySelectorAll("button")).toHaveLength(0);
    expect(
      picker.element.querySelector(".mm-mermaid-template-actions"),
    ).toBeNull();
    expect(document.activeElement).toBe(picker.list);
    picker.list.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(select).toHaveBeenLastCalledWith(expect.stringContaining("Ready?"));
    const active = picker.list.getAttribute("aria-activedescendant");
    expect(picker.list.querySelector('[aria-selected="true"]')?.id).toBe(
      active,
    );
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      picker.list.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("generates candidate direction only and ignores composing navigation", () => {
    const select = vi.fn();
    const picker = new MermaidTemplatePicker({ select });
    document.body.append(picker.element);
    picker.open();
    const direction =
      picker.element.querySelector<HTMLSelectElement>("select")!;
    direction.value = "LR";
    direction.dispatchEvent(new Event("change"));
    expect(select).toHaveBeenLastCalledWith(
      expect.stringMatching(/^flowchart LR/),
    );
    picker.list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true }),
    );
    expect(
      picker.list
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("data-template-id"),
    ).toBe("flowchart-basic");
    picker.list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", cancelable: true }),
    );
    expect(direction.parentElement?.hidden).toBe(true);
    picker.reset();
    picker.open();
    expect(picker.source).toMatch(/^flowchart TD/);
  });
});
