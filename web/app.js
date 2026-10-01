import { formatDuration, parseDeviceLine } from "./protocol.js";
import { MACRO_SLOT_COUNT } from "./macro-editor.js";
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
  slotSelect: document.querySelector('[data-testid="console-slot-select"]'),
  routineTitle: document.querySelector('[data-testid="console-routine-title"]'),
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
let activeSlot = 0;
const manualAxes = { leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
const manualStickPointers = new Map();
let lastManualStickSendAt = 0;
let manualStickPendingTimer = null;
let gamepadProtocolReady = mockMode;
let xboxPanel = null;
const manualInputState = new ManualInputState(onManualInputChange);
const macroPage = new MacroPage({
  request: requestDevice,
  isConnected: () => connected,
  isRunning: () => deviceState === "running" ||
    Boolean(xboxPanel?.active || xboxPanel?.stopping),
  refreshStatus: () => transport?.send("STATUS"),
  onSlots: (slots) => {
    const chosen = elements.slotSelect.value;
    elements.slotSelect.replaceChildren(...slots.map((slot) =>
      new Option(`${String(Number(slot.slot) + 1).padStart(2, "0")} · ${slot.name || "空槽位"}`,
        String(slot.slot))));
    elements.slotSelect.value = slots.some((slot) => String(slot.slot) === chosen &&
      slot.source !== "empty") ? chosen : String(activeSlot);
    render();
  },
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
      resetManualSticks();
      manualInputState.clear();
      deviceState = "idle";
      devicePhase = "idle";
      currentStep = 0;
    }
    render();
  },
  onDraft: (steps) => {
    macroPage.importRecording(steps);
    window.location.hash = `#/macros/${macroPage.selectedSlot + 1}`;
  },
  onError: (message) => setError(message),
});
document.querySelector('[data-testid="xbox-unavailable"]').hidden = xboxPanel.enabled;

elements.durationText.textContent = formatDuration(63595);

function setError(message = "") {
  elements.errorText.textContent = message;
  elements.errorText.hidden = !message;
}

function render() {
  const axesActive = Object.values(manualAxes).some((value) => value !== 128);
  const manualActive = connected && (activeManualControls.size > 0 || axesActive);
  const gamepadActive = connected && Boolean(xboxPanel?.active || xboxPanel?.stopping);
  const running = connected && deviceState === "running" && !manualActive && !gamepadActive;
  const selectedSummary = macroPage.summaries[Number(elements.slotSelect.value)];
  const visibleSteps = running ? stepCount :
    selectedSummary ? Number(selectedSummary.steps) : stepCount;
  elements.connectionButton.textContent = connected ? "断开设备" : "连接手柄";
  elements.connectionButton.disabled = busy || !transportSupported;
  elements.headerConnectionButton.textContent = connected ? "设备已连接" : "连接设备";
  elements.headerConnectionButton.dataset.connected = String(connected);
  elements.headerConnectionButton.disabled = busy || !transportSupported;
  elements.startButton.disabled = busy || !connected || running || manualActive ||
    gamepadActive || selectedSummary?.source === "empty";
  elements.stopButton.disabled = busy || !connected || !running;
  elements.slotSelect.disabled = busy || running || gamepadActive;
  elements.routineTitle.textContent = `${selectedSummary?.name || "素材远征"} · 自动循环`;
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
    elements.detailText.textContent = `按键 ${activeManualControls.size} 个 · ${axesActive ? "摇杆操作中" : "板载脚本已停止"}`;
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
    elements.manualStatus.textContent = axesActive ? "摇杆操作中" : `${activeManualControls.size} 个输入按下`;
    elements.manualStatus.dataset.state = "active";
  } else {
    elements.manualStatus.textContent = "触屏 / 键盘输入已启用";
    elements.manualStatus.dataset.state = "ready";
  }

  for (const stick of document.querySelectorAll("[data-manual-stick]")) {
    stick.setAttribute("aria-disabled", String(!connected || busy || gamepadActive));
  }
  elements.progress.max = Math.max(1, visibleSteps);
  elements.progress.value = running ? currentStep : 0;
  elements.stepText.textContent = running
    ? `${currentStep} / ${visibleSteps}`
    : `0 / ${visibleSteps}`;
  elements.heroSteps.textContent = `${visibleSteps} STEPS`;
  elements.factSteps.textContent = visibleSteps;
  if (!running && selectedSummary) {
    elements.durationText.textContent = formatDuration(
      Number(selectedSummary.duration_ms) + Number(selectedSummary.loop_gap_ms));
  }
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
  stepCount = Number(message.steps ?? 48);
  activeSlot = Number(message.slot) || 0;
  if (deviceState === "running") elements.slotSelect.value = String(activeSlot);
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

