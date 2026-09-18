# pi-check-agent-quota

在 pi TUI 中显示 AI provider 的配额、余额，以及最近几轮对话的消耗。

[English](./README_EN.md) | 中文说明

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot.png)

## 支持的 provider

| Provider | 显示 |
|---|---|
| MiniMax (`minimax`, `minimax-cn`) | 5h / 7d 使用率 |
| Kimi API (`moonshotai`, `moonshotai-cn`) | 余额 |
| Kimi For Coding (`kimi-coding`) | 5h / 7d 使用率 |
| Z.AI / GLM (`zai`) | 余额 |
| Z.AI Coding Plan (`zai-coding-cn`) | 使用率 |
| DeepSeek (`deepseek`) | 余额 |
| OpenRouter (`openrouter`) | 余额 |
| OpenCode Go (`opencode-go`) | 5h / 7d / mo 使用率 |
| OpenAI Codex (`openai-codex`，ChatGPT Plus/Pro OAuth 登录) | 5h / 周使用率、套餐标识 |
| Codex Account Pool (`codex-account-pool`) | 当前池账户、5h / 周使用率、套餐标识 |

其他 provider 不查询，Widget 显示 `--`。`opencode-go` 使用 pi 已有的 `OPENCODE_API_KEY`。`openai-codex` 复用 pi `/login openai-codex` 的 OAuth 凭据（access token，由 pi 自动续期）；普通 OpenAI API key 无法查询 ChatGPT 订阅限额。`kimi-coding` 同时支持 pi `/login kimi-coding` 的 OAuth 订阅和普通 `KIMI_API_KEY`。`/login` 是 pi 内置命令，不是本扩展注册的命令；本扩展只读取 pi 已解析的凭据，不实现或保存登录流程。

## 安装

```bash
pi install https://github.com/rodrigojager/pi-check-agent-quota
```

此分支通过 Pi 共享事件总线支持 `rodrigojager/pi-codex-account-pool`，并保留所有原有 provider。

API key 复用 pi 已有的 provider 认证，无需额外配置。

## 认证命令（pi 内置）

下面的命令属于 pi，不是本扩展注册的命令；使用 OAuth 配额 provider 时需要先执行：

```text
/login kimi-coding       # 登录 Kimi For Coding OAuth
/login openai-codex      # 登录 ChatGPT Plus/Pro Codex OAuth
```

- 按 pi 显示的浏览器/设备码流程完成登录；
- 凭据由 pi 自己保存和自动续期；
- 登录后切换到对应 provider/model，本扩展只读取 pi 已解析的 access credential；
- 本扩展不注册 `/login`，不接收登录密钥，也不持久化 OAuth token。

## 显示

### 颜色与状态

- **配额颜色**：低用量绿色、接近上限黄色、超限红色；消耗差值紫色。
- **上一轮消耗**：余额 `(¥-0.20)`、桶型 `(-20%)`；回升为正，无变化不带符号。
- **状态标注**：
  - 对话进行中 → `(使用中)`
  - 抓取失败 → `(失败)`
  - 跨 provider 切换 → `(变更)`
- **余额告警**：低于阈值（默认 10，可用 `/aqset <红> <黄> <余额告警>` 调整；环境变量 `PI_QUOTA_BALANCE_ALERT` 仍可作为初始值）时数字标红。

### 余量预估（ETA）

状态栏右侧显示 `2分钟前 · 预计可用：N轮/2h15m`：

- **消耗速率**：按窗口优先级取最短可用窗口（`5h` → `used` → `7d` → `mo`）。`5h`/`used` 的增量是真实单轮消耗；`7d`/`mo` 为滑动窗口，仅在无更小窗口时作为回退。
- **瓶颈桶**：各桶轮数 = 各自剩余量 ÷ 统一速率，取最先耗尽的瓶颈。`7d`/`mo` 先重置则不构成约束。
- **隐藏条件**：样本不足、任一桶已耗尽、或请求失败时隐藏。
- **特殊显示**：
  - 近期无消耗 → `近x轮0消耗`（余额型和桶型都支持）
  - 超过 365 轮 → `365+轮`
  - 剩余 ≤5 轮或 ≤30 分钟 → 数字标红
