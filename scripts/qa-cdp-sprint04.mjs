#!/usr/bin/env node
/**
 * Sprint 04 Comprehensive Real Obsidian Electron GUI Validation Suite (CDP).
 *
 * Strictly isolated:
 * - Requires --expect-vault <name> (default "test-vault") and aborts with exit code 2
 *   if connected Obsidian vault name OR basePath does not match.
 * - Cleans up any temporary 99-qa-graph-scratch*.org (and 99-qa-scratch*.org) files
 *   inside test-vault before & after execution.
 * - Automates Scenarios G1..G12 and captures screenshots under tests/qa/screenshots/.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "org-native";
const VIEW_TYPE_ORG = "org-native-view";
const VIEW_TYPE_ORG_GRAPH = "org-native-graph";
const VIEW_TYPE_ORG_LOCAL_GRAPH = "org-native-local-graph";
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
  "07-graph-showcase.org",
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
    if (name.startsWith("99-qa-graph-scratch") || name.startsWith("99-qa-scratch")) {
      fs.rmSync(path.join(TEST_VAULT_DIR, name), { force: true });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node scripts/qa-cdp-sprint04.mjs [--port 9222] [--expect-vault test-vault] [--screenshots] [--close-browser]"
    );
    process.exit(0);
  }

  cleanupScratchFiles();
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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
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

    const waitForCondition = async (expr, timeoutMs = 4500, pollMs = 80) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await client.eval(`Boolean(${expr})`);
        if (ok) return true;
        await sleep(pollMs);
      }
      return false;
    };

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
        };
      })()`);
    };

    const openOrgFile = async (filePath, { split = false, waitMs = 400 } = {}) => {
      return client.eval(`(async () => {
        const app = window.app;
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(filePath)});
        if (!f) return { ok: false, reason: "Missing file in vault: " + ${JSON.stringify(filePath)} };
        let leaf = ${split ? 'app.workspace.getLeaf("split")' : `app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]`};
        if (!leaf) {
          leaf = app.workspace.getLeaf("tab") ?? app.workspace.getLeaf(true);
        }
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
          activePath: app.workspace.getActiveFile()?.path ?? null,
          mode: leaf.view?.getMode?.() ?? null,
        };
      })()`);
    };

    const centerAndGetCanvasCoords = async (viewType, nodeId) => {
      return client.eval(`(async () => {
        const leaf = window.app.workspace.getLeavesOfType(${JSON.stringify(viewType)})[0];
        const view = leaf?.view;
        const renderer = view?.getRenderer?.();
        if (!view || !renderer) return null;
        window.app.workspace.revealLeaf(leaf);
        window.app.workspace.setActiveLeaf(leaf, { focus: true });
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 180)));
        view.getSimulation?.().step?.(5);
        view.getSimulation?.().stop?.();
        renderer.markPositionsDirty?.();
        view.centerOnNode?.(${JSON.stringify(nodeId)});
        await new Promise((r) => requestAnimationFrame(r));
        const pos = view.getNodePosition?.(${JSON.stringify(nodeId)});
        if (!pos) return null;
        const screen = renderer.worldToScreen(pos.x, pos.y);
        const rect = renderer.canvas.getBoundingClientRect();
        const cx = rect.left + screen.x;
        const cy = rect.top + screen.y;
        const hitAtCenter = renderer.hitTest?.(screen.x, screen.y)?.id ?? null;
        const elAtPoint = document.elementFromPoint(cx, cy)?.className ?? null;
        return {
          x: cx,
          y: cy,
          rectLeft: rect.left,
          rectTop: rect.top,
          rectWidth: rect.width,
          rectHeight: rect.height,
          hitAtCenter,
          elAtPoint,
        };
      })()`);
    };

    const cleanupVaultScratchInObsidian = async () => {
      await client.eval(`(async () => {
        const app = window.app;
        for (const l of [...app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})]) {
          const p = l.view?.file?.path ?? "";
          if (p.startsWith("99-qa-graph-scratch") || p.startsWith("99-qa-scratch")) {
            l.detach();
          }
        }
        for (const f of [...app.vault.getFiles()]) {
          if (f.path.startsWith("99-qa-graph-scratch") || f.path.startsWith("99-qa-scratch")) {
            await app.vault.delete(f);
          }
        }
        const plugin = app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
        await plugin?.vaultIndex?.flushPendingUpdates?.();
      })()`);
      cleanupScratchFiles();
    };

    // Wait for layout, close modals, reload plugin cleanly, and initialize VaultIndex
    await closeAllModals();
    await cleanupVaultScratchInObsidian();
    await client.eval(`(async () => {
      const app = window.app;
      if (!app.workspace.layoutReady) {
        await new Promise((r) => app.workspace.onLayoutReady(r));
      }
      for (const t of [${JSON.stringify(VIEW_TYPE_ORG_GRAPH)}, ${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)}, ${JSON.stringify(VIEW_TYPE_ORG)}]) {
        app.workspace.detachLeavesOfType(t);
      }
      if (app.plugins && app.plugins.enabled === false && typeof app.plugins.setEnable === "function") {
        await app.plugins.setEnable(true);
        await new Promise((r) => setTimeout(r, 300));
      }
      if (typeof app.plugins?.disablePlugin === "function" && typeof app.plugins?.enablePlugin === "function") {
        await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 180));
        await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 400));
      }
      const p = app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
      if (p?.settings) {
        p.settings.graphGlobalState = undefined;
        p.settings.graphLocalState = undefined;
        await p.saveData(p.settings);
      }
      if (p?.vaultIndex) {
        await p.vaultIndex.initialize();
      }
    })()`);
    await setTheme("obsidian");

    // Baseline SHA-256 hashes of 01..07 corpus files
    const baselineHashes = {};
    for (const f of CORPUS_FILES) {
      baselineHashes[f] = sha256File(path.join(TEST_VAULT_DIR, f));
    }

    // -----------------------------------------------------------------------
    // G1: Global Graph open + non-empty canvas/graphData (Node & File + Dark/Light)
    // -----------------------------------------------------------------------
    {
      await client.eval(`window.app.commands.executeCommandById("${PLUGIN_ID}:open-global-graph")`);
      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.()?.nodes?.length > 0`
      );
      await client.eval(`(async () => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        if (view?.getViewState?.()?.granularity !== "node") {
          view?.setGranularity?.("node");
          await new Promise((r) => setTimeout(r, 250));
        }
      })()`);
      await sleep(450);

      const g1Dark = await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        view?.fitToView?.();
        const data = view?.getGraphData?.();
        const canvas = view?.getRenderer?.()?.canvas;
        let nonZeroPixels = 0;
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          const ctx = canvas.getContext("2d");
          const img = ctx?.getImageData?.(0, 0, canvas.width, canvas.height);
          if (img) {
            for (let i = 3; i < img.data.length; i += 64) {
              if (img.data[i] > 0) nonZeroPixels++;
            }
          }
        }
        return {
          granularity: data?.granularity ?? null,
          nodeCount: data?.stats?.nodeCount ?? 0,
          edgeCount: data?.stats?.edgeCount ?? 0,
          transclusionEdges: data?.stats?.transclusionEdges ?? 0,
          hasHub: Boolean(data?.nodeMap?.has?.("id:graph-showcase-hub")),
          hasOrphan: Boolean(data?.nodeMap?.has?.("id:graph-orphan-island")),
          canvasW: canvas?.width ?? 0,
          canvasH: canvas?.height ?? 0,
          nonZeroPixels,
        };
      })()`);
      await snap("s4-global-node-dark.png");

      // Light mode screenshot
      const lightTheme = await setTheme("moonstone");
      const themeFlippedLight = await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        return view?.getRenderer?.()?.getTheme?.()?.isDark === false;
      })()`);
      await snap("s4-global-node-light.png");
      await setTheme("obsidian");

      // File granularity toggle + screenshot
      const fileMode = await client.eval(`(async () => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        const fileBtn = view?.contentEl?.querySelector('button[data-granularity="file"]');
        fileBtn?.click();
        await new Promise((r) => setTimeout(r, 350));
        view?.fitToView?.();
        const data = view?.getGraphData?.();
        return {
          granularity: data?.granularity ?? null,
          nodeCount: data?.stats?.nodeCount ?? 0,
          edgeCount: data?.stats?.edgeCount ?? 0,
          hasFile07: Boolean(data?.nodeMap?.has?.("file:07-graph-showcase.org")),
        };
      })()`);
      await snap("s4-global-file-dark.png");

      // Restore Node granularity
      await client.eval(`(async () => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        view?.contentEl?.querySelector('button[data-granularity="node"]')?.click();
        await new Promise((r) => setTimeout(r, 250));
        view?.fitToView?.();
      })()`);

      const g1Ok =
        g1Dark.granularity === "node" &&
        g1Dark.nodeCount >= 18 &&
        g1Dark.edgeCount >= 12 &&
        g1Dark.transclusionEdges >= 5 &&
        g1Dark.hasHub &&
        g1Dark.hasOrphan &&
        g1Dark.canvasW > 0 &&
        g1Dark.canvasH > 0 &&
        g1Dark.nonZeroPixels > 0 &&
        lightTheme.isLight &&
        themeFlippedLight &&
        fileMode.granularity === "file" &&
        fileMode.nodeCount === 7 &&
        fileMode.hasFile07;
      record("G1", "Global Graph opens with Canvas2D render (Node/File & Dark/Light)", g1Ok, JSON.stringify({ g1Dark, themeFlippedLight, fileMode }));
    }

    // -----------------------------------------------------------------------
    // G2: Local Graph open + depth 1/2/3 + incoming/outgoing + hover/inspector
    // -----------------------------------------------------------------------
    {
      await openOrgFile("07-graph-showcase.org", { waitMs: 350 });
      await client.eval(`(async () => {
        const app = window.app;
        app.workspace.rightSplit?.expand?.();
        const orgView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        const hubRes = p.vaultIndex.index.resolveId("graph-showcase-hub");
        if (hubRes.status === "found") {
          const sec = orgView?.contentEl?.querySelector('.org-section[data-line="' + hubRes.node.line + '"]');
          sec?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
        app.commands.executeCommandById("${PLUGIN_ID}:open-local-graph");
      })()`);
      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view?.getGraphData?.()?.nodes?.length > 0`
      );
      await sleep(300);

      const depthMetrics = await client.eval(`(async () => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        view?.focusNode?.("id:graph-showcase-hub", "07-graph-showcase.org");
        await new Promise((r) => setTimeout(r, 150));
        const counts = {};
        for (const d of [1, 2, 3]) {
          const btn = view?.contentEl?.querySelector('button.org-graph-depth-btn[data-depth="' + d + '"]');
          btn?.click();
          await new Promise((r) => setTimeout(r, 180));
          counts["d" + d] = view?.getGraphData?.()?.stats?.nodeCount ?? 0;
        }
        // Test showIncoming / showOutgoing toggles around graph-layer-core
        view?.focusNode?.("id:graph-layer-core", "07-graph-showcase.org");
        view?.contentEl?.querySelector('button.org-graph-depth-btn[data-depth="1"]')?.click();
        await new Promise((r) => setTimeout(r, 150));
        const bothCount = view?.getGraphData?.()?.stats?.nodeCount ?? 0;
        const checks = Array.from(view?.contentEl?.querySelectorAll(".org-graph-local-panel-slot input[type='checkbox']") ?? []);
        const [incBox, outBox] = checks;
        if (incBox) {
          incBox.checked = false;
          incBox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 120));
        const outgoingOnlyCount = view?.getGraphData?.()?.stats?.nodeCount ?? 0;
        if (incBox) {
          incBox.checked = true;
          incBox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (outBox) {
          outBox.checked = false;
          outBox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 120));
        const incomingOnlyCount = view?.getGraphData?.()?.stats?.nodeCount ?? 0;
        if (outBox) {
          outBox.checked = true;
          outBox.dispatchEvent(new Event("change", { bubbles: true }));
        }

        // Restore hub depth=2 for visual sync screenshot
        view?.focusNode?.("id:graph-showcase-hub", "07-graph-showcase.org");
        view?.contentEl?.querySelector('button.org-graph-depth-btn[data-depth="2"]')?.click();
        await new Promise((r) => setTimeout(r, 350));
        view?.fitToView?.();
        return { counts, bothCount, outgoingOnlyCount, incomingOnlyCount };
      })()`);
      await snap("s4-local-sync-dark.png");

      // Select + Hover inspector screenshot on Local Graph
      await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        view?.selectNode?.("id:graph-layer-core");
      })()`);
      const hoverCoords = await centerAndGetCanvasCoords(
        VIEW_TYPE_ORG_LOCAL_GRAPH,
        "id:graph-layer-core"
      );
      if (hoverCoords) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          pointerType: "mouse",
          x: Math.max(1, hoverCoords.x - 12),
          y: Math.max(1, hoverCoords.y - 12),
        });
        await sleep(30);
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          pointerType: "mouse",
          x: hoverCoords.x,
          y: hoverCoords.y,
        });
        await waitForCondition(
          `Boolean(window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view?.contentEl?.querySelector(".org-graph-hover-popover[data-status]"))`,
          1800,
          50
        );
      }
      const hoverInspectorState = await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        const container = view?.contentEl;
        const inspector = container?.querySelector(".org-graph-inspector-card");
        const popover = container?.querySelector(".org-graph-hover-popover");
        return {
          inspectorVisible: Boolean(inspector && !inspector.classList.contains("is-hidden")),
          popoverVisible: Boolean(popover),
          popoverStatus: popover?.dataset?.status ?? null,
          popoverScripts: popover?.querySelectorAll("script")?.length ?? 0,
        };
      })()`);
      await snap("s4-local-hover-inspector.png");
      // Clear hover & selection
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
      await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        view?.getControls?.()?.removeHoverPopover?.();
        view?.selectNode?.(null);
      })()`);

      const g2Ok =
        depthMetrics.counts.d1 >= 2 &&
        depthMetrics.counts.d2 > depthMetrics.counts.d1 &&
        depthMetrics.counts.d3 > depthMetrics.counts.d2 &&
        depthMetrics.bothCount > depthMetrics.outgoingOnlyCount &&
        depthMetrics.bothCount > depthMetrics.incomingOnlyCount &&
        hoverInspectorState.inspectorVisible &&
        hoverInspectorState.popoverVisible &&
        hoverInspectorState.popoverScripts === 0;
      record("G2", "Local Graph opens, switches depth 1/2/3 & incoming/outgoing, shows hover/inspector", g2Ok, JSON.stringify({ depthMetrics, hoverCoords, hoverInspectorState }));
    }

    // -----------------------------------------------------------------------
    // G3: Graph -> Reader open preserving Graph leaf + .org-heading-jump-highlight
    // -----------------------------------------------------------------------
    {
      // Open a different file in OrgView first so Graph -> Reader jump opens 03-vla-memory-notes.org
      await openOrgFile("01-welcome-and-reading.org", { waitMs: 250 });
      const coords = await centerAndGetCanvasCoords(
        VIEW_TYPE_ORG_GRAPH,
        "id:vla-memory-overview"
      );
      if (coords) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          pointerType: "mouse",
          x: coords.x,
          y: coords.y,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          pointerType: "mouse",
          x: coords.x,
          y: coords.y,
          button: "left",
          clickCount: 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          pointerType: "mouse",
          x: coords.x,
          y: coords.y,
          button: "left",
          clickCount: 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          pointerType: "mouse",
          x: coords.x,
          y: coords.y,
          button: "left",
          clickCount: 2,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          pointerType: "mouse",
          x: coords.x,
          y: coords.y,
          button: "left",
          clickCount: 2,
        });
      }

      const jumped = await waitForCondition(
        `window.app.workspace.getActiveFile()?.path === "03-vla-memory-notes.org" && Boolean(document.querySelector(".org-heading-jump-highlight"))`,
        3500,
        50
      );
      await sleep(80);
      const jumpMetrics = await client.eval(`(() => {
        const app = window.app;
        const orgLeaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0];
        const highlight = orgLeaf?.view?.contentEl?.querySelector(".org-heading-jump-highlight");
        return {
          globalLeaves: app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)}).length,
          localLeaves: app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)}).length,
          activePath: app.workspace.getActiveFile()?.path ?? null,
          hasHighlight: Boolean(highlight),
          highlightText: highlight?.textContent?.trim() ?? "",
        };
      })()`);
      await snap("s4-graph-to-reader-jump.png");

      const g3Ok =
        jumped &&
        jumpMetrics.globalLeaves === 1 &&
        jumpMetrics.localLeaves === 1 &&
        jumpMetrics.activePath === "03-vla-memory-notes.org" &&
        jumpMetrics.hasHighlight;
      record("G3", "Graph -> Reader jump opens target file, preserves Graph leaves & highlights heading", g3Ok, JSON.stringify({ coords, jumped, jumpMetrics }));
    }

    // -----------------------------------------------------------------------
    // G4: Reader heading switch -> Local Graph auto-follow + scroll-stability
    // -----------------------------------------------------------------------
    {
      await openOrgFile("07-graph-showcase.org", { waitMs: 300 });
      const followRes = await client.eval(`(async () => {
        const app = window.app;
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        const orgView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
        const localView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        localView?.unlockFocus?.();

        const core = p.vaultIndex.index.resolveId("graph-layer-core");
        const comp = p.vaultIndex.index.resolveId("graph-layer-composer");

        const clickLine = async (line) => {
          const sec = orgView?.contentEl?.querySelector('.org-section[data-line="' + line + '"]');
          sec?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 180));
        };

        if (core.status === "found") await clickLine(core.node.line);
        const afterCore = localView?.getLocalState?.()?.centerNodeId ?? null;

        if (comp.status === "found") await clickLine(comp.node.line);
        const afterComp = localView?.getLocalState?.()?.centerNodeId ?? null;

        // Scroll jitter check
        const preview = orgView?.contentEl?.querySelector(".org-preview");
        if (preview) {
          preview.scrollTop = 180;
          preview.dispatchEvent(new Event("scroll"));
          await new Promise((r) => setTimeout(r, 150));
          preview.scrollTop = 40;
          preview.dispatchEvent(new Event("scroll"));
          await new Promise((r) => setTimeout(r, 150));
        }
        const afterScroll = localView?.getLocalState?.()?.centerNodeId ?? null;
        return { afterCore, afterComp, afterScroll };
      })()`);

      await openOrgFile("03-vla-memory-notes.org", { waitMs: 300 });
      const afterFileSwitch = await client.eval(`(() => {
        const localView = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        return {
          centerFilePath: localView?.getLocalState?.()?.centerFilePath ?? null,
          centerNodeId: localView?.getLocalState?.()?.centerNodeId ?? null,
        };
      })()`);

      const g4Ok =
        followRes.afterCore === "id:graph-layer-core" &&
        followRes.afterComp === "id:graph-layer-composer" &&
        followRes.afterScroll === "id:graph-layer-composer" &&
        afterFileSwitch.centerFilePath === "03-vla-memory-notes.org";
      record("G4", "Reader heading/file switches auto-follow in Local Graph with zero scroll jitter", g4Ok, JSON.stringify({ followRes, afterFileSwitch }));
    }

    // -----------------------------------------------------------------------
    // G5: Lock button -> Reader switch ignored
    // -----------------------------------------------------------------------
    {
      const lockSetup = await client.eval(`(async () => {
        const localView = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        const lockBtn = localView?.contentEl?.querySelector(".org-graph-lock-btn");
        lockBtn?.click();
        await new Promise((r) => setTimeout(r, 160));
        return {
          followReader: localView?.getLocalState?.()?.followReader ?? null,
          lockedNodeId: localView?.getLocalState?.()?.lockedNodeId ?? null,
          centerNodeId: localView?.getLocalState?.()?.centerNodeId ?? null,
          pressed: lockBtn?.getAttribute("aria-pressed") ?? null,
        };
      })()`);

      await openOrgFile("01-welcome-and-reading.org", { waitMs: 250 });
      const afterSwitch = await client.eval(`(async () => {
        const app = window.app;
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        const orgView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})[0]?.view;
        const welcome = p.vaultIndex.index.resolveId("welcome-core-idea");
        if (welcome.status === "found") {
          const sec = orgView?.contentEl?.querySelector('.org-section[data-line="' + welcome.node.line + '"]');
          sec?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 250));
        const localView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)})[0]?.view;
        const centerWhileLocked = localView?.getLocalState?.()?.centerNodeId ?? null;
        localView?.contentEl?.querySelector(".org-graph-lock-btn")?.click();
        await new Promise((r) => setTimeout(r, 200));
        return {
          centerWhileLocked,
          followAfterUnlock: localView?.getLocalState?.()?.followReader ?? null,
        };
      })()`);

      const g5Ok =
        lockSetup.followReader === false &&
        lockSetup.pressed === "true" &&
        afterSwitch.centerWhileLocked === lockSetup.centerNodeId &&
        afterSwitch.followAfterUnlock === true;
      record("G5", "Local Graph Lock button freezes focus across Reader switches", g5Ok, JSON.stringify({ lockSetup, afterSwitch }));
    }

    // -----------------------------------------------------------------------
    // G6, G7, G8: Scratch edits (incremental link, #+TRANSCLUDE:, cross-file move)
    // -----------------------------------------------------------------------
    try {
      const scratchA = "99-qa-graph-scratch-a.org";
      const scratchB = "99-qa-graph-scratch-b.org";
      const scratchC = "99-qa-graph-scratch-c.org";

      await client.eval(`(async () => {
        const app = window.app;
        const gLeaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0];
        if (gLeaf) {
          app.workspace.revealLeaf(gLeaf);
          app.workspace.setActiveLeaf(gLeaf, { focus: true });
        }
        await app.vault.create(${JSON.stringify(scratchA)}, "* Scratch A\\n:PROPERTIES:\\n:ID: qa-graph-scratch-a\\n:END:\\nInitial.\\n");
        await app.vault.create(${JSON.stringify(scratchB)}, "* Scratch B\\n:PROPERTIES:\\n:ID: qa-graph-scratch-b\\n:END:\\nTarget.\\n");
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        await p.vaultIndex.flushPendingUpdates();
        await new Promise((r) => setTimeout(r, 320));
      })()`);

      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.()?.nodeMap?.has?.("id:qa-graph-scratch-b")`
      );

      // Settle simulation before G6 edit
      const beforeG6 = await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        view?.getSimulation?.()?.step?.(60);
        view?.getSimulation?.()?.stop?.();
        return {
          posB: view?.getNodePosition?.("id:qa-graph-scratch-b") ?? null,
        };
      })()`);

      // G6: Incremental [[id:...]] link edit
      await client.eval(`(async () => {
        const app = window.app;
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratchA)});
        await app.vault.modify(f, "* Scratch A\\n:PROPERTIES:\\n:ID: qa-graph-scratch-a\\n:END:\\nLinks [[id:qa-graph-scratch-b]].\\n");
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        await p.vaultIndex.flushPendingUpdates();
      })()`);
      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.()?.edges?.some?.((e) => e.id === "reference:id:qa-graph-scratch-a->id:qa-graph-scratch-b")`
      );
      const g6Res = await client.eval(`(() => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        const data = view?.getGraphData?.();
        const posB = view?.getNodePosition?.("id:qa-graph-scratch-b");
        return {
          hasRefEdge: Boolean(data?.edges?.some?.((e) => e.id === "reference:id:qa-graph-scratch-a->id:qa-graph-scratch-b")),
          alpha: view?.getSimulationAlpha?.() ?? null,
          posB,
        };
      })()`);
      const g6Drift =
        beforeG6.posB && g6Res.posB
          ? Math.hypot(g6Res.posB.x - beforeG6.posB.x, g6Res.posB.y - beforeG6.posB.y)
          : Infinity;
      record("G6", "Incremental [[id:...]] edit updates edges cleanly while keeping node coordinates", g6Res.hasRefEdge && g6Res.alpha <= 0.25 && g6Drift < 80, JSON.stringify({ beforeG6, g6Res, g6Drift }));

      // G7: Incremental #+TRANSCLUDE: adds distinct transclusion edge + parallel slot
      await client.eval(`(async () => {
        const app = window.app;
        const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratchA)});
        await app.vault.modify(f, "* Scratch A\\n:PROPERTIES:\\n:ID: qa-graph-scratch-a\\n:END:\\nLinks [[id:qa-graph-scratch-b]].\\n#+TRANSCLUDE: [[id:qa-graph-scratch-b]] :only-contents\\n");
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        await p.vaultIndex.flushPendingUpdates();
      })()`);
      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.()?.edges?.some?.((e) => e.id === "transclusion:id:qa-graph-scratch-a->id:qa-graph-scratch-b")`
      );
      const g7Res = await client.eval(`(() => {
        const data = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.();
        const pair = (data?.edges ?? []).filter((e) => e.source === "id:qa-graph-scratch-a" && e.target === "id:qa-graph-scratch-b");
        return {
          pairKinds: pair.map((e) => e.kind).sort(),
          parallelCounts: pair.map((e) => e.parallelCount),
          parallelIndices: pair.map((e) => e.parallelIndex).sort(),
        };
      })()`);
      const g7Ok =
        g7Res.pairKinds.length === 2 &&
        g7Res.pairKinds[0] === "reference" &&
        g7Res.pairKinds[1] === "transclusion" &&
        g7Res.parallelCounts.every((c) => c === 2);
      record("G7", "Incremental #+TRANSCLUDE: adds distinct transclusion edge & parallel slot", g7Ok, JSON.stringify(g7Res));

      // G8: Cross-file move preserves canonical ID & updates filePath
      await client.eval(`(async () => {
        const app = window.app;
        const fb = app.vault.getAbstractFileByPath(${JSON.stringify(scratchB)});
        await app.vault.modify(fb, "* Scratch B Empty\\nMoved away.\\n");
        await app.vault.create(${JSON.stringify(scratchC)}, "* Scratch C\\n** Scratch B\\n:PROPERTIES:\\n:ID: qa-graph-scratch-b\\n:END:\\nMoved here.\\n");
        const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        await p.vaultIndex.flushPendingUpdates();
      })()`);
      await waitForCondition(
        `window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.()?.nodeMap?.get?.("id:qa-graph-scratch-b")?.filePath === ${JSON.stringify(scratchC)}`
      );
      const g8Res = await client.eval(`(() => {
        const data = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view?.getGraphData?.();
        const moved = data?.nodeMap?.get?.("id:qa-graph-scratch-b");
        return {
          exists: Boolean(moved),
          id: moved?.id ?? null,
          filePath: moved?.filePath ?? null,
          hasIncomingRef: Boolean(data?.edges?.some?.((e) => e.id === "reference:id:qa-graph-scratch-a->id:qa-graph-scratch-b")),
        };
      })()`);
      record("G8", "Cross-file :ID: move preserves canonical id:<orgId> & updates filePath", g8Res.exists && g8Res.id === "id:qa-graph-scratch-b" && g8Res.filePath === scratchC && g8Res.hasIncomingRef, JSON.stringify(g8Res));
    } finally {
      await cleanupVaultScratchInObsidian();
      await sleep(250);
    }

    // -----------------------------------------------------------------------
    // G9: Duplicate + unresolved toggle zero crash
    // -----------------------------------------------------------------------
    {
      const g9Res = await client.eval(`(async () => {
        const app = window.app;
        const gLeaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0];
        if (gLeaf) {
          app.workspace.revealLeaf(gLeaf);
          app.workspace.setActiveLeaf(gLeaf, { focus: true });
        }
        const view = gLeaf?.view;
        const container = view?.contentEl;
        const gearBtn = container?.querySelector(".org-graph-gear-btn");
        if (!view?.getViewState?.()?.controlsOpen) gearBtn?.click();
        await new Promise((r) => setTimeout(r, 150));

        const unresolvedBox = container?.querySelector('input[data-filter-key="showUnresolved"]');
        if (unresolvedBox) {
          unresolvedBox.checked = true;
          unresolvedBox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 180));
        const withUnresolved = view?.getGraphData?.();
        const hasMissing404 = Boolean(withUnresolved?.nodeMap?.has?.("missing:missing-demo-404"));
        const duplicateCount = withUnresolved?.stats?.duplicateCount ?? 0;

        view?.selectNode?.("id:demo-duplicate-id");
        const dupBadge = Boolean(container?.querySelector(".org-graph-status-badge.is-duplicate"));
        view?.selectNode?.("missing:missing-demo-404");
        const unresBadge = Boolean(container?.querySelector(".org-graph-status-badge.is-unresolved"));
        view?.selectNode?.(null);

        if (unresolvedBox) {
          unresolvedBox.checked = false;
          unresolvedBox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 150));
        const afterUncheck = Boolean(view?.getGraphData?.()?.nodeMap?.has?.("missing:missing-demo-404"));
        return { hasMissing404, duplicateCount, dupBadge, unresBadge, afterUncheck };
      })()`);
      record("G9", "Duplicate ID & showUnresolved toggle render cleanly with zero crash", g9Res.hasMissing404 && g9Res.duplicateCount === 2 && g9Res.dupBadge && g9Res.unresBadge && !g9Res.afterUncheck, JSON.stringify(g9Res));
    }

    // -----------------------------------------------------------------------
    // G10: Multi-pane + Search + Color Groups + Dark/Light + Controls screenshot
    // -----------------------------------------------------------------------
    {
      const g10Res = await client.eval(`(async () => {
        const app = window.app;
        const view = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        const container = view?.contentEl;
        const gearBtn = container?.querySelector(".org-graph-gear-btn");
        if (!view?.getViewState?.()?.controlsOpen) gearBtn?.click();
        await new Promise((r) => setTimeout(r, 150));

        // Search filter tag:#zh中文
        const searchInput = container?.querySelector(".org-graph-search-input");
        if (searchInput) {
          searchInput.value = "tag:#zh中文";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 180));
        const searchCount = view?.getGraphData?.()?.stats?.nodeCount ?? 0;
        const searchMatchesLeaf = Boolean(view?.getGraphData?.()?.nodeMap?.has?.("id:graph-layer-leaf"));

        // Clear search
        if (searchInput) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 180));
        const restoredCount = view?.getGraphData?.()?.stats?.nodeCount ?? 0;

        // Custom color groups
        const selectEl = container?.querySelector(".org-graph-color-select");
        if (selectEl) {
          selectEl.value = "custom";
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        view?.setColorGroups?.([
          { id: "g-graph", query: "tag:#graph", color: "#7c3aed" },
          { id: "g-memory", query: "tag:#memory", color: "#0ea5e9" },
        ]);
        await new Promise((r) => setTimeout(r, 250));
        view?.fitToView?.();

        const data = view?.getGraphData?.();
        const hubColor = data?.nodeMap?.get?.("id:graph-showcase-hub")?.groupColor ?? null;
        const leafColor = data?.nodeMap?.get?.("id:graph-layer-leaf")?.groupColor ?? null;

        return {
          globalLeaves: app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)}).length,
          localLeaves: app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_LOCAL_GRAPH)}).length,
          orgLeaves: app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)}).length,
          searchCount,
          searchMatchesLeaf,
          restoredCount,
          hubColor,
          leafColor,
          controlsOpen: Boolean(container?.querySelector(".org-graph-controls-panel.is-open")),
        };
      })()`);
      await snap("s4-controls-groups-dark.png");

      // Reset controls closed + colorMode file, test Dark/Light switch cleanly
      await client.eval(`(async () => {
        const view = window.app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        view?.setColorGroups?.([]);
        view?.setColorMode?.("file");
        if (view?.getViewState?.()?.controlsOpen) {
          view?.contentEl?.querySelector(".org-graph-gear-btn")?.click();
        }
      })()`);
      const lightCheck = await setTheme("moonstone");
      const darkCheck = await setTheme("obsidian");

      const g10Ok =
        g10Res.globalLeaves === 1 &&
        g10Res.localLeaves === 1 &&
        g10Res.orgLeaves >= 1 &&
        g10Res.searchMatchesLeaf &&
        g10Res.searchCount < g10Res.restoredCount &&
        g10Res.hubColor === "#7c3aed" &&
        g10Res.leafColor === "#0ea5e9" &&
        g10Res.controlsOpen &&
        lightCheck.isLight &&
        darkCheck.isDark;
      record("G10", "Multi-pane Global+Local+OrgView, Search, Color Groups & Dark/Light themes", g10Ok, JSON.stringify({ g10Res, lightIsLight: lightCheck.isLight, darkIsDark: darkCheck.isDark }));
    }

    // -----------------------------------------------------------------------
    // G11: Strict SHA-256 zero disk mutation on 01..07
    // -----------------------------------------------------------------------
    {
      const diffs = [];
      for (const f of CORPUS_FILES) {
        const current = sha256File(path.join(TEST_VAULT_DIR, f));
        if (current !== baselineHashes[f]) {
          diffs.push({ file: f, before: baselineHashes[f], after: current });
        }
      }
      record("G11", "Strict SHA-256 zero disk mutation across 01..07 corpus files", diffs.length === 0, JSON.stringify({ checkedFiles: CORPUS_FILES.length, diffs }));
    }

    // -----------------------------------------------------------------------
    // G12: Plugin disable/re-enable + zero pageErrors/consoleErrors
    // -----------------------------------------------------------------------
    {
      const reloadRes = await client.eval(`(async () => {
        const app = window.app;
        await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 200));
        await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
        await new Promise((r) => setTimeout(r, 400));
        const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
        if (plugin?.vaultIndex) await plugin.vaultIndex.initialize();
        app.commands.executeCommandById("${PLUGIN_ID}:open-global-graph");
        await new Promise((r) => setTimeout(r, 350));
        const gView = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG_GRAPH)})[0]?.view;
        return {
          enabled: Boolean(plugin),
          hasGraphHandle: Boolean(plugin?.graph),
          reopenedNodes: gView?.getGraphData?.()?.stats?.nodeCount ?? 0,
        };
      })()`);

      const g12Ok =
        reloadRes.enabled &&
        reloadRes.hasGraphHandle &&
        reloadRes.reopenedNodes >= 18 &&
        client.pageErrors.length === 0 &&
        client.consoleErrors.length === 0;
      record("G12", "Plugin disable/re-enable stability & zero pageErrors/consoleErrors", g12Ok, JSON.stringify({ reloadRes, pageErrors: client.pageErrors, consoleErrors: client.consoleErrors }));
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
