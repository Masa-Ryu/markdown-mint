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

  it("does not reselect at navigation boundaries", () => {
    const select = vi.fn();
    const picker = new MermaidTemplatePicker({ select });
    document.body.append(picker.element);
    picker.open();
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      picker.list.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };

    press("End");
    const lastId = picker.list
      .querySelector('[aria-selected="true"]')
      ?.getAttribute("data-template-id");
    const lastActive = picker.list.getAttribute("aria-activedescendant");
    const lastCalls = select.mock.calls.length;
    expect(lastId).toBe("gitgraph-branch-merge");
    press("ArrowDown");
    press("ArrowDown");
    press("End");
    expect(
      picker.list
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("data-template-id"),
    ).toBe(lastId);
    expect(picker.list.getAttribute("aria-activedescendant")).toBe(lastActive);
    expect(select).toHaveBeenCalledTimes(lastCalls);

    press("Home");
    const firstId = picker.list
      .querySelector('[aria-selected="true"]')
      ?.getAttribute("data-template-id");
    const firstActive = picker.list.getAttribute("aria-activedescendant");
    const firstCalls = select.mock.calls.length;
    expect(firstId).toBe("flowchart-basic");
    press("ArrowUp");
    press("ArrowUp");
    press("Home");
    expect(
      picker.list
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("data-template-id"),
    ).toBe(firstId);
    expect(picker.list.getAttribute("aria-activedescendant")).toBe(firstActive);
    expect(select).toHaveBeenCalledTimes(firstCalls);
  });

  it("scrolls only the list viewport to reveal keyboard selections", () => {
    const select = vi.fn();
    const picker = new MermaidTemplatePicker({ select });
    const outer = document.createElement("div");
    outer.scrollTop = 27;
    Object.defineProperty(picker.list, "clientHeight", { value: 100 });
    Object.defineProperty(picker.list, "clientTop", { value: 0 });
    picker.list.getBoundingClientRect = () =>
      ({ top: 10, bottom: 110 }) as DOMRect;
    const options = Array.from(
      picker.list.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    for (const [index, option] of options.entries()) {
      option.getBoundingClientRect = () => {
        const top = 10 + index * 36 - picker.list.scrollTop;
        return { top, bottom: top + 28 } as DOMRect;
      };
      Object.defineProperty(option, "scrollIntoView", {
        value: vi.fn(),
      });
    }
    outer.append(picker.element);
    document.body.append(outer);
    const documentScrollTop = document.documentElement.scrollTop;
    picker.open();
    for (let index = 0; index < 8; index++)
      picker.list.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );

    expect(picker.list.scrollTop).toBeGreaterThan(0);
    expect(outer.scrollTop).toBe(27);
    expect(document.documentElement.scrollTop).toBe(documentScrollTop);
    for (const option of options)
      expect(option.scrollIntoView).not.toHaveBeenCalled();
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
