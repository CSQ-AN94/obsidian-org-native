/**
 * Minimal Obsidian API mock for headless Vitest unit & DOM tests.
 */

export const Platform = {
  isMobileApp: false,
  isDesktop: true,
};

export function getLanguage(): string {
  return "en";
}

export const registeredIcons = new Map<string, string>();

export function addIcon(iconId: string, svgContent: string): void {
  registeredIcons.set(iconId, svgContent);
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.dataset.icon = icon;
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocked = new Set(["script", "iframe", "object", "embed", "style"]);
  const clean = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (blocked.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (
          name.startsWith("on") ||
          ((name === "href" || name === "src") &&
            (val.startsWith("javascript:") || val.startsWith("vbscript:") || val.startsWith("data:text/html")))
        ) {
          child.removeAttribute(attr.name);
        }
      }
      clean(child);
    }
  };
  clean(template.content as unknown as Element);
  return template.content;
}

export function renderMath(source: string, display: boolean): HTMLElement {
  const el = document.createElement(display ? "div" : "span");
  el.className = "mjx-container";
  el.dataset.renderedMath = source;
  el.textContent = source;
  return el;
}

export async function finishRenderMath(): Promise<void> {}
export async function loadMathJax(): Promise<void> {}
export async function loadPrism(): Promise<{ languages: Record<string, unknown>; highlight: (c: string) => string }> {
  return { languages: {}, highlight: (c: string) => c };
}

export class Notice {
  static history: string[] = [];
  constructor(public message: string, public timeout?: number) {
    Notice.history.push(message);
  }
}

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  constructor(path: string) {
    super(path);
  }
  get basename(): string {
    const file = this.path.split("/").pop() ?? this.path;
    const dot = file.lastIndexOf(".");
    return dot > 0 ? file.slice(0, dot) : file;
  }
  get extension(): string {
    const dot = this.path.lastIndexOf(".");
    return dot > 0 ? this.path.slice(dot + 1) : "";
  }
}

export class TextFileView {
  app: unknown;
  leaf: unknown;
  file: TFile | null = null;
  data = "";
  contentEl: HTMLElement = document.createElement("div");

  constructor(leaf: unknown) {
    this.leaf = leaf;
    this.app = (leaf as { app?: unknown })?.app ?? createMockApp();
    attachObsidianDomHelpers(this.contentEl);
  }

  addAction(_icon: string, title: string, callback: () => void): HTMLElement {
    const btn = document.createElement("button");
    attachObsidianDomHelpers(btn);
    btn.setAttribute("aria-label", title);
    btn.addEventListener("click", callback);
    return btn;
  }

  registerDomEvent(el: EventTarget, type: string, cb: EventListener): void {
    el.addEventListener(type, cb);
  }

  registerEvent(_ref: unknown): void {}

  requestSave: () => void = () => {
    this._mockRequestSave();
  };
  _mockRequestSave(): void {}
  async save(_clear?: boolean): Promise<void> {}
  setViewData(_data: string, _clear: boolean): void {}
  getViewData(): string {
    return this.data;
  }
  clear(): void {
    this.data = "";
  }
}

