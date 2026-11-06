# 墨页（MoTex）{{version}} · Windows x64

1. 解压此 ZIP，运行 `{{installer}}`。首次安装在 `D:\program` 存在时默认选择 `D:\program\墨页`，覆盖安装沿用原目录。
2. 如需从 Zotero 发送文献，在 Zotero 的「工具 → 插件」中选择「从文件安装插件」，打开 `{{zotero}}`。启用插件后，在墨页中选择 Zotero 文献入口。
3. 已有 TeX Live 时，在墨页设置中选择含 `xelatex.exe` 的目录，通常是 TeX Live 安装目录下的 `bin\windows`。

## 下载 TeX Live ISO

需要离线安装介质时，在解压目录打开 PowerShell，运行下载脚本。默认下载 TeX Live 2026 官方发行 ISO，大小约 6.8 GB，保存到用户目录下的 `Downloads\TeXLive`。脚本使用 HTTPS、支持断点续传，并在 SHA-512 校验通过后生成最终 ISO 文件。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Get-TeXLiveIso.ps1
```

可用 `-Destination "D:\Downloads\TeXLive"` 指定保存目录。`-DryRun` 显示下载计划，`-CheckOnly` 访问官方摘要、签名文件和 ISO 响应头。

拿到 ISO 后，在资源管理器中装载它，运行虚拟光驱根目录下的 `install-tl-windows.bat`，然后回墨页设置选择 `bin\windows`。适合在线安装的轻量引导器也可从 TUG 获取。[离线镜像](https://tug.org/texlive/acquire-iso.html) · [在线安装](https://tug.org/texlive/acquire-netinstall.html)

CTAN 发布了 ISO 摘要对应的 GPG 签名。需要独立验证签名时，按 TUG 说明获取其签名密钥并验证 `.sha512.asc`。[TUG 验签说明](https://tug.org/texlive/verify.html) · [官方 SHA-512 签名](https://tug.ctan.org/systems/texlive/Images/texlive2026-20260301.iso.sha512.asc)

`SHA256SUMS.txt` 列出了此 ZIP 内各交付文件的 SHA-256。
