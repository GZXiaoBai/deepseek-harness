/** Review panel dictionary namespace. */

export interface DevPanelKey {
  'panel.title': string
  'panel.tabs.files': string
  'panel.tabs.history': string
  'panel.tabs.vcs': string
  'panel.files.empty': string
  'panel.files.preview': string
  'panel.files.previewClose': string
  'panel.files.previewError': string
  'panel.history.empty': string
  'panel.vcs.empty': string
  'panel.vcs.diff': string
  'panel.vcs.error': string
  'panel.footer.open': string
}

export const zh: DevPanelKey = {
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

export const en: DevPanelKey = {
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
