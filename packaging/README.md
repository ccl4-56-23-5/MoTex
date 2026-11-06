# 墨页（MoTex）Windows 打包

构建需要 Node.js 24、pnpm 和 Inno Setup。构建脚本优先使用工作区的 Inno Setup 6.7.4，再检查系统常用安装目录及 PATH。可以用 `-IsccPath` 指定编译器。

在版本源码目录运行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:pdfjs
pnpm prepare:editor
pnpm start
```

独立克隆默认使用仓库根目录的 `dist`，工作区版本源码沿用对应的 `output` 目录。在仓库根目录打开 PowerShell，生成 Zotero 插件并将其作为安装器的构建输入。

```powershell
$plugin = .\zotero-plugin\build.ps1 -OutDirectory .\dist\zotero
.\packaging\build.ps1 -ZoteroXpi $plugin.FullName
```

可用 `-OutputDir` 指定安装器输出目录。Electron 和预览资源随程序交付，TeX 由用户在应用设置中指定。安装目录的 `resources\zotero\Moye-Zotero.xpi` 可用于补装插件，`resources\texlive\Get-TeXLiveIso.ps1` 可按需下载官方 TeX Live ISO。

安装为当前用户注册。首次安装在 `D:\program` 存在时默认选择 `D:\program\墨页`，其他情况下默认选择 `%LOCALAPPDATA%\Programs\墨页`。同一 AppId 的覆盖安装沿用实际安装路径。

安装目录中的 `programdata` 保存设置和草稿，`工程` 保存工程，`template` 随包提供默认模板。安装器会在缺少目标文件时复制 `%APPDATA%\Moye` 中的 `settings.json` 和 `draft.json`。覆盖安装补齐缺失的默认模板，卸载时保留用户数据和模板。

可在尚未安装墨页的 Windows 用户下运行 `packaging/verify-installer.ps1`，传入安装包、构建用 XPI 和日志目录。脚本检查首次安装、从测试用前版覆盖到自选目录及自动卸载，并记录安装包、XPI 与 TeX Live 下载脚本的摘要。

安装包验证后，GitHub Release 直接上传 `MoTex-<版本>-Setup-x64.exe`，在发布说明中填写构建输出的 SHA-256。发布后重新下载 EXE 并核对摘要。

`MoTex.ico` 用于程序与安装器。安装器的简体中文文本来自 [Kira 的 Inno Setup 翻译](https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation/tree/1ff90acc4ed4aee82b1cda43253243deee3daed4)，许可随 `ChineseSimplified.LICENSE` 保存。
