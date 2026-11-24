export type OrgViewMode = "reading" | "live" | "source";
export type PropertiesDisplayMode = "collapsed" | "expanded" | "hidden";
export type FoldLevelMode = "overview" | "content" | "all";
export type ReadingWidthMode = "narrow" | "normal" | "wide";
export type ReadingLineHeightMode = "compact" | "comfortable" | "relaxed";

export type BlockType =
  | "src"
  | "quote"
  | "example"
  | "center"
  | "verse"
  | "comment"
  | "export"
  | "special";

export type LineKind =
  | "blank"
  | "text"
  | "heading"
  | "planning"
  | "list"
  | "table"
  | "table-rule"
  | "drawer-start"
  | "drawer-end"
  | "drawer"
  | "block-start"
  | "block-end"
  | "src"
  | "quote"
  | "example"
  | "center"
  | "verse"
  | "comment-block"
  | "export"
  | "comment"
  | "keyword"
  | "rule"
  | "fixed-width"
  | "math-block";

export interface TagSpan {
  /** Tag name without colons. */
  name: string;
  /** Absolute range including surrounding colons. */
  from: number;
  to: number;
}

export interface HeadingData {
  level: number;
  starsFrom: number;
  starsTo: number;
  keyword?: { text: string; from: number; to: number; done: boolean };
  priority?: { text: string; from: number; to: number };
  tags: TagSpan[];
  /** Start of visible headline text (after stars/keyword/priority). */
  titleFrom: number;
  /** End of headline text (before trailing tags). */
  titleTo: number;
}

export interface ListData {
  indent: number;
  markerFrom: number;
  markerTo: number;
  ordered: boolean;
  number: number;
  checkbox?: { from: number; to: number; checked: boolean };
  contentFrom: number;
}

export interface BlockData {
  id: number;
  type: BlockType;
  rawName: string;
  beginLine: number;
  endLine?: number;
  lang?: string;
  beginFrom: number;
  beginTo: number;
}

export interface TableCell {
  from: number;
  to: number;
  text: string;
  align?: "left" | "center" | "right";
}

export interface TableRow {
  line: number;
  cells: TableCell[];
}

export interface TableData {
  id: number;
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  rows: TableRow[];
  ruleAfter: number[];
  alignments?: TableCell["align"][];
}

export interface DrawerEntry {
  key: string;
  value: string;
  line: number;
}

export interface DrawerData {
  id: number;
  name: string;
  startLine: number;
  endLine?: number;
  entries: DrawerEntry[];
  rawLines: string[];
}

export interface MathBlockData {
  id: number;
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  latex: string;
  display: boolean;
  kind: "env" | "dollar" | "bracket" | "paren";
  env?: string;
}

export interface OrgLine {
  /** Zero-based line index. */
  index: number;
  from: number;
  to: number;
  text: string;
  kind: LineKind;
  heading?: HeadingData;
  list?: ListData;
  planning?: { keyword: string; from: number; to: number };
  block?: BlockData;
  table?: TableData;
  drawer?: DrawerData;
  mathBlock?: MathBlockData;
  blockFirst?: boolean;
  blockLast?: boolean;
}

export interface OrgDoc {
  lines: OrgLine[];
  blocks: BlockData[];
  tables: TableData[];
  drawers: DrawerData[];
  mathBlocks: MathBlockData[];
  todoActive: Set<string>;
  todoDone: Set<string>;
  title?: string;
  startup: string[];
}

export type InlineToken =
  | {
      type: "emphasis";
      style: "bold" | "italic" | "underline" | "strike";
      delim: string;
      from: number;
      to: number;
      contentFrom: number;
      contentTo: number;
    }
  | {
      type: "verbatim";
      style: "verbatim" | "code";
      delim: string;
      from: number;
      to: number;
      contentFrom: number;
      contentTo: number;
    }
  | {
      type: "link";
      from: number;
      to: number;
      target: string;
      desc?: string;
      image: boolean;
    }
  | { type: "timestamp"; from: number; to: number; active: boolean }
  | { type: "footnote"; from: number; to: number; name: string }
  | { type: "cookie"; from: number; to: number }
  | { type: "url"; from: number; to: number; url: string }
  | { type: "tag"; from: number; to: number; name: string }
  | {
      type: "math";
      from: number;
      to: number;
      latex: string;
      display: boolean;
    };

export interface OrgSectionNode {
  headingLineIndex: number;
  endLineIndex: number;
  level: number;
  titleText: string;
  slug: string;
  id?: string;
  customId?: string;
  drawerStartLine?: number;
  drawerEndLine?: number;
  bodyLines: number[];
  children: OrgSectionNode[];
}

export interface OrgSectionTree {
  preambleLines: number[];
  fileId?: string;
  fileCustomId?: string;
  fileDrawerStartLine?: number;
  fileDrawerEndLine?: number;
  sections: OrgSectionNode[];
}

export interface OrgNodeEntry {
  id?: string;
  customId?: string;
  filePath: string;
  /** Zero-based line index of the heading (or 0 for file-level property drawer). */
  line: number;
  /** Zero-based inclusive end line of this node's subtree (or last line of file for level-0 node). */
  endLine: number;
  /** Heading level (0 for file-level zeroth section). */
  level: number;
  title: string;
  /** Heading breadcrumb from top-level ancestor to this node (empty for file-level node). */
  headingPath: string[];
  drawerStartLine: number;
  drawerEndLine: number;
}

export interface OrgIdLink {
  sourcePath: string;
  line: number;
  from: number;
  to: number;
  targetId: string;
  desc?: string;
  relation?: "link" | "transclude";
  context?: string;
}

export interface DuplicateIdDiagnostic {
  id: string;
  nodes: OrgNodeEntry[];
}

export interface BrokenIdLinkDiagnostic {
  link: OrgIdLink;
}

export interface OrgIndexDiagnostics {
  fileCount: number;
  nodeCount: number;
  duplicates: DuplicateIdDiagnostic[];
  brokenLinks: BrokenIdLinkDiagnostic[];
}

export type OrgIdStatus = "found" | "duplicate" | "missing";