- **布局**：窄窗口自动换行，拖拉窗口自动重算贴边；时间精确到分（`2h15m`），≥24h 换算成天（`3d4h`）。
- **刷新时间**：有 ETA 时，`2分钟前 ·`（en: `2m ago ·`）显示在「预计可用」前；没有 ETA 时只显示 `2分钟前`（en: `2m ago`），表示当前配额快照抓取于 2 分钟前。定义：`age = 当前时间 − 该 provider 最近一次成功抓取时间`（抓取由会话启动、切换模型、每轮结算、`/checkaq` 触发；会话恢复时可能来自磁盘缓存，会如实显示如 `5小时前`）。闲置时每分钟自动重算；age 与 ETA 独立，ETA 不可用时（窗口耗尽/窄窗/样本不足）仍显示；抓取失败后也显示最近一次成功快照的 age。
- **自动刷新（可选，默认关闭）**：用 `/aqauto 5` 开启（每 5 分钟）、`/aqauto on`（默认 5 分钟）、`/aqauto off` 关闭、`/aqauto` 查看。开启后 pi 挂着不用也会按间隔自动抓取（纯监控用途，无需对话）；手动 `/checkaq` 和每轮结算照常工作，并会推迟下一次自动抓取。设置与阈值一样持久化；环境变量 `PI_QUOTA_AUTO_REFRESH_MINUTES` 仍可作为初始值。

## 命令

| 命令 | 用法 | 说明 |
|---|---|---|
| `/checkaq` | `/checkaq` | 强制刷新并显示当前 provider 的实时配额 |
| `/aq10` | `/aq10` | 显示最近 10 条已结算轮次的消耗汇总 |
| `/aqlang` | `/aqlang zh\|en` | 切换界面语言（默认中文） |
| `/aqset` | `/aqset [红 黄 余额] \| reset` | 查看/设置显示阈值 |
| `/aqauto` | `/aqauto [分钟\|on\|off]` | 查看/开关挂机自动抓取 |

### `/checkaq` — 强制刷新

用法：

```text
/checkaq
```

- 不需要参数（多余文本会被忽略），始终请求当前 provider 的实时配额，不依赖缓存；
- 使用当前 provider 配置的 API key 或 pi 管理的 OAuth 凭据；
- 成功后更新 Widget、`age` 和 ETA，但单独执行 `/checkaq` 不会创建消耗记录；
- 同 provider 已有请求在途时会等待并复用该请求；同 provider 在 1 秒内重复执行会防抖；
- 没有当前 provider 时提示警告；未支持或未配置 provider 保持 `--`/限额不可用。

### `/aq10` — 近期消耗汇总

用法：

```text
/aq10
```

- 不需要参数（多余文本会被忽略），也不会触发网络请求；
- 显示当前 provider 最近成功结算的对话轮次，最多 10 条；
- 配额型 provider 显示各窗口的百分比消耗，余额型 provider 显示货币消耗；
- 跨 provider 或失败轮次不计入消耗；余额增加/不变不会作为余额消耗显示；
- 没有可用记录时提示暂无消耗记录。

示例：

```text
minimax-cn 近2轮消耗 5h 23% / 7d 11%
opencode-go 近5轮消耗 5h 15% / 7d 10% / mo 5%
openrouter 近5轮消耗 $0.69
```

### `/aqlang` — 切换界面语言

用法：

```text
/aqlang zh
/aqlang en
```

- 只接受 `zh` 或 `en`（不区分大小写，会忽略首尾空格）；
- 立即切换 Widget 标签、状态、ETA、通知和命令描述；
- 语言选择写入本地缓存，下次会话自动恢复；
- 其他值、缺少参数或多余参数都会拒绝并提示用法。

