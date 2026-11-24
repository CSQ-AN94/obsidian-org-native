import {
  App,
  loadMathJax,
  loadPrism,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { PLUGIN_ID, VIEW_TYPE_ORG } from "./constants";
import type {
  OrgViewMode,
  PropertiesDisplayMode,
  ReadingLineHeightMode,
  ReadingWidthMode,
} from "./core/model/types";
import { VaultIndexService } from "./core/index/vaultIndexService";
import { configureTodoKeywordExtras } from "./core/parser/todoKeywords";
import {
  createVaultTransclusionProvider,
  OrgTransclusionEngine,
} from "./core/transclusion";
import {
  LanguageSetting,
  resolveLanguage,
  translate,
  TranslationKey,
  UiLanguage,
} from "./i18n";
import { OrgOutlineBridge } from "./integration/outline";
import { DEFAULT_SETTINGS, OrgNativeSettings } from "./settings";
import { setPrismInstance, type PrismLike } from "./views/editor/highlight";
import { registerNodeNavigation, type NodeNavigationHandle } from "./views/nodes";
import { OrgView } from "./views/OrgView";

export default class OrgNativePlugin extends Plugin {
  settings: OrgNativeSettings = { ...DEFAULT_SETTINGS };
  outline!: OrgOutlineBridge;
  vaultIndex!: VaultIndexService;
  nodeNavigation!: NodeNavigationHandle;
  transclusionEngine!: OrgTransclusionEngine;

  get uiLanguage(): UiLanguage {
    return resolveLanguage(this.settings.language);
  }

  t(key: TranslationKey): string {
    return translate(this.uiLanguage, key);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    configureTodoKeywordExtras(this.settings.todoKeywords);

    this.outline = new OrgOutlineBridge(this.app, this);
    this.outline.setEnabled(this.settings.enableOutlineBridge);
    this.outline.start();

    this.vaultIndex = new VaultIndexService(this.app, this);
    this.vaultIndex.start();
    this.app.workspace.onLayoutReady(() => {
      void this.vaultIndex.initialize();
    });

    this.transclusionEngine = this.createTransclusionEngine();
    this.nodeNavigation = registerNodeNavigation({
      plugin: this,
      vaultIndex: this.vaultIndex,
    });

    this.registerView(VIEW_TYPE_ORG, (leaf) => new OrgView(leaf, this));

    try {
      this.registerExtensions(["org"], VIEW_TYPE_ORG);
    } catch (error) {
      console.error("Org Native: unable to register the .org extension", error);
      new Notice(this.t("notice.extensionConflict"));
    }

    this.addCommand({
      id: "toggle-reading-view",
      name: this.t("command.toggleReadingView"),
      checkCallback: (checking) => this.withView(checking, (v) => v.toggleMode()),
    });

    this.addCommand({
      id: "mode-reading",
      name: this.t("command.modeReading"),
      checkCallback: (checking) => this.withView(checking, (v) => v.setMode("reading")),
    });

    this.addCommand({
      id: "mode-live",
      name: this.t("command.modeLive"),
      checkCallback: (checking) => this.withView(checking, (v) => v.setMode("live")),
    });

    this.addCommand({
      id: "mode-source",
      name: this.t("command.modeSource"),
      checkCallback: (checking) => this.withView(checking, (v) => v.setMode("source")),
    });

    this.addCommand({
      id: "cycle-todo",
      name: this.t("command.cycleTodo"),
      checkCallback: (checking) => this.withView(checking, (v) => v.cycleTodo()),
    });

    this.addCommand({
      id: "toggle-fold",
      name: this.t("command.toggleFold"),
      checkCallback: (checking) =>
        this.withView(checking, (v) => {
          v.toggleFold();
        }),
    });

    this.addCommand({
      id: "cycle-fold",
      name: this.t("command.cycleFold"),
      checkCallback: (checking) =>
        this.withView(checking, (v) => {
          v.cycleFold();
        }),
    });

    this.addCommand({
      id: "fold-overview",
      name: this.t("command.foldOverview"),
      checkCallback: (checking) => this.withView(checking, (v) => v.foldLevel("overview")),
    });

    this.addCommand({
      id: "fold-content",
      name: this.t("command.foldContent"),
      checkCallback: (checking) => this.withView(checking, (v) => v.foldLevel("content")),
    });

    this.addCommand({
      id: "unfold-all",
      name: this.t("command.unfoldAll"),
      checkCallback: (checking) => this.withView(checking, (v) => v.foldLevel("all")),
    });

    this.addCommand({
      id: "show-diagnostics",
      name: this.t("command.showDiagnostics"),
      callback: () => this.vaultIndex.openDiagnosticsModal(),
    });

    this.addCommand({
      id: "rebuild-index",
      name: this.t("command.rebuildIndex"),
      callback: async () => {
        await this.vaultIndex.initialize();
        new Notice(this.t("notice.indexRebuilt"));
      },
    });

    this.addSettingTab(new OrgNativeSettingTab(this.app, this));

    void Promise.allSettled([
      loadMathJax(),
      loadPrism().then((instance) => setPrismInstance(instance as PrismLike)),
    ])
      .then(() => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ORG)) {
          if (leaf.view instanceof OrgView) leaf.view.refreshSettings();
        }
      })
      .catch((error) => console.warn("Org Native: unable to load MathJax/Prism", error));
  }

  onunload(): void {
    this.nodeNavigation?.dispose();
    this.vaultIndex?.dispose();
    this.outline?.destroy();
  }

  private createTransclusionEngine(): OrgTransclusionEngine {
    return new OrgTransclusionEngine(
      createVaultTransclusionProvider(this.app, this.vaultIndex.index),
      { defaultMaxDepth: this.settings.transclusionMaxDepth }
    );
  }

  private withView(checking: boolean, fn: (view: OrgView) => void): boolean {
    const view = this.app.workspace.getActiveViewOfType(OrgView);
    if (!view) return false;
    if (!checking) fn(view);
    return true;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<OrgNativeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(options: { refreshEditors?: boolean } = {}): Promise<void> {
    configureTodoKeywordExtras(this.settings.todoKeywords);
    this.outline?.setEnabled(this.settings.enableOutlineBridge);
    if (this.vaultIndex) {
      this.transclusionEngine = this.createTransclusionEngine();
    }
    await this.saveData(this.settings);
    this.refreshCommandNames();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ORG)) {
      if (!(leaf.view instanceof OrgView)) continue;
      if (options.refreshEditors === false) leaf.view.refreshLocale();
      else leaf.view.refreshSettings();
    }
  }

  private refreshCommandNames(): void {
    const commands = (
      this.app as unknown as {
        commands?: { commands?: Record<string, { name?: string }> };
      }
    ).commands?.commands;
    if (!commands) return;

    const names: Record<string, string> = {
      [`${PLUGIN_ID}:toggle-reading-view`]: this.t("command.toggleReadingView"),
      [`${PLUGIN_ID}:mode-reading`]: this.t("command.modeReading"),
      [`${PLUGIN_ID}:mode-live`]: this.t("command.modeLive"),
      [`${PLUGIN_ID}:mode-source`]: this.t("command.modeSource"),
      [`${PLUGIN_ID}:cycle-todo`]: this.t("command.cycleTodo"),
      [`${PLUGIN_ID}:toggle-fold`]: this.t("command.toggleFold"),
      [`${PLUGIN_ID}:cycle-fold`]: this.t("command.cycleFold"),
      [`${PLUGIN_ID}:fold-overview`]: this.t("command.foldOverview"),
      [`${PLUGIN_ID}:fold-content`]: this.t("command.foldContent"),
      [`${PLUGIN_ID}:unfold-all`]: this.t("command.unfoldAll"),
      [`${PLUGIN_ID}:show-diagnostics`]: this.t("command.showDiagnostics"),
      [`${PLUGIN_ID}:rebuild-index`]: this.t("command.rebuildIndex"),
      ...(this.nodeNavigation?.getCommandNames() ?? {}),
    };
    for (const [id, name] of Object.entries(names)) {
      const command = commands[id];
      if (command) command.name = name;
    }
  }
}

class OrgNativeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OrgNativePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: this.plugin.t("settings.heading") });
    containerEl.createEl("p", {
      text: this.plugin.t("settings.intro"),
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.language"))
      .setDesc(this.plugin.t("settings.languageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", this.plugin.t("settings.languageAuto"))
          .addOption("en", this.plugin.t("settings.languageEn"))
          .addOption("zh", this.plugin.t("settings.languageZh"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as LanguageSetting;
            await this.plugin.saveSettings({ refreshEditors: false });
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.defaultMode"))
      .setDesc(this.plugin.t("settings.defaultModeDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("reading", this.plugin.t("settings.modeReading"))
          .addOption("live", this.plugin.t("settings.modeLive"))
          .addOption("source", this.plugin.t("settings.modeSource"))
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultMode = value as OrgViewMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.todoKeywords"))
      .setDesc(this.plugin.t("settings.todoKeywordsDesc"))
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.t("settings.todoKeywordsPlaceholder"))
          .setValue(this.plugin.settings.todoKeywords)
          .onChange(async (value) => {
            this.plugin.settings.todoKeywords = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.propertiesDisplay"))
      .setDesc(this.plugin.t("settings.propertiesDisplayDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("collapsed", this.plugin.t("settings.propertiesCollapsed"))
          .addOption("expanded", this.plugin.t("settings.propertiesExpanded"))
          .addOption("hidden", this.plugin.t("settings.propertiesHidden"))
          .setValue(this.plugin.settings.propertiesDisplay)
          .onChange(async (value) => {
            this.plugin.settings.propertiesDisplay = value as PropertiesDisplayMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.renderTables"))
      .setDesc(this.plugin.t("settings.renderTablesDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.renderTables).onChange(async (value) => {
          this.plugin.settings.renderTables = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.renderMath"))
      .setDesc(this.plugin.t("settings.renderMathDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.renderMath).onChange(async (value) => {
          this.plugin.settings.renderMath = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.honorStartup"))
      .setDesc(this.plugin.t("settings.honorStartupDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.honorStartup).onChange(async (value) => {
          this.plugin.settings.honorStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.enableOutlineBridge"))
      .setDesc(this.plugin.t("settings.enableOutlineBridgeDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableOutlineBridge).onChange(async (value) => {
          this.plugin.settings.enableOutlineBridge = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.readingWidth"))
      .setDesc(this.plugin.t("settings.readingWidthDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("narrow", this.plugin.t("settings.widthNarrow"))
          .addOption("normal", this.plugin.t("settings.widthNormal"))
          .addOption("wide", this.plugin.t("settings.widthWide"))
          .setValue(this.plugin.settings.readingWidth)
          .onChange(async (value) => {
            this.plugin.settings.readingWidth = value as ReadingWidthMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.readingLineHeight"))
      .setDesc(this.plugin.t("settings.readingLineHeightDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("compact", this.plugin.t("settings.lineHeightCompact"))
          .addOption("comfortable", this.plugin.t("settings.lineHeightComfortable"))
          .addOption("relaxed", this.plugin.t("settings.lineHeightRelaxed"))
          .setValue(this.plugin.settings.readingLineHeight)
          .onChange(async (value) => {
            this.plugin.settings.readingLineHeight = value as ReadingLineHeightMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.readingFontScale"))
      .setDesc(this.plugin.t("settings.readingFontScaleDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(0.85, 1.25, 0.05)
          .setValue(this.plugin.settings.readingFontScale)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.readingFontScale = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.cjkTypography"))
      .setDesc(this.plugin.t("settings.cjkTypographyDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cjkTypography).onChange(async (value) => {
          this.plugin.settings.cjkTypography = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.enableTransclusion"))
      .setDesc(this.plugin.t("settings.enableTransclusionDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableTransclusion).onChange(async (value) => {
          this.plugin.settings.enableTransclusion = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t("settings.transclusionMaxDepth"))
      .setDesc(this.plugin.t("settings.transclusionMaxDepthDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setValue(this.plugin.settings.transclusionMaxDepth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.transclusionMaxDepth = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
