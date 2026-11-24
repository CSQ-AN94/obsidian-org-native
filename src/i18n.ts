import { getLanguage } from "obsidian";

export type LanguageSetting = "auto" | "en" | "zh";
export type UiLanguage = "en" | "zh";

const en = {
  "settings.heading": "Org Native Settings",
  "settings.intro": "Org as Source of Truth — configure reading, editing, folding, and Org ID behavior.",
  "settings.language": "Interface language",
  "settings.languageDesc": "Language used by settings, commands, and notices.",
  "settings.languageAuto": "Automatic (follow Obsidian)",
  "settings.languageEn": "English",
  "settings.languageZh": "中文",
  "settings.defaultMode": "Default view mode",
  "settings.defaultModeDesc": "Mode used when opening an .org file.",
  "settings.modeReading": "Reading view",
  "settings.modeLive": "Live preview",
  "settings.modeSource": "Source mode",
  "settings.todoKeywords": "Custom TODO keywords",
  "settings.todoKeywordsDesc":
    "Extra Org TODO keywords separated by |: active | done (e.g. TODO NEXT | DONE CANCELED). File-level #+TODO: declarations are also supported.",
  "settings.todoKeywordsPlaceholder": "e.g. 待办 进行中 | 完成 取消",
  "settings.renderTables": "Render tables",
  "settings.renderTablesDesc": "Render Org tables in Reading View and Live Preview.",
  "settings.renderMath": "Render math",
  "settings.renderMathDesc": "Typeset Org and LaTeX math fragments via Obsidian MathJax.",
  "settings.propertiesDisplay": "Property drawer display",
  "settings.propertiesDisplayDesc":
    "Collapsed (default) keeps :PROPERTIES: hidden behind a toggle with raw source inspectable.",
  "settings.propertiesCollapsed": "Collapsed (inspectable)",
  "settings.propertiesExpanded": "Expanded",
  "settings.propertiesHidden": "Hidden",
  "settings.honorStartup": "Honor #+STARTUP directives",
  "settings.honorStartupDesc": "Apply #+STARTUP: overview or content folding automatically when opening a file.",
  "settings.enableOutlineBridge": "Integrate with Core Outline",
  "settings.enableOutlineBridgeDesc":
    "Show Org headings in Obsidian's Outline pane (uses guarded internal Outline methods).",
  "settings.readingWidth": "Reading column width",
  "settings.readingWidthDesc": "Maximum content measure in Reading View.",
  "settings.widthNarrow": "Narrow",
  "settings.widthNormal": "Normal",
  "settings.widthWide": "Wide",
  "settings.readingLineHeight": "Reading line height",
  "settings.readingLineHeightDesc": "Vertical rhythm in Reading View, especially for long prose.",
  "settings.lineHeightCompact": "Compact",
  "settings.lineHeightComfortable": "Comfortable",
  "settings.lineHeightRelaxed": "Relaxed",
  "settings.readingFontScale": "Reading font scale",
  "settings.readingFontScaleDesc": "Scale multiplier for Reading View body text (0.85 to 1.25).",
  "settings.cjkTypography": "Optimize CJK + Latin typography",
  "settings.cjkTypographyDesc": "Enable balanced line-breaking and spacing for mixed Chinese and English text.",
  "settings.enableTransclusion": "Render #+transclude directives",
  "settings.enableTransclusionDesc": "Expand read-only #+transclude: nodes in Reading View without modifying source files.",
  "settings.transclusionMaxDepth": "Max transclusion nesting depth",
  "settings.transclusionMaxDepthDesc": "Maximum recursion depth for nested #+transclude: expansions (1 to 8).",

  "action.readingView": "Reading view",
  "action.livePreview": "Live preview",
  "action.sourceMode": "Source mode",

  "command.toggleReadingView": "Toggle reading / editing view",
  "command.modeReading": "Switch to Reading view",
  "command.modeLive": "Switch to Live preview",
  "command.modeSource": "Switch to Source mode",
  "command.cycleTodo": "Cycle TODO state",
  "command.toggleFold": "Toggle fold at cursor",
  "command.cycleFold": "Cycle document folding (all / overview / content)",
  "command.foldOverview": "Fold all headings (Overview)",
  "command.foldContent": "Show headings only (Contents)",
  "command.unfoldAll": "Unfold all headings",
  "command.showDiagnostics": "Show Org ID diagnostics",
  "command.rebuildIndex": "Rebuild Org ID index",
  "command.openBacklinks": "Open Org backlinks panel",
  "command.quickOpenNode": "Quick open Org node by ID or title",

  "backlinks.title": "Org Backlinks",
  "backlinks.empty": "No incoming Org ID backlinks or transclusions point to nodes in this file.",
  "backlinks.noActiveOrg": "Open an .org note to inspect incoming Org node backlinks.",
  "backlinks.incomingCount": "Incoming references",
  "switcher.placeholder": "Search Org nodes by title, heading path, file, :ID:, or :CUSTOM_ID:...",
  "switcher.empty": "No matching Org ID nodes indexed in vault.",

  "transclusion.readOnlyBadge": "Read-only",
  "transclusion.openSource": "Open source node",
  "transclusion.unsupportedParams": "Unsupported options",
  "transclusion.errorMissing": "Transclusion target not found",
  "transclusion.errorCycle": "Circular transclusion blocked",
  "transclusion.errorDepth": "Transclusion nesting/budget limit exceeded",
  "transclusion.errorSecurity": "Transclusion target blocked for security",
  "transclusion.errorUnsupported": "Unsupported transclusion target",

  "notice.extensionConflict":
    "Org Native could not register .org files. Disable any conflicting .org plugin (e.g. Org Live or Orgmode cm6) and reload.",
  "notice.idNotFound": "Org ID not found in vault: ",
  "notice.idDuplicate": "Duplicate Org ID found in multiple locations; jumping to first match: ",
  "notice.customIdNotFound": "Org CUSTOM_ID not found: ",
  "notice.indexRebuilt": "Org ID index rebuilt.",

  "conflict.title": "External disk change detected",
  "conflict.desc":
    "This file changed on disk (e.g. saved in Emacs) while you have unsaved edits in Obsidian. Auto-save is paused to prevent data loss.",
  "conflict.reloadDisk": "Reload from disk",
  "conflict.keepLocal": "Keep local & save",
  "conflict.saveCopy": "Save local conflict copy",

  "diagnostics.title": "Org ID Index Diagnostics",
  "diagnostics.summaryPrefix": "Indexed files: ",
  "diagnostics.nodesLabel": "Nodes with ID/CUSTOM_ID: ",
  "diagnostics.duplicatesHeading": "Duplicate :ID: entries",
  "diagnostics.brokenHeading": "Broken [[id:...]] links",
  "diagnostics.none": "No duplicate IDs or broken [[id:...]] links found.",
  "diagnostics.missingTarget": "Missing ID: ",
} as const;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, string> = {
  "settings.heading": "Org Native 设置",
  "settings.intro": "以原始 .org 文件为唯一权威源 — 配置阅读、编辑、折叠与 Org ID 导航行为。",
  "settings.language": "界面语言",
  "settings.languageDesc": "设置页、命令与提示信息使用的语言。",
  "settings.languageAuto": "自动（跟随 Obsidian）",
  "settings.languageEn": "English",
  "settings.languageZh": "中文",
  "settings.defaultMode": "默认打开视图",
  "settings.defaultModeDesc": "打开 .org 文件时默认使用的显示模式。",
  "settings.modeReading": "阅读视图 (Reading)",
  "settings.modeLive": "实时预览 (Live Preview)",
  "settings.modeSource": "源码模式 (Source)",
  "settings.todoKeywords": "自定义 TODO 关键字",
  "settings.todoKeywordsDesc":
    "额外的 Org TODO 关键字，用 | 分隔进行中与已完成（例如：TODO NEXT | DONE CANCELED）。也支持文件级 #+TODO: 声明。",
  "settings.todoKeywordsPlaceholder": "例如：待办 进行中 | 完成 取消",
  "settings.renderTables": "渲染表格",
  "settings.renderTablesDesc": "在阅读视图与实时预览中渲染 Org 表格。",
  "settings.renderMath": "渲染数学公式",
  "settings.renderMathDesc": "使用 Obsidian 内置 MathJax 渲染行内与块级公式。",
  "settings.propertiesDisplay": "Property Drawer 显示方式",
  "settings.propertiesDisplayDesc":
    "默认折叠可保持阅读清爽，同时支持点击展开查看原始 :PROPERTIES: 内容。",
  "settings.propertiesCollapsed": "默认折叠（可展开查看原文）",
  "settings.propertiesExpanded": "默认展开",
  "settings.propertiesHidden": "隐藏",
  "settings.honorStartup": "遵循 #+STARTUP 折叠指令",
  "settings.honorStartupDesc": "打开文件时自动应用 #+STARTUP: overview 或 content。",
  "settings.enableOutlineBridge": "集成核心大纲面板 (Outline)",
  "settings.enableOutlineBridgeDesc":
    "在 Obsidian 大纲面板中显示 Org 标题（通过受保护的内部接口实现，可随时关闭）。",
  "settings.readingWidth": "阅读栏宽",
  "settings.readingWidthDesc": "控制阅读视图正文区域的最大排版宽度。",
  "settings.widthNarrow": "紧凑 (Narrow)",
  "settings.widthNormal": "标准 (Normal)",
  "settings.widthWide": "宽松 (Wide)",
  "settings.readingLineHeight": "阅读行距",
  "settings.readingLineHeightDesc": "调整阅读视图的垂直节奏与行高。",
  "settings.lineHeightCompact": "紧凑",
  "settings.lineHeightComfortable": "舒适",
  "settings.lineHeightRelaxed": "宽松",
  "settings.readingFontScale": "阅读字号缩放",
  "settings.readingFontScaleDesc": "阅读视图正文字号缩放比例（0.85 至 1.25）。",
  "settings.cjkTypography": "优化中英文混排",
  "settings.cjkTypographyDesc": "优化中文与英文/代码混排时的换行规则与段落间距。",
  "settings.enableTransclusion": "展开 #+transclude 引用内容",
  "settings.enableTransclusionDesc": "在阅读视图中以只读方式展开 #+transclude: 节点，绝不修改源文件。",
  "settings.transclusionMaxDepth": "Transclusion 最大嵌套深度",
  "settings.transclusionMaxDepthDesc": "限制嵌套引用的最大递归层数（1 至 8）。",

  "action.readingView": "阅读视图",
  "action.livePreview": "实时预览",
  "action.sourceMode": "源码模式",

  "command.toggleReadingView": "切换阅读 / 编辑视图",
  "command.modeReading": "切换到阅读视图",
  "command.modeLive": "切换到实时预览",
  "command.modeSource": "切换到源码模式",
  "command.cycleTodo": "循环切换 TODO 状态",
  "command.toggleFold": "折叠或展开当前标题/块",
  "command.cycleFold": "循环切换全篇折叠状态（全部 / 概览 / 仅标题）",
  "command.foldOverview": "全部折叠（仅顶层标题）",
  "command.foldContent": "仅显示各级标题",
  "command.unfoldAll": "全部展开",
  "command.showDiagnostics": "查看 Org ID 诊断面板",
  "command.rebuildIndex": "重建 Org ID 索引",
  "command.openBacklinks": "打开 Org 反向链接侧栏",
  "command.quickOpenNode": "快速搜索并打开 Org 节点",

  "backlinks.title": "Org 反向链接",
  "backlinks.empty": "当前文件中没有来自其他位置的 Org ID 引用或 Transclusion。",
  "backlinks.noActiveOrg": "请打开一个 .org 文档以查看节点反向链接。",
  "backlinks.incomingCount": "反向引用",
  "switcher.placeholder": "按标题、标题路径、文件名、:ID: 或 :CUSTOM_ID: 搜索 Org 节点...",
  "switcher.empty": "Vault 中尚未索引到匹配该搜索词的 Org ID 节点。",

  "transclusion.readOnlyBadge": "只读引用",
  "transclusion.openSource": "打开源节点",
  "transclusion.unsupportedParams": "未支持参数",
  "transclusion.errorMissing": "未找到 Transclusion 目标",
  "transclusion.errorCycle": "已阻止循环引用",
  "transclusion.errorDepth": "超出 Transclusion 最大嵌套深度或配额",
  "transclusion.errorSecurity": "Transclusion 目标路径因安全限制被拦截",
  "transclusion.errorUnsupported": "不支持的 Transclusion 目标格式",

  "notice.extensionConflict":
    "Org Native 无法注册 .org 扩展名。请先停用其他占用 .org 的插件（如 Org Live 或 Orgmode cm6）后重启。",
  "notice.idNotFound": "未在当前 Vault 中找到该 Org ID：",
  "notice.idDuplicate": "检测到重复的 Org ID，已跳转到第一个匹配位置：",
  "notice.customIdNotFound": "未找到对应的 CUSTOM_ID：",
  "notice.indexRebuilt": "Org ID 索引已重建。",

  "conflict.title": "检测到磁盘上的外部修改",
  "conflict.desc":
    "文件在磁盘上被外部程序（如 Emacs）修改，同时你在 Obsidian 中有未保存的更改。已暂停自动保存以避免静默覆盖。",
  "conflict.reloadDisk": "放弃本地更改并重载磁盘版本",
  "conflict.keepLocal": "保留本地更改并覆盖保存",
  "conflict.saveCopy": "保存本地冲突副本后重载磁盘版本",

  "diagnostics.title": "Org ID 索引诊断",
  "diagnostics.summaryPrefix": "已索引文件数：",
  "diagnostics.nodesLabel": "含 ID/CUSTOM_ID 节点数：",
  "diagnostics.duplicatesHeading": "重复的 :ID: 定义",
  "diagnostics.brokenHeading": "失效的 [[id:...]] 链接",
  "diagnostics.none": "未发现重复 ID 或失效的 [[id:...]] 链接。",
  "diagnostics.missingTarget": "缺失目标 ID：",
};

export function resolveLanguage(setting: LanguageSetting): UiLanguage {
  if (setting !== "auto") return setting;
  try {
    const current = (getLanguage as (() => string) | undefined)?.() ?? "";
    if (current.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    // Fallback when getLanguage is unavailable.
  }
  return "en";
}

export function translate(language: UiLanguage, key: TranslationKey): string {
  return language === "zh" ? zh[key] : en[key];
}