export class Modal {
  contentEl: HTMLElement = document.createElement("div");
  constructor(public app: unknown) {
    attachObsidianDomHelpers(this.contentEl);
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class ItemView {
  app: unknown;
  leaf: unknown;
  containerEl: HTMLElement = document.createElement("div");
  contentEl: HTMLElement;

  constructor(leaf: unknown) {
    this.leaf = leaf;
    this.app = (leaf as { app?: unknown })?.app ?? createMockApp();
    attachObsidianDomHelpers(this.containerEl);
    const header = document.createElement("div");
    attachObsidianDomHelpers(header);
    const content = document.createElement("div");
    attachObsidianDomHelpers(content);
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
    this.contentEl = content;
  }

  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "document";
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_state: unknown, _result?: unknown): Promise<void> {}
  addAction(_icon: string, title: string, callback: () => void): HTMLElement {
    const btn = document.createElement("button");
    attachObsidianDomHelpers(btn);
    btn.setAttribute("aria-label", title);
    btn.addEventListener("click", callback);
    return btn;
  }
  registerEvent(_ref: unknown): void {}
  registerDomEvent(el: EventTarget, type: string, cb: EventListener): void {
    el.addEventListener(type, cb);
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export interface FuzzyMatch<T> {
  item: T;
  match: { score: number; matches: unknown[] };
}

export abstract class FuzzySuggestModal<T> extends Modal {
  placeholder = "";
  emptyStateText = "";

  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }

  setInstructions(_instructions: Array<{ command: string; purpose: string }>): void {}

  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
    el.textContent = this.getItemText(value.item);
  }

  filterItems(query: string): T[] {
    const q = query.trim().toLowerCase();
    const items = this.getItems();
    if (!q) return items;
    return items.filter((item) => this.getItemText(item).toLowerCase().includes(q));
  }
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  constructor(app?: unknown, manifest?: unknown) {
    this.app = app ?? createMockApp();
    this.manifest = manifest;
  }
  registerView(): void {}
  registerExtensions(): void {}
  addCommand(): void {}
  addRibbonIcon(_icon: string, title: string, callback: () => void): HTMLElement {
    const btn = document.createElement("button");
    attachObsidianDomHelpers(btn);
    btn.setAttribute("aria-label", title);
    btn.addEventListener("click", callback);
    return btn;
  }
  addSettingTab(): void {}
  registerEvent(): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {}
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");
  constructor(public app: unknown, public plugin: unknown) {
    attachObsidianDomHelpers(this.containerEl);
  }
  display(): void {}
}

export class Setting {
  constructor(private containerEl: HTMLElement) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addDropdown(cb: (d: unknown) => void): this {
    const dropdown = {
      addOption: () => dropdown,
      setValue: () => dropdown,
      onChange: () => dropdown,
    };
    cb(dropdown);
    return this;
  }
  addText(cb: (t: unknown) => void): this {
    const text = {
      setPlaceholder: () => text,
      setValue: () => text,
      onChange: () => text,
    };
    cb(text);
    return this;
  }
  addToggle(cb: (t: unknown) => void): this {
    const toggle = {
      setValue: () => toggle,
      onChange: () => toggle,
    };
    cb(toggle);
    return this;
  }
  addSlider(cb: (s: unknown) => void): this {
    const slider = {
      setLimits: () => slider,
      setValue: () => slider,
      setDynamicTooltip: () => slider,
      onChange: () => slider,
    };
    cb(slider);
    return this;
  }
}

export function attachObsidianDomHelpers(el: HTMLElement): HTMLElement {
  const anyEl = el as unknown as Record<string, unknown>;
  anyEl.addClass = (cls: string) => el.classList.add(cls);
  anyEl.addClasses = (classes: string[]) => el.classList.add(...classes);
  anyEl.toggleClass = (cls: string, force?: boolean) => el.classList.toggle(cls, force);
  anyEl.empty = () => {
    el.replaceChildren();
  };
  anyEl.setText = (text: string) => {
    el.textContent = text;
  };
  anyEl.createDiv = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
    const d = document.createElement("div");
    if (opts?.cls) d.className = opts.cls;
    if (opts?.text) d.textContent = opts.text;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) d.setAttribute(k, v);
    }
    attachObsidianDomHelpers(d);
    el.appendChild(d);
    return d;
  };
  anyEl.createSpan = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
    const s = document.createElement("span");
    if (opts?.cls) s.className = opts.cls;
    if (opts?.text) s.textContent = opts.text;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) s.setAttribute(k, v);
    }
    attachObsidianDomHelpers(s);
    el.appendChild(s);
    return s;
  };
  anyEl.createEl = (
    tag: string,
    opts?: { cls?: string; text?: string; href?: string; attr?: Record<string, string> }
  ) => {
    const child = document.createElement(tag);
    if (opts?.cls) child.className = opts.cls;
    if (opts?.text) child.textContent = opts.text;
    if (opts?.href && child instanceof HTMLAnchorElement) child.setAttribute("href", opts.href);
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
    }
    attachObsidianDomHelpers(child);
    el.appendChild(child);
    return child;
  };
  return el;
}

export function createMockApp() {
  return {
    workspace: {
      openLinkText: async () => {},
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
      getActiveFile: (): TFile | null => null,
      activeLeaf: null as unknown,
      getMostRecentLeaf: () => null as unknown,
      getLeaf: (_newLeaf?: boolean | "tab" | "split" | "window") => ({
        openFile: async () => {},
        setViewState: async () => {},
      }),
      getRightLeaf: () => ({ setViewState: async () => {}, openFile: async () => {} }),
      revealLeaf: () => {},
      detachLeavesOfType: () => {},
      setActiveLeaf: () => {},
      onLayoutReady: (cb: () => void) => cb(),
      on: () => ({}),
      offref: () => {},
    },
    metadataCache: {
      getFirstLinkpathDest: () => null,
    },
    vault: {
      adapter: {
        getResourcePath: (p: string) => `app://local/${p}`,
      },
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      cachedRead: async () => "",
      create: async (p: string) => new TFile(p),
      on: () => ({}),
      offref: () => {},
    },
  };
}

export type App = ReturnType<typeof createMockApp>;
export type WorkspaceLeaf = unknown;
export type EventRef = unknown;
