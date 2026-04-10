# Google AI Studio to API Adapter

[中文文档](README.md) | English

A high-performance proxy tool that wraps the Google AI Studio web interface into OpenAI, Gemini, and Anthropic API-compatible endpoints. Through advanced browser automation, it seamlessly translates REST API requests into web UI interactions.

Geared towards high-concurrency environments, this project features a newly designed **Account Pool Mode** allowing for multi-node dynamic load balancing, precise traffic orchestration, and intelligent 429 rate-limit defense circuits—ensuring extreme availability under massive workloads.

---

## �?Core Features

- 🚀 **High-Concurrency Account Pool Mode**:
  - **Dynamic Load Balancing**: Toggle on via `CONCURRENCY_MODE=pool` to orchestrate massive API requests in parallel using large groups of accounts.
  - **Intelligent Batch Switching**: Configure active pools by size (`POOL_BATCH_SIZE`). Once a designated batch hits standard rate limits (`POOL_BATCH_SWITCH_RATIO`), the engine seamlessly halts and routes incoming traffic to the next batch, shielding computational limits.
  - **429 Defense & Auto-Recovery**: Pinpoint rate-limit handling. Whenever an underlying account receives a 429 restriction, it retires into isolation instead of blocking global throughput and attempts an auto-recovery after an elapsed window (`RETIRE_RECOVERY_HOURS`)—returning to the pool dynamically.
  - **Session Stickiness**: Maintains contextual consistency automatically across prompt windows per unique client IP to reduce detection entropy.

- 🔄 **Omni-API Compatibility**: Works out of the box with standards like OpenAI API, Anthropic API, and localized Gemini API with support for live fake & real streams across integrations.
- 🔧 **Native Tool Calls Support**: Fully maps and executes Tool Calls (Function Calling) over intercepted browsers.
- 📝 **Multimodal Model Access**: Unlock the full Gemini catalog from standard experimentals all the way to Imagen series models (image gen) and TTS vocal endpoints directly.
- 🎨 **Visual Monitoring Dashboard**: Navigate through an enterprise-grade WebUI. Track real-time pool health metrics, connectivity statuses, downtime recovery counting, and globally mapped concurrency bounds in plain sight.

---

## 🚀 Quick Start

### 💻 Run Directly (Windows / macOS / Linux)

1. Clone the repository:

   ```bash
   git clone https://github.com/iBUHub/AIStudioToAPI.git
   cd AIStudioToAPI
   ```

