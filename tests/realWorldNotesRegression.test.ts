import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createMockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { parseOrgDoc } from "../src/core/parser/parse";
import { parseInline } from "../src/core/parser/inline";
import { resolveResourcePath } from "../src/util/links";
import { renderOrgPreview } from "../src/views/reading/render";
import { orgLivePreview } from "../src/views/editor/livePreview";

function createLiveEditor(doc: string): EditorView {
  const app = createMockApp() as unknown as import("obsidian").App;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const state = EditorState.create({
    doc,
    extensions: [
      orgLivePreview({
        app,
        sourcePath: "real-world.org",
        displayTitle: "Real World",
        settings: { ...DEFAULT_SETTINGS },
      }),
    ],
  });
  return new EditorView({ state, parent: host });
}

describe("Real-world Org notes fidelity & anti-misparse regression suite", () => {
  it("auto-closes unclosed #+BEGIN_SRC at column-0 heading without affecting properly closed blocks", () => {
    const src = [
      "* Program Structure",
      "#+BEGIN_SRC java",
      "class Demo {",
      "  public static void main(String[] args) {}",
      "}",
      "",
      "* Output",
      "Normal prose after unclosed src.",
      "",
      "* Closed Org Example",
      "#+BEGIN_SRC org",
      "* Raw heading inside closed src block",
      "#+END_SRC",
    ].join("\n");

    const doc = parseOrgDoc(src);
    const headings = doc.lines.filter((l) => l.kind === "heading").map((l) => l.text);
    expect(headings).toEqual(["* Program Structure", "* Output", "* Closed Org Example"]);

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "java.org", { settings: DEFAULT_SETTINGS });
    const renderedHeadings = Array.from(root.querySelectorAll(".org-heading-title")).map(
      (el) => el.textContent
    );
    expect(renderedHeadings).toEqual(["Program Structure", "Output", "Closed Org Example"]);
    expect(root.querySelectorAll(".org-code-block")).toHaveLength(2);
  });

  it("handles Org-roam v2 preamble (:PROPERTIES: before #+title: and #+filetags:)", () => {
    const src = [
      ":PROPERTIES:",
      ":ID:       90000000-0000-4000-8000-000000000011",
      ":END:",
      "#+title: Org Roam Note Title",
      "#+filetags: :C:Systems:",
      "- tag :: [[id:01010101-1111-4111-8111-000000000001][Parent Topic]]",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "roam.org", { settings: DEFAULT_SETTINGS });
    expect(root.querySelector(".inline-title")?.textContent).toBe("Org Roam Note Title");
    const tags = Array.from(root.querySelectorAll(".org-filetags .org-filetag")).map(
      (el) => el.textContent
    );
    expect(tags).toEqual(["#C", "#Systems"]);
    expect(root.querySelector("details.org-properties")?.getAttribute("data-drawer-key")).toContain(
      "properties"
    );
    expect(root.querySelector(".org-desc-item .org-desc-term")?.textContent).toBe("tag");
    expect(root.querySelector(".org-desc-item .org-link-id")?.textContent).toBe("Parent Topic");

    // Live Preview keeps title + filetags + collapsed properties above body once cursor is in body
    const view = createLiveEditor(src);
    view.dispatch({ selection: { anchor: src.length } });
    expect(view.dom.querySelector(".org-metadata .inline-title")?.textContent).toBe(
      "Org Roam Note Title"
    );
    expect(
      Array.from(view.dom.querySelectorAll(".org-metadata .org-filetag")).map((e) => e.textContent)
    ).toEqual(["#C", "#Systems"]);
    expect(view.dom.querySelector(".org-metadata .org-properties")).toBeTruthy();
    view.destroy();
  });

  it("prevents false-positive inline emphasis on slashes, paths, snake_case, math +, and table pipes while keeping **bold** and true italics", () => {
    const falseSamples = [
      "编译器/仿真器，使用输入时序，逐扫描比较输出/状态轨迹",
      "轮数/预算/提交指令 与 双线圈/扫描序冲突、急停安全旁路、多周期边沿/定时",
      "| 移动/嵌入 | 桌面/服务器 |",
      "文件路径：/usr/local/include/stdio.h 与 TYPE var_name; int var_name = 1;",
      "闰年公式：a + a / 4 - a / 100 + a / 400",
    ];
    for (const line of falseSamples) {
      const emph = parseInline(line, 0).filter((t) => t.type === "emphasis");
      expect(emph).toEqual([]);
    }

    const validLine =
      "evaluates expr /once/, called /\"abstraction\"/, **栈（stack）** and *核心*结论";
    const tokens = parseInline(validLine, 0).filter((t) => t.type === "emphasis");
    expect(
      tokens.map((t) =>
        t.type === "emphasis" ? `${t.style}:${validLine.slice(t.contentFrom, t.contentTo)}` : ""
      )
    ).toEqual(["italic:once", "italic:\"abstraction\"", "bold:栈（stack）", "bold:核心"]);
  });

  it("renders Org entities outside math, preserves math LaTeX, handles trailing \\\\, --- hr, and ASCII arrows without fake tables", () => {
    const src = [
      "编译：main.c \\rightarrow main.i \\\\",
      "等价 \\Downarrow 结论 $a \\times b$",
      "---",
      "|",
      "| Next: 自动化构建 [[id:90000000-0000-4000-8000-000000000002][skip]]",
      "v",
    ].join("\n");

    const doc = parseOrgDoc(src);
    expect(doc.tables).toHaveLength(0);
    expect(doc.lines.some((l) => l.kind === "rule")).toBe(true);

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "entities.org", { settings: DEFAULT_SETTINGS });
    expect(root.querySelector("hr")).toBeTruthy();
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector("br.org-linebreak")).toBeTruthy();
    const entitySymbols = Array.from(root.querySelectorAll(".org-entity")).map((e) => e.textContent);
    expect(entitySymbols).toEqual(["→", "⇓"]);
    expect(root.querySelector(".org-math")?.getAttribute("data-latex")).toBe("a \\times b");
  });

  it("keeps multi-line list continuations, indented code blocks, description lists, and • bullets inside proper lists without breaking <ol> numbering", () => {
    const src = [
      "1. 第一项 Wrapper Classes",
      "   这是第一项的缩进续行。",
      "",
      "   #+begin_src C",
      "   const int x = 3;",
      "   ,*p = 4;",
      "   #+end_src",
      "2. 第二项 Math Methods",
      "   这是第二项续行。",
      "",
      "- =part_v1= :: 3D 形状重合",
      "• 圆点项目符号",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "lists.org", {
      settings: { ...DEFAULT_SETTINGS },
    });

    const ols = root.querySelectorAll("ol");
    expect(ols).toHaveLength(1);
    expect(Array.from(ols[0].children).filter((el) => el.tagName === "LI")).toHaveLength(2);
    expect(ols[0].querySelector(".org-list-continuation .org-code-block")).toBeTruthy();
    // Protective comma unescaped cleanly in code block
    expect(ols[0].querySelector("pre > code")?.textContent).not.toContain(",*p");
    expect(ols[0].querySelector("pre > code")?.textContent).toContain("*p = 4;");

    // No border-left indentation guide class on root
    expect(root.classList.contains("show-indentation-guide")).toBe(false);
    expect(root.querySelector(".org-desc-item .org-desc-term")?.textContent).toBe("part_v1");
  });

  it("strips fixed-width `: ` prefixes, renders Babel RESULTS, consecutive footnotes, tables inside footnotes, H7-H9, and ATTR_ORG widths", () => {
    const src = [
      "#+ATTR_ORG: :width 85%",
      "[[file:./eee_img/circuit.png]]",
      "",
      "#+RESULTS:",
      ": Hello",
      ": World",
      "",
      "#+RESULTS: \"Answer: 42\"",
      "",
      "********* Level 9 Heading",
      "",
      "[fn:1] 指令说明",
      "[fn:2] | Warning | Error |",
      "|---------+-------|",
      "| 警告    | 错误  |",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "Org/circuits.org", { settings: DEFAULT_SETTINGS });

    const img = root.querySelector<HTMLImageElement>("figure.org-figure img")!;
    expect(img).toBeTruthy();
    expect(img.style.width).toBe("85%");
    expect(img.getAttribute("src")).toContain("Org/eee_img/circuit.png");

    const fw = root.querySelector(".org-fixed-width")!;
    expect(fw.textContent).toBe("Hello\nWorld");
    expect(root.querySelector(".org-results-inline")?.textContent).toBe('"Answer: 42"');

    const fnDefs = root.querySelectorAll(".org-footnote-def");
    expect(fnDefs).toHaveLength(2);
    expect(fnDefs[1].querySelector("table")).toBeTruthy();
    expect(fnDefs[1].querySelectorAll("th, td").length).toBeGreaterThanOrEqual(4);

    expect(root.querySelector(".org-heading-preview.org-level-9")).toBeTruthy();
  });

  it("resolves subfolder relative resource paths and blocks path traversal safely", () => {
    const fakeFile = Object.create(TFile.prototype) as TFile;
    (fakeFile as { path: string }).path = "Org/eee_img/diagram.png";
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((p: string) =>
          p === "Org/eee_img/diagram.png" ? fakeFile : null
        ),
        adapter: {
          getResourcePath: vi.fn((p: string) => `app://local/${p}`),
        },
      },
      metadataCache: {
        getFirstLinkpathDest: vi.fn(() => null),
      },
    } as unknown as import("obsidian").App;

    expect(resolveResourcePath(app, "file:./eee_img/diagram.png", "Org/note.org")).toBe(
      "app://local/Org/eee_img/diagram.png"
    );
    expect(resolveResourcePath(app, "file:../../outside.png", "Org/note.org")).toBeNull();
  });

  it("hides protective commas and fixed-width colons in Live Preview until cursor enters line, and renders EntityWidget", () => {
    const doc = [
      "Arrow: a \\rightarrow b",
      "#+begin_src C",
      ",*p = 4;",
      "#+end_src",
      ": Hello",
    ].join("\n");

    const view = createLiveEditor(doc);
    // Cursor inside \rightarrow reveals raw TeX entity formatting
    view.dispatch({ selection: { anchor: doc.indexOf("\\rightarrow") + 2 } });
    expect(view.dom.querySelector(".cm-formatting")).toBeTruthy();

    // Move cursor to end (`: Hello`) -> \rightarrow renders as EntityWidget and `,*p` hides `,`
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector(".org-entity")?.textContent).toBe("→");
    const srcLineText = view.dom.querySelector(".org-src-body")?.textContent ?? "";
    expect(srcLineText).toBe("*p = 4;");

    // Cursor enters `,*p = 4;` -> raw `,` revealed cleanly
    view.dispatch({ selection: { anchor: doc.indexOf(",*p") } });
    expect(view.dom.querySelector(".org-src-body")?.textContent).toBe(",*p = 4;");
    view.destroy();
  });

  it("renders Notion-style prose arrows while protecting C pointer dereference and verbatim", () => {
    const src = [
      "经典教材题背诵 --> 重构变量命名",
      "- benchCAD -> No LLM Judge",
      "逻辑等价：P <=> Q，反推 A <-- B，双向 X <-> Y，推导 M => N",
      "C 指针保留：Correct: (*q).x or q->x and =->= and $a \\to b$",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "arrows.org", { settings: DEFAULT_SETTINGS });
    const arrows = Array.from(root.querySelectorAll('.org-entity[data-entity="arrow"]')).map(
      (el) => el.textContent
    );
    expect(arrows).toEqual(["→", "→", "⇔", "←", "↔", "⇒"]);
    // C pointer dereference q->x and verbatim =->= must stay literal
    expect(root.textContent).toContain("(*q).x or q->x");
    expect(root.querySelector("code.org-verbatim")?.textContent).toBe("->");

    const view = createLiveEditor(src);
    // Cursor at end keeps earlier arrows rendered as EntityWidget
    view.dispatch({ selection: { anchor: src.length } });
    const liveArrows = Array.from(
      view.dom.querySelectorAll('.org-entity[data-entity="arrow"]')
    ).map((el) => el.textContent);
    expect(liveArrows).toEqual(["→", "→", "⇔", "←", "↔", "⇒"]);
    expect(view.dom.textContent).toContain("q->x");

    // Moving cursor onto `-->` reveals raw ASCII token for editing
    view.dispatch({ selection: { anchor: src.indexOf("-->") + 1 } });
    expect(view.dom.querySelector(".cm-formatting")?.textContent).toBe("-->");
    view.destroy();
  });

  it("renders vertical ASCII flow arrows cleanly in Reading View & Live Preview while keeping IDs indexed", () => {
    const src = [
      "|",
      "| Next: 自动化构建 [[id:90000000-0000-4000-8000-000000000010][Makefile 自动化]]",
      "v",
      "",
      "After flow arrow",
    ].join("\n");

    const doc = parseOrgDoc(src);
    expect(doc.tables).toHaveLength(0);
    // Underlying lines remain text so OrgIdIndex still indexes the [[id:...]] link inside
    expect(doc.lines[1].kind).toBe("text");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "flow.org", { settings: DEFAULT_SETTINGS });
    const flow = root.querySelector(".org-flow-arrow");
    expect(flow).toBeTruthy();
    expect(flow?.querySelector(".org-flow-arrow-stem")).toBeTruthy();
    expect(flow?.querySelector(".org-flow-arrow-head")).toBeTruthy();
    expect(flow?.querySelector(".org-link-id")?.textContent).toBe("Makefile 自动化");
    // Raw literal | and v should not appear in rendered text
    expect(flow?.textContent?.trim()).toBe("Next: 自动化构建 Makefile 自动化");

    const view = createLiveEditor(src);
    // Cursor on last line -> vertical arrow replaced by FlowArrowWidget
    view.dispatch({ selection: { anchor: src.length } });
    const widget = view.dom.querySelector(".org-flow-arrow-widget");
    expect(widget).toBeTruthy();
    expect(widget?.querySelector(".org-link-id")?.textContent).toBe("Makefile 自动化");

    // Cursor enters vertical arrow block -> raw lines revealed for editing
    view.dispatch({ selection: { anchor: src.indexOf("Next:") } });
    expect(view.dom.querySelector(".org-flow-arrow-widget")).toBeNull();
    expect(view.dom.textContent).toContain("| Next: 自动化构建");
    view.destroy();
  });

  it("renders multi-line space-aligned columns in monospace in both Reading View and Live Preview", () => {
    const src = [
      "*格式：gcc <options> <source-files>*",
      "-o<filename>  指定输出文件名",
      "-Wall         开启常用警告信息",
      "-Werror       把警告视为错误[fn:1]",
      "",
      "-o<filename> 指定输出文件名",
      "-wall        输出警告信息",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "aligned.org", { settings: DEFAULT_SETTINGS });
    const blocks = root.querySelectorAll(".org-aligned-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelectorAll(".org-aligned-row")).toHaveLength(3);
    expect(blocks[1].querySelectorAll(".org-aligned-row")).toHaveLength(2);
    // Heading line `*格式：...*` remains normal prose <p>, not monospace aligned block
    expect(root.querySelector("p strong")?.textContent).toBe("格式：gcc <options> <source-files>");

    const view = createLiveEditor(src);
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelectorAll(".cm-line.org-aligned-line")).toHaveLength(5);
    view.destroy();
  });
});
