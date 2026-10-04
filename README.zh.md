# pi-notify-kde

pi 需要你的时候通知你：**KDE 桌面通知** + 通过 **KDE Connect 推到手机**。

pi 本身没有桌面通知。所以起了个长任务、走开、十分钟后回来，才发现 pi 四秒就跑完了 ——
或者它从那时候起就一直挂在一个问题上等你。

> English: [README.md](README.md)

这个扩展盯着两个「球确实在你这边」的时刻：

- **整轮真正结束** —— 重试、自动压缩、排队的跟进都跑完之后；
- **弹出阻塞式提问** —— quiz、确认框、选择框，pi 正卡在那里等你。

## 长什么样

```
pi · pi-notify-kde · auth-refactor
✅ 跑完了 · 4 分 12 秒
改写了 token 刷新路径，并为过期边界补了测试。

pi · steward · nightly-audit
⏳ pi 挂着等你 · 要你确认：应用这 3 个包升级？
```

手机上收到的是同样内容的 KDE Connect ping（一条通知 + 震动）。

## 默认很安静

没人想因为一句「这个的时间复杂度是多少」被手机震一下：

- 非交互式运行（`pi -p`、`--mode json`、subagent 子进程）不提醒；
- 整轮耗时不足 `minDurationMs`（默认 **30 秒**）不提醒；
- 你按 Esc 中断的那一轮不提醒 —— 你显然就在键盘前；
- 提问要挂了 `uiPromptDelayMs`（默认 **8 秒**）才提醒；
- 你**一打字就把通知撤回**，人回来了屏幕上不留东西。

## 依赖

| | |
|---|---|
| 调用 | `notify-send`（libnotify）发桌面通知 |
| 调用 | `kdeconnect-cli` 推手机 —— 仅当 `kdeconnect: true` |
| 会话 | 有 DBus session bus 的桌面会话 |
| pi | 任意暴露 `agent_settled` / `ui_prompt_start` / `input` 的版本 |

桌面通知部分适用于任何有 libnotify 的 Linux 桌面；推手机需要手机装 KDE Connect。
没有 `kdeconnect-cli` 时会跳过推送（日志里能看到）；设 `"kdeconnect": false` 就不再尝试。

## 安装

作为 pi 包：

```sh
pi install git:github.com/Ahrunda/pi-notify-kde
```

或者直接把单文件放进去：

```sh
git clone https://github.com/Ahrunda/pi-notify-kde
cd pi-notify-kde && ./install.sh
```

`install.sh` 把 `extensions/notify-kde.ts` 复制到 `~/.pi/agent/extensions/notify-kde.ts`，
原有文件先备份成 `.bak`。撤销：`rm ~/.pi/agent/extensions/notify-kde.ts`。

> **两种方式只能选一种。** `install.sh` 装的是*个人扩展文件*，`pi install` 注册的是*包*。
> pi 两者都会加载，所以同时做会跑两遍、每条通知收到两次。
> 撤掉包那份：`pi remove git:github.com/Ahrunda/pi-notify-kde`。

然后在 pi 里：

```
/notify-kde test
```

## 配置

`~/.pi/agent/notify-kde.json` 首次运行时生成，每次发通知都会重新读，新版本新增的键会自动补齐
（先备份成 `.bak`）。

```json
{
  "locale": "zh",
  "minDurationMs": 30000,
  "urgency": "normal",
  "coalesce": true,
  "dismissOnReturn": true,
  "kdeconnect": true,
  "kdeconnectDevices": [],
  "includeSnippet": true
}
```

每个键的说明见 **[docs/configuration.md](docs/configuration.md)**。

## 命令

| 命令 | 作用 |
|---|---|
| `/notify-kde` | 当前生效配置、有没有找到 session bus、上次手机投递结果 |
| `/notify-kde test` | 立刻发一条测试通知 |
| `/notify-kde on` / `off` | 切总开关（写回配置，先备份） |

## 手机推送是怎么工作的，以及什么时候不工作

KDE Connect 没有「推送任意通知」的接口，等价物是 `kdeconnect-cli --ping-msg` ——
让手机弹通知并震动。它要求手机**此刻可达**。

一个都不可达时，扩展会让 `kdeconnectd` 重搜网络并**轮询**几秒，然后把结果写进桌面通知，
而不是静默失败。轮询是刻意的：`--refresh` 4 毫秒就返回，设备要几秒后才出现，
所以 refresh 之后只查一次读到的必然是旧缓存、永远查不到。这条以及其它实测行为写在
**[docs/measurements.md](docs/measurements.md)**。

最常见的真实故障根本不是缓存问题：在后台省电策略激进的手机上（小米/HyperOS 等），
**锁屏会把 KDE Connect 杀掉**，手机就是彻底不在网络上，直到它醒来。这只能在手机上解决 ——
见 **[docs/troubleshooting.md](docs/troubleshooting.md)**。

## 已知限制

- 只支持 Linux/KDE。它调用 `notify-send` 和 `kdeconnect-cli`；逻辑本身不绑 KDE，
  但没有实现别的后端（macOS/Windows 后端欢迎 PR）。
- 不能点击聚焦终端。通知服务器宣告了 `actions` 能力，但在 Wayland 上可靠地聚焦到正确的终端
  窗口超出本扩展的范围。
- `includeSnippet: true` 时，最后一条回复的首行会被复制进通知并送到手机。
  如果这可能把敏感内容放到锁屏上，关掉它。

## 开发

```sh
npm install
npm test          # node --test，只测纯函数
npm run typecheck # tsc --noEmit，对着真实的 pi 类型检查
```

`test/pure.test.ts` 直接 import 扩展模块（它唯一的 pi import 是 type-only 的），
并且对每个修过的 bug 都留了一条**区分性断言** —— 那个 bug 一旦回来，测试就红。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
