# 西安交通大学硕博学位论文模板

此目录的 XJTU-thesis.cls 和 LICENSE 来自作者发布的 [XJTU-thesis 1.2.7](https://github.com/obster-y/XJTU-thesis/releases/tag/1.2.7)。该发行版对应 2021 年版学位论文要求。下载 ZIP 的 SHA-256 为 c85c14d4a8da61be9bef616914b830ef8a6549fed308716452b4b1d98ddb1e1a。类文件内部版本标识为 1.2.4，类文件及 LPPL 1.3c 许可证均按发布包原字节复制。

moye-template.tex 是墨页独立入口，默认使用 doctor 与 Doctor of Philosophy。使用类文件提供的中英文题名页、中文目录、页眉、原生章节布局和 GB/T 7714—2015 参考文献排版。英文姓名、导师与学科随当前项目字段显示，可在导出的 LaTeX 源码中另填英文值。提交年月使用项目中填写的日期，未填时采用本机编译日期。入口在旧类把目录命令改成无参数宏时恢复其原有参数签名，以兼容新版 hyperref 的书签钩子。

随包分发的模板组件是类文件及许可证。题名页默认用普通文字写学校名称，如已有获准使用的校名图形，可在项目中添加 Materials/Icons/XJTU.pdf，由类文件载入。此模板在 Windows 依赖本机宋体、黑体、楷体及 Times New Roman，使用 XeLaTeX 和 Biber。

正式论文应以研究生院公布的当前版为准。学校在 2025 年另行发布了 1.2.8，本集成适用的是上述 1.2.7。[研究生院 2025 年模板更新通知](https://gs.xjtu.edu.cn/info/1209/11370.htm)
