# Multi-TTS Fish Bridge

这是 Multi-TTS 的独立 SillyTavern Server Plugin。它只负责把浏览器同源请求转发到固定的 Fish Audio API 地址；Fish Audio API Key 由浏览器通过 `X-Fish-API-Key` 传入，Bridge 只在服务端内存中生成上游 `Authorization: Bearer ...` 请求头。

公开仓库地址：<https://github.com/dreamdana88/Multi-TTS-Fish-Bridge>。

普通用户不需要安装 Node.js、npm 依赖或单独启动 Bridge。推荐在仓库页面点击 **Code → Download ZIP**，解压后把目录内容放入 SillyTavern 的插件目录。命令行复制方式仅供熟悉 Git 或终端的用户使用。

## 安装

插件目录必须是：

```text
<SillyTavern>/plugins/multi-tts-fish-bridge
```

从 GitHub ZIP 下载时，解压目录通常叫 `Multi-TTS-Fish-Bridge-main`。请将它重命名为 `multi-tts-fish-bridge`，或新建同名目录后把 `index.js`、`package.json` 和 `README.md` 放进去；最终必须确保 `index.js` 直接位于上述插件目录下，不能多套一层仓库目录。

Windows PowerShell（本地源码目录）：

```powershell
$SillyTavern = 'D:\path\to\SillyTavern'
New-Item -ItemType Directory -Force "$SillyTavern\plugins\multi-tts-fish-bridge"
Copy-Item -Recurse -Force 'D:\path\to\Multi-TTS-Fish-Bridge\*' "$SillyTavern\plugins\multi-tts-fish-bridge"
```

Termux / Linux（本地源码目录）：

```bash
SILLY_TAVERN=/path/to/SillyTavern
mkdir -p "$SILLY_TAVERN/plugins/multi-tts-fish-bridge"
cp -a /path/to/Multi-TTS-Fish-Bridge/. "$SILLY_TAVERN/plugins/multi-tts-fish-bridge/"
```

如果以后从正式 Git 仓库安装，仓库内容仍须落在上述目录；不要把插件套在额外的二级目录中。

Docker 部署时，把包含 `plugins/multi-tts-fish-bridge` 的宿主机目录持久化挂载到容器的 SillyTavern `plugins` 目录，例如：

```bash
docker run --name sillytavern \
  -v /path/to/plugins:/home/node/app/plugins \
  -v /path/to/config.yaml:/home/node/app/config.yaml \
  <your-sillytavern-image>
```

云端部署也使用相同的插件目录结构。需要有权限写入服务器文件、重启 SillyTavern，并为浏览器访问提供 HTTPS；不要在公网 HTTP 页面中传输 Fish API Key。

## 启用

在 SillyTavern 的 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

保存后重启 SillyTavern。插件加载器会挂载：

```text
GET  /api/plugins/multi-tts-fish-bridge/health
POST /api/plugins/multi-tts-fish-bridge/models
POST /api/plugins/multi-tts-fish-bridge/speech
```

`/health` 是本地健康握手，不访问 Fish Audio，并返回协议版本 `1`。模型查询和语音合成只访问以下两个固定上游地址：

```text
https://api.fish.audio/model?self=true&page_size=100&page_number=1
https://api.fish.audio/v1/tts
```

Bridge 不接受任意上游 URL，不保存 API Key，不把 API Key 写入 URL、日志、文件、缓存或错误响应，也不生成临时音频文件。Multi-TTS 前端和这个 Server Plugin 是两个独立组件，前端不负责安装、启动、重启或修改 SillyTavern 配置。

## 开发检查

```bash
npm test
node --check index.js
```

不要在未审阅代码来源的情况下把此插件安装到公开的 SillyTavern 实例。
