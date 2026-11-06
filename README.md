# 墨页 MoTex

墨页 MoTex 是 Windows 上的科研写作工作台。正文按章节编写，使用本机 TeX Live 生成 PDF。内置 ElegantNote 笔记模板和 XJTU-thesis 1.2.7，后者默认博士。

## 安装

从 [Releases](https://github.com/ccl4-56-23-5/MoTex/releases) 下载 Windows x64 ZIP，解压后运行安装程序。TeX Live 镜像下载脚本随 ZIP 提供，也可以继续使用本机已有的 TeX Live。启动后在「偏好设置」选择含 xelatex.exe 和 biber.exe 的 bin 目录。

在 D:\program 已存在的系统上，首次安装默认使用 D:\program\墨页。升级沿用实际安装目录。

    墨页\
      Moye.exe
      programdata\
      template\
      工程\
        文档名\
          project.moye
          source\
          正文.pdf

编辑内容自动保存。成功编译后更新 LaTeX 源码和 PDF。编译失败时保留上次成功的 PDF。

## 写作

- 右键插入章节。章内用 # 写一级小节，自动编号为 1.1、2.1 等。
- 输入一个 $ 会自动补齐闭合符号。按 Alt+= 也可插入公式，再按回车转为独立公式。
- 左侧行号对应编译日志中的正文行号。编辑区的插图以题注卡片显示。
- 工作区的「附件」按章节显示图片缩略图。删除时移除工程内的图片数据、正文引用和相应的生成文件。
- 右键引用或按 Ctrl+Shift+C，按 Zotero 个人或群组文库的集合层级浏览。可在当前分类搜索。引用快照随工程保存。
- 西交模板的封面信息可在模板菜单填写。两套模板的来源、许可和适配说明见 template。

## 构建

需要 Node.js 24、pnpm 11 和 Inno Setup。运行以下命令启动开发版。

    pnpm install --frozen-lockfile
    pnpm prepare:pdfjs
    pnpm prepare:editor
    pnpm start

从 zotero-plugin 目录构建 XPI，构建安装程序和发行 ZIP 的入口见 [packaging](packaging/README.md)。测试包括公式与编译、Zotero 集合分页和编辑器交互。

程序源码和资源随仓库提供。各第三方组件遵循随附的许可文件。
