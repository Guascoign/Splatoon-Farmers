import {
  DEFAULT_BINDINGS, describeReport, NEUTRAL_REPORT, normalizedBindings,
  reportCommand, reportsEqual, SWITCH_KEYS, XBOX_KEYS, XboxRecorder,
  xboxGamepads, xboxPressedKeys, xboxToReport,
} from "./xbox-input.js";

const BINDINGS_KEY = "splatoon-farmers-xbox-bindings-v1";
const KEY_LABELS = Object.freeze({
  LB: "LB", RB: "RB", LT: "LT", RT: "RT", VIEW: "View", MENU: "Menu",
  LS: "左摇杆按下", RS: "右摇杆按下", UP: "方向上", RIGHT: "方向右",
  DOWN: "方向下", LEFT: "方向左", GUIDE: "Xbox 主键", SHARE: "分享键",
  L_STICK_PRESS: "左摇杆按下", R_STICK_PRESS: "右摇杆按下",
  DPAD_UP: "方向上", DPAD_RIGHT: "方向右", DPAD_DOWN: "方向下",
  DPAD_LEFT: "方向左", MINUS: "−", PLUS: "+", HOME: "Home",
  CAPTURE: "截图",
});

function label(key) { return KEY_LABELS[key] || key; }

function savedBindings() {
  try { return normalizedBindings(JSON.parse(localStorage.getItem(BINDINGS_KEY))); }
  catch { return { ...DEFAULT_BINDINGS }; }
}

export class XboxPanel {
  constructor({ enabled, isConnected, isFirmwareReady, isBusy, isRunning,
    send, flush, onState,
    onDraft, onError }) {
    this.enabled = enabled;
    this.isConnected = isConnected;
    this.isFirmwareReady = isFirmwareReady;
    this.isBusy = isBusy;
    this.isRunning = isRunning;
    this.send = send;
    this.flush = flush;
    this.onState = onState;
    this.onDraft = onDraft;
    this.onError = onError;
    this.active = false;
    this.stopping = false;
    this.stopTask = Promise.resolve();
    this.recorder = new XboxRecorder();
    this.bindings = savedBindings();
    this.selectedSource = null;
    this.selectedIndex = null;
    this.devicesSignature = "";
    this.lastReport = NEUTRAL_REPORT;
    this.lastHeartbeatAt = 0;
    this.sendTail = Promise.resolve();
    this.frame = null;
    this.selector = document.querySelector('[data-testid="xbox-device"]');
    this.status = document.querySelector('[data-testid="xbox-status"]');
    this.output = document.querySelector('[data-testid="xbox-output"]');
    this.recordInfo = document.querySelector('[data-testid="xbox-record-info"]');
    this.startButton = document.querySelector('[data-testid="xbox-start"]');
    this.stopButton = document.querySelector('[data-testid="xbox-stop"]');
    this.recordButton = document.querySelector('[data-testid="xbox-record"]');
    this.finishButton = document.querySelector('[data-testid="xbox-finish"]');
    this.panel = document.querySelector('[data-testid="xbox-panel"]');
    this.bindingHint = document.querySelector('[data-testid="xbox-binding-hint"]');
    this.bindingList = document.querySelector('[data-testid="xbox-binding-list"]');
    this.unbindButton = document.querySelector('[data-testid="xbox-unbind"]');
    this.resetButton = document.querySelector('[data-testid="xbox-reset-bindings"]');
    this.panel.hidden = !enabled;

    this.panel.addEventListener("click", (event) => {
      const source = event.target.closest("[data-source-key]")?.dataset.sourceKey;
      const target = event.target.closest("[data-target-key]")?.dataset.targetKey;
      if (source) this.selectSource(source);
      else if (target) this.bindTarget(target);
    });
    this.unbindButton.addEventListener("click", () => this.bindTarget(null));
    this.resetButton.addEventListener("click", () => {
      this.bindings = { ...DEFAULT_BINDINGS };
      this.selectedSource = null;
      this.persistBindings();
      this.bindingHint.textContent = "已恢复同位置映射：Xbox A → Switch B，Xbox B → Switch A。";
      this.renderBindings();
    });

    this.selector.addEventListener("change", () => {
      this.selectedIndex = this.selector.value === "" ? null : Number(this.selector.value);
      this.lastReport = NEUTRAL_REPORT;
      this.render();
    });
    this.startButton.addEventListener("click", () => this.start());
    this.stopButton.addEventListener("click", () => this.stop());
    this.recordButton.addEventListener("click", () => this.startRecording());
    this.finishButton.addEventListener("click", () => this.stop());
    window.addEventListener("blur", () => { if (this.active) this.stop(); });
    window.addEventListener("pagehide", () => { if (this.active) this.stop(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.active) this.stop();
    });
    this.render();
    this.renderBindings();
    if (enabled) this.poll();
  }