2. Run the quick authentication setup script (automatically downloads the required browser):

   ```bash
   npm run setup-auth
   ```

   > 💡 The script drives the browser directly to AI Studio. Simply log in to your Google Account manually, and the resulting authentication state gets silently cached under `/configs/auth`.
   > 💡 Note: If automatic browser downloading stalls manually download [Camoufox](https://github.com/daijro/camoufox/releases/tag/v135.0.1-beta.24) and point the `CAMOUFOX_EXECUTABLE_PATH` environment variable towards the binary.

3. Configuration Setup: Copy `.env.example` into `.env` (it is highly recommended to activate pool mode with `CONCURRENCY_MODE=pool`).

4. Launch Server:

   ```bash
   npm start
   ```

   The service starts locally on `http://localhost:7860`. Open this address in your browser to view the Control Panel.

### 🐋 Docker Deployment

For clean infrastructure using Docker, you can build and run the image locally.

**1. Build Image Locally:**

```bash
docker build -t aistudio-to-api .
```

**2. Run Container:**

```bash
docker run -d \
  --name aistudio-to-api \
  -p 7860:7860 \
  -v /path/to/auth:/app/configs/auth \
  -e CONCURRENCY_MODE=pool \
  --restart unless-stopped \
  aistudio-to-api
```

> 💡 After spinning it up visit `http://localhost:7860`. You can inject accounts remotely using the dashboard's built-in **VNC feature**, instantly loading authenticated contexts into the active proxy pools directly from the GUI.

> 📖 Alternative managed platform deployment instructions: [Claw Cloud Run Guide](docs/en/claw-cloud-run.md) | [Zeabur Guide](docs/en/zeabur.md)

---

## 📡 API Endpoint Support

The adapter replaces primary LLM gateway endpoints via its default port `http://localhost:7860`.

### 🤖 OpenAI Compatible Output

- `/v1/models`: Yield supported models
- `/v1/chat/completions`: Standard message completions, multimodal context (and imagen gen mapping). Live stream & fake stream native.

### �?Gemini Native Standard

- `/v1beta/models`
- `/v1beta/models/{model_name}:streamGenerateContent`: Multi-directional stream sync execution.
- `/v1beta/models/{model_name}:predict`: Text-to-Image execution via Imagen models.

### 👤 Anthropic Compatible Mode

- `/v1/messages`: Claude's standardized structure mapping layer.

> 📖 Detailed documentation and cURL queries can be viewed at: [API Usage Examples](docs/en/api-examples.md).

---

## 🧰 Core Configurations Guide

Customize the container behavior globally by injecting environment fields.

### 🔄 Concurrency Pool Parameters

| Variable                  | Description                                                                                                                                                                                                                   | Default |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| `CONCURRENCY_MODE`        | Routing architecture. Use `pool` for highly concurrent balancing across multi-account deployments, or `single` for legacy serial loops (highly susceptible to drops, no longer recommended).                                  | `pool`  |
| `POOL_BATCH_SIZE`         | Break large authentication clusters down mathematically. e.g. Grouping 100 loaded profiles by sizes of `20`. Only invokes the next batch once the current one is entirely exhausted. Settable to `0` for one unified cluster. | `0`     |
| `POOL_BATCH_SWITCH_RATIO` | Failsafe pivot threshold. Once X% of the active batch becomes 429 congested (e.g. `0.5` signifies 50% dead), active traffic smoothly swaps over to the next batch lineup.                                                     | `0.5`   |
| `RETIRE_RECOVERY_HOURS`   | Rest timer (Hours). Handles indefinite rate-limit penalties by quarantining profiles out of the dispatch queues and scheduling auto-retries back into the active queues X hours later.                                        | `5`     |
| `REST_DURATION_MINUTES`   | Baseline isolation timeout buffer (in minutes) upon experiencing standard transient non-429 circuit failures.                                                                                                                 | `1`     |

### 🛠�?Basics

| Variable               | Description                                                             | Default |
| :--------------------- | :---------------------------------------------------------------------- | :------ |
| `WEB_CONSOLE_USERNAME` | Master WebUI login user                                                 | N/A     |
| `WEB_CONSOLE_PASSWORD` | Master WebUI login key                                                  | N/A     |
| `PORT`                 | Local service endpoint listener variable                                | `7860`  |
| `LOG_LEVEL`            | Verbose toggle (INFO, DEBUG, ERROR)                                     | `INFO`  |
| `HTTP_PROXY`           | Global external proxy hook routing back towards original Google origins | N/A     |

> 📖 More advanced routing contexts such as `users.csv` mappings: [Account Auto-fill Guide](docs/en/auto-fill-guide.md) and strict fronting protocols: [Nginx Routing Base](docs/en/nginx-setup.md).

---

## 📄 Licensing & Acknowledgments

This infrastructure rests atop the progressive frameworks originally architectured by [**Ellinav**](https://github.com/Ellinav) under the [**ais2api**](https://github.com/Ellinav/ais2api) platform space and explicitly inherits downstream compliance to the standing CC BY-NC 4.0 usage rights.

[![Contributors](https://contrib.rocks/image?repo=iBUHub/AIStudioToAPI)](https://github.com/iBUHub/AIStudioToAPI/graphs/contributors)

Heartfelt thanks goes outwards toward all engineers fortifying continuous, open LLM scaling accessibility limits here today.

---

⭐️ If this backend system has rescued your AI usage budgets previously, drop us a star above!

[![Star History Chart](https://api.star-history.com/svg?repos=iBUHub/AIStudioToAPI&type=date&legend=top-left)](https://www.star-history.com/#iBUHub/AIStudioToAPI&type=date&legend=top-left)
