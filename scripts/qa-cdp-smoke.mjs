#!/usr/bin/env node
/**
 * Vault-guarded Chrome DevTools Protocol (CDP) smoke harness for Org Native.
 *
 * Zero external dependencies (Node 22+ built-in fetch & global WebSocket).
 * Strictly read-only: NEVER writes .org files, NEVER opens personal vaults,
 * and ABORTS with exit code 2 if app.vault.getName() !== --expect-vault.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIEW_TYPE_ORG = "org-native-view";
const PLUGIN_ID = "org-native";
const DEFAULT_PORT = 9222;
const DEFAULT_EXPECT_VAULT = "test-vault";
const REQUIRED_SAMPLE_FILES = [
  "01-welcome-and-reading.org",
  "02-math-code-and-tables.org",
  "03-vla-memory-notes.org",
  "04-knowledge-nodes.org",
  "05-diagnostics-demo.org",
];
const OPTIONAL_SAMPLE_FILES = ["06-transclusion-demo.org"];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOTS_DIR = path.join(ROOT_DIR, "tests", "qa", "screenshots");

function printUsage() {
  console.log(`Usage: node scripts/qa-cdp-smoke.mjs [options]

Options:
  --port <port>           Obsidian remote debugging port (default: ${DEFAULT_PORT})
  --expect-vault <name>   Required Obsidian vault name guard (default: "${DEFAULT_EXPECT_VAULT}")
  --screenshots           Save PNG screenshots into tests/qa/screenshots/
  --open-file <list>      Comma-separated vault-relative .org paths to open
  -h, --help              Show this help message

Exit codes:
  0  Connected to expected vault and all smoke checks passed
  1  CDP endpoint unreachable, invalid arguments, or smoke assertion failed
  2  Vault guard violation (connected vault does not match --expect-vault)`);
}

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    expectVault: DEFAULT_EXPECT_VAULT,
    screenshots: false,
    openFiles: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--screenshots") {
      opts.screenshots = true;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg.includes("=") ? arg.slice("--port=".length) : argv[++i];
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error(`Invalid --port value: ${raw ?? "(missing)"}`);
      }
      const parsed = Number(raw);
      if (parsed < 1 || parsed > 65535) {
        throw new Error(`Port out of range (1..65535): ${parsed}`);
      }
      opts.port = parsed;
      continue;
    }
    if (arg === "--expect-vault" || arg.startsWith("--expect-vault=")) {
      const raw = arg.includes("=") ? arg.slice("--expect-vault=".length) : argv[++i];
      if (!raw || !raw.trim()) {
        throw new Error(`Invalid --expect-vault value: ${raw ?? "(missing)"}`);
      }
      opts.expectVault = raw.trim();
      continue;
    }
    if (arg === "--open-file" || arg.startsWith("--open-file=")) {
      const raw = arg.includes("=") ? arg.slice("--open-file=".length) : argv[++i];
      if (!raw || !raw.trim()) {
        throw new Error(`Invalid --open-file value: ${raw ?? "(missing)"}`);
      }
      const files = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (files.length === 0) {
        throw new Error("--open-file must specify at least one file path");
      }
      opts.openFiles = files;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
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
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error("Global WebSocket API is unavailable; Node 22+ is required.");
    }
    await new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to CDP WebSocket: ${this.wsUrl}`));
      }, timeoutMs);

      const onOpen = () => {
        clearTimeout(timer);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        reject(new Error(`WebSocket connection failed: ${this.wsUrl}`));
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("message", (event) => this.handleMessage(event));
      ws.addEventListener("close", () => this.rejectAll("CDP WebSocket closed unexpectedly"));
    });
  }

  handleMessage(event) {
    let raw;
    if (typeof event.data === "string") {
      raw = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      raw = Buffer.from(event.data).toString("utf8");
    } else {
      raw = String(event.data);
    }

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
        entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params?.exceptionDetails;
      const text =
        details?.exception?.description ||
        details?.text ||
        JSON.stringify(details ?? {});
      this.pageErrors.push(text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const args = Array.isArray(msg.params.args)
        ? msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")
        : "";
      this.consoleErrors.push(args || "console.error");
    } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
      this.consoleErrors.push(msg.params.entry.text ?? "log.error");
    }
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`CDP WebSocket not open when calling ${method}`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "Runtime.evaluate exception";
      throw new Error(desc);
    }
    return res?.result?.value;
  }

  async captureScreenshot(filePath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    if (!res?.data) {
      throw new Error("Page.captureScreenshot returned empty image payload");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(res.data, "base64"));
  }

  close() {
    this.rejectAll("CDP client closed");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      this.ws = null;
    }
  }
}

async function fetchCdpTargets(port) {
  const endpoint = `http://127.0.0.1:${port}/json`;
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[NOT_VERIFIED] Obsidian CDP endpoint not available on port ${port} (${msg}). ` +
        `Launch Obsidian against test-vault with --remote-debugging-port=${port} first.`
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `[NOT_VERIFIED] Obsidian CDP endpoint on port ${port} returned HTTP ${response.status}.`
    );
    process.exit(1);
  }

  const targets = await response.json();
  if (!Array.isArray(targets)) {
    console.error(`[NOT_VERIFIED] Unexpected CDP /json payload on port ${port}.`);
    process.exit(1);
  }

  return targets.filter(
    (t) =>
      t &&
      t.type === "page" &&
      typeof t.webSocketDebuggerUrl === "string" &&
      !String(t.url ?? "").startsWith("devtools://") &&
      !String(t.url ?? "").startsWith("chrome-extension://")
  );
}

async function connectAndVerifyVault(targets, expectVault) {
  let matchedTarget = null;
  let matchedInfo = null;

  for (const target of targets) {
    const probe = new CdpClient(target.webSocketDebuggerUrl);
    try {
      await probe.connect();
      const info = await probe.evaluate(`(() => ({
        hasApp: Boolean(window.app),
        vaultName: typeof window.app?.vault?.getName === "function" ? window.app.vault.getName() : null,
        title: document.title || ""
      }))()`);

      if (!info?.hasApp) continue;

      if (info.vaultName !== expectVault) {
        console.error(
          `[ABORT] Vault guard rejected connected Obsidian window: ` +
            `app.vault.getName()="${info.vaultName ?? "(none)"}" title="${info.title}" ` +
            `does not match expected vault "${expectVault}".`
        );
        probe.close();
        process.exit(2);
      }

      if (!matchedTarget) {
        matchedTarget = target;
        matchedInfo = info;
      }
    } finally {
      probe.close();
    }
  }

  if (!matchedTarget || !matchedInfo) {
    const titles = targets.map((t) => t.title || t.url || "(untitled)").join(", ");
    console.error(
      `[ABORT] No Obsidian window matching vault "${expectVault}" found on CDP targets (${titles}).`
    );
    process.exit(2);
  }

  const client = new CdpClient(matchedTarget.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");
  return { client, vaultInfo: matchedInfo };
}

function toScreenshotSlug(filePath) {
  return filePath
    .replace(/\.org$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

class VaultGuardError extends Error {}

async function runSmoke(client, opts, vaultInfo) {
  const failures = [];
  const screenshotsSaved = [];

  const saveShot = async (filename) => {
    if (!opts.screenshots) return;
    const outPath = path.join(SCREENSHOTS_DIR, filename);
    await client.captureScreenshot(outPath);
    screenshotsSaved.push(path.relative(ROOT_DIR, outPath));
  };

  // 1. Verify plugin & .org view registration
  const pluginState = await client.evaluate(`(async () => {
    const app = window.app;
    if (!app.workspace.layoutReady) {
      await new Promise((resolve) => app.workspace.onLayoutReady(resolve));
    }
    const plugin =
      app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}] ??
      app.plugins?.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ??
      null;
    const enabled = Boolean(
      app.plugins?.enabledPlugins?.has?.(${JSON.stringify(PLUGIN_ID)}) || plugin
    );
    const extType = app.viewRegistry?.getTypeByExtension?.("org") ?? null;
    const commands = Object.keys(app.commands?.commands ?? {})
      .filter((id) => id.startsWith("${PLUGIN_ID}:"))
      .sort();
    return {
      vaultName: app.vault.getName(),
      title: document.title,
      pluginLoaded: Boolean(plugin),
      enabled,
      extType,
      commands,
    };
  })()`);

  if (pluginState.vaultName !== opts.expectVault) {
    throw new VaultGuardError(
      `[ABORT] Vault changed mid-run to "${pluginState.vaultName}" (expected "${opts.expectVault}").`
    );
  }
  if (!pluginState.pluginLoaded || !pluginState.enabled) {
    failures.push(`Plugin "${PLUGIN_ID}" is not loaded/enabled in ${opts.expectVault}.`);
  }
  if (pluginState.extType !== VIEW_TYPE_ORG) {
    failures.push(`Expected .org extension view "${VIEW_TYPE_ORG}", got "${pluginState.extType}".`);
  }

  // 2. Open .org files
  const filesToCheck = opts.openFiles
    ? opts.openFiles.map((p) => ({ path: p, required: true }))
    : [
        ...REQUIRED_SAMPLE_FILES.map((p) => ({ path: p, required: true })),
        ...OPTIONAL_SAMPLE_FILES.map((p) => ({ path: p, required: false })),
      ];

  const openedFiles = [];
  const skippedOptionalFiles = [];

  for (const entry of filesToCheck) {
    const result = await client.evaluate(`(async () => {
      const app = window.app;
      const filePath = ${JSON.stringify(entry.path)};
      const abstract = app.vault.getAbstractFileByPath(filePath);
      if (!abstract) {
        return { found: false, filePath };
      }
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(abstract);
      app.workspace.setActiveLeaf(leaf, { focus: true });

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (leaf.view?.getViewType?.() === ${JSON.stringify(VIEW_TYPE_ORG)}) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200));

      const view = leaf.view;
      const contentEl = view?.contentEl;
      return {
        found: true,
        filePath,
        viewType: view?.getViewType?.() ?? null,
        mode: view?.getMode?.() ?? null,
        dirty: view?.syncGuard?.isDirty?.() ?? null,
        conflicted: view?.syncGuard?.isConflicted?.() ?? null,
        hasOrgViewClass: Boolean(contentEl?.classList?.contains("org-view")),
        previewCount: contentEl?.querySelectorAll(".org-preview").length ?? 0,
        transclusionCount: contentEl?.querySelectorAll(".org-transclusion").length ?? 0,
        transclusionSlotCount: contentEl?.querySelectorAll(".org-transclude-slot").length ?? 0,
      };
    })()`);

    if (!result.found) {
      if (entry.required) {
        failures.push(`Required .org file missing in vault: ${entry.path}`);
      } else {
        skippedOptionalFiles.push(entry.path);
      }
      continue;
    }

    openedFiles.push(result);
    if (result.viewType !== VIEW_TYPE_ORG) {
      failures.push(`File "${entry.path}" opened in "${result.viewType}" instead of "${VIEW_TYPE_ORG}".`);
    }
    if (result.dirty !== false) {
      failures.push(`Read-only open marked buffer dirty on "${entry.path}" (dirty=${result.dirty}).`);
    }
    if (result.conflicted !== false) {
      failures.push(`Unexpected conflict state on "${entry.path}".`);
    }
    await saveShot(`cdp-open-${toScreenshotSlug(entry.path)}.png`);
  }

  // 3. Mode switching & fold commands on primary .org file
  const primaryPath = openedFiles[0]?.filePath ?? null;
  const modeTransitions = [];
  const foldChecks = [];

  if (!primaryPath) {
    failures.push("No .org file opened; cannot verify mode switching or folding commands.");
  } else {
    const modePlan = [
      { mode: "reading", cmd: `${PLUGIN_ID}:mode-reading`, cls: "is-preview-mode", shot: "cdp-mode-reading.png" },
      { mode: "live", cmd: `${PLUGIN_ID}:mode-live`, cls: "is-live-preview", shot: "cdp-mode-live.png" },
      { mode: "source", cmd: `${PLUGIN_ID}:mode-source`, cls: "is-source-mode", shot: "cdp-mode-source.png" },
      { mode: "reading", cmd: `${PLUGIN_ID}:mode-reading`, cls: "is-preview-mode", shot: "cdp-mode-reading-restored.png" },
    ];

    // Activate leaf for primary file
    await client.evaluate(`(async () => {
      const app = window.app;
      const leaves = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)});
      const target = leaves.find((l) => l.view?.file?.path === ${JSON.stringify(primaryPath)});
      if (target) {
        app.workspace.setActiveLeaf(target, { focus: true });
      }
      await new Promise((r) => setTimeout(r, 100));
    })()`);

    for (const step of modePlan) {
      const res = await client.evaluate(`(async () => {
        const app = window.app;
        const targetLeaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})
          .find((l) => l.view?.file?.path === ${JSON.stringify(primaryPath)});
        if (targetLeaf) {
          app.workspace.setActiveLeaf(targetLeaf, { focus: true });
          await new Promise((r) => setTimeout(r, 30));
        }
        const executed = app.commands.executeCommandById(${JSON.stringify(step.cmd)});
        await new Promise((r) => setTimeout(r, 200));
        const activeLeafView = targetLeaf?.view ?? app.workspace.getMostRecentLeaf?.()?.view ?? app.workspace.activeLeaf?.view;
        return {
          executed,
          mode: activeLeafView?.getMode?.() ?? null,
          hasExpectedClass: Boolean(activeLeafView?.contentEl?.classList?.contains(${JSON.stringify(step.cls)})),
          dirty: activeLeafView?.syncGuard?.isDirty?.() ?? null,
        };
      })()`);

      modeTransitions.push({ target: step.mode, command: step.cmd, ...res });
      if (!res.executed) {
        failures.push(`Command "${step.cmd}" did not execute.`);
      }
      if (res.mode !== step.mode || !res.hasExpectedClass) {
        failures.push(`Mode transition to "${step.mode}" failed (got mode=${res.mode}, class=${res.hasExpectedClass}).`);
      }
      if (res.dirty !== false) {
        failures.push(`Mode transition to "${step.mode}" dirtied buffer (dirty=${res.dirty}).`);
      }
      await saveShot(step.shot);
    }

    const foldPlan = [
      { cmd: `${PLUGIN_ID}:fold-overview`, expectFolded: true, expectBodyFolded: false, shot: "cdp-fold-overview.png" },
      { cmd: `${PLUGIN_ID}:fold-content`, expectFolded: false, expectBodyFolded: true, shot: null },
      { cmd: `${PLUGIN_ID}:unfold-all`, expectFolded: false, expectBodyFolded: false, shot: "cdp-fold-unfolded.png" },
    ];

    for (const step of foldPlan) {
      const res = await client.evaluate(`(async () => {
        const app = window.app;
        const targetLeaf = app.workspace.getLeavesOfType(${JSON.stringify(VIEW_TYPE_ORG)})
          .find((l) => l.view?.file?.path === ${JSON.stringify(primaryPath)});
        if (targetLeaf) {
          app.workspace.setActiveLeaf(targetLeaf, { focus: true });
          await new Promise((r) => setTimeout(r, 30));
        }
        const executed = app.commands.executeCommandById(${JSON.stringify(step.cmd)});
        await new Promise((r) => setTimeout(r, 150));
        const activeView = targetLeaf?.view ?? app.workspace.getMostRecentLeaf?.()?.view ?? app.workspace.activeLeaf?.view;
        const root = activeView?.contentEl;
        return {
          executed,
          sectionCount: root?.querySelectorAll(".org-section").length ?? 0,
          foldedCount: root?.querySelectorAll(".org-section.is-folded").length ?? 0,
          bodyFoldedCount: root?.querySelectorAll(".org-section.is-body-folded").length ?? 0,
          dirty: activeView?.syncGuard?.isDirty?.() ?? null,
        };
      })()`);

      foldChecks.push({ command: step.cmd, ...res });
      if (!res.executed) {
        failures.push(`Fold command "${step.cmd}" did not execute.`);
      }
      if (res.sectionCount > 0) {
        if (step.expectFolded && res.foldedCount === 0) {
          failures.push(`"${step.cmd}" produced 0 .is-folded sections.`);
        }
        if (step.expectBodyFolded && res.bodyFoldedCount === 0) {
          failures.push(`"${step.cmd}" produced 0 .is-body-folded sections.`);
        }
        if (!step.expectFolded && !step.expectBodyFolded && (res.foldedCount > 0 || res.bodyFoldedCount > 0)) {
          failures.push(`"${step.cmd}" left folded sections behind (folded=${res.foldedCount}, bodyFolded=${res.bodyFoldedCount}).`);
        }
      }
      if (res.dirty !== false) {
        failures.push(`Fold command "${step.cmd}" dirtied buffer (dirty=${res.dirty}).`);
      }
      if (step.shot) await saveShot(step.shot);
    }
  }

  if (client.pageErrors.length > 0) {
    failures.push(`Uncaught page errors detected (${client.pageErrors.length}).`);
  }
  if (client.consoleErrors.length > 0) {
    failures.push(`Console errors detected (${client.consoleErrors.length}).`);
  }

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    timestamp: new Date().toISOString(),
    port: opts.port,
    expectedVault: opts.expectVault,
    connectedVault: vaultInfo.vaultName,
    windowTitle: vaultInfo.title,
    plugin: {
      id: PLUGIN_ID,
      loaded: pluginState.pluginLoaded,
      enabled: pluginState.enabled,
      orgExtensionViewType: pluginState.extType,
      registeredCommands: pluginState.commands,
    },
    openedFiles,
    skippedOptionalFiles,
    modeTransitions,
    foldChecks,
    screenshotsSaved,
    pageErrors: client.pageErrors,
    consoleErrors: client.consoleErrors,
    failures,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exit(1);
  }

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const targets = await fetchCdpTargets(opts.port);
  if (targets.length === 0) {
    console.error(`[NOT_VERIFIED] No Obsidian page targets exposed on CDP port ${opts.port}.`);
    process.exit(1);
  }

  const { client, vaultInfo } = await connectAndVerifyVault(targets, opts.expectVault);
  try {
    const summary = await runSmoke(client, opts, vaultInfo);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.status === "PASS" ? 0 : 1;
  } catch (error) {
    if (error instanceof VaultGuardError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      throw error;
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`[ERROR] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
