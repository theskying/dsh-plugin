# DSH Plugins

DSH 插件源码与安装包仓库。

仓库地址：[https://github.com/theskying/dsh-plugin](https://github.com/theskying/dsh-plugin)。

## 侧边栏对话

借鉴 **OpenAI Codex 的侧边栏对话体验**，在 DSH 主对话旁开启独立侧聊，支持独立选择模型与权限、引用主对话上下文及 12 小时有效期管理。侧聊内容不会自动写回主对话。

这是独立的 DSH 社区插件，与 OpenAI 或 Codex 无官方关联；具体实现与限制以插件说明为准，并非 Codex 功能的完整复刻。

插件位于 [dsh-sidebar-chat](./dsh-sidebar-chat/README.md)，当前版本 `0.1.0`，适配 DSH `0.2.1-rc.2`。

- 独立侧栏会话、创建时继承主会话权限。
- 标签重命名与页面内关闭确认。
- 12 小时有效期及生命周期清理。
- 有预算的增量主会话上下文。

当前为验证版。已通过本地回归测试；真实页面、完整重启及删除后引用行为仍需按插件说明验收，不代表所有需求已完整验证。

安装包在 GitHub Releases 中作为附件提供。此仓库不等于 DSH 市场索引，也未发布 npm。

## 开发

```sh
cd dsh-sidebar-chat
pnpm install --frozen-lockfile
node --test --test-timeout 8000 tests/*.test.mjs
npm pack --ignore-scripts
```

依赖目录和本地生成的安装包不提交到 Git；分发包通过 Release 附件提供。
