# Google AI Studio to API Adapter

中文文档 | [English](README_EN.md)

一个将 Google AI Studio 网页端封装为兼容 OpenAI API、Gemini API �?Anthropic API 的高性能代理工具。通过浏览器自动化技术，它将 API 请求无缝转化为与 AI Studio 网页界面的交互�?
针对高并发场景，本项目全新设计了\*_账号池模式（Pool Mode�?_，支持多点动态负载均衡、流量调度与 429 智能风控，确保在海量请求下的极高可用性�?

---

## �?核心特�?

- 🚀 **高并发账号池机制（Pool Mode�?\*�? - **动态负载均�?_：通过 `CONCURRENCY_MODE=pool` 开启，支持大量账号并行处理海量 API 请求�? - **智能批次调度**：支持配置批次大小（`POOL_BATCH_SIZE`），按批次切分账号组。当某批次触发熔断比例（`POOL_BATCH_SWITCH_RATIO`）时，无缝切换下一批次，最大化利用计算资源�? - \*\*429 防御与自动恢�?_：内置精�?429 风控。遭�?429（使用限额）时，账号自动进入“退休”状态进行隔离，不影响全局吞吐；并在配置的时间（`RETIRE_RECOVERY_HOURS`）后自动恢复重新投入生产�? - \*_IP 粘性会�?_：内置请�?IP 粘性绑定，保持对话上下文的连贯性，防止被风控�?
- 🔄 **全方�?API 兼容�?\*：同时支�?OpenAI API、Gemini 原生 API 以及 Anthropic API 格式，支持真流式与假流式传输，支持各类客户端无缝接入�?- 🔧 **Native 工具调用支持**：完美支持所有的 Tool Calls (Function Calling) 能力�?- 📝 **多模态与多元模型**：支�?Gemini 系列全模型矩阵，包括实验性预览模型、生图模�?(Imagen) 以及 TTS 音频能力�?- 🎨 **可视化监控大�?\*：内置现代化 WebUI 控制台，实时监控当前账号池健康度、批次连通状态、休�?退休倒计时以及全局并发吞吐量�?

---

## 🚀 快速开�?

### 💻 直接运行（Windows / macOS / Linux�?

1. 克隆并进入仓库：

   ```bash
   git clone https://github.com/iBUHub/AIStudioToAPI.git
   cd AIStudioToAPI
   ```

