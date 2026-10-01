import { formatDuration, parseDeviceLine } from "./protocol.js";
import {
  buildManualReport,
  KEYBOARD_BINDINGS,
  ManualInputState,
} from "./manual-input.js";
import { HttpTransport, MockSerialTransport, SerialTransport } from "./serial-transport.js";
import { MacroPage } from "./macro-page.js";
import { XboxPanel } from "./xbox-panel.js";

const elements = {
  connectionButton: document.querySelector('[data-testid="connect-button"]'),
  headerConnectionButton: document.querySelector('[data-testid="header-connect-button"]'),
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
  heroSteps: document.querySelector('[data-testid="hero-steps"]'),
  factSteps: document.querySelector('[data-testid="macro-fact-steps"]'),
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
let pendingReply = null;
let currentRoute = "home";
let gamepadProtocolReady = mockMode;
let xboxPanel = null;
const manualInputState = new ManualInputState(onManualInputChange);
const macroPage = new MacroPage({
  request: requestDevice,
  isConnected: () => connected,
  isRunning: () => deviceState === "running" ||
    Boolean(xboxPanel?.active || xboxPanel?.stopping),
  refreshStatus: () => transport?.send("STATUS"),
});
xboxPanel = new XboxPanel({
  enabled: !wifiMode && typeof navigator.getGamepads === "function",
  isConnected: () => connected,
  isFirmwareReady: () => gamepadProtocolReady,
  isBusy: () => busy || macroPage.busy,
  isRunning: () => deviceState === "running",
  send: (command) => connected && transport
    ? transport.send(command) : Promise.reject(new Error("设备连接已断开")),
  flush: () => requestDevice("PING", "pong"),
  onState: (active) => {
    if (active) {
      manualInputState.clear();
      deviceState = "idle";
      devicePhase = "idle";
      currentStep = 0;
    }
    render();
  },
  onDraft: (steps) => {
    macroPage.importRecording(steps);
    window.location.hash = "#/macros/1";
  },
  onError: (message) => setError(message),
});

elements.durationText.textContent = formatDuration(63595);

function setError(message = "") {
  elements.errorText.textContent = message;
  elements.errorText.hidden = !message;
}

function render() {
  const manualActive = connected && activeManualControls.size > 0;
  const gamepadActive = connected && Boolean(xboxPanel?.active || xboxPanel?.stopping);
  const running = connected && deviceState === "running" && !manualActive && !gamepadActive;
  elements.connectionButton.textContent = connected ? "断开设备" : "连接手柄";
  elements.connectionButton.disabled = busy || !transportSupported;
  elements.headerConnectionButton.textContent = connected ? "设备已连接" : "连接设备";
  elements.headerConnectionButton.dataset.connected = String(connected);
  elements.headerConnectionButton.disabled = busy || !transportSupported;
  elements.startButton.disabled = busy || !connected || running || manualActive || gamepadActive;
  elements.stopButton.disabled = busy || !connected || !running;
  for (const button of manualButtons) {
    const pressed = activeManualControls.has(button.dataset.control);
    button.disabled = busy || !connected || gamepadActive;
    button.classList.toggle("is-pressed", pressed);
    button.setAttribute("aria-pressed", String(pressed));
  }

  elements.statusBadge.dataset.state = connected
    ? gamepadActive || manualActive
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
  } else if (gamepadActive) {
    elements.statusText.textContent = xboxPanel.recording ? "手柄录制中" : "Xbox 手柄直通";
    elements.detailText.textContent = "电脑正在把 Xbox 操作映射为 Switch 手柄输入";
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
  } else if (gamepadActive) {
    elements.manualStatus.textContent = "Xbox 手柄正在接管";
    elements.manualStatus.dataset.state = "active";
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
  elements.heroSteps.textContent = `${stepCount} STEPS`;
  elements.factSteps.textContent = stepCount;
  macroPage.renderControls();
  xboxPanel?.render();
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

  if (typeof message.firmware === "string") {
    const version = /^SplatoonFarmers\/(\d+)\.(\d+)\./.exec(message.firmware);
    gamepadProtocolReady = mockMode || Boolean(version &&
      (Number(version[1]) > 1 ||
       (Number(version[1]) === 1 && Number(version[2]) >= 3)));
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
  const message = parseDeviceLine(line);
  if (!message) return;
  if (pendingReply) {
    if (message.type === "error") {
      const pending = pendingReply;
      pendingReply = null;
      clearTimeout(pending.timer);
      pending.reject(new Error(message.message));
    } else if (message.type === pendingReply.expected) {
      const pending = pendingReply;
      pendingReply = null;
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }
  applyDeviceMessage(message);
}

function requestDevice(command, expected) {
  if (!connected || !transport) return Promise.reject(new Error("请先连接设备。"));
  if (pendingReply) return Promise.reject(new Error("设备正在处理上一条命令。"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingReply = null;
      reject(new Error("设备响应超时，请确认连接后重试。"));
    }, 10000);
    pendingReply = { expected, resolve, reject, timer };
    transport.send(command).catch((error) => {
      if (pendingReply?.timer === timer) {
        pendingReply = null;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function rejectPendingReply(message) {
  if (!pendingReply) return;
  const pending = pendingReply;
  pendingReply = null;
  clearTimeout(pending.timer);
  pending.reject(new Error(message));
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

  if (!connected || !transport || xboxPanel?.active || xboxPanel?.stopping) {
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
  xboxPanel?.stop("串口已断开，录制草稿仍可预览。");
  rejectPendingReply("设备连接已断开。");
  clearInterval(pollTimer);
  pollTimer = null;
  manualInputState.clear();
  macroPage.setConnection();
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
    macroPage.setConnection();
    xboxPanel.render();
    pollTimer = window.setInterval(() => {
      if (!pendingReply && !macroPage.busy) {
        transport?.send("STATUS").catch(onUnexpectedDisconnect);
      }
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
  await xboxPanel?.stop("直通已停止，录制草稿仍可预览。");
  clearInterval(pollTimer);
  pollTimer = null;
  manualInputState.clear();
  connected = false;
  rejectPendingReply("设备已断开。");
  render();
  try {
    await transport?.disconnect();
  } catch (error) {
    setError(error?.message || "断开设备时发生错误");
  } finally {
    connected = false;
    transport = null;
    busy = false;
    macroPage.setConnection();
    xboxPanel.render();
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

function toggleConnection() {
  if (connected) {
    disconnect();
  } else {
    connect();
  }
}
elements.connectionButton.addEventListener("click", toggleConnection);
elements.headerConnectionButton.addEventListener("click", toggleConnection);
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
    xboxPanel?.active || xboxPanel?.stopping ||
    currentRoute !== "home" ||
    event.target?.closest?.("input,select,textarea,[contenteditable]") ||
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

async function renderRoute() {
  const requestedHash = window.location.hash;
  const route = window.location.hash.slice(1) || "/";
  currentRoute = route === "/macros/1" ? "macro-edit" :
    route === "/macros" ? "macros" : "home";
  if (currentRoute !== "home" && (xboxPanel?.active || xboxPanel?.stopping)) {
    await xboxPanel.stop("离开控制台，直通已停止。");
    if (window.location.hash !== requestedHash) return;
  }
  if (currentRoute !== "home") manualInputState.clear();
  for (const view of document.querySelectorAll("[data-route-view]")) {
    view.hidden = view.dataset.routeView !== currentRoute;
  }
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === (currentRoute === "home" ? "home" : "macros")) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  macroPage.setRoute(currentRoute);
}
window.addEventListener("hashchange", renderRoute);

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
renderRoute();
if (wifiMode) {
  connect();
}
