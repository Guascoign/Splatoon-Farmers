import { formatDuration, parseDeviceLine } from "./protocol.js";
import {
  buildManualReport,
  KEYBOARD_BINDINGS,
  ManualInputState,
} from "./manual-input.js";
import { HttpTransport, MockSerialTransport, SerialTransport } from "./serial-transport.js";

const elements = {
  connectionButton: document.querySelector('[data-testid="connect-button"]'),
  startButton: document.querySelector('[data-testid="start-button"]'),
  stopButton: document.querySelector('[data-testid="stop-button"]'),
  statusBadge: document.querySelector('[data-testid="status-badge"]'),
  statusText: document.querySelector('[data-testid="status-text"]'),
  detailText: document.querySelector('[data-testid="detail-text"]'),
  progress: document.querySelector('[data-testid="macro-progress"]'),
  stepText: document.querySelector('[data-testid="step-text"]'),
  browserNote: document.querySelector('[data-testid="browser-note"]'),
  errorText: document.querySelector('[data-testid="error-text"]'),
  durationText: document.querySelector('[data-testid="duration-text"]'),
  manualStatus: document.querySelector('[data-testid="manual-status"]'),
};
const manualButtons = [
  ...document.querySelectorAll("button[data-control]"),
];

const mockMode = new URLSearchParams(window.location.search).get("mock") === "1";
const wifiMode = !mockMode && window.location.hostname === "192.168.9.1";
const TransportClass = mockMode ? MockSerialTransport : wifiMode ? HttpTransport : SerialTransport;
const transportSupported = TransportClass.isSupported();

let transport = null;
let connected = false;
let busy = false;
let deviceState = "unknown";
let devicePhase = "idle";
let currentStep = 0;
let stepCount = 48;
let pollTimer = null;
let activeManualControls = new Set();
const manualInputState = new ManualInputState(onManualInputChange);

elements.durationText.textContent = formatDuration(63595);

function setError(message = "") {
  elements.errorText.textContent = message;
  elements.errorText.hidden = !message;
}

function render() {
  const manualActive = connected && activeManualControls.size > 0;
  const running = connected && deviceState === "running" && !manualActive;
  elements.connectionButton.textContent = connected ? "断开设备" : "连接手柄";
  elements.connectionButton.disabled = busy || !transportSupported;
  elements.startButton.disabled = busy || !connected || running || manualActive;
  elements.stopButton.disabled = busy || !connected || !running;
  for (const button of manualButtons) {
    const pressed = activeManualControls.has(button.dataset.control);
    button.disabled = busy || !connected;
    button.classList.toggle("is-pressed", pressed);
    button.setAttribute("aria-pressed", String(pressed));
  }

  elements.statusBadge.dataset.state = connected
    ? manualActive
      ? "manual"
      : running
      ? "running"
      : "connected"
    : "disconnected";

  if (!connected) {
    elements.statusText.textContent = "未连接";
    elements.detailText.textContent =
      deviceState === "running"
        ? "控制线已断开；板载远征任务可能仍在独立运行"
        : wifiMode ? "正在连接板载控制台" : "连接 ESP32-S3 热点，或用 USB-UART 连接电脑";
  } else if (manualActive) {
    elements.statusText.textContent = "手动输入";
    elements.detailText.textContent = `已按下 ${activeManualControls.size} 个控制 · 板载脚本已停止`;
  } else if (running && devicePhase === "gap") {
    elements.statusText.textContent = "补给间隔";
    elements.detailText.textContent = `已完成 ${Math.max(
      1,
      Number(elements.statusBadge.dataset.cycle || 1),
    )} 轮 · 准备下一次素材远征`;
  } else if (running) {
    elements.statusText.textContent = "远征执行中";
    elements.detailText.textContent = `脚本在 ESP32-S3 本地执行 · 第 ${currentStep}/${stepCount} 步`;
  } else {
    elements.statusText.textContent = "已连接 · 待命";
    elements.detailText.textContent = "素材脚本已固化在 Flash，点击即可从第 1 步出发";
  }

  if (!connected) {
    elements.manualStatus.textContent = "连接后启用";
    elements.manualStatus.dataset.state = "disconnected";
  } else if (manualActive) {
    elements.manualStatus.textContent = `${activeManualControls.size} 个输入按下`;
    elements.manualStatus.dataset.state = "active";
  } else {
    elements.manualStatus.textContent = "触屏 / 键盘输入已启用";
    elements.manualStatus.dataset.state = "ready";
  }

  elements.progress.max = stepCount;
  elements.progress.value = running ? currentStep : 0;
  elements.stepText.textContent = running
    ? `${currentStep} / ${stepCount}`
    : `0 / ${stepCount}`;
}

