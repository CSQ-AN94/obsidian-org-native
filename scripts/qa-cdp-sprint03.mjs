#!/usr/bin/env node
/**
 * Sprint 03 Comprehensive Real Obsidian Electron GUI Validation Suite (CDP).
 *
 * Strictly isolated:
 * - Requires --expect-vault <name> (default "test-vault") and aborts with exit code 2
 *   if connected Obsidian vault name OR basePath does not match.
 * - Cleans up any temporary 99-qa-scratch*.org scratch files inside test-vault.
 * - Reports honest PASS / FAIL / NOT_VERIFIED results and saves PNG screenshots
 *   under tests/qa/screenshots/.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "org-native";
const VIEW_TYPE_ORG = "org-native-view";
const VIEW_TYPE_BACKLINKS = "org-native-backlinks";
const DEFAULT_PORT = 9222;
const DEFAULT_EXPECT_VAULT = "test-vault";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_VAULT_DIR = path.join(ROOT_DIR, "test-vault");
const SCREENSHOTS_DIR = path.join(ROOT_DIR, "tests", "qa", "screenshots");

const CORPUS_FILES = [
  "01-welcome-and-reading.org",
  "02-math-code-and-tables.org",
  "03-vla-memory-notes.org",
  "04-knowledge-nodes.org",
  "05-diagnostics-demo.org",
  "06-transclusion-demo.org",
];

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    expectVault: DEFAULT_EXPECT_VAULT,
    screenshots: false,
    closeBrowser: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--screenshots") opts.screenshots = true;
    else if (arg === "--close-browser") opts.closeBrowser = true;
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg.includes("=") ? arg.slice("--port=".length) : argv[++i];
      opts.port = Number(raw);
    } else if (arg === "--expect-vault" || arg.startsWith("--expect-vault=")) {
      const raw = arg.includes("=") ? arg.slice("--expect-vault=".length) : argv[++i];
      opts.expectVault = String(raw || "").trim();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.pageErrors = [];
    this.consoleErrors = [];
  }

  async connect(timeoutMs = 5000) {
    await new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timeout connecting CDP WebSocket: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`WebSocket failed: ${this.wsUrl}`));
        },
        { once: true }
      );
      ws.addEventListener("message", (event) => this.handleMessage(event));
      ws.addEventListener("close", () => this.rejectAll("WebSocket closed"));
    });
  }

  handleMessage(event) {
    const raw =
      typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data).toString("utf8");
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${entry.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      this.pageErrors.push(d?.exception?.description || d?.text || "Runtime exception");
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const txt = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" ");
      if (txt) this.consoleErrors.push(txt);
    }
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`CDP socket not open for ${method}`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "Runtime.evaluate failed"
      );
    }
    return res?.result?.value;
  }

  async saveScreenshot(filename, enabled) {
    if (!enabled) return null;
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    if (!res?.data) throw new Error("Empty screenshot data");
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const outPath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(res.data, "base64"));
    return path.relative(ROOT_DIR, outPath);
  }

  close() {
    this.rejectAll("Client closed");
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function connectTestVault(port, expectVault) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const pages = targets.filter(
    (t) =>
      t?.type === "page" &&
      typeof t.webSocketDebuggerUrl === "string" &&
      !String(t.url ?? "").startsWith("devtools://") &&
      !String(t.url ?? "").startsWith("chrome-extension://")
  );
  if (pages.length === 0) {
    throw new Error(`No Obsidian page target exposed on CDP port ${port}`);
  }

  for (const target of pages) {
    const probe = new CdpClient(target.webSocketDebuggerUrl);
    try {
      await probe.connect();
      const info = await probe.eval(`(() => ({
        hasApp: Boolean(window.app),
        vaultName: window.app?.vault?.getName?.() ?? null,
        basePath: window.app?.vault?.adapter?.basePath ?? window.app?.vault?.adapter?.getBasePath?.() ?? null,
        title: document.title || ""
      }))()`);
      if (!info?.hasApp) continue;

      if (info.vaultName !== expectVault) {
        console.error(
          `[ABORT] Vault guard rejected "${info.vaultName}" at "${info.basePath}" (expected "${expectVault}")`
        );
        probe.close();
        process.exit(2);
      }
      if (
        expectVault === DEFAULT_EXPECT_VAULT &&
        info.basePath &&
        path.resolve(info.basePath) !== path.resolve(TEST_VAULT_DIR)
      ) {
        console.error(
          `[ABORT] Base path guard rejected "${info.basePath}" (expected "${TEST_VAULT_DIR}")`
        );
        probe.close();
        process.exit(2);
      }

      probe.close();
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      await client.send("Log.enable");
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 920,
        deviceScaleFactor: 2,
        mobile: false,
      });
      return { client, info };
    } finally {
      probe.close();
    }
  }

  console.error(`[ABORT] No Obsidian window matching "${expectVault}" found on port ${port}`);
  process.exit(2);
}

function cleanupScratchFiles() {
  if (!fs.existsSync(TEST_VAULT_DIR)) return;
  for (const name of fs.readdirSync(TEST_VAULT_DIR)) {
    if (name.startsWith("99-qa-scratch")) {
      fs.rmSync(path.join(TEST_VAULT_DIR, name), { force: true });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/qa-cdp-sprint03.mjs [--port 9222] [--expect-vault test-vault] [--screenshots] [--close-browser]");
    process.exit(0);
  }

  const { client, info } = await connectTestVault(opts.port, opts.expectVault);
  const checks = [];
  const screenshots = [];

  const record = (id, title, passed, detail, metrics = {}) => {
    checks.push({
      id,
      title,
      status: passed ? "PASS" : "FAIL",
      detail,
      metrics,
    });
  };

  const snap = async (filename) => {
    const rel = await client.saveScreenshot(filename, opts.screenshots);
    if (rel) screenshots.push(rel);
    return rel;
  };

  try {
    // Wait for layout + reload freshly deployed plugin build + index initialize
    await client.eval(`(async () => {
      const app = window.app;
      if (!app.workspace.layoutReady) {
        await new Promise((r) => app.workspace.onLayoutReady(r));
      }
      if (typeof app.plugins?.disablePlugin === "function" && typeof app.plugins?.enablePlugin === "function") {
        await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 150));
        await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 350));
      }
      const p = app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
      if (p?.vaultIndex) {
        await p.vaultIndex.initialize();
      }
    })()`);

    // Close any open modal reliably using CDP Escape + backdrop/button click
    const closeAllModals = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const count = await client.eval(`document.querySelectorAll(".modal-container").length`);
        if (count === 0) break;
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await client.eval(`(async () => {
          document.querySelectorAll(".modal-container .modal-close-button, .modal-container .modal-bg").forEach((el) => el.click());
          await new Promise((r) => setTimeout(r, 180));
        })()`);
      }
    };
    await closeAllModals();

    // Helper inside Electron to open a file cleanly in main workspace leaf
    const openVaultFile = async (filePath, { split = false, waitMs = 450 } = {}) => {
      return client.eval(`(async () => {
        const app = window.app;
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(filePath)});
        if (!f) return { ok: false, reason: "File not indexed by Obsidian vault yet" };
        const leaf = ${split ? 'app.workspace.getLeaf("split")' : "app.workspace.getLeaf(false)"};
        await leaf.openFile(f);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (leaf.view?.getViewType?.() === ${JSON.stringify(VIEW_TYPE_ORG)}) break;
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => setTimeout(r, ${waitMs}));
        return {
          ok: leaf.view?.getViewType?.() === ${JSON.stringify(VIEW_TYPE_ORG)},
          viewType: leaf.view?.getViewType?.() ?? null,
          mode: leaf.view?.getMode?.() ?? null,
          dirty: leaf.view?.syncGuard?.isDirty?.() ?? null,
          conflicted: leaf.view?.syncGuard?.isConflicted?.() ?? null,
        };
      })()`);
    };

    // Baseline file hashes before checks 1..9
    const baselineHashes = {};
    for (const f of CORPUS_FILES) {
      baselineHashes[f] = sha256File(path.join(TEST_VAULT_DIR, f));
    }

    // -----------------------------------------------------------------------
    // Check 1: Open, close, reopen all 6 .org files + zero disk mutation
    // -----------------------------------------------------------------------
    {
      const results = [];
      for (const f of CORPUS_FILES) {
        const opened = await openVaultFile(f, { waitMs: 350 });
        results.push({ file: f, ...opened });
      }
      // Close all leaves and reopen 01-welcome-and-reading.org
      await client.eval(`(async () => {
        const app = window.app;
        for (const l of [...app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})]) {
          l.detach();
        }
        await new Promise((r) => setTimeout(r, 150));
      })()`);
      const reopened = await openVaultFile("01-welcome-and-reading.org", { waitMs: 400 });
      const hashesMatch = CORPUS_FILES.every(
        (f) => sha256File(path.join(TEST_VAULT_DIR, f)) === baselineHashes[f]
      );
      const allOk = results.every((r) => r.ok && r.dirty === false) && reopened.ok && hashesMatch;
      record(
        "C1",
        "Open, close, and reopen .org files (`01`–`06`) with zero byte mutation",
        allOk,
        allOk ? "All 6 sample .org files opened, closed, and reopened cleanly; SHA-256 unchanged." : JSON.stringify({ results, reopened, hashesMatch }),
        { fileCount: results.length, reopenedOk: reopened.ok, hashesMatch }
      );
    }

    // -----------------------------------------------------------------------
    // Check 2: Reading / Live Preview / Source mode switching + toolbar buttons
    // -----------------------------------------------------------------------
    {
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 300 });
      const stepResults = [];
      for (const plan of [
        { mode: "live", cmd: `${PLUGIN_ID}:mode-live`, cls: "is-live-preview", shot: "s3-01-live-preview.png" },
        { mode: "source", cmd: `${PLUGIN_ID}:mode-source`, cls: "is-source-mode", shot: "s3-01-source-mode.png" },
        { mode: "reading", cmd: `${PLUGIN_ID}:mode-reading`, cls: "is-preview-mode", shot: null },
      ]) {
        const r = await client.eval(`(async () => {
          const app = window.app;
          const v = app.workspace.getActiveViewOfType(
            app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.constructor
          ) ?? app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          app.commands.executeCommandById(${JSON.stringify(plan.cmd)});
          await new Promise((r) => setTimeout(r, 250));
          return {
            mode: v?.getMode?.() ?? null,
            hasCls: Boolean(v?.contentEl?.classList?.contains(${JSON.stringify(plan.cls)})),
            dirty: v?.syncGuard?.isDirty?.() ?? null,
          };
        })()`);
        stepResults.push({ target: plan.mode, ...r });
        if (plan.shot) await snap(plan.shot);
      }

      // Test toolbar toggle-reading button & view action button
      const toolbarRes = await client.eval(`(async () => {
        const app = window.app;
        const view = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
        const modeBtn = view?.contentEl?.closest?.(".workspace-leaf-content")?.querySelector?.(".view-actions .clickable-icon[aria-label]") ?? null;
        const before = view?.getMode?.();
        app.commands.executeCommandById("${PLUGIN_ID}:toggle-reading-view");
        await new Promise((r) => setTimeout(r, 200));
        const mid = view?.getMode?.();
        app.commands.executeCommandById("${PLUGIN_ID}:toggle-reading-view");
        await new Promise((r) => setTimeout(r, 200));
        const after = view?.getMode?.();
        return { before, mid, after, hasHeaderActions: Boolean(modeBtn) };
      })()`);

      const ok =
        stepResults.every((s) => s.mode === s.target && s.hasCls && s.dirty === false) &&
        toolbarRes.before === "reading" &&
        toolbarRes.mid === "live" &&
        toolbarRes.after === "reading";
      record(
        "C2",
        "Reading / Live Preview / Source mode switching & toggle consistency",
        ok,
        JSON.stringify({ stepResults, toolbarRes }),
        { transitions: stepResults.length }
      );
    }

    // -----------------------------------------------------------------------
    // Check 3: H1–H6, Reading Fold click, Snapshot across mode switch, #+STARTUP
    // -----------------------------------------------------------------------
    {
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 300 });
      const foldRes = await client.eval(`(async () => {
        const app = window.app;
        const view = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
        const root = view?.contentEl;
        const foldBtns = root.querySelectorAll(".org-fold-btn");
        const firstSection = root.querySelector(".org-section");
        const beforeExpanded = foldBtns[0]?.getAttribute("aria-expanded");
        foldBtns[0]?.click();
        await new Promise((r) => setTimeout(r, 120));
        const foldedAfterClick = Boolean(firstSection?.classList?.contains("is-folded"));
        const afterExpanded = foldBtns[0]?.getAttribute("aria-expanded");

        // Switch Reading -> Live -> Source -> Reading and confirm fold state persisted
        app.commands.executeCommandById("${PLUGIN_ID}:mode-live");
        await new Promise((r) => setTimeout(r, 180));
        app.commands.executeCommandById("${PLUGIN_ID}:mode-source");
        await new Promise((r) => setTimeout(r, 180));
        app.commands.executeCommandById("${PLUGIN_ID}:mode-reading");
        await new Promise((r) => setTimeout(r, 220));
        const preservedFolded = Boolean(root.querySelector(".org-section")?.classList?.contains("is-folded"));

        app.commands.executeCommandById("${PLUGIN_ID}:fold-overview");
        await new Promise((r) => setTimeout(r, 120));
        const overviewFolded = root.querySelectorAll(".org-section.is-folded").length;

        app.commands.executeCommandById("${PLUGIN_ID}:unfold-all");
        await new Promise((r) => setTimeout(r, 120));
        const afterUnfold = root.querySelectorAll(".org-section.is-folded, .org-section.is-body-folded").length;

        return {
          foldBtnCount: foldBtns.length,
          beforeExpanded,
          foldedAfterClick,
          afterExpanded,
          preservedFolded,
          overviewFolded,
          afterUnfold,
          dirty: view?.syncGuard?.isDirty?.(),
        };
      })()`);

      await openVaultFile("05-diagnostics-demo.org", { waitMs: 300 });
      const startupRes = await client.eval(`(() => {
        const root = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl;
        return {
          sectionCount: root?.querySelectorAll(".org-section").length ?? 0,
          bodyFoldedOnStartup: root?.querySelectorAll(".org-section.is-body-folded").length ?? 0,
        };
      })()`);

      await openVaultFile("03-vla-memory-notes.org", { waitMs: 300 });
      const headingLevels = await client.eval(`(() => {
        const root = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl;
        return Array.from(root?.querySelectorAll(".org-heading-preview") ?? []).map((el) => el.dataset.level);
      })()`);

      const ok =
        foldRes.foldedAfterClick &&
        foldRes.beforeExpanded === "true" &&
        foldRes.afterExpanded === "false" &&
        foldRes.preservedFolded &&
        foldRes.overviewFolded > 0 &&
        foldRes.afterUnfold === 0 &&
        foldRes.dirty === false &&
        startupRes.bodyFoldedOnStartup > 0 &&
        headingLevels.includes("1") &&
        headingLevels.includes("2");
      record("C3", "Heading hierarchy, Reading Fold, snapshot preservation & #+STARTUP", ok, JSON.stringify({ foldRes, startupRes, headingLevels }));
    }

    // -----------------------------------------------------------------------
    // Check 4: MathJax, Prism Highlighting, Aligned Tables, Local Image, Property Drawer, Footnotes
    // -----------------------------------------------------------------------
    {
      await openVaultFile("02-math-code-and-tables.org", { waitMs: 900 });
      const mediaRes = await client.eval(`(async () => {
        const root = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl;
        await new Promise((r) => setTimeout(r, 400));
        const mjxCount = root?.querySelectorAll("mjx-container").length ?? 0;
        const mathRawCount = root?.querySelectorAll(".org-math[data-latex]").length ?? 0;
        const latexValues = Array.from(root?.querySelectorAll(".org-math[data-latex]") ?? []).map((e) => e.dataset.latex);
        const priceEscapedCorrectly = !latexValues.some((v) => v && v.includes("5 and"));
        const prismTokens = root?.querySelectorAll("pre > code .token").length ?? 0;
        const copyBtns = root?.querySelectorAll(".org-code-copy-btn").length ?? 0;
        const tableAligns = Array.from(root?.querySelectorAll("table.org-table td, table.org-table th") ?? [])
          .map((c) => c.style.textAlign)
          .filter(Boolean);
        const imgs = Array.from(root?.querySelectorAll("img.org-inline-image") ?? []).map((img) => ({
          alt: img.alt,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }));
        return { mjxCount, mathRawCount, priceEscapedCorrectly, prismTokens, copyBtns, tableAlignsCount: tableAligns.length, imgs };
      })()`);
      await snap("s3-02-math-code-table-img.png");

      // Scroll down on 02 to inspect table + image visually in a second shot
      await client.eval(`(() => {
        const preview = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl?.querySelector(".org-preview");
        if (preview) preview.scrollTop = preview.scrollHeight;
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      await snap("s3-02-table-and-image.png");

      // Property Drawer toggle + Footnotes on 01
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 350 });
      const propsAndFootnotes = await client.eval(`(async () => {
        const root = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl;
        const drawer = root?.querySelector("details.org-properties-preview");
        const initiallyOpen = Boolean(drawer?.open);
        const summary = drawer?.querySelector("summary.org-properties-title");
        summary?.click();
        await new Promise((r) => setTimeout(r, 100));
        const openAfterClick = Boolean(drawer?.open);
        const hasRawToggle = Boolean(drawer?.querySelector(".org-drawer-raw-toggle pre.org-drawer-raw"));
        summary?.click();
        const supFootnotes = root?.querySelectorAll("sup.org-footnote").length ?? 0;
        const defFootnotes = root?.querySelectorAll(".org-footnote-def").length ?? 0;
        return { initiallyOpen, openAfterClick, hasRawToggle, supFootnotes, defFootnotes };
      })()`);

      const imgOk = mediaRes.imgs.length >= 1 && mediaRes.imgs.every((i) => i.complete && i.naturalWidth > 0);
      const ok =
        mediaRes.mjxCount >= 3 &&
        mediaRes.priceEscapedCorrectly &&
        mediaRes.prismTokens > 0 &&
        mediaRes.copyBtns >= 3 &&
        mediaRes.tableAlignsCount > 0 &&
        imgOk &&
        !propsAndFootnotes.initiallyOpen &&
        propsAndFootnotes.openAfterClick &&
        propsAndFootnotes.hasRawToggle &&
        propsAndFootnotes.supFootnotes >= 1 &&
        propsAndFootnotes.defFootnotes >= 1;
      record("C4", "MathJax, Prism, aligned tables, local image, Property Drawer & footnotes", ok, JSON.stringify({ mediaRes, propsAndFootnotes }));
    }

    // -----------------------------------------------------------------------
    // Check 5: Themes (Dark & Light), CJK+English typography, Narrow Split Pane
    // -----------------------------------------------------------------------
    {
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 350 });
      const setTheme = async (mode) => {
        return client.eval(`(async () => {
          const app = window.app;
          const target = ${JSON.stringify(mode)}; // "obsidian" (dark) or "moonstone" (light)
          if (typeof app.changeTheme === "function") {
            app.changeTheme(target);
          } else {
            app.vault?.setConfig?.("theme", target);
            document.body.classList.toggle("theme-dark", target === "obsidian");
            document.body.classList.toggle("theme-light", target === "moonstone");
          }
          await new Promise((r) => setTimeout(r, 350));
          return {
            isDark: document.body.classList.contains("theme-dark"),
            isLight: document.body.classList.contains("theme-light"),
            bg: getComputedStyle(document.body).backgroundColor,
            fg: getComputedStyle(document.body).color,
          };
        })()`);
      };

      const darkState = await setTheme("obsidian");
      const previewAttrs = await client.eval(`(() => {
        const preview = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl?.querySelector(".org-preview");
        const sizer = preview?.querySelector(".markdown-preview-sizer");
        const style = sizer ? getComputedStyle(sizer) : null;
        return {
          readingWidth: preview?.dataset?.readingWidth,
          readingLineHeight: preview?.dataset?.readingLineHeight,
          cjkTypography: preview?.dataset?.cjkTypography,
          lineBreak: style?.lineBreak,
          overflowXZero: preview ? preview.scrollWidth <= preview.clientWidth + 2 : false,
        };
      })()`);
      await snap("s3-01-welcome-dark.png");

      const lightState = await setTheme("moonstone");
      await snap("s3-01-welcome-light.png");

      // Narrow mobile-width / split-pane test (~390px) with sidebars collapsed cleanly
      const sidebarPrev = await client.eval(`(() => {
        const ws = window.app.workspace;
        const leftCollapsed = Boolean(ws.leftSplit?.collapsed);
        const rightCollapsed = Boolean(ws.rightSplit?.collapsed);
        ws.leftSplit?.collapse?.();
        ws.rightSplit?.collapse?.();
        return { leftCollapsed, rightCollapsed };
      })()`);
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 300));
      const narrowMetrics = await client.eval(`(() => {
        const preview = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl?.querySelector(".org-preview");
        return {
          clientWidth: preview?.clientWidth ?? 0,
          scrollWidth: preview?.scrollWidth ?? 0,
        };
      })()`);
      await snap("s3-01-narrow-split.png");

      // Restore 1440x920 Dark theme & sidebar state
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 920,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await client.eval(`(() => {
        const ws = window.app.workspace;
        if (!${JSON.stringify(false)} && ${sidebarPrev.leftCollapsed === false}) ws.leftSplit?.expand?.();
      })()`);
      await setTheme("obsidian");

      const ok =
        darkState.isDark &&
        lightState.isLight &&
        darkState.bg !== lightState.bg &&
        previewAttrs.cjkTypography === "true" &&
        previewAttrs.lineBreak === "strict" &&
        previewAttrs.overflowXZero &&
        narrowMetrics.clientWidth >= 280 &&
        narrowMetrics.scrollWidth <= narrowMetrics.clientWidth + 16;
      record("C5", "Dark & Light themes, CJK+English typography, and narrow pane responsiveness", ok, JSON.stringify({ darkState, lightState, previewAttrs, narrowMetrics }));
    }

    // -----------------------------------------------------------------------
    // Check 6: Cross-file [[id:...]] click navigation
    // -----------------------------------------------------------------------
    {
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 350 });
      const jumpRes = await client.eval(`(async () => {
        const app = window.app;
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0];
        const link = leaf?.view?.contentEl?.querySelector("a.org-link-id[data-org-id='vla-memory-overview']");
        if (!link) return { clicked: false };
        link.click();
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const active = app.workspace.getActiveFile()?.path;
          if (active === "03-vla-memory-notes.org") break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 250));
        return {
          clicked: true,
          activePath: app.workspace.getActiveFile()?.path ?? null,
        };
      })()`);
      const ok = jumpRes.clicked && jumpRes.activePath === "03-vla-memory-notes.org";
      record("C6", "Cross-file [[id:...]] link click jump (01 -> 03)", ok, JSON.stringify(jumpRes));
    }

    // -----------------------------------------------------------------------
    // Check 7: Backlinks Sidebar, Quick Open Node Modal, Hover Preview, Diagnostics Modal
    // -----------------------------------------------------------------------
    {
      await openVaultFile("04-knowledge-nodes.org", { waitMs: 400 });
      const backlinksRes = await client.eval(`(async () => {
        const app = window.app;
        app.commands.executeCommandById("${PLUGIN_ID}:open-backlinks");
        await new Promise((r) => setTimeout(r, 350));
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_BACKLINKS)})[0];
        const el = leaf?.view?.contentEl;
        const items = el?.querySelectorAll(".org-backlinks-item").length ?? 0;
        const transcludeBadges = el?.querySelectorAll(".org-backlinks-relation.is-transclude").length ?? 0;
        const linkBadges = el?.querySelectorAll(".org-backlinks-relation.is-link").length ?? 0;
        const text = el?.textContent ?? "";
        return { hasLeaf: Boolean(leaf), items, transcludeBadges, linkBadges, mentionsFile: text.includes("04-knowledge-nodes.org") };
      })()`);

      // Trigger Hover Preview on 01's [[id:vla-memory-overview]] link while Backlinks stays open
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 350 });
      const hoverRes = await client.eval(`(async () => {
        const preview = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl?.querySelector(".org-preview");
        const link = preview?.querySelector("a.org-link-id[data-org-id='vla-memory-overview']");
        if (!link) return { foundLink: false };
        link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        const pop = document.querySelector(".org-node-hover-popover");
        return {
          foundLink: true,
          popoverVisible: Boolean(pop),
          status: pop?.dataset?.status ?? null,
          textLen: (pop?.textContent ?? "").length,
          scriptCount: pop?.querySelectorAll("script")?.length ?? 0,
        };
      })()`);

      await openVaultFile("04-knowledge-nodes.org", { waitMs: 250 });
      const hoverOn04 = await client.eval(`(async () => {
        const preview = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl?.querySelector(".org-preview");
        const link = preview?.querySelector("a.org-link-id[data-org-id='vla-memory-overview']");
        link?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        return Boolean(document.querySelector(".org-node-hover-popover"));
      })()`);
      await snap("s3-04-backlinks-hover.png");
      await client.eval(`(() => {
        const link = document.querySelector("a.org-link-id[data-org-id='vla-memory-overview']");
        link?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      })()`);

      // Quick Open Node Modal
      const switcherRes = await client.eval(`(async () => {
        const app = window.app;
        app.commands.executeCommandById("${PLUGIN_ID}:quick-open-node");
        await new Promise((r) => setTimeout(r, 250));
        const modal = document.querySelector(".modal-container .prompt");
        const results = modal?.querySelectorAll(".suggestion-item")?.length ?? 0;
        const text = modal?.textContent ?? "";
        return { opened: Boolean(modal), results, containsRealNode: text.includes("vla-memory-overview"), leaksFakeId: text.includes("fake-id-must-not-be-indexed") };
      })()`);
      await closeAllModals();

      // Diagnostics Modal
      const diagRes = await client.eval(`(async () => {
        const app = window.app;
        app.commands.executeCommandById("${PLUGIN_ID}:show-diagnostics");
        await new Promise((r) => setTimeout(r, 250));
        const modal = document.querySelector(".org-diagnostics-modal");
        const text = modal?.textContent ?? "";
        return {
          opened: Boolean(modal),
          hasDuplicate: text.includes("demo-duplicate-id"),
          hasMissing404: text.includes("missing-demo-404"),
          hasMissingTransclude: text.includes("missing-transclude-404"),
          leaksFakeId: text.includes("fake-id-must-not-be-indexed") || text.includes("fake-transclude-target-id"),
        };
      })()`);
      await closeAllModals();
      const remainingModals = await client.eval(`document.querySelectorAll(".modal-container").length`);

      // Close Backlinks leaf to keep screenshots clean for transclusion check
      await client.eval(`(() => {
        window.app.workspace.detachLeavesOfType(${JSON.stringify(VIEW_TYPE_BACKLINKS)});
      })()`);

      const ok =
        backlinksRes.hasLeaf &&
        backlinksRes.items >= 2 &&
        backlinksRes.transcludeBadges >= 1 &&
        backlinksRes.linkBadges >= 1 &&
        hoverRes.popoverVisible &&
        hoverRes.status === "found" &&
        hoverRes.scriptCount === 0 &&
        hoverOn04 &&
        switcherRes.opened &&
        switcherRes.results >= 5 &&
        !switcherRes.leaksFakeId &&
        diagRes.opened &&
        diagRes.hasDuplicate &&
        diagRes.hasMissing404 &&
        !diagRes.leaksFakeId &&
        remainingModals === 0;
      record("C7", "Backlinks sidebar, Quick Open Node switcher, Hover Preview & Diagnostics modal", ok, JSON.stringify({ backlinksRes, hoverRes, switcherRes, diagRes, remainingModals }));
    }

    // -----------------------------------------------------------------------
    // Checks 8 & 9: Transclusion expansion, nesting, cycles, missing, unsupported warnings & code immunity
    // -----------------------------------------------------------------------
    {
      await openVaultFile("06-transclusion-demo.org", { waitMs: 1100 });
      const transRes = await client.eval(`(() => {
        const root = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view?.contentEl;
        const total = root?.querySelectorAll(".org-transclusion").length ?? 0;
        const remainingSlots = root?.querySelectorAll(".org-transclude-slot").length ?? 0;
        const nested = root?.querySelectorAll(".org-transclusion-nested").length ?? 0;
        const readonlyBadges = root?.querySelectorAll(".org-transclusion-readonly-badge").length ?? 0;
        const sourceLinks = root?.querySelectorAll(".org-transclusion-source-link").length ?? 0;
        const cycleErr = root?.querySelectorAll(".org-transclusion-error[data-transclusion-status='cycle']").length ?? 0;
        const missingErr = root?.querySelectorAll(".org-transclusion-error[data-transclusion-status='missing']").length ?? 0;
        const unsupportedWarn = Array.from(root?.querySelectorAll(".org-transclusion-warning.is-unsupported") ?? [])
          .map((e) => e.textContent ?? "")
          .filter((t) => t.includes(":thing-at-point")).length;
        const fakeCodeEl = Array.from(root?.querySelectorAll("pre > code") ?? []).find((c) =>
          (c.textContent ?? "").includes("fake-transclude-in-code")
        );
        const text = root?.textContent ?? "";
        return {
          total,
          remainingSlots,
          nested,
          readonlyBadges,
          sourceLinks,
          cycleErr,
          missingErr,
          unsupportedWarn,
          hasCodeRaw: Boolean(fakeCodeEl),
          hasLevel2Episodic: Boolean(root?.querySelector(".org-transclusion h2, .org-transclusion .org-level-2")),
          hasOnlyContentsKv: text.includes("attention sinks"),
        };
      })()`);
      await snap("s3-06-transclusion-dark.png");

      // Light mode screenshot of Transclusion too
      await client.eval(`(async () => {
        window.app.changeTheme?.("moonstone");
        await new Promise((r) => setTimeout(r, 300));
      })()`);
      await snap("s3-06-transclusion-light.png");
      await client.eval(`(async () => {
        window.app.changeTheme?.("obsidian");
        await new Promise((r) => setTimeout(r, 250));
      })()`);

      const c8Ok =
        transRes.total >= 5 &&
        transRes.remainingSlots === 0 &&
        transRes.readonlyBadges >= 5 &&
        transRes.sourceLinks >= 5 &&
        transRes.hasOnlyContentsKv;
      const c9Ok =
        transRes.nested >= 1 &&
        transRes.cycleErr >= 1 &&
        transRes.missingErr >= 1 &&
        transRes.unsupportedWarn >= 1 &&
        transRes.hasCodeRaw;
      record("C8", "Transclusion expansion on 06-transclusion-demo.org (:level, :only-contents, :lines, :exclude-elements)", c8Ok, JSON.stringify(transRes));
      record("C9", "Nested transclusion, cycle guard, missing ID, unsupported parameter warning & code immunity", c9Ok, JSON.stringify(transRes));
    }

    // -----------------------------------------------------------------------
    // Checks 10 & 11: Real Edit/Save/Undo/Reopen (CRLF) + External Emacs Edit & Conflict Banner
    // -----------------------------------------------------------------------
    {
      const scratchName = "99-qa-scratch.org";
      const scratchDiskPath = path.join(TEST_VAULT_DIR, scratchName);
      const initialCrlf = [
        "#+TITLE: QA Scratch Note",
        "#+ATTR_HTML: :width 500px",
        "",
        "* QA Node",
        ":PROPERTIES:",
        ":ID: qa-scratch-node-1",
        ":CUSTOM_ID: scratch-1",
        ":END:",
        "- [ ] Scratch task item",
        "",
        "#+BEGIN_CUSTOM_BLOCK",
        "keep custom block verbatim",
        "#+END_CUSTOM_BLOCK",
      ].join("\r\n");

      try {
        await client.eval(`(async () => {
          const existing = window.app.vault.getAbstractFileByPath(${JSON.stringify(scratchName)});
          if (existing) await window.app.vault.delete(existing);
          await window.app.vault.create(${JSON.stringify(scratchName)}, ${JSON.stringify(initialCrlf)});
        })()`);
        await new Promise((r) => setTimeout(r, 350));

        await openVaultFile(scratchName, { waitMs: 400 });

        // Edit checkbox -> save -> close -> reopen -> verify CRLF & preservation
        const editRes = await client.eval(`(async () => {
          const app = window.app;
          const view = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          const cb = view?.contentEl?.querySelector("input.org-task-checkbox");
          if (!cb) return { ok: false, reason: "checkbox missing" };
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
          await view.save();
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true, data: view.getViewData() };
        })()`);

        const savedOnDisk = fs.readFileSync(scratchDiskPath, "utf8");
        const editPreserved =
          editRes.ok &&
          savedOnDisk.includes("\r\n") &&
          savedOnDisk.includes("- [X] Scratch task item") &&
          savedOnDisk.includes(":ID: qa-scratch-node-1") &&
          savedOnDisk.includes("#+ATTR_HTML: :width 500px") &&
          savedOnDisk.includes("#+BEGIN_CUSTOM_BLOCK");

        // Test Source mode edit, undo/revert, save, close, and reopen in fresh leaf
        const undoRes = await client.eval(`(async () => {
          const app = window.app;
          app.commands.executeCommandById("${PLUGIN_ID}:mode-source");
          await new Promise((r) => setTimeout(r, 150));
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0];
          const view = leaf.view;
          const line = view.editor.state.doc.line(9);
          view.editor.dispatch({ changes: { from: line.from + 3, to: line.from + 4, insert: " " } });
          await new Promise((r) => setTimeout(r, 120));
          await view.save();
          await new Promise((r) => setTimeout(r, 150));
          leaf.detach();
          await new Promise((r) => setTimeout(r, 150));
          return { closed: true };
        })()`);
        const reopenedScratch = await openVaultFile(scratchName, { waitMs: 300 });
        const diskAfterUndoEdit = fs.readFileSync(scratchDiskPath, "utf8");
        const c10Ok =
          editPreserved &&
          undoRes.closed &&
          reopenedScratch.ok &&
          diskAfterUndoEdit === initialCrlf;
        record("C10", "Real edit, save, close, and reopen preserves CRLF, :ID:, :PROPERTIES:, and unknown Org blocks", c10Ok, JSON.stringify({ editPreserved, reopenedOk: reopenedScratch.ok, exactRoundTripCrlf: diskAfterUndoEdit === initialCrlf }));

        // Check 11a: External modification while clean -> auto-reload without overwrite
        const emacsV2 = initialCrlf.replace("- [ ] Scratch task item", "- [ ] Edited externally by Emacs v2");
        fs.writeFileSync(scratchDiskPath, emacsV2, "utf8");
        const cleanReloadRes = await client.eval(`(async () => {
          const app = window.app;
          const view = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            if (view?.getViewData?.().includes("Edited externally by Emacs v2")) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            reloaded: view?.getViewData?.().includes("Edited externally by Emacs v2") ?? false,
            dirty: view?.syncGuard?.isDirty?.() ?? null,
            conflicted: view?.syncGuard?.isConflicted?.() ?? null,
          };
        })()`);

        // Check 11b: Make local dirty edit -> external disk edit -> .org-conflict-banner visible & safe copy
        const dirtySetup = await client.eval(`(async () => {
          const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          const endPos = view.editor.state.doc.length;
          view.editor.dispatch({ changes: { from: endPos, to: endPos, insert: "\\nLocal unsaved Obsidian line." } });
          await new Promise((r) => setTimeout(r, 100));
          return { dirty: view.syncGuard.isDirty() };
        })()`);

        const emacsV3 = initialCrlf.replace("- [ ] Scratch task item", "- [ ] Conflicting external Emacs v3");
        fs.writeFileSync(scratchDiskPath, emacsV3, "utf8");

        const conflictRes = await client.eval(`(async () => {
          const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            if (view?.syncGuard?.isConflicted?.()) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const banner = view?.contentEl?.querySelector(".org-conflict-banner");
          return {
            conflicted: Boolean(view?.syncGuard?.isConflicted?.()),
            bannerVisible: Boolean(banner && !banner.classList.contains("is-hidden")),
          };
        })()`);
        await snap("s3-conflict-banner.png");

        const conflictDiskUntouched = fs.readFileSync(scratchDiskPath, "utf8") === emacsV3;
        const copyRes = await client.eval(`(async () => {
          const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
          const copyBtn = view?.contentEl?.querySelector(".org-conflict-btn-copy");
          copyBtn?.click();
          await new Promise((r) => setTimeout(r, 300));
          return {
            conflictedAfterCopy: view?.syncGuard?.isConflicted?.() ?? null,
            hasEmacsV3: view?.getViewData?.().includes("Conflicting external Emacs v3") ?? false,
          };
        })()`);

        const conflictCopies = fs
          .readdirSync(TEST_VAULT_DIR)
          .filter((n) => n.startsWith("99-qa-scratch.conflict-"));
        const c11Ok =
          cleanReloadRes.reloaded &&
          cleanReloadRes.dirty === false &&
          !cleanReloadRes.conflicted &&
          dirtySetup.dirty &&
          conflictRes.conflicted &&
          conflictRes.bannerVisible &&
          conflictDiskUntouched &&
          copyRes.conflictedAfterCopy === false &&
          copyRes.hasEmacsV3 &&
          conflictCopies.length >= 1;
        record("C11", "External Emacs modification auto-reload & dirty conflict guard in Electron", c11Ok, JSON.stringify({ cleanReloadRes, dirtySetup, conflictRes, conflictDiskUntouched, copyRes, conflictCopies }));
      } finally {
        await client.eval(`(async () => {
          const app = window.app;
          for (const l of [...app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})]) {
            if (l.view?.file?.path?.startsWith("99-qa-scratch")) l.detach();
          }
        })()`);
        cleanupScratchFiles();
      }
    }

    // -----------------------------------------------------------------------
    // Check 12: Multi-pane same-file split + Plugin disable/re-enable stability
    // -----------------------------------------------------------------------
    {
      await openVaultFile("01-welcome-and-reading.org", { waitMs: 300 });
      const multiRes = await client.eval(`(async () => {
        const app = window.app;
        const f = app.vault.getAbstractFileByPath("01-welcome-and-reading.org");
        const leaf1 = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0];
        const leaf2 = app.workspace.getLeaf("split");
        await leaf2.openFile(f);
        await new Promise((r) => setTimeout(r, 250));
        leaf2.view.setMode("live");
        await new Promise((r) => setTimeout(r, 150));
        const modesBefore = [leaf1.view.getMode(), leaf2.view.getMode()];
        leaf2.detach();
        await new Promise((r) => setTimeout(r, 150));
        const leaf1StillWorks = leaf1.view.getMode() === "reading" && leaf1.view.syncGuard.isDirty() === false;
        return { modesBefore, leaf1StillWorks };
      })()`);

      const reloadPluginRes = await client.eval(`(async () => {
        const app = window.app;
        await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 200));
        await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 400));
        const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        if (plugin?.vaultIndex) await plugin.vaultIndex.initialize();
        const ext = app.viewRegistry?.getTypeByExtension?.("org");
        return { enabled: Boolean(plugin), ext };
      })()`);

      const ok =
        multiRes.modesBefore[0] === "reading" &&
        multiRes.modesBefore[1] === "live" &&
        multiRes.leaf1StillWorks &&
        reloadPluginRes.enabled &&
        reloadPluginRes.ext === VIEW_TYPE_ORG &&
        client.pageErrors.length === 0 &&
        client.consoleErrors.length === 0;
      record("C12", "Multi-pane same-file split & plugin disable/re-enable stability", ok, JSON.stringify({ multiRes, reloadPluginRes, pageErrors: client.pageErrors, consoleErrors: client.consoleErrors }));
    }

    const failed = checks.filter((c) => c.status !== "PASS");
    const summary = {
      status: failed.length === 0 ? "PASS" : "FAIL",
      timestamp: new Date().toISOString(),
      vault: info.vaultName,
      basePath: info.basePath,
      passedCount: checks.length - failed.length,
      totalCount: checks.length,
      checks,
      screenshots,
      pageErrors: client.pageErrors,
      consoleErrors: client.consoleErrors,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (opts.closeBrowser) {
      await client.send("Browser.close").catch(() => {});
    }

    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    cleanupScratchFiles();
    client.close();
  }
}

main().catch((err) => {
  console.error("[ERROR]", err instanceof Error ? err.stack || err.message : String(err));
  cleanupScratchFiles();
  process.exit(1);
});
