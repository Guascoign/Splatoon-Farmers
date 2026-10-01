import { formatDuration, parseDeviceLine } from "./protocol.js";
import {
  buildManualReport,
  KEYBOARD_BINDINGS,
  ManualInputState,
} from "./manual-input.js";
import { HttpTransport, MockSerialTransport, SerialTransport } from "./serial-transport.js";
import { MacroPage } from "./macro-page.js";
import { XboxPanel } from "./xbox-panel.js";
import { TaskPage } from "./task-page.js";
import { SettingsPage } from "./settings-page.js";

const elements = {
  connectionButton: document.querySelector('[data-testid="connect-button"]'),
  headerConnectionButton: document.querySelector('[data-testid="header-connect-button"]'),
  startButton: document.querySelector('[data-testid="start-button"]'),
  pauseButton: document.querySelector('[data-testid="pause-button"]'),
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
  runType: document.querySelector('[data-testid="console-run-type"]'),
  taskSelect: document.querySelector('[data-testid="console-task-select"]'),
  taskPicker: document.querySelector('[data-testid="console-task-picker"]'),
  slotPicker: document.querySelector('[data-testid="console-slot-picker"]'),
  taskList: document.querySelector('[data-testid="console-task-list"]'),
  taskEntries: document.querySelector('[data-testid="console-task-entries"]'),
  taskProgress: document.querySelector('[data-testid="console-task-progress"]'),
  macroCycles: document.querySelector('[data-testid="console-macro-cycles"]'),
  runDuration: document.querySelector('[data-testid="console-run-duration"]'),
  taskProgressBlock: document.querySelector('[data-testid="task-progress-block"]'),
  taskProgressBar: document.querySelector('[data-testid="task-progress"]'),
  taskStepText: document.querySelector('[data-testid="task-step-text"]'),
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
let stepCount = 0;
let pollTimer = null;
let activeManualControls = new Set();
let manualReportActive = false;
let manualReportPromise = Promise.resolve();
let pendingReply = null;
let requestQueue = Promise.resolve();
let queuedRequests = 0;
let currentRoute = "home";
let activeSlot = 0;
let activeMode = "macro";
let activeTask = -1;
let taskEntry = 0;
let taskEntries = 0;
let taskRepeat = 0;
let taskRepeats = 0;
let taskLoop = 0;
let runMs = 0;
let currentCycles = 0;
const manualAxes = { leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
const manualStickPointers = new Map();
let lastManualStickSendAt = 0;
let manualStickPendingTimer = null;
let gamepadProtocolReady = mockMode;
let xboxPanel = null;
const manualInputState = new ManualInputState(onManualInputChange);
const routineActive = () => deviceState === "running" || deviceState === "paused";
const macroPage = new MacroPage({
  request: requestDevice,
  isConnected: () => connected,
  isRunning: () => routineActive() ||
    Boolean(xboxPanel?.active || xboxPanel?.stopping),
  refreshStatus: () => transport?.send("STATUS"),
  onSlots: (slots) => {
    const chosen = elements.slotSelect.value;
    const occupied = slots.filter((slot) => slot.source !== "empty");
    elements.slotSelect.replaceChildren(...occupied.map((slot) =>
      new Option(`${String(Number(slot.slot) + 1).padStart(2, "0")} · ${slot.name || "未命名宏"}`,
        String(slot.slot))));
    const fallback = occupied[0]?.slot;
    elements.slotSelect.value = occupied.some((slot) => String(slot.slot) === chosen)
      ? chosen : String(occupied.some((slot) => Number(slot.slot) === activeSlot)
        ? activeSlot : (fallback ?? ""));
    taskPage.setSlots(slots);
    taskPage.setStorage(macroPage.storageUsed, macroPage.storageTotal);
    render();
  },
});
const taskPage = new TaskPage({
  request: requestDevice,
  isConnected: () => connected,
  isRunning: routineActive,
  onTasks: (tasks) => {
    const chosen = elements.taskSelect.value;
    const available = tasks.filter((task) => task.exists !== false);
    const activeChoice = routineActive() && activeMode === "task" &&
      available.some((task) => Number(task.id) === activeTask)
      ? String(activeTask) : null;
    elements.taskSelect.replaceChildren(...available.map((task) =>
      new Option(`${String(task.id + 1).padStart(2, "0")} · ${task.name}`, String(task.id))));
    elements.taskSelect.value = activeChoice ?? (available.some((task) => String(task.id) === chosen)
      ? chosen : String(available[0]?.id ?? ""));
    elements.taskList.replaceChildren(...available.map((task) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.taskId = String(task.id);
      button.textContent = `${String(task.id + 1).padStart(2, "0")} · ${task.name} · ${task.entries.length} 步`;
      return button;
    }));
    if (!available.length) elements.taskList.textContent = "尚无任务列表。";
    render();
  },
});
const settingsPage = new SettingsPage({
  request: requestDevice,
  isConnected: () => connected,
  slots: () => macroPage.summaries,
  tasks: () => taskPage.tasks,
  macroPage,
  taskPage,
  onImported: async () => {
    await macroPage.loadList();
    await taskPage.loadList();
    await settingsPage.load();
  },
});
xboxPanel = new XboxPanel({
  enabled: !wifiMode && typeof navigator.getGamepads === "function",
  isConnected: () => connected,
  isFirmwareReady: () => gamepadProtocolReady,
  isBusy: () => busy || macroPage.busy,
  isRunning: routineActive,
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

function taskExecutionProgress(task, entryNumber, repeatNumber) {
  if (!Array.isArray(task?.entries) || !task.entries.length ||
      !Number.isInteger(entryNumber) || entryNumber < 1 ||
      entryNumber > task.entries.length) return null;
  let total = 0;
  let beforeCurrentEntry = 0;
  for (const [index, entry] of task.entries.entries()) {
    const repeats = Number(entry?.[1]);
    if (!Number.isSafeInteger(repeats) || repeats < 1) return null;
    total += repeats;
    if (index < entryNumber - 1) beforeCurrentEntry += repeats;
  }
  if (!Number.isSafeInteger(total)) return null;
  const currentRepeats = Number(task.entries[entryNumber - 1][1]);
  const current = beforeCurrentEntry + Math.min(currentRepeats,
    Math.max(1, repeatNumber));
  return { current, total };
}

function renderTaskEntries(task, showCurrent) {
  if (!task?.exists || !Array.isArray(task.entries) || !task.entries.length) {
    elements.taskEntries.textContent = "选择任务后查看执行顺序与次数。";
    return;
  }
  const total = task.entries.reduce((sum, entry) => sum + (Number(entry[1]) || 0), 0);
  const heading = document.createElement("h3");
  heading.textContent = `${task.name} · ${total} 次宏执行`;
  const list = document.createElement("ol");
  for (const [index, entry] of task.entries.entries()) {
    const slotNumber = Number(entry[0]);
    const summary = macroPage.summaries.find((item) => Number(item.slot) === slotNumber);
    const item = document.createElement("li");
    const slotName = document.createElement("span");
    slotName.textContent = `${String(index + 1).padStart(2, "0")} · ${summary?.name || `槽位 ${String(slotNumber + 1).padStart(2, "0")}`}`;
    const repeats = document.createElement("strong");
    repeats.textContent = `× ${entry[1]} 次`;
    item.append(slotName, repeats);
    if (showCurrent && taskEntry === index + 1) {
      item.dataset.active = "true";
      const current = document.createElement("small");
      current.textContent = `${!connected ? "断开前" : deviceState === "paused" ? "已暂停" : "进行中"} ${taskRepeat}/${entry[1]}`;
      item.append(current);
    }
    list.append(item);
  }
  elements.taskEntries.replaceChildren(heading, list);
}

function render() {
  const axesActive = Object.values(manualAxes).some((value) => value !== 128);
  const manualActive = connected && (activeManualControls.size > 0 || axesActive);
  const gamepadActive = connected && Boolean(xboxPanel?.active || xboxPanel?.stopping);
  const running = connected && routineActive() && !manualActive && !gamepadActive;
  const showRoutineProgress = running || (!connected && routineActive());
  const paused = running && deviceState === "paused";
  const taskSelected = elements.runType.value === "task";
  const selectedTask = taskPage.tasks.find((task) => Number(task.id) === Number(elements.taskSelect.value));
  const executingTask = taskPage.tasks.find((task) => Number(task.id) === activeTask);
  const taskProgress = showRoutineProgress && activeMode === "task"
    ? taskExecutionProgress(executingTask, taskEntry, taskRepeat) : null;
  const selectedSummary = macroPage.summaries.find((summary) => Number(summary.slot) === Number(
    taskSelected ? (selectedTask?.entries?.[0]?.[0] ?? -1) : Number(elements.slotSelect.value)));
  const visibleSteps = showRoutineProgress ? stepCount :
    selectedSummary ? Number(selectedSummary.steps) : stepCount;
  elements.connectionButton.textContent = connected ? "断开设备" : "连接手柄";
  elements.connectionButton.disabled = busy || !transportSupported;
  elements.headerConnectionButton.textContent = connected ? "设备已连接" : "连接设备";
  elements.headerConnectionButton.dataset.connected = String(connected);
  elements.headerConnectionButton.disabled = busy || !transportSupported;
  elements.startButton.disabled = busy || !connected || running || manualActive ||
    gamepadActive || (taskSelected ? !selectedTask?.exists : !selectedSummary || selectedSummary.source === "empty");
  elements.pauseButton.disabled = busy || !connected || !running;
  elements.pauseButton.textContent = paused ? "恢复" : "暂停";
  elements.stopButton.disabled = busy || !connected || !running;
  elements.stopButton.textContent = activeMode === "task" ? "停止任务" : "停止宏";
  elements.slotSelect.disabled = busy || running || gamepadActive;
  elements.taskSelect.disabled = busy || running || gamepadActive;
  elements.runType.disabled = busy || running || gamepadActive;
  elements.slotPicker.hidden = taskSelected;
  elements.taskPicker.hidden = !taskSelected;
  elements.routineTitle.textContent = `${taskSelected ? selectedTask?.name || "任务列表" : selectedSummary?.name || "素材远征"} · 自动循环`;
  elements.macroCycles.textContent = String(showRoutineProgress && activeMode === "task" ? taskRepeat : currentCycles);
  elements.runDuration.textContent = `${String(Math.floor(runMs / 3600000)).padStart(2, "0")}:${String(Math.floor(runMs / 60000) % 60).padStart(2, "0")}:${String(Math.floor(runMs / 1000) % 60).padStart(2, "0")}`;
  elements.taskProgress.hidden = !(showRoutineProgress && activeMode === "task");
  elements.taskProgressBlock.hidden = !(showRoutineProgress && activeMode === "task");
  elements.taskProgressBar.max = taskProgress?.total || 1;
  elements.taskProgressBar.value = taskProgress?.current || 0;
  elements.taskStepText.textContent = showRoutineProgress && activeMode === "task"
    ? taskProgress ? `${(taskProgress.current / taskProgress.total * 100).toFixed(1)}%` : "读取任务中"
    : "0%";
  if (!elements.taskProgress.hidden) elements.taskProgress.textContent =
    `任务第 ${taskEntry}/${taskEntries} 步 · 当前宏第 ${taskRepeat}/${taskRepeats} 次` +
    (taskProgress ? ` · 本轮 ${taskProgress.current}/${taskProgress.total} 次宏执行` : "") +
    ` · 整组完成 ${taskLoop} 轮`;
  renderTaskEntries(selectedTask, showRoutineProgress && activeMode === "task" &&
    Number(selectedTask?.id) === activeTask);
  for (const button of elements.taskList.querySelectorAll("[data-task-id]")) {
    button.dataset.selected = String(elements.taskSelect.value === button.dataset.taskId && taskSelected);
    button.disabled = running || busy;
  }
  for (const button of manualButtons) {
    const pressed = activeManualControls.has(button.dataset.control);
    button.disabled = busy || !connected || gamepadActive;
    button.classList.toggle("is-pressed", pressed);
    button.setAttribute("aria-pressed", String(pressed));
  }

  elements.statusBadge.dataset.state = connected
    ? gamepadActive || manualActive
      ? "manual"
      : paused
      ? "paused"
      : running
      ? "running"
      : "connected"
    : "disconnected";

  if (!connected) {
    elements.statusText.textContent = "未连接";
    elements.detailText.textContent =
      deviceState === "running"
        ? "控制线已断开；板载远征任务可能仍在独立运行"
        : deviceState === "paused"
        ? "控制线已断开；板载远征任务可能仍保持暂停"
        : wifiMode ? "正在连接板载控制台" : "连接 ESP32-S3 热点，或用 USB-UART 连接电脑";
  } else if (gamepadActive) {
    elements.statusText.textContent = xboxPanel.recording ? "手柄录制中" : "手柄直通";
    elements.detailText.textContent = "电脑正在把输入手柄映射为 Switch 手柄输入";
  } else if (manualActive) {
    elements.statusText.textContent = "手动输入";
    elements.detailText.textContent = `按键 ${activeManualControls.size} 个 · ${axesActive ? "摇杆操作中" : "板载脚本已停止"}`;
  } else if (paused) {
    elements.statusText.textContent = "任务已暂停";
    elements.detailText.textContent = `板载执行暂停于第 ${currentStep}/${stepCount} 步，点击恢复继续`;
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
  elements.progress.value = showRoutineProgress ? currentStep : 0;
  elements.stepText.textContent = showRoutineProgress
    ? `${currentStep} / ${visibleSteps}`
    : `0 / ${visibleSteps}`;
  elements.heroSteps.textContent = visibleSteps > 0 ? `${visibleSteps} STEPS` : "DYNAMIC STEPS";
  elements.factSteps.textContent = visibleSteps;
  if (!showRoutineProgress && selectedSummary) {
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

  const previousState = deviceState;
  deviceState = message.state === "running" || message.state === "paused"
    ? message.state : "idle";
  if (routineActive()) manualReportActive = false;
  if (previousState !== deviceState) taskPage.render();
  devicePhase = message.phase || "idle";
  currentStep = Number(message.step) || 0;
  stepCount = Number(message.steps ?? 0);
  activeSlot = Number(message.slot) || 0;
  activeMode = message.mode || "macro";
  activeTask = Number(message.task ?? -1);
  taskEntry = Number(message.task_entry) || 0;
  taskEntries = Number(message.task_entries) || 0;
  taskRepeat = Number(message.task_repeat) || 0;
  taskRepeats = Number(message.task_repeats) || 0;
  taskLoop = Number(message.task_loop) || 0;
  runMs = Number(message.run_ms) || 0;
  currentCycles = Number(message.cycle) || 0;
  if (routineActive()) elements.slotSelect.value = String(activeSlot);
  if (routineActive() && activeMode === "task" && activeTask >= 0) {
    elements.runType.value = "task";
    elements.taskSelect.value = String(activeTask);
  }
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

function requestDevice(command, expected, timeoutMs = 10000) {
  if (!connected || !transport) return Promise.reject(new Error("请先连接设备。"));
  const requestedTransport = transport;
  queuedRequests += 1;
  const perform = () => {
    if (!connected || transport !== requestedTransport) {
      throw new Error("设备连接已断开。");
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingReply = null;
        reject(new Error("设备响应超时，请确认连接后重试。"));
      }, timeoutMs);
      pendingReply = { expected, resolve, reject, timer };
      requestedTransport.send(command).catch((error) => {
        if (pendingReply?.timer === timer) {
          pendingReply = null;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  };
  const result = requestQueue.then(perform, perform);
  requestQueue = result.catch(() => {});
  return result.finally(() => { queuedRequests -= 1; });
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
  const hasInput = activeControls.size > 0 ||
    Object.values(manualAxes).some((value) => value !== 128);
  if (!hasInput && !manualReportActive) {
    render();
    return;
  }
  if (connected) {
    deviceState = "idle";
    devicePhase = "idle";
    currentStep = 0;
    setError();
  }
  render();

  if (!connected || !transport || xboxPanel?.active || xboxPanel?.stopping) {
    manualReportActive = false;
    return;
  }
  manualReportActive = hasInput;
  manualReportPromise = transport.send(buildManualReport(activeControls, manualAxes).command).catch((error) => {
    setError(error?.message || "手动输入发送失败");
    render();
  });
}

function onUnexpectedDisconnect(error) {
  const disconnectedTransport = transport;
  transport = null;
  connected = false;
  busy = true;
  resetManualSticks();
  xboxPanel?.stop("串口已断开，录制草稿仍可预览。");
  rejectPendingReply("设备连接已断开。");
  clearInterval(pollTimer);
  pollTimer = null;
  manualInputState.clear();
  manualReportActive = false;
  macroPage.setConnection();
  taskPage.setConnection();
  setError(error?.message || "设备连接意外断开");
  render();
  Promise.resolve().then(() => disconnectedTransport?.disconnect()).catch(() => {
    // The physical port may already be gone. Local controls can reconnect.
  }).finally(() => {
    busy = false;
    render();
  });
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
    // Opening USB-UART can briefly toggle DTR/RTS and reset ESP32 boards.
    // Give setup() time to finish, then retry the handshake because a HELLO
    // written during that reset is discarded by the UART peripheral.
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
    let helloError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await requestDevice("HELLO", "info", 2200);
        helloError = null;
        break;
      } catch (error) {
        helloError = error;
        if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    if (helloError) throw helloError;
    xboxPanel.render();
    pollTimer = window.setInterval(() => {
      if (connected && !pendingReply && queuedRequests === 0 && !macroPage.busy) {
        requestDevice("STATUS", "status").catch((error) => {
          if (connected) onUnexpectedDisconnect(error);
        });
      }
    }, 1000);
    const connectedTransport = transport;
    window.setTimeout(async () => {
      if (!connected || transport !== connectedTransport) return;
      const slotsLoaded = await macroPage.loadList();
      if (!connected || transport !== connectedTransport) return;
      await taskPage.loadList();
      if (currentRoute === "settings") await settingsPage.load();
      if (slotsLoaded && currentRoute === "macro-edit") macroPage.loadForRoute();
    }, 0);
  } catch (error) {
    connected = false;
    try { await transport?.disconnect(); } catch { /* The port may already be gone. */ }
    transport = null;
    setError(error?.message || "无法连接设备");
  } finally {
    busy = false;
    render();
  }
}

async function disconnect() {
  busy = true;
  render();
  const boardRoutineActive = routineActive();
  if (boardRoutineActive) connected = false;
  await xboxPanel?.stop("直通已停止，录制草稿仍可预览。");
  clearInterval(pollTimer);
  pollTimer = null;
  resetManualSticks();
  manualInputState.clear();
  if (!boardRoutineActive) await manualReportPromise;
  connected = false;
  manualReportActive = false;
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
    taskPage.setConnection();
    xboxPanel.render();
    render();
  }
}

async function sendCommand(command) {
  busy = true;
  setError();
  render();
  try {
    await requestDevice(command, "status");
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
  sendCommand(elements.runType.value === "task"
    ? `TASK_START ${Number(elements.taskSelect.value) || 0}`
    : `START ${Number(elements.slotSelect.value) || 0}`));
elements.pauseButton.addEventListener("click", () =>
  sendCommand(deviceState === "paused" ? "RESUME" : "PAUSE"));
elements.stopButton.addEventListener("click", () => sendCommand("STOP"));
elements.slotSelect.addEventListener("change", render);
elements.taskSelect.addEventListener("change", render);
elements.runType.addEventListener("change", render);
elements.taskList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  elements.runType.value = "task";
  elements.taskSelect.value = button.dataset.taskId;
  render();
});

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
  currentRoute = editSlot !== null && editSlot >= 0 ? "macro-edit" :
    route === "/macros" ? "macros" :
    route === "/control" ? "control" :
    route === "/record" ? "record" :
    route === "/tasks" ? "tasks" :
    route === "/settings" ? "settings" : "home";
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
  if (currentRoute === "tasks") taskPage.render();
  if (currentRoute === "settings" && connected) settingsPage.load();
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
