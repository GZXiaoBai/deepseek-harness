/** Review panel dictionary namespace. */

export const zh = {
  'panel.title': '审查台',
  'panel.tabs.files': '文件',
  'panel.tabs.history': '历史',
  'panel.tabs.vcs': 'Git',
  'panel.files.empty': '工作区为空',
  'panel.files.preview': '预览',
  'panel.files.previewClose': '关闭预览',
  'panel.files.previewError': '无法预览该文件',
  'panel.history.empty': '会话中还没有消息',
  'panel.vcs.empty': '工作区没有未提交变更',
  'panel.vcs.diff': '差异',
  'panel.vcs.error': '无法读取 Git 状态',
  'panel.footer.open': '审查台',
}

/** Dictionary keys of the review panel namespace. */
export type DevPanelKey = keyof typeof zh

/** English dictionary of the review panel namespace. */
export const en: Record<DevPanelKey, string> = {
  'panel.title': 'Review Panel',
  'panel.tabs.files': 'Files',
  'panel.tabs.history': 'History',
  'panel.tabs.vcs': 'Git',
  'panel.files.empty': 'Workspace is empty',
  'panel.files.preview': 'Preview',
  'panel.files.previewClose': 'Close preview',
  'panel.files.previewError': 'This file cannot be previewed',
  'panel.history.empty': 'No messages in this session yet',
  'panel.vcs.empty': 'No uncommitted changes in the workspace',
  'panel.vcs.diff': 'Diff',
  'panel.vcs.error': 'Could not read Git status',
  'panel.footer.open': 'Review Panel',
}
