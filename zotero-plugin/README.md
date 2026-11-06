# 墨页 Zotero 桥接

插件向墨页提供 Zotero 当前选中的普通文献条目。墨页通过 Zotero 自带的本地 API 查询文献与导出 BibLaTeX。

## 构建与安装

用 PowerShell 运行 `./build.ps1 -OutDirectory <输出目录>`。在 Zotero 9.0 的“工具 → 插件”页面中，从齿轮菜单选择“从文件安装插件”，打开生成的 XPI。墨页使用本地 API 时需要在 Zotero“设置 → 高级”允许本机其他程序与 Zotero 通信。

插件图标使用 `packaging/MoTex.ico` 内的 32、48 和 64 像素 PNG，分别适配 100%、150% 和 200% 的显示缩放。

## 接口

向 `http://127.0.0.1:23119/moye-latex/v1/selection` 发送 GET 请求，带上 `X-MoyeLatex-Bridge: 1`。返回以下 JSON，其中 `groupID` 为 `null` 时表示个人文库。

```json
{
  "protocol": 1,
  "version": "0.1.3",
  "items": [{"key": "ABCD1234", "groupID": null}]
}
```

空选区返回空数组。请求需由桌面端发起，带 `Origin` 的请求会被拒绝。插件仅读取所选普通条目的文库和条目标识。

## 插件更新

Zotero 9 要求清单包含 HTTPS update_url。此版使用回环地址占位，通过发布的 XPI 手动更新。