  get recording() { return this.recorder.active; }

  selectedPad(devices = xboxGamepads()) {
    return devices.find((pad) => pad.index === this.selectedIndex) || null;
  }

  persistBindings() {
    try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(this.bindings)); }
    catch { this.bindingHint.textContent = "浏览器未允许保存键位；本次页面中仍可使用。"; }
  }

  selectSource(source) {
    if (!XBOX_KEYS.includes(source)) return;
    this.selectedSource = source;
    this.bindingHint.textContent = `Xbox ${label(source)} 当前对应 Switch ${label(this.bindings[source]) || "未绑定"}；点击右侧键位改绑。`;
    this.renderBindings();
  }

  bindTarget(target) {
    if (!this.selectedSource) {
      this.bindingHint.textContent = "请先点击左侧的 Xbox 键位。";
      return;
    }
    if (target !== null && !SWITCH_KEYS.includes(target)) return;
    const source = this.selectedSource;
    this.bindings[source] = target;
    this.selectedSource = null;
    this.persistBindings();
    this.bindingHint.textContent = target
      ? `已绑定：Xbox ${label(source)} → Switch ${label(target)}。`
      : `已取消 Xbox ${label(source)} 的输出。`;
    this.renderBindings();
  }

  renderBindings() {
    this.unbindButton.disabled = !this.selectedSource;
    for (const button of this.panel.querySelectorAll("[data-source-key]")) {
      button.dataset.selected = String(button.dataset.sourceKey === this.selectedSource);
      button.title = `Xbox ${label(button.dataset.sourceKey)} → Switch ${label(this.bindings[button.dataset.sourceKey]) || "未绑定"}`;
    }
    for (const button of this.panel.querySelectorAll("[data-target-key]")) {
      button.dataset.mapped = String(Boolean(this.selectedSource &&
        button.dataset.targetKey === this.bindings[this.selectedSource]));
    }
    this.bindingList.replaceChildren(...XBOX_KEYS.map((source) => {
      const chip = document.createElement("span");
      chip.textContent = `${label(source)} → ${label(this.bindings[source]) || "未绑定"}`;
      chip.dataset.selected = String(source === this.selectedSource);
      return chip;
    }));
  }

  paintPressed(pad) {
    const active = pad ? xboxPressedKeys(pad) : new Set();
    const targets = new Set([...active].map((source) => this.bindings[source]));
    for (const button of this.panel.querySelectorAll("[data-source-key]")) {
      button.dataset.active = String(active.has(button.dataset.sourceKey));
    }
    for (const button of this.panel.querySelectorAll("[data-target-key]")) {
      button.dataset.active = String(targets.has(button.dataset.targetKey));
    }
  }

  refreshDevices(devices) {
    const signature = devices.map((pad) => `${pad.index}:${pad.id}`).join("|");
    if (signature === this.devicesSignature) return;
    this.devicesSignature = signature;
    const previous = this.selectedIndex;
    this.selector.replaceChildren();
    if (!devices.length) {
      const option = new Option("未检测到 Xbox 手柄，请按任意键", "");
      this.selector.add(option);
      this.selectedIndex = null;
    } else {
      for (const pad of devices) {
        this.selector.add(new Option(pad.id || `Xbox 手柄 ${pad.index}`, String(pad.index)));
      }
      this.selectedIndex = devices.some((pad) => pad.index === previous)
        ? previous : devices[0].index;
      this.selector.value = String(this.selectedIndex);
    }
    this.render();
  }

  poll() {
    const devices = xboxGamepads();
    const selectedStillPresent = devices.some((pad) => pad.index === this.selectedIndex);
    if (this.active && !selectedStillPresent) {
      this.stop("手柄已断开；已释放 Switch 输入。");
    }
    this.refreshDevices(devices);
    const pad = this.selectedPad(devices);
    if (pad) {
      const report = xboxToReport(pad, this.bindings);
      this.paintPressed(pad);
      if (this.active && !reportsEqual(report, this.lastReport)) {
        const now = performance.now();
        if (this.recorder.active && !this.recorder.record(report, now)) {
          this.stop("已达到 128 步上限；录制结束，请检查草稿。");
        } else {
          this.lastReport = report;
          this.lastHeartbeatAt = now;
          this.output.textContent = describeReport(report);
          this.queueReport(report);
          this.renderRecordingInfo();
        }
      } else if (this.active && performance.now() - this.lastHeartbeatAt >= 200) {
        this.lastHeartbeatAt = performance.now();
        this.queueReport(this.lastReport);
      } else if (!this.active) {
        this.output.textContent = describeReport(report);
      }
    } else if (!this.active) {
      this.output.textContent = "中立";
      this.paintPressed(null);
    }
    if (this.recorder.active) this.renderRecordingInfo();
    this.frame = requestAnimationFrame(() => this.poll());
  }

  queueReport(report) {
    const command = reportCommand(report);
    this.sendTail = this.sendTail.then(() => this.send(command))
      .catch((error) => {
        this.onError(error?.message || "手柄输入发送失败");
        if (this.active) this.stop("串口发送失败，直通已停止。");
      });
    return this.sendTail;
  }

  start() {
    if (!this.enabled || !this.isConnected() || !this.isFirmwareReady() || this.isBusy() ||
        this.isRunning() || this.active) return;
    const pad = this.selectedPad();
    if (!pad) return;
    this.active = true;
    this.lastReport = xboxToReport(pad, this.bindings);
    this.lastHeartbeatAt = performance.now();
    this.onState(true);
    this.queueReport(this.lastReport);
    this.status.textContent = "直通中 · Xbox 输入正送往 Switch";
    this.output.textContent = describeReport(this.lastReport);
    this.render();
  }

  startRecording() {
    if (!this.active || this.recorder.active) return;
    this.recorder.start(this.lastReport, performance.now());
    this.status.textContent = "正在录制 · 操作会进入槽位 01 草稿";
    this.render();
  }

  stop(reason = "直通已停止，Switch 按键已释放。") {
    if (this.stopping) return this.stopTask;
    if (!this.active) return Promise.resolve();
    this.stopping = true;
    this.active = false;
    const wasRecording = this.recorder.active;
    const draft = this.recorder.finish(performance.now());
    this.lastReport = NEUTRAL_REPORT;
    this.output.textContent = "中立";
    this.status.textContent = reason;
    this.onState(false);
    this.render();
    this.stopTask = (async () => {
      try {
        if (this.isConnected()) {
          await this.queueReport(NEUTRAL_REPORT);
          await this.flush();
        }
      } catch (error) {
        this.onError(error?.message || "串口同步失败");
      } finally {
        this.stopping = false;
        this.onState(false);
        this.render();
      }
      if (draft?.length) this.onDraft(draft);
      else if (wasRecording && draft === null) {
        this.status.textContent = "没有录到有效操作，槽位内容未改变。";
      }
    })();
    return this.stopTask;
  }

  renderRecordingInfo() {
    if (!this.recorder.active) return;
    const seconds = ((performance.now() - this.recorder.startedAt) / 1000).toFixed(1);
    this.recordInfo.textContent = `${seconds} 秒 · 已记录 ${this.recorder.steps.length + 1}/128 步`;
  }

  render() {
    const ready = this.enabled && this.isConnected() && this.isFirmwareReady() && !this.isBusy() &&
      !this.stopping &&
      !this.isRunning() && Boolean(this.selectedPad());
    this.selector.disabled = this.active || this.stopping;
    this.startButton.disabled = !ready || this.active;
    this.stopButton.disabled = !this.active;
    this.recordButton.disabled = !this.active || this.recorder.active;
    this.finishButton.disabled = !this.recorder.active;
    this.recordInfo.hidden = !this.recorder.active;
    if (!this.enabled || this.active || this.stopping) return;
    if (!this.isConnected()) {
      this.status.textContent = "先连接 ESP32 的 USB-UART 串口。";
    } else if (!this.isFirmwareReady()) {
      this.status.textContent = "请先烧录支持手柄直通的 1.3.0 固件。";
    } else if (!this.devicesSignature) {
      this.status.textContent = "等待 Xbox 手柄：先在 Windows 中连接，再按手柄任意键。";
    } else if (/^(先连接|请先烧录|等待 Xbox)/.test(this.status.textContent)) {
      this.status.textContent = "手柄已识别，可开始直通。";
    }
  }
}
