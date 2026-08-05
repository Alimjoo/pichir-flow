# ugASR 本地语音识别服务

ugASR 提供一个本地 WebSocket 服务，用于流式维吾尔语语音识别。每个 WebSocket 连接都有独立的会话、音频队列和转写文本，不会和其他用户的文本混在一起。

## License

中文：ugASR 仅限免费非商业使用。商业使用、转售、付费服务、付费托管、
SaaS、与付费产品捆绑或其他营利活动都必须事先取得书面许可。任何分享本应用
的人都必须清楚说明作者是 Piyazon、应用来源、是否修改过，以及本应用仅限
非商业使用。完整中英维三语许可证见 [LICENSE](LICENSE)。

ئۇيغۇرچە: ugASR ھەقسىز، پەقەت سودا بولمىغان ئىشلىتىش ئۈچۈنلا رۇخسەت قىلىنىدۇ.
سودا ئىشلىتىش، قايتا سېتىش، ھەقلىق مۇلازىمەت، ھەقلىق host، SaaS، ھەقلىق مەھسۇلاتقا
قوشۇش ياكى باشقا كىرىم قىلىش پائالىيىتى ئۈچۈن ئالدىن يېزىلغان رۇخسەت كېرەك. بۇ ئەپنى
ھەمبەھىرلىگەن كىشى ئاپتورنىڭ Piyazon ئىكەنلىكىنى، ئەپنى قەيەردىن ئالغانلىقىنى، ئۆزگەرتكەن
ياكى ئۆزگەرتىلمىگەنلىكىنى، ۋە پەقەت سودا بولمىغان ئىشلىتىشكە رۇخسەت قىلىنىدىغانلىقىنى
ئېنىق كۆرسىتىشى كېرەك.

ugASR is free for non-commercial use only. Commercial use, resale, paid
services, paid hosting, SaaS, bundling with paid products, or other revenue
activity requires prior written permission. Anyone sharing the app must clearly
state that the author is Piyazon, where they obtained the app, whether it was
modified, and that it is non-commercial only. See [LICENSE](LICENSE) for the
full non-commercial source-available license and unauthorized commercial-use
liquidated damages terms.

默认地址：

```text
ws://localhost:47831
```

客户端通过 WebSocket 发送 JSON 控制消息和二进制音频数据。服务端只把状态和识别结果返回给当前连接。

## 启动服务

在包含模型文件的目录中运行：

```bash
./ASR
```

Windows 上通常是：

```bat
ASR.exe
```

默认需要的文件：

```text
helper.model
uyghur-fast.model
```

如果使用桌面应用，应用会自动启动本地服务，一般不需要手动运行。

## 指定模型

WebSocket API 不能切换模型。服务启动时加载哪个模型，之后本次进程就使用哪个模型。

如果直接运行 `ASR`，可以在启动前指定模型路径。

macOS / Linux：

```bash
UGASR_UYGHUR_MODEL_PATH=./uyghur-fast.model ./ASR
```

Windows PowerShell：

```powershell
$env:UGASR_UYGHUR_MODEL_PATH=".\uyghur-fast.model"
.\ASR.exe
```

模型文件名保持 `.model` 结尾。

## 音频格式

音频用 WebSocket 二进制消息发送。

要求：

```text
采样率：16000 Hz
声道：单声道
格式：32-bit float
范围：-1.0 到 1.0
```

推荐每次发送 100 ms 到 1000 ms 的音频。

JavaScript 示例：

```js
ws.send(float32Pcm16k.buffer);
```

## 客户端命令

控制消息都是 JSON 文本消息。

### 开始识别

开始当前 WebSocket 连接的新会话，并清空当前连接的旧文本。

```json
{
  "type": "start",
  "maxUnconfirmedSec": 15
}
```

`maxUnconfirmedSec` 表示最多保留多少秒未确认文本，范围会限制在 3 到 20 秒之间。

模型不能通过 API 选择。模型由应用或服务启动配置决定。

### 停止识别

停止接收新的音频，并处理队列中剩余的音频。

```json
{
  "type": "stop"
}
```

### 取消识别

取消当前连接的会话，清空队列和文本。

```json
{
  "type": "cancel"
}
```

## 服务端消息

服务端消息都是 JSON 文本消息。

### 状态

```json
{
  "type": "status",
  "text": "recording"
}
```

常见状态：

```text
connected
recording
processing remaining audio
stopped
cancelled
model error
```

### 清空文本

收到这个消息时，客户端应清空当前显示的文本。

```json
{
  "type": "reset",
  "text": ""
}
```

### 未确认文本

灰色预览文本，还可能被后续结果替换。

```json
{
  "type": "unconfirmed",
  "text": "..."
}
```

### 已确认文本

最终文本，可以追加到正式转写结果中。

```json
{
  "type": "confirmed",
  "text": "..."
}
```

### 带时间戳的片段

```json
{
  "type": "segment",
  "text": "...",
  "start_ms": 1200,
  "end_ms": 4300
}
```

## 最小 JavaScript 示例

```js
const ws = new WebSocket("ws://localhost:47831");
ws.binaryType = "arraybuffer";

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg);
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "start",
    maxUnconfirmedSec: 15
  }));
};

function sendAudioChunk(float32Pcm16k) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(float32Pcm16k.buffer);
  }
}

function stop() {
  ws.send(JSON.stringify({ type: "stop" }));
}

function cancel() {
  ws.send(JSON.stringify({ type: "cancel" }));
}
```

## 文件转写流程

1. 在客户端解码音频或视频文件。
2. 转成单声道 Float32 PCM。
3. 重采样到 16000 Hz。
4. 发送 `start`。
5. 逐块发送二进制音频数据。
6. 发送 `stop`。

如果用户中途取消，发送 `cancel`。


## Build

asr:

```sh
cmake -S . -B build-vulkan -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-vulkan --config Release --parallel
```
