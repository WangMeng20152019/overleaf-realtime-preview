# Overleaf Realtime Preview (`0.1.0-alpha.2`)

感谢 realtime-tex 的作者 **[@HenryXiaoYang](https://github.com/HenryXiaoYang)** 及所有贡献者, 他们的卓越工作和开源贡献让 LaTeX 实时预览变得简单易用. 我们尝试将他们的开源项目 [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex) 融合进 [Overleaf 社区版](https://github.com/overleaf/overleaf), 并部署在运行 Linux 的 x86 NAS 上, 实现了 Overleaf CE 中支持中英文的 LaTeX 实时预览.

We thank **[@HenryXiaoYang](https://github.com/HenryXiaoYang)**, the author of realtime-tex, and all its contributors, whose outstanding work and open-source contributions have made real-time LaTeX preview simple and accessible. We integrated their open-source project [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex) into [Overleaf Community Edition](https://github.com/overleaf/overleaf) and deployed it on an x86 NAS running Linux, bringing real-time LaTeX preview for both Chinese and English documents to Overleaf CE.

同时也感谢 [Overleaf](https://github.com/overleaf/overleaf) 与 [realtime-tex-vsc-plugin](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin) 的作者和贡献者. 本项目所用的核心排版引擎与渲染基础来自这些开源项目, 相关署名和许可均已保留.

We also thank the authors and contributors of [Overleaf](https://github.com/overleaf/overleaf) and [realtime-tex-vsc-plugin](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin). The core typesetting engine and rendering foundations used in this project come from these open-source projects, and their original credits and licenses are preserved.

## 开发经过 / Development

本项目的代码编写与调试主要借助 GPT (ChatGPT/Codex) 完成. 在实际使用过程中, 尤其是处理篇幅较大的中文论文项目时, 我们遇到了新段落迟迟不显示, 文字出现后又消失, 已删除内容重新出现, 公式输入卡顿等问题, 并为此投入了大量时间进行排查和调试.

Most of the coding and debugging was carried out with GPT (ChatGPT/Codex). In real-world use, especially on larger Chinese thesis projects, we ran into issues such as new paragraphs taking too long to appear, text appearing and then disappearing, deleted content returning, and lag during formula updates, and spent considerable time investigating and fixing them.

本项目建立在上游开源工作的基础上, 相关的集成代码, 补丁和部署工具也一并开源. 当前版本已支持基本的中英文实时预览, 但在复杂排版, 定位和使用兼容性方面仍有待完善. 欢迎试用并反馈问题, 也欢迎参与改进.

This project builds on upstream open-source work, and its integration code, patches, and deployment tools are also open source. The current version supports basic real-time preview for Chinese and English, though complex layouts, navigation, and compatibility still need refinement. Trial use, bug reports, suggestions, and contributions are welcome.

![Overleaf Realtime Preview Demo (Synthetic Document)](docs/images/preview.png)

*演示使用合成文档. / The demo uses a synthetic document.*

## 安装部署 / Installation

请在自部署的 Overleaf CE 环境中安装. 宿主机需具备 Docker Compose v2, Node.js 24 与 npm, Python 3, Git 和 rustup. 先下载源码并进入项目目录:

Install this integration in a self-hosted Overleaf CE environment. The host machine requires Docker Compose v2, Node.js 24 and npm, Python 3, Git, and rustup. First, download the source and enter the project directory:

```bash
git clone https://github.com/WangMeng20152019/overleaf-realtime-preview.git
cd overleaf-realtime-preview
```

随后请按照[中文安装教程](docs/installation/README.md)或[英文安装教程](docs/installation/README.en.md)完成部署. 教程涵盖启动 Overleaf, 创建管理员, 构建实时预览引擎和前端, 绑定项目以及故障恢复. 目前的安装验证基于固定的 Linux amd64 与 Overleaf CE 6.2.2 镜像组合, 建议先用项目副本进行测试.

Then follow the [Chinese installation guide](docs/installation/README.md) or [English installation guide](docs/installation/README.en.md) to complete deployment. The guide covers starting Overleaf, creating an administrator, building the real-time preview engine and frontend, binding a project, and recovering from failures. Installation has been validated with a pinned Linux amd64 and Overleaf CE 6.2.2 image combination, so testing with a copy of your project first is recommended.

## 使用限制 / Known limitations

实时预览使用 LuaLaTeX, 正式 PDF 编译则保留 Overleaf 原有的编译设置. 目前支持一个可信项目和一个控制编辑会话. 复杂环境中的定位与跨页更新仍有限制; 在传统模式或离线期间修改文档后, 可能需要管理员刷新预览快照. 更多模板, 真实拼音输入法和多人并发场景尚待验证, 详见[兼容说明](docs/COMPATIBILITY.md).

Live preview runs on LuaLaTeX, while formal PDF builds keep your original Overleaf compiler settings. The current setup supports one trusted project and one controlling editor session. Navigation within complex environments and cross-page updates still have limitations, and edits made in traditional mode or while offline may require an administrator to refresh the preview snapshot. More templates, real Pinyin input methods, and concurrent editing remain to be tested; see the [compatibility notes](docs/COMPATIBILITY.md) for details.

## 问题反馈 / Feedback

如遇问题或有任何建议, 欢迎提交 [GitHub Issue](https://github.com/WangMeng20152019/overleaf-realtime-preview/issues). 提交时请说明操作步骤, 预期结果和实际现象, 最好附上一个能复现问题的小例子.

If you encounter a bug or have a suggestion, please open a [GitHub issue](https://github.com/WangMeng20152019/overleaf-realtime-preview/issues). Please describe the steps to reproduce, the expected result, and what actually happened, ideally with a small example that reproduces the problem.

实时预览中的 "诊断" 按钮可下载状态和耗时记录以方便排查问题, 但不会自动提交报错. 诊断文件可能包含项目标识, 分享前请先检查内容, 不要上传私人论文或账号凭据.

The "诊断" (Diagnostics) button in live preview downloads preview state and timing records to help with troubleshooting, and does not submit a report automatically. Because diagnostic files may contain project identifiers, please review them before sharing and do not upload private manuscripts or account credentials.

[开发说明 / Development](docs/DEVELOPMENT.md) · [问题记录 / Bug history](docs/BUG_HISTORY.md) · [本地调试网页 / Local debug page](dev/preview/README.md) · [验证记录 / Validation](docs/VALIDATION.md)

## 许可证 / License

本集成采用 AGPL-3.0-only 许可, 第三方组件保留各自的许可与署名. 详见 [COPYING](COPYING), [NOTICE](NOTICE) 和 [THIRD_PARTY.md](THIRD_PARTY.md).

This integration is licensed under AGPL-3.0-only, and third-party components retain their own licenses and credits. See [COPYING](COPYING), [NOTICE](NOTICE), and [THIRD_PARTY.md](THIRD_PARTY.md) for details.
