# DSH Plugins

DSH 插件源码与安装包仓库。

## 侧边栏对话

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
