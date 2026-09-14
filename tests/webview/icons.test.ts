import { describe, expect, it, vi } from "vitest";
import { createToolbarIcon } from "../../src/webview/icons";

describe("toolbar icons", () => {
  it("parses each icon source once before cloning its template", () => {
    const parseFromString = vi.spyOn(DOMParser.prototype, "parseFromString");

    createToolbarIcon("table-row-above");
    const firstCallCount = parseFromString.mock.calls.length;
    createToolbarIcon("table-row-above");

    expect(firstCallCount).toBe(1);
    expect(parseFromString.mock.calls.length).toBe(firstCallCount);
  });

  it("returns independent cached clones with per-call attributes", () => {
    const first = createToolbarIcon("table", {
      className: "first-icon",
      size: 14,
    });
    const second = createToolbarIcon("table", {
      className: "second-icon",
      size: 20,
    });
    const equivalent = createToolbarIcon("table", {
      className: "first-icon",
      size: 14,
    });

    expect(first).not.toBe(second);
    expect(first).not.toBe(equivalent);
    expect(first.outerHTML).toBe(equivalent.outerHTML);
    expect(first.getAttribute("class")).toBe("first-icon");
    expect(second.getAttribute("class")).toBe("second-icon");
    expect(first.getAttribute("width")).toBe("14");
    expect(first.getAttribute("height")).toBe("14");
    expect(second.getAttribute("width")).toBe("20");
    expect(second.getAttribute("height")).toBe("20");
    expect(first.dataset.icon).toBe("table");
    expect(second.dataset.icon).toBe("table");
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(first.getAttribute("focusable")).toBe("false");
    expect(first.outerHTML).not.toContain("#111827");

    first.setAttribute("data-mutated", "true");
    first.classList.add("mutated");
    expect(second.hasAttribute("data-mutated")).toBe(false);
    expect(second.classList.contains("mutated")).toBe(false);

    const defaults = createToolbarIcon("table");
    expect(defaults.getAttribute("class")).toBe("mm-toolbar-icon");
    expect(defaults.getAttribute("width")).toBe("20");
    expect(defaults.getAttribute("height")).toBe("20");
  });
});
