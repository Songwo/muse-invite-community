# Muse 邀请互助

一个独立的 Muse 邀请互助网站：已开通的人分享邀请码或邀请链接，其他人领取并反馈使用结果，由分享者确认互助状态。

## 启动

需要 Node.js 22.13.0 或更新版本。前端使用 React 19、TypeScript 和 Vite 6；本地后端使用 Express 5 和 Node.js 内置 SQLite，线上后端使用 Cloudflare Worker 与 SQLite Durable Object。

在本目录执行：

```powershell
npm install
npm run dev
```

开发地址为 http://127.0.0.1:5173；端口被占用时以终端显示的地址为准。开发服务器同时提供前端和 API。

在本工作区需要指定可写的 npm 缓存时，可将安装命令改为 `npm install --cache ../../work/npm-cache`。这是可选项。

运行构建后的版本：

```powershell
npm run build
npm start
```

默认地址为 http://127.0.0.1:4174。`npm start` 需要先生成 `dist`，缺少构建产物时会直接报错。

## 互助流程

1. 分享者发布邀请码或邀请链接，填写可邀请次数、有效期和备注。
2. 其他人领取一个名额后，才能看到完整邀请内容。分享者始终可以查看自己的内容。
3. 领取人提交“已使用，等待确认”，或反馈无法使用并填写原因。
4. 分享者处理反馈；只有“确认互助”后，才增加已确认互助次数。无效反馈不能确认成功。

“我的领取”保留所有领取记录，包括已取消和已退回的记录；“我的分享”可以查看领取进度、处理反馈、暂停、恢复或结束分享。

领取、等待确认、无效待处理和已确认记录都会占用名额。领取人取消或分享者退回反馈后会释放名额；取消和退回不会删除历史。结束分享后不可重新开放，已有领取仍可反馈和处理。

## 身份与数据

首次打开网站会创建浏览器身份，可点击右上角昵称修改名称。本地模式使用 HttpOnly Cookie，线上跨域 API 模式使用 localStorage 中的随机会话 token，服务端仅保存 token 的 hash。它没有密码登录、跨设备账号或身份恢复入口：清除对应浏览器存储、会话到期或换浏览器后，无法通过页面找回原来的分享和领取管理权。旧记录仍保存在数据库中。

在本目录运行时，开发和构建后的服务默认共用 `data/muse.sqlite`，重启不会清空数据。不要删除 `data` 目录，它保存用户、会话、分享、领取和动态；端到端测试每次使用独立的 `data/e2e-*.sqlite`。线上记录保存在 Cloudflare 的 Durable Object SQLite 中，与本地数据库分开。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `4174` | `npm start` 的端口，必须为 1 至 65535 的整数 |
| `HOST` | `127.0.0.1` | `npm start` 的监听地址 |
| `DATABASE_PATH` | `data/muse.sqlite` | 开发和构建后服务的 SQLite 文件路径，支持绝对路径 |
| `VITE_API_URL` | 空 | 前端构建或开发时连接的云端 API 地址；留空使用本地同源 API |
| `PAGES_BASE` | `/` | 前端静态资源根路径；本仓库 Pages 使用 `/muse-invite-community/` |

PowerShell 示例，在本目录设置后启动：

```powershell
$env:PORT = '4175'
$env:HOST = '127.0.0.1'
$env:DATABASE_PATH = './data/muse.sqlite'
npm start
```

`PORT` 和 `HOST` 不控制 Vite 开发服务器；开发时可使用 `npm run dev -- --port 5175 --strictPort` 指定端口。环境变量保留在当前 PowerShell 会话中。

## 线上部署

目标站点：[Muse 邀请互助](https://songwo.github.io/muse-invite-community/)。源码仓库：[Songwo/muse-invite-community](https://github.com/Songwo/muse-invite-community)。`main` 保存源码，`gh-pages` 保存构建后的静态页面，GitHub Pages 从 `gh-pages` 分支根目录发布。

GitHub Pages 无法运行 Express 或保存共享 SQLite，因此网站通过 HTTPS 连接 Cloudflare Worker。`wrangler.jsonc` 管理 API、社区 Durable Object 绑定和允许的页面 Origin；`worker/index.ts` 是云端入口。一个社区使用一个协调对象，领取容量和相关记录在同步事务中更新。

有对应 Cloudflare 部署权限时：

```powershell
npm run worker:check
npm run worker:deploy
```

前端构建时将 `VITE_API_URL` 设置为 Wrangler 返回的实际 HTTPS API 地址，将 `PAGES_BASE` 设置为 `/muse-invite-community/`，然后执行 `npm run build`。API 地址是公开配置，不是凭据；不要在前端构建变量中放 API Key。将 `dist` 的内容更新到 `gh-pages` 分支即可发布前端。

仓库不包含本地数据库、会话记录或 Cloudflare/GitHub 登录凭据。切勿把 `data`、`.wrangler` 或 `.env` 添加到版本控制。

## 验证

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run worker:check
```

`npm test` 执行本地后端、展示逻辑、云端业务核心及 CORS 测试。端到端测试默认使用本机已安装的 Edge，自动在 `127.0.0.1:5186` 启动开发服务器，该端口需要空闲。

跨域 Worker 模式的浏览器验收使用独立本地 Cloudflare 存储：设置 `$env:MUSE_E2E_REMOTE = '1'` 后执行 `npm run test:e2e`，测试结束后删除该环境变量即可恢复本地 Cookie 模式。它不会写入线上社区。

迁移到其他环境时，若没有 Edge，可以在 `playwright.config.ts` 中把 `channel` 改为 Playwright 支持的已安装浏览器；也可以在该环境执行 `npx playwright install chromium`，再移除 `channel: 'msedge'` 使用 Chromium。本机无需额外安装浏览器。

## 当前边界

- 可邀请次数和有效期由分享者填写，代表站内领取限制，不是 Muse 官方配额。状态来自领取人反馈和分享者确认，网站未调用 Muse API，也不能核验账号是否已开通。
- 邀请链接仅接受 `muse.ai` 或其子域名的 HTTPS 地址，不接受携带账号密码或非默认端口的链接。
- 新数据库不预置假邀请，没有收费流程。分享内容需要由实际持有邀请的人提交。
- Node.js 内置 SQLite 在部分版本中会输出 `ExperimentalWarning`；该提示不代表数据保存失败。
- 首版仍未提供身份恢复、举报审核后台或历史分页；后续维护应包含线上数据备份与恢复验证。
- `public/muse-avatar.png` 裁切自用户提供的截图，仅用于此非官方互助社区的主题标识。
