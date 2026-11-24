import { describe, expect, it } from "vitest";
import { createMockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { parseOrgDoc } from "../src/core/parser/parse";
import { parseInline } from "../src/core/parser/inline";
import { renderOrgPreview } from "../src/views/reading/render";

describe("Org parser & mixed EN/ZH/math/table/CRLF support", () => {
  it("parses custom Chinese & fast-access TODO keywords, priorities, and Unicode tags", () => {
    const src = [
      "#+TITLE: 中文测试",
      "#+TODO: 待办(t) 进行中(p@) | 完成(d!) 取消(c)",
      "* 待办 [#A] 阅读 VLA Memory 论文 :研究:中文:",
      "* 完成 [#B] 整理笔记 :归档:",
    ].join("\n");

    const doc = parseOrgDoc(src);
    expect(doc.title).toBe("中文测试");
    expect(doc.todoActive.has("待办")).toBe(true);
    expect(doc.todoActive.has("进行中")).toBe(true);
    expect(doc.todoDone.has("完成")).toBe(true);
    expect(doc.todoDone.has("取消")).toBe(true);

    const h1 = doc.lines[2].heading!;
    expect(h1.keyword).toMatchObject({ text: "待办", done: false });
    expect(h1.priority?.text).toBe("A");
    expect(h1.tags.map((t) => t.name)).toEqual(["研究", "中文"]);
    expect(src.slice(h1.titleFrom, h1.titleTo)).toBe("阅读 VLA Memory 论文");

    const h2 = doc.lines[3].heading!;
    expect(h2.keyword).toMatchObject({ text: "完成", done: true });
  });

  it("parses inline formatting, CJK boundaries, timestamps, footnotes, and math", () => {
    const line = "中文*粗体*和/斜体/，=verbatim=与~[[id:code-only]]~，价格 $5 and $10，公式 $E=mc^2$，链接 [[id:abc][说明]] [fn:1] <2026-11-24 Tue>";
    const tokens = parseInline(line, 0);

    expect(tokens.some((t) => t.type === "emphasis" && t.style === "bold")).toBe(true);
    expect(tokens.some((t) => t.type === "emphasis" && t.style === "italic")).toBe(true);
    expect(tokens.some((t) => t.type === "verbatim" && t.style === "verbatim")).toBe(true);
    expect(tokens.some((t) => t.type === "verbatim" && t.style === "code")).toBe(true);
    // [[id:code-only]] inside ~...~ must NOT become a link token
    expect(tokens.filter((t) => t.type === "link").map((t) => (t.type === "link" ? t.target : ""))).toEqual([
      "id:abc",
    ]);
    // Prices $5 and $10 should not parse as math, while $E=mc^2$ does
    const mathTokens = tokens.filter((t) => t.type === "math");
    expect(mathTokens).toHaveLength(1);
    expect(mathTokens[0].type === "math" && mathTokens[0].latex).toBe("E=mc^2");
    expect(tokens.some((t) => t.type === "footnote" && t.name === "1")).toBe(true);
    expect(tokens.some((t) => t.type === "timestamp" && t.active)).toBe(true);

    // Full-width CJK punctuation around inline code & emphasis
    const cjkPunctLine = "支持三种模式（=Reading= / =Live Preview= / =Source=）与【*加粗*】及《/斜体/》。";
    const cjkTokens = parseInline(cjkPunctLine, 0);
    expect(
      cjkTokens
        .filter((t) => t.type === "verbatim")
        .map((t) => cjkPunctLine.slice(t.contentFrom, t.contentTo))
    ).toEqual(["Reading", "Live Preview", "Source"]);
    expect(
      cjkTokens
        .filter((t) => t.type === "emphasis")
        .map((t) => cjkPunctLine.slice(t.contentFrom, t.contentTo))
    ).toEqual(["加粗", "斜体"]);
  });

  it("parses multi-line math blocks and tables with <l>/<c>/<r> alignments", () => {
    const src = [
      "\\begin{align}",
      "a &= b + c \\\\",
      "d &= e",
      "\\end{align}",
      "",
      "| Item | Score | Notes |",
      "|------+-------+-------|",
      "| <l>  | <c>   | <r>   |",
      "| A    | 98    | *ok*  |",
    ].join("\n");

    const doc = parseOrgDoc(src);
    expect(doc.mathBlocks).toHaveLength(1);
    expect(doc.mathBlocks[0].env).toBe("align");
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].alignments).toEqual(["left", "center", "right"]);
    expect(doc.tables[0].rows).toHaveLength(2);
    expect(doc.tables[0].rows[1].cells[1].align).toBe("center");
  });

  it("maintains exact character offsets on CRLF (\\r\\n) files", () => {
    const src = [
      "#+TITLE: CRLF Doc",
      "* Heading",
      "- [ ] Task A",
      "- [X] Task B",
      "Paragraph line",
    ].join("\r\n");

    const doc = parseOrgDoc(src);
    for (const line of doc.lines) {
      expect(src.slice(line.from, line.to)).toBe(line.text);
    }
    const cbLine = doc.lines[2];
    expect(cbLine.list?.checkbox).toBeTruthy();
    const cb = cbLine.list!.checkbox!;
    expect(src.slice(cb.from, cb.to)).toBe("[ ]");
  });

  it("preserves unknown Org keywords, blocks, and drawers safely in Reading View", () => {
    const src = [
      "* Section",
      "#+TRANSCLUDE: [[id:node-1]] :only-contents",
      "#+ATTR_HTML: :width 600px",
      "#+CALL: my-babel-fn(x=1)",
      "",
      ":CUSTOM_DRAWER:",
      ":KEY: value",
      ":END:",
      "",
      "#+BEGIN_CUSTOMBLOCK",
      "raw custom line",
      "#+END_CUSTOMBLOCK",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(src, app, "unknown.org", {
      settings: { ...DEFAULT_SETTINGS, propertiesDisplay: "collapsed" },
    });

    expect(root.textContent).toContain("TRANSCLUDE");
    expect(root.textContent).toContain("ATTR_HTML");
    expect(root.textContent).toContain("CALL");
    expect(root.textContent).toContain("CUSTOMBLOCK");
    expect(root.textContent).toContain("raw custom line");
    expect(root.textContent).toContain("custom_drawer");
  });
});