function applyDeviceMessage(message) {
  if (!message || message.ok === false) {
    if (message?.message) {
      setError(message.message);
    }
    return;
  }
  if (message.type !== "info" && message.type !== "status") {
    return;
  }

  deviceState = message.state === "running" ? "running" : "idle";
  devicePhase = message.phase || "idle";
  currentStep = Number(message.step) || 0;
  stepCount = Number(message.steps) || 48;
  elements.statusBadge.dataset.cycle = String(Number(message.cycle) || 0);
  if (Number.isFinite(message.cycle_ms)) {
    elements.durationText.textContent = formatDuration(message.cycle_ms);
  }
  setError();
  render();
}

function onLine(line) {
  applyDeviceMessage(parseDeviceLine(line));
}

function onManualInputChange(activeControls) {
  activeManualControls = activeControls;
  if (connected) {
    deviceState = "idle";
    devicePhase = "idle";
    currentStep = 0;
    setError();
  }
  render();

  if (!connected || !transport) {
    return;
  }
  transport.send(buildManualReport(activeControls).command).catch((error) => {
    setError(error?.message || "手动输入发送失败");
    render();
  });
}

function onUnexpectedDisconnect(error) {
  connected = false;
  busy = false;
  clearInterval(pollTimer);
  pollTimer = null;
  manualInputState.clear();
  setError(error?.message || "设备连接意外断开");
  render();
}

async function connect() {
  busy = true;
  setError();
  render();
  transport = new TransportClass({
    onLine,
    onDisconnect: onUnexpectedDisconnect,
  });
  try {
    await transport.connect();
    connected = true;
    await transport.send("HELLO");
    pollTimer = window.setInterval(() => {
      transport?.send("STATUS").catch(onUnexpectedDisconnect);
    }, 1000);
  } catch (error) {
    connected = false;
    transport = null;
    setError(error?.message || "无法连接设备");
  } finally {
    busy = false;
    render();
  }
}

async function disconnect() {
  busy = true;
  clearInterval(pollTimer);
  pollTimer = null;
  manualInputState.clear();
  render();
  try {
    await transport?.disconnect();
  } catch (error) {
    setError(error?.message || "断开设备时发生错误");
  } finally {
    connected = false;
    transport = null;
    busy = false;
    render();
  }
}

async function sendCommand(command) {
  busy = true;
  setError();
  render();
  try {
    await transport.send(command);
  } catch (error) {
    setError(error?.message || "指令发送失败");
  } finally {
    busy = false;
    render();
  }
}

elements.connectionButton.addEventListener("click", () => {
  if (connected) {
    disconnect();
  } else {
    connect();
  }
});
elements.startButton.addEventListener("click", () => sendCommand("START"));
elements.stopButton.addEventListener("click", () => sendCommand("STOP"));

function pointerSource(pointerId) {
  return `pointer:${pointerId}`;
}

for (const button of manualButtons) {
  const control = button.dataset.control;
  button.addEventListener("pointerdown", (event) => {
    if (
      !connected ||
      busy ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    event.preventDefault();
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; window blur still releases all controls.
    }
    manualInputState.press(pointerSource(event.pointerId), control);
  });

  const releasePointer = (event) => {
    manualInputState.release(pointerSource(event.pointerId));
  };
  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", releasePointer);
  button.addEventListener("contextmenu", (event) => event.preventDefault());

  button.addEventListener("keydown", (event) => {
    if (
      !connected ||
      busy ||
      (event.code !== "Space" && event.code !== "Enter")
    ) {
      return;
    }
    event.preventDefault();
    manualInputState.press(
      `button:${control}:${event.code}`,
      control,
    );
  });
  button.addEventListener("keyup", (event) => {
    if (event.code !== "Space" && event.code !== "Enter") {
      return;
    }
    event.preventDefault();
    manualInputState.release(`button:${control}:${event.code}`);
  });
  button.addEventListener("blur", () => {
    manualInputState.release(`button:${control}:Space`);
    manualInputState.release(`button:${control}:Enter`);
  });
}

window.addEventListener("keydown", (event) => {
  const control = KEYBOARD_BINDINGS[event.code];
  if (
    !control ||
    !connected ||
    busy ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  manualInputState.press(`keyboard:${event.code}`, control);
});

window.addEventListener("keyup", (event) => {
  const source = `keyboard:${event.code}`;
  if (!manualInputState.hasSource(source)) {
    return;
  }
  event.preventDefault();
  manualInputState.release(source);
});

window.addEventListener("blur", () => manualInputState.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    manualInputState.clear();
  }
});

if (!transportSupported) {
  elements.connectionButton.disabled = true;
  elements.browserNote.textContent =
    "当前浏览器不支持 Web Serial。请用桌面版 Chrome 或 Edge，并通过 localhost 打开本页。";
  elements.browserNote.dataset.warning = "true";
} else if (mockMode) {
  elements.browserNote.textContent =
    "DEMO MODE · 正在使用模拟串口，不会连接真实设备";
} else if (wifiMode) {
  elements.browserNote.textContent =
    "已通过 ESP32-S3-Switch 热点访问 · 手机触屏可直接控制";
} else {
  elements.browserNote.textContent =
    "手机可连接 ESP32-S3-Switch 热点并访问 http://192.168.9.1";
}

render();
if (wifiMode) {
  connect();
}