### `/aqset` — 显示阈值

一行三个数字，顺序固定：**红 / 黄 / 余额告警**。

- 第 1 个数：使用率 ≥ 此百分比变**红**
- 第 2 个数：使用率 ≥ 此百分比变**黄**
- 第 3 个数：余额 ≤ 此值标红（货币单位）

```text
/aqset               # 查看当前阈值（同样格式输出，改数字重发即可）
/aqset 80 40 10      # 默认：使用率 ≥80% 红、≥40% 黄、余额 ≤10 标红
/aqset 60 30 20      # 更敏感：更早变黄变红，余额告警提高
/aqset reset         # 恢复默认
```

规则：

- 红线必须大于黄线，否则拒绝并提示用法；
- 非法输入（个数不对、非数字、越界）拒绝且不保存；
- 设置立即生效并跨会话持久化（存在本地缓存文件里）；
- 旧环境变量 `PI_QUOTA_PCT_YELLOW` / `PI_QUOTA_PCT_RED` / `PI_QUOTA_BALANCE_ALERT` 仍可作为初始值。

### `/aqauto` — 挂机自动抓取

默认关闭；开启后即使不对话，也按设定间隔自动抓取配额：

```text
/aqauto               # 查看当前状态（如：自动抓取：每 5 分钟一次）
/aqauto 4             # 开启，每 4 分钟
/aqauto 30            # 最大间隔
/aqauto on            # 开启（保持当前间隔，未设置时默认 5 分钟）
/aqauto off           # 关闭（等同 /aqauto 0）
```

规则：

- 间隔只接受整数，范围 0–30 分钟：`0` = 关闭，`30` = 上限；小数和超过 30 的值直接拒绝；
- 立即生效并跨会话持久化（与 `/aqset` 一样存在本地缓存文件里）；
- 防抖：1 秒内重复同一命令忽略；任何一次抓取（手动 `/checkaq`、每轮结算、会话启动）都会推迟下一次自动抓取；同 provider 在途请求合并不重复；
- `/aqset reset` 会连自动抓取一起重置回环境变量初始值（或关闭）；
- 旧环境变量 `PI_QUOTA_AUTO_REFRESH_MINUTES` 仍可作为初始值（超过 30 钳制到 30）。

### `/aq10` 示例

```text
minimax-cn 近2轮消耗 5h 23% / 7d 11%
opencode-go 近5轮消耗 5h 15% / 7d 10% / mo 5%
openrouter 近5轮消耗 $0.69
```

## 从旧版本迁移缓存（老用户须知）

v0.1.2 起，缓存文件从 `~/.pi/agent/pi-check-agent-quota.json` 迁移到了 `~/.pi/agent/pi-check-agent-quota/quota-cache.json`。

**不迁移也能正常使用**——插件会在新位置从头开始累计，只是 `/aq10` 的历史消耗记录会清空。

如果想保留历史记录，手动搬移即可：

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

确认新位置能正常读写后，旧文件即可删除（上面的 `mv` 已完成移动）。

> **Migration is optional** — the plugin works fine without it; it will simply start fresh, and your `/aq10` consumption history will be reset. To keep your history, move the file manually using the commands above.

## 隐私

- 只向对应 provider 的配额接口发送该 provider 的凭据（API key 或 OAuth access token，后者由 pi 管理与续期，本扩展不落盘、不日志）；
- 不读取、不上传 prompt、回复、文件或对话内容；不保存 API key 和完整响应；无遥测；
- 本地缓存位于 `~/.pi/agent/pi-check-agent-quota/quota-cache.json`，仅当前用户可读写；
- 自定义 `baseUrl` 仅允许 HTTPS（本机回环可用 HTTP），请求不跟随重定向；
- 默认只在用户可见事件时抓取（会话启动、切换模型、每轮结算、`/checkaq`）；若通过 `/aqauto` 开启自动刷新，pi 打开期间会按该间隔在后台自动抓取。

## License

MIT