function resetManualSticks() {
  const changed = Object.values(manualAxes).some((value) => value !== 128);
  manualAxes.leftX = 128;
  manualAxes.leftY = 128;
  manualAxes.rightX = 128;
  manualAxes.rightY = 128;
  manualStickPointers.clear();
  if (manualStickPendingTimer !== null) {
    clearTimeout(manualStickPendingTimer);
    manualStickPendingTimer = null;
  }
  for (const stick of document.querySelectorAll("[data-manual-stick]")) {
    stick.style.setProperty("--stick-x", "0px");
    stick.style.setProperty("--stick-y", "0px");
    stick.dataset.active = "false";
    stick.setAttribute("aria-valuenow", "128");
    stick.setAttribute("aria-valuetext", "居中");
  }
  if (changed) onManualInputChange(activeManualControls);
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
  transport.send(buildManualReport(activeControls, manualAxes).command).catch((error) => {
    setError(error?.message || "手动输入发送失败");
    render();
  });
}

function onUnexpectedDisconnect(error) {
  connected = false;
  busy = false;
  resetManualSticks();
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
    const slotsLoaded = await macroPage.loadList();
    if (slotsLoaded && currentRoute === "macro-edit") macroPage.loadForRoute();
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
  resetManualSticks();
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
elements.startButton.addEventListener("click", () =>
  sendCommand(`START ${Number(elements.slotSelect.value) || 0}`));
elements.stopButton.addEventListener("click", () => sendCommand("STOP"));
elements.slotSelect.addEventListener("change", render);

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

function moveManualStick(stick, x, y, release = false) {
  const side = stick.dataset.manualStick;
  const radius = (stick.clientWidth - 55) / 2;
  const distance = Math.hypot(x, y);
  const scale = distance > radius ? radius / distance : 1;
  const dx = release ? 0 : x * scale;
  const dy = release ? 0 : y * scale;
  const axisX = release ? 128 : Math.max(0, Math.min(255,
    Math.round(128 + dx / radius * 127)));
  const axisY = release ? 128 : Math.max(0, Math.min(255,
    Math.round(128 + dy / radius * 127)));
  if (manualAxes[`${side}X`] === axisX && manualAxes[`${side}Y`] === axisY) return;
  manualAxes[`${side}X`] = axisX;
  manualAxes[`${side}Y`] = axisY;
  stick.style.setProperty("--stick-x", `${Math.round(dx)}px`);
  stick.style.setProperty("--stick-y", `${Math.round(dy)}px`);
  stick.dataset.active = String(axisX !== 128 || axisY !== 128);
  stick.setAttribute("aria-valuenow", String(axisX));
  stick.setAttribute("aria-valuetext", `横向 ${axisX}，纵向 ${axisY}`);
  const now = performance.now();
  if (release || now - lastManualStickSendAt >= 33) {
    if (manualStickPendingTimer !== null) {
      clearTimeout(manualStickPendingTimer);
      manualStickPendingTimer = null;
    }
    lastManualStickSendAt = now;
    onManualInputChange(activeManualControls);
  } else if (manualStickPendingTimer === null) {
    manualStickPendingTimer = setTimeout(() => {
      manualStickPendingTimer = null;
      lastManualStickSendAt = performance.now();
      onManualInputChange(activeManualControls);
    }, Math.max(1, 33 - (now - lastManualStickSendAt)));
  }
}

for (const stick of document.querySelectorAll("[data-manual-stick]")) {
  const locate = (event) => {
    const bounds = stick.getBoundingClientRect();
    moveManualStick(stick, event.clientX - bounds.left - bounds.width / 2,
      event.clientY - bounds.top - bounds.height / 2);
  };
  stick.addEventListener("pointerdown", (event) => {
    if (!connected || busy || xboxPanel?.active || currentRoute !== "control" ||
        (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    manualStickPointers.set(stick.dataset.manualStick, event.pointerId);
    try { stick.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
    locate(event);
  });
  stick.addEventListener("pointermove", (event) => {
    if (manualStickPointers.get(stick.dataset.manualStick) !== event.pointerId) return;
    event.preventDefault();
    locate(event);
  });
  const release = (event) => {
    if (manualStickPointers.get(stick.dataset.manualStick) !== event.pointerId) return;
    manualStickPointers.delete(stick.dataset.manualStick);
    moveManualStick(stick, 0, 0, true);
  };
  stick.addEventListener("pointerup", release);
  stick.addEventListener("pointercancel", release);
  stick.addEventListener("lostpointercapture", release);
  stick.addEventListener("keydown", (event) => {
    if (!connected || busy || currentRoute !== "control") return;
    const delta = { ArrowLeft: [-32, 0], ArrowRight: [32, 0],
      ArrowUp: [0, -32], ArrowDown: [0, 32] }[event.code];
    if (!delta && event.code !== "Home") return;
    event.preventDefault();
    event.stopPropagation();
    const side = stick.dataset.manualStick;
    const radius = (stick.clientWidth - 55) / 2;
    const x = event.code === "Home" ? 0 :
      (manualAxes[`${side}X`] - 128) / 127 * radius + delta[0] / 127 * radius;
    const y = event.code === "Home" ? 0 :
      (manualAxes[`${side}Y`] - 128) / 127 * radius + delta[1] / 127 * radius;
    moveManualStick(stick, x, y, event.code === "Home");
  });
  stick.addEventListener("keyup", (event) => {
    if (!event.code.startsWith("Arrow")) return;
    event.preventDefault();
    event.stopPropagation();
    moveManualStick(stick, 0, 0, true);
  });
}

window.addEventListener("keydown", (event) => {
  const control = KEYBOARD_BINDINGS[event.code];
  if (
    !control ||
    !connected ||
    busy ||
    xboxPanel?.active || xboxPanel?.stopping ||
    currentRoute !== "control" ||
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

window.addEventListener("blur", () => {
  resetManualSticks();
  manualInputState.clear();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    resetManualSticks();
    manualInputState.clear();
  }
});

async function renderRoute() {
  const requestedHash = window.location.hash;
  const route = window.location.hash.slice(1) || "/";
  const slotMatch = /^\/macros\/(\d+)$/.exec(route);
  const editSlot = slotMatch ? Number(slotMatch[1]) - 1 : null;
  currentRoute = editSlot !== null && editSlot >= 0 &&
    editSlot < MACRO_SLOT_COUNT ? "macro-edit" :
    route === "/macros" ? "macros" :
    route === "/control" ? "control" :
    route === "/record" ? "record" : "home";
  if (currentRoute !== "record" && (xboxPanel?.active || xboxPanel?.stopping)) {
    await xboxPanel.stop("离开控制台，直通已停止。");
    if (window.location.hash !== requestedHash) return;
  }
  if (currentRoute !== "control") {
    resetManualSticks();
    manualInputState.clear();
  }
  for (const view of document.querySelectorAll("[data-route-view]")) {
    view.hidden = view.dataset.routeView !== currentRoute;
  }
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === (currentRoute === "macro-edit" ? "macros" : currentRoute)) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  macroPage.setRoute(currentRoute, editSlot ?? macroPage.selectedSlot);
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
