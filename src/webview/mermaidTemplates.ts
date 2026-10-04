export type MermaidTemplateDirection = "TD" | "LR";

export interface MermaidTemplate {
  readonly id: string;
  readonly diagram: string;
  readonly name: string;
  readonly description: string;
  readonly hint: string;
  readonly source: string;
  readonly directions?: readonly MermaidTemplateDirection[];
}

// Data only: importing the catalog must never load the Mermaid runtime.
const templates: readonly MermaidTemplate[] = [
  {
    id: "flowchart-basic",
    diagram: "Flowchart",
    name: "Basic flow",
    description: "Show the steps in a simple process.",
    hint: "Rename the steps and add arrows between them.",
    source: "flowchart TD\n    A[Start] --> B[Process]\n    B --> C[End]",
    directions: ["TD", "LR"],
  },
  {
    id: "flowchart-decision",
    diagram: "Flowchart",
    name: "Decision and review",
    description: "Show a decision, two outcomes, and a review loop.",
    hint: "Change the question, outcomes, and review step.",
    source:
      "flowchart TD\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Finish]\n    B -->|No| D[Review]\n    D --> B",
    directions: ["TD", "LR"],
  },
  {
    id: "flowchart-grouped",
    diagram: "Flowchart",
    name: "Grouped components",
    description: "Separate clients and services into connected groups.",
    hint: "Rename the groups and the components inside each subgraph.",
    source:
      "flowchart TD\n    subgraph Clients\n        A[Browser]\n        B[Mobile app]\n    end\n    subgraph Services\n        C[API]\n        D[Database]\n    end\n    A --> C\n    B --> C\n    C --> D",
    directions: ["TD", "LR"],
  },
  {
    id: "sequence-request-response",
    diagram: "Sequence",
    name: "Request and response",
    description: "Show the order of messages between a user, app, and server.",
    hint: "Rename the participants and their messages.",
    source:
      "sequenceDiagram\n    participant U as User\n    participant A as App\n    participant S as Server\n    U->>A: Open page\n    A->>S: Request data\n    S-->>A: Return data\n    A-->>U: Show page",
  },
  {
    id: "sequence-alternative",
    diagram: "Sequence",
    name: "Success and failure",
    description: "Show different responses for successful and failed requests.",
    hint: "Change the messages and the conditions in alt and else.",
    source:
      "sequenceDiagram\n    participant U as User\n    participant A as App\n    participant S as Server\n    U->>A: Sign in\n    A->>S: Check credentials\n    alt Accepted\n        S-->>A: Success\n        A-->>U: Welcome\n    else Rejected\n        S-->>A: Failure\n        A-->>U: Try again\n    end",
  },
  {
    id: "state-workflow",
    diagram: "State diagram",
    name: "Workflow states",
    description: "Show how work moves from one state to the next.",
    hint: "Rename the states and describe transitions after the colon.",
    source:
      "stateDiagram-v2\n    [*] --> Planned\n    Planned --> InProgress: Begin\n    InProgress --> Complete: Finish\n    Complete --> [*]",
  },
  {
    id: "class-basic",
    diagram: "Class diagram",
    name: "Classes and association",
    description: "Describe classes, their data, and their operations.",
    hint: "Edit the class names, attributes, methods, and association.",
    source:
      'classDiagram\n    class User {\n        +String name\n        +placeOrder()\n    }\n    class Order {\n        +int number\n        +submit()\n    }\n    User "1" --> "many" Order : places',
  },
  {
    id: "er-order",
    diagram: "ER diagram",
    name: "Orders and products",
    description: "Model relationships between users, orders, and products.",
    hint: "Change entity names, attributes, and relationship labels.",
    source:
      "erDiagram\n    USER ||--o{ ORDER : places\n    ORDER }o--o{ PRODUCT : contains\n    USER {\n        int id PK\n        string name\n    }\n    ORDER {\n        int id PK\n        string status\n    }\n    PRODUCT {\n        int id PK\n        string name\n    }",
  },
  {
    id: "gantt-project",
    diagram: "Gantt",
    name: "Project schedule",
    description: "Plan design, implementation, and testing with dependencies.",
    hint: "Change the fixed example date, task names, and durations.",
    source:
      "gantt\n    title Project schedule\n    dateFormat YYYY-MM-DD\n    section Project\n    Design :design, 2026-01-05, 3d\n    Implement :build, after design, 5d\n    Test :test, after build, 2d",
  },
  {
    id: "mindmap-basic",
    diagram: "Mindmap",
    name: "Ideas and categories",
    description: "Organize ideas around a central topic.",
    hint: "Rename the central topic and its indented branches.",
    source:
      "mindmap\n    root((Project))\n        Goals\n            Quality\n            Simplicity\n        People\n            Team\n            Users",
  },
  {
    id: "timeline-roadmap",
    diagram: "Timeline",
    name: "Release roadmap",
    description: "Show planning, development, and release over time.",
    hint: "Edit the time periods and the events after each colon.",
    source:
      "timeline\n    title Release roadmap\n    Q1 : Plan\n    Q2 : Develop\n    Q3 : Release",
  },
  {
    id: "pie-composition",
    diagram: "Pie chart",
    name: "Composition",
    description: "Compare the proportions of three categories.",
    hint: "Change the category names and their numeric values.",
    source:
      'pie showData\n    title Work allocation\n    "Build" : 50\n    "Test" : 30\n    "Plan" : 20',
  },
  {
    id: "gitgraph-branch-merge",
    diagram: "Git graph",
    name: "Branch and merge",
    description: "Show commits on a feature branch merging into main.",
    hint: "Rename the branch and commit IDs, or add commits.",
    source:
      'gitGraph\n    commit id: "Start"\n    branch feature\n    checkout feature\n    commit id: "Change"\n    checkout main\n    commit id: "Prepare"\n    merge feature id: "Merge"',
  },
];

export function getMermaidTemplates(): readonly MermaidTemplate[] {
  return templates;
}

export function getMermaidTemplate(id: string): MermaidTemplate | undefined {
  return templates.find((template) => template.id === id);
}

export function buildMermaidTemplateSource(
  id: string,
  options: { readonly direction?: MermaidTemplateDirection } = {},
): string {
  const template = getMermaidTemplate(id);
  if (!template) throw new Error("Unknown Mermaid template: " + id);
  if (!template.directions) return template.source;
  const direction = options.direction ?? "TD";
  if (!template.directions.includes(direction))
    throw new Error("Unsupported Mermaid template direction");
  return (
    "flowchart " + direction + template.source.slice("flowchart TD".length)
  );
}
