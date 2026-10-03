import {
  buildMermaidTemplateSource,
  getMermaidTemplate,
  getMermaidTemplates,
  type MermaidTemplateDirection,
} from "./mermaidTemplates";

let nextPickerId = 0;

export class MermaidTemplatePicker {
  readonly element: HTMLElement;
  readonly previewSlot: HTMLElement;
  readonly list: HTMLElement;
  readonly back: HTMLButtonElement;
  readonly apply: HTMLButtonElement;
  private readonly name: HTMLElement;
  private readonly description: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly directionField: HTMLElement;
  private readonly direction: HTMLSelectElement;
  private readonly options: HTMLElement[] = [];
  private selectedId = "flowchart-basic";

  constructor(
    private readonly callbacks: {
      select(source: string): void;
      apply(source: string): void;
      back(): void;
    },
  ) {
    const ownerDocument = document;
    const prefix = "mm-mermaid-template-" + ++nextPickerId + "-";
    this.element = ownerDocument.createElement("div");
    this.element.className = "mm-mermaid-template-picker";
    this.list = ownerDocument.createElement("div");
    this.list.className = "mm-mermaid-template-list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Diagram templates");
    this.list.tabIndex = 0;
    let group: HTMLElement | undefined;
    let groupName = "";
    for (const template of getMermaidTemplates()) {
      if (template.diagram !== groupName) {
        groupName = template.diagram;
        group = ownerDocument.createElement("div");
        group.setAttribute("role", "group");
        const heading = ownerDocument.createElement("div");
        heading.className = "mm-mermaid-template-group";
        heading.id = prefix + "group-" + this.options.length;
        heading.textContent = groupName;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
        this.list.append(group);
      }
      const option = ownerDocument.createElement("div");
      option.id = prefix + template.id;
      option.dataset.templateId = template.id;
      option.setAttribute("role", "option");
      option.textContent = template.name;
      option.addEventListener("click", () => {
        this.select(template.id);
        this.list.focus();
      });
      this.options.push(option);
      group!.append(option);
    }
    this.list.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const index = this.options.findIndex(
        (option) => option.dataset.templateId === this.selectedId,
      );
      const next =
        event.key === "ArrowDown"
          ? Math.min(index + 1, this.options.length - 1)
          : event.key === "ArrowUp"
            ? Math.max(0, index - 1)
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? this.options.length - 1
                : -1;
      if (next >= 0) {
        event.preventDefault();
        this.select(this.options[next]!.dataset.templateId!);
      } else if (event.key === "Enter" || event.key === " ")
        event.preventDefault();
    });
    const detail = ownerDocument.createElement("div");
    detail.className = "mm-mermaid-template-detail";
    this.name = ownerDocument.createElement("h3");
    this.description = ownerDocument.createElement("p");
    this.hint = ownerDocument.createElement("p");
    this.hint.className = "mm-mermaid-template-hint";
    this.directionField = ownerDocument.createElement("label");
    this.directionField.textContent = "Direction ";
    this.direction = ownerDocument.createElement("select");
    this.direction.setAttribute("aria-label", "Template direction");
    for (const [value, label] of [
      ["TD", "Vertical"],
      ["LR", "Horizontal"],
    ]) {
      const option = ownerDocument.createElement("option");
      option.value = value!;
      option.textContent = label!;
      this.direction.append(option);
    }
    this.direction.addEventListener("change", () =>
      this.callbacks.select(this.source),
    );
    this.directionField.append(this.direction);
    this.previewSlot = ownerDocument.createElement("div");
    this.previewSlot.className = "mm-mermaid-preview-slot";
    const actions = ownerDocument.createElement("div");
    actions.className = "mm-mermaid-template-actions";
    this.back = ownerDocument.createElement("button");
    this.back.type = "button";
    this.back.addEventListener("click", () => this.callbacks.back());
    this.apply = ownerDocument.createElement("button");
    this.apply.type = "button";
    this.apply.textContent = "Use this template";
    this.apply.addEventListener("click", () =>
      this.callbacks.apply(this.source),
    );
    actions.append(this.back, this.apply);
    detail.append(
      this.name,
      this.description,
      this.hint,
      this.directionField,
      this.previewSlot,
      actions,
    );
    this.element.append(this.list, detail);
  }

  get source(): string {
    return buildMermaidTemplateSource(this.selectedId, {
      direction: this.direction.value as MermaidTemplateDirection,
    });
  }

  open(initial = false): void {
    this.back.textContent = initial ? "Create from code" : "Back to code";
    this.select(this.selectedId);
    this.list.focus();
  }

  reset(): void {
    this.selectedId = "flowchart-basic";
    this.direction.value = "TD";
  }

  private select(id: string): void {
    const template = getMermaidTemplate(id)!;
    this.selectedId = id;
    for (const option of this.options) {
      const selected = option.dataset.templateId === id;
      option.setAttribute("aria-selected", String(selected));
      if (selected) {
        this.list.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView?.({ block: "nearest" });
      }
    }
    this.name.textContent = template.diagram + ": " + template.name;
    this.description.textContent = template.description;
    this.hint.textContent = template.hint;
    this.directionField.hidden = !template.directions;
    this.callbacks.select(this.source);
  }
}
