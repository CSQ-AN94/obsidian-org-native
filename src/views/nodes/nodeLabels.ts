import type { UiLanguage } from "../../i18n";

const EN_LABELS = {
  "hover.readOnly": "Read-only",
  "hover.openSource": "Open source node",
  "hover.missingTitle": "Org ID not found",
  "hover.missingHint":
    "No indexed heading or file node defines this :ID:. It may have been removed or not yet indexed.",
  "hover.duplicateTitle": "Duplicate :ID:",
  "hover.duplicateHint": "Multiple nodes define the same :ID:. Select a target to open:",
  "hover.fileMissing": "Target file could not be read from vault.",
  "hover.noExcerpt": "No body content in this node.",
  "hover.loading": "Loading node preview…",

  "backlinks.filterPlaceholder": "Filter backlinks by file, heading, ID, or excerpt…",
  "backlinks.toggleFilter": "Filter references",
  "backlinks.collapseAll": "Collapse all groups",
  "backlinks.expandAll": "Expand all groups",
  "backlinks.showContext": "Show context",
  "backlinks.hideContext": "Hide context",
  "backlinks.showIssues": "Open ID diagnostics",
  "backlinks.noMatches": "No backlinks match the current filter.",
  "backlinks.duplicateWarning": "Duplicate ID conflict — also defined at:",
  "backlinks.issuesHeading": "Outgoing ID Link Issues",
  "backlinks.issueBroken": "Broken ID",
  "backlinks.issueDuplicate": "Duplicate ID",
  "backlinks.issueInvalid": "Invalid [[id:]]",
  "backlinks.sourceRoot": "(Document preamble)",
  "backlinks.emptyIdTarget": "(empty ID)",

  "switcher.duplicateBadge": "Duplicate ID",
  "switcher.fileLevel": "File",

  "diagnostics.refreshOutdated": "Refresh Outdated",
  "diagnostics.rebuildAll": "Rebuild Full Index",
  "diagnostics.statusFresh": "Index up to date",
  "diagnostics.statusOutdated": "Index outdated",
  "diagnostics.outdatedHeading": "Index Outdated",
  "diagnostics.notFoundHeading": "Node Not Found",
  "diagnostics.invalidHeading": "Invalid Empty [[id:]] Links",
  "diagnostics.reasonUnindexed": "Not yet indexed",
  "diagnostics.reasonDeleted": "Removed from vault",
  "diagnostics.reasonModified": "Modified since last index",
  "diagnostics.reasonStale": "Marked stale",
  "diagnostics.reasonPending": "Pending incremental update",
  "diagnostics.reasonIdNotIndexed": "ID not in index",
  "diagnostics.reasonFileMissing": "Backing file missing",
  "diagnostics.reasonNodeMissingAtLoc": "Node missing at target location",
  "diagnostics.indexUninitialized": "Vault index has not completed initial indexing yet.",
} as const;

export type NodeLabelKey = keyof typeof EN_LABELS;

const ZH_LABELS: Record<NodeLabelKey, string> = {
  "hover.readOnly": "只读预览",
  "hover.openSource": "打开源节点",
  "hover.missingTitle": "未找到 Org ID",
  "hover.missingHint": "当前索引中不存在定义该 :ID: 的节点，可能已被删除或尚未建立索引。",
  "hover.duplicateTitle": "检测到重复的 Org ID",
  "hover.duplicateHint": "多个节点定义了相同的 :ID:，请选择要打开的目标：",
  "hover.fileMissing": "无法从 Vault 读取目标文件。",
  "hover.noExcerpt": "该节点暂无正文内容。",
  "hover.loading": "正在加载节点预览…",

  "backlinks.filterPlaceholder": "按文件、标题路径、ID 或摘要过滤反向链接…",
  "backlinks.toggleFilter": "过滤引用",
  "backlinks.collapseAll": "折叠全部分组",
  "backlinks.expandAll": "展开全部分组",
  "backlinks.showContext": "显示上下文",
  "backlinks.hideContext": "隐藏上下文",
  "backlinks.showIssues": "打开 ID 诊断",
  "backlinks.noMatches": "没有符合当前过滤条件的反向链接。",
  "backlinks.duplicateWarning": "重复 ID 冲突 — 同名定义还存在于：",
  "backlinks.issuesHeading": "当前文件中的异常 ID 链接",
  "backlinks.issueBroken": "失效 ID",
  "backlinks.issueDuplicate": "重复 ID",
  "backlinks.issueInvalid": "无效 [[id:]]",
  "backlinks.sourceRoot": "（文档导言区）",
  "backlinks.emptyIdTarget": "（空 ID）",

  "switcher.duplicateBadge": "重复 ID",
  "switcher.fileLevel": "文件",

  "diagnostics.refreshOutdated": "增量刷新过期文件",
  "diagnostics.rebuildAll": "重建全量索引",
  "diagnostics.statusFresh": "索引最新",
  "diagnostics.statusOutdated": "索引过期",
  "diagnostics.outdatedHeading": "索引过期 / 未同步文件 (Index Outdated)",
  "diagnostics.notFoundHeading": "未找到节点记录 (Node Not Found)",
  "diagnostics.invalidHeading": "无效的空 [[id:]] 链接",
  "diagnostics.reasonUnindexed": "尚未索引",
  "diagnostics.reasonDeleted": "文件已从 Vault 移除",
  "diagnostics.reasonModified": "磁盘文件已修改",
  "diagnostics.reasonStale": "已标记为过期",
  "diagnostics.reasonPending": "等待增量更新",
  "diagnostics.reasonIdNotIndexed": "索引中不存在该 ID",
  "diagnostics.reasonFileMissing": "源文件不存在",
  "diagnostics.reasonNodeMissingAtLoc": "目标位置未找到节点",
  "diagnostics.indexUninitialized": "全量 Vault 索引尚未完成初始化。",
};

export function nodeLabel(language: UiLanguage, key: NodeLabelKey): string {
  return language === "zh" ? ZH_LABELS[key] : EN_LABELS[key];
}
