# Lenny's Newsletter Exporter

一个用于导出 [Lenny's Newsletter](https://www.lennysnewsletter.com/) 文章到 Markdown 格式的油猴脚本。

## ✨ 功能特性

- 🚀 **并发抓取**：支持 1-12 并发，快速导出大量文章
- 📦 **两种导出模式**：
  - **Batch 模式**：多篇文章合并成单个 `.md` 文件，分批下载
  - **ZIP 模式**：每篇文章单独一个 `.md` 文件，打包成 ZIP 下载
- 🔄 **智能重试**：自动处理 429/5xx 错误，支持指数退避和 Retry-After
- 💾 **设置持久化**：配置自动保存，下次使用无需重新设置
- 📊 **实时进度**：显示抓取进度、当前文件、已用时间等

## 📥 安装

### 前置要求

- 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 扩展

### 安装步骤

1. 打开 Tampermonkey 扩展
2. 点击「添加新脚本」
3. 将 `jiaoben.txt` 中的代码复制粘贴进去
4. 保存脚本（Ctrl+S）

## 🚀 使用方法

1. 登录 [Lenny's Newsletter](https://www.lennysnewsletter.com/)（需要订阅账号）
2. 访问 [Archive 页面](https://www.lennysnewsletter.com/archive)
3. 点击页面右下角的 **「Export Markdown」** 按钮
4. 在弹出的设置面板中配置导出选项
5. 等待导出完成，文件会自动下载

## ⚙️ 配置选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| **模式** | Batch（合并）或 ZIP（打包） | Batch |
| **并发** | 同时抓取的文章数（1-12） | 6 |
| **重试次数** | 遇到 429/5xx 错误时的重试次数 | 5 |
| **退避基数** | 重试间隔的基础毫秒数 | 500ms |
| **Batch 篇数** | Batch 模式下每个文件包含的文章数 | 20 |

### 模式说明

#### Batch 模式
- 每 N 篇文章合并成一个 `.md` 文件
- 适合想要快速阅读或搜索的用户
- 输出文件：`lennysnewsletter_export_part_001.md`, `part_002.md`, ...

#### ZIP 模式
- 每篇文章单独一个 `.md` 文件，以文章标题命名
- 所有文件打包成一个 ZIP
- 适合想要分类整理的用户
- 输出文件：`lennysnewsletter_export.zip`

## 📝 输出格式

每篇文章的 Markdown 格式如下：

```markdown
# 文章标题

> 副标题/描述

- 日期：2024-01-15T12:00:00.000Z
- 作者：Lenny Rachitsky
- 链接：https://www.lennysnewsletter.com/p/article-slug

（正文内容...）

---
```

### 支持的内容

- ✅ 标题、副标题
- ✅ 发布日期、作者
- ✅ 正文文本、列表、引用
- ✅ 图片（保留原始 URL）
- ✅ 表格（GFM 格式）
- ✅ 代码块
- ✅ 嵌入内容（转为链接）

## 🔧 技术细节

### 依赖库

- [Turndown](https://github.com/mixmark-io/turndown) - HTML 转 Markdown
- [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) - GFM 扩展（表格、删除线等）

### ZIP 生成

使用纯 JavaScript 手动构建 ZIP 文件格式（STORE 模式，无压缩），避免了 JSZip 在油猴脚本环境下的兼容性问题。

### 文件名处理

- 自动清理 Windows/macOS/Linux 不允许的字符
- 处理 Windows 保留名称（CON, PRN, NUL 等）
- 文件名长度限制 140 字符
- 重复标题自动添加序号

## ⚠️ 注意事项

1. **需要订阅账号**：只能导出你有权限访问的文章
2. **并发建议**：建议从 4-6 开始，过高可能触发 429 限流
3. **网络问题**：脚本会自动重试，但如果持续失败请检查网络
4. **ZIP 文件大小**：ZIP 使用无压缩模式，文件较大但生成速度快

## 📜 许可证

MIT License

## 🙏 致谢

- [Lenny's Newsletter](https://www.lennysnewsletter.com/) - 优质的产品管理内容
- [Tampermonkey](https://www.tampermonkey.net/) - 强大的用户脚本管理器