2. 运行快速配置脚本提取账号凭证（自动启动下载的浏览器）：

   ```bash
   npm run setup-auth
   ```

   > 💡 浏览器将自动导航�?AI Studio。请登录您的 Google 账号，凭证将自动保存�?`/configs/auth` 目录�? > 💡 提示：若自动下载浏览器失败，请手动下�?[Camoufox](https://github.com/daijro/camoufox/releases/tag/v135.0.1-beta.24)，并通过 `CAMOUFOX_EXECUTABLE_PATH` 环境变量指定其路径�?

3. 配置参数：复�?`.env.example` �?`.env` 并进行配置（推荐开启池模式 `CONCURRENCY_MODE=pool`）�?
4. 启动服务�?

   ```bash
   npm start
   ```

   服务运行�?`http://localhost:7860`。浏览器访问该地址即可打开控制台面板�?

### 🐋 Docker 部署

使用 Docker 进行部署，提供原生的容器化环境隔离。请在本地执行构建�? \*_1. 本地构建镜像�?_

```bash
docker build -t aistudio-to-api .
```

\*_2. 运行容器�?_

```bash
docker run -d \
  --name aistudio-to-api \
  -p 7860:7860 \
  -v /path/to/auth:/app/configs/auth \
  -e CONCURRENCY_MODE=pool \
  --restart unless-stopped \
  aistudio-to-api
```

> 💡 部署完成后访�?`http://localhost:7860`。可在监控首页利用内置的 **VNC 登录** 功能进行可视化账号录入，录入的账号将自动加载至账号池�?
> 📖 其他云平台一键部署请参见：[Claw Cloud Run部署指南](docs/zh/claw-cloud-run.md) | [Zeabur部署指南](docs/zh/zeabur.md)

---

## 📡 接口支持详情

该适配器可以充当绝佳的 LLM 客户端网关，默认端点�?`http://localhost:7860`�?

### 🤖 OpenAI 兼容端点

- `/v1/models`：获取支持的模型列表
- `/v1/chat/completions`：标准聊天、多模态请求（甚至生图）。支持真/假流式�?

### �?Gemini 原生端点

- `/v1beta/models`
- `/v1beta/models/{model_name}:streamGenerateContent`：支持双端流式输出�?- `/v1beta/models/{model_name}:predict`：Imagen 생图接口�?

### 👤 Anthropic 兼容端点

- `/v1/messages`：标准化 Claude API 风格接入层�?
  > 📖 详细接口参数和调用示例，参见 [API 调用示例](docs/zh/api-examples.md)�?

---

## 🧰 核心配置指南

你可以在 `.env` 文件�?Docker 环境变量中全局配置服务的行为。以下是重点配置一览：

### 🔄 高并发池模式 (Pool Mode) 核心参数

| 变量�?                    | 描述                                                                                                                        | 默认�? |
| :------------------------ | :-------------------------------------------------------------------------------------------------------------------------- | :----- |
| `CONCURRENCY_MODE`        | 并发架构。`pool` 为多账号高并发池模式，`single` 为传统单账号串行模式（极易因 429 拥塞，现已不推荐�?                         | `pool` |
| `POOL_BATCH_SIZE`         | 自动批次大小。大型账号池（如 100 账号）推荐分批（�?`20`）。仅在当前批次资源耗尽时加载下个批次资源。使�?`0` 代表单一大池子�? | `0`    |
| `POOL_BATCH_SWITCH_RATIO` | 批次切换阈值。当当前批次有该比例的机器被风控休眠时（�?`0.6`，即 60% 无响应），自动激活下一批次�?                            | `0.5`  |
| `RETIRE_RECOVERY_HOURS`   | 429 死亡隔离自动恢复时间（小时）。遭精准限制后账号移出调度队列的时间，到期后重进队列末尾�?                                  | `5`    |
| `REST_DURATION_MINUTES`   | 非常规错误的临时冷却隔离时间（分钟）�?                                                                                      | `1`    |

### 🛠�?基础配置

| 变量�?                 | 描述                                | 默认�? |
| :--------------------- | :---------------------------------- | :----- |
| `WEB_CONSOLE_USERNAME` | 控制台登录账户名                    | �?     |
| `WEB_CONSOLE_PASSWORD` | 控制台登录验证密�?                  | �?     |
| `PORT`                 | 本地服务运行端口                    | `7860` |
| `LOG_LEVEL`            | 日志级别（INFO, DEBUG, ERROR 等）   | `INFO` |
| `HTTP_PROXY`           | 后端访问 Google 服务�?HTTP 全局代理 | �?     |

> 📖 控制台的高级使用、定制多账号初始化方法请参阅：[账号自动填充指南](docs/zh/auto-fill-guide.md) �?[Nginx 部署文档](docs/zh/nginx-setup.md)�?

---

## 📄 许可证传承与鸣谢

本项目基�?[**ais2api**](https://github.com/Ellinav/ais2api)（作者：[**Ellinav**](https://github.com/Ellinav)）二次进阶开发，完全沿用上游采用�?CC BY-NC 4.0 许可证�?
[![Contributors](https://contrib.rocks/image?repo=iBUHub/AIStudioToAPI)](https://github.com/iBUHub/AIStudioToAPI/graphs/contributors)

## 感谢所有对构建高并发无缝大语言模型网关做出贡献的工程师们�?

⭐️ 如果这个项目拯救了你�?API 调用预算，欢迎给�?Star�?
[![Star History Chart](https://api.star-history.com/svg?repos=iBUHub/AIStudioToAPI&type=date&legend=top-left)](https://www.star-history.com/#iBUHub/AIStudioToAPI&type=date&legend=top-left)
