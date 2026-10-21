# DSH Plugins 个人插件集合

个人收集、改造和开发的 DeepSeek Harness (DSH) 插件仓库。

仓库地址：[https://github.com/theskying/dsh-plugin](https://github.com/theskying/dsh-plugin)

---

## 📦 插件列表

### 1. dsh-sidebar-chat - 侧边栏对话

借鉴 **OpenAI Codex 的侧边栏对话体验**，在 DSH 主对话旁开启独立侧聊，支持独立选择模型与权限、引用主对话上下文及 12 小时有效期管理。侧聊内容不会自动写回主对话。

这是独立的 DSH 社区插件，与 OpenAI 或 Codex 无官方关联；具体实现与限制以插件说明为准，并非 Codex 功能的完整复刻。

**目录**: [dsh-sidebar-chat](./dsh-sidebar-chat/)  
**当前版本**: `0.1.0`  
**适配 DSH**: `0.2.1-rc.2`

**特性**:
- ✅ 独立侧栏会话、创建时继承主会话权限
- ✅ 标签重命名与页面内关闭确认
- ✅ 12 小时有效期及生命周期清理
- ✅ 有预算的增量主会话上下文

**状态**: 验证版，已通过本地回归测试

---

### 2. dsh-wechat - 微信远程控制

**原作者**: [xcisxc29/dsh-wechat](https://github.com/xcisxc29/dsh-wechat)  
**本地版本**: 基于 v0.36.5 + 多账号隔离改造（计划中）

用微信遥控 DeepSeek Harness：手机上聊天，电脑上的 DSH 干活。

**目录**: [dsh-wechat](./dsh-wechat/)  
**安全评估**: [dsh-wechat-安全评估报告.md](./dsh-wechat-安全评估报告.md)

**核心特性**:
- ✅ 文字、图片、文件、语音、视频双向传输
- ✅ 一个微信对话，多个 DSH 会话（`/new` `/list` `/switch` `/model`）
- ✅ 权限申请和多选提问发到微信，手机上回答
- ✅ 主动推送：会话可以自己找你（"做完了告诉我"）
- ✅ 设置页：DSH 的 **设置 → 微信**
- ✅ 直连腾讯官方 iLink 服务，无第三方中转
- ✅ 支持一个 DSH 实例绑定多个微信账号

**安全评估结论**:
- ✅ 无第三方服务器，直连腾讯
- ✅ 凭据安全存储（0600 权限）
- ✅ 无数据收集或追踪
- ⚠️ 默认完全访问权限（可配置）
- ⚠️ Agent 以你的身份运行（设计用途）

**计划改造**（进行中）:
- 🔨 多微信账号对应多工作区隔离
- 🔨 账号级别的会话列表过滤
- 🔨 禁用跨账号的会话推送
- 🎯 目标：实现个人知识库多人共享入口

**原始功能说明**: 见 [dsh-wechat/README.zh.md](./dsh-wechat/README.zh.md)

---

## 📥 安装方式

### 从 Git 仓库安装

```bash
# 在 DSH 的「插件」页面，选择「添加插件」，输入：
https://github.com/theskying/dsh-plugin.git#main:/插件目录名

# 例如：
https://github.com/theskying/dsh-plugin.git#main:/dsh-sidebar-chat
https://github.com/theskying/dsh-plugin.git#main:/dsh-wechat
```

### 从本地安装包安装

安装包在 GitHub Releases 中作为附件提供（如果已发布）。

---

## 🛠️ 开发

### dsh-sidebar-chat

```bash
cd dsh-sidebar-chat
pnpm install --frozen-lockfile
node --test --test-timeout 8000 tests/*.test.mjs
npm pack --ignore-scripts
```

### dsh-wechat

```bash
cd dsh-wechat
pnpm install
pnpm build              # 只编译
pnpm run dist           # build + 内嵌 core
pnpm typecheck
pnpm test               # 316 项测试
pnpm check              # build + typecheck + test
pnpm run pack           # 生成发布包
```

---

## 📝 说明

- 依赖目录和本地生成的安装包不提交到 Git
- 分发包通过 Release 附件提供（如果有）
- 此仓库不等于 DSH 市场索引，也未发布 npm
- 插件可能经过个人改造，与原作者版本有差异

---

## 📄 许可证

- **dsh-sidebar-chat**: 见其目录内的 LICENSE
- **dsh-wechat**: MIT（原作者 xcisxc29）
