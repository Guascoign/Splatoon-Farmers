import { BUTTON_BITS } from "./manual-input.js";
import { formatDuration } from "./protocol.js";
import {
  createBlankStep, describeStep, DPAD_OPTIONS, MACRO_COLORS,
  macroChecksum, macroDurationMs, MAX_MACRO_STEPS, normalizeMacro,
  validateMacro,
} from "./macro-editor.js";

const buttonOptions = Object.entries(BUTTON_BITS);

export class MacroPage {
  constructor({ request, isConnected, isRunning, refreshStatus }) {
    this.request = request;
    this.isConnected = isConnected;
    this.isRunning = isRunning;
    this.refreshStatus = refreshStatus;
    this.route = "home";
    this.busy = false;
    this.pendingRouteLoad = false;
    this.macro = null;
    this.summary = null;
    this.storage = "unknown";

    this.listMessage = document.querySelector('[data-testid="macro-list-message"]');
    this.editMessage = document.querySelector('[data-testid="macro-edit-message"]');
    this.stepList = document.querySelector('[data-testid="macro-step-list"]');
    this.editFields = document.querySelector('[data-testid="macro-edit-fields"]');
    this.colorOptions = document.querySelector('[data-testid="macro-color-options"]');
    this.loopGapInput = document.querySelector('[data-testid="macro-loop-gap"]');
    this.saveButton = document.querySelector('[data-testid="macro-save"]');
    this.addStepButton = document.querySelector('[data-testid="macro-add-step"]');
    this.restoreButton = document.querySelector('[data-testid="macro-restore"]');
    this.formatButton = document.querySelector('[data-testid="macro-format-button"]');

    this.loopGapInput.addEventListener("input", () => {
      if (this.busy || !this.macro) return;
      this.macro.loopGapMs = Number(this.loopGapInput.value);
      this.renderSummary();
      this.message(this.editMessage, "草稿已修改，保存后才会写入 Flash。");
    });
    this.colorOptions.addEventListener("change", (event) => {
      if (this.busy || !this.macro || event.target.name !== "macro-color") return;
      this.macro.color = Number(event.target.value);
      this.message(this.editMessage, "灯色已修改，保存后生效。");
    });
    this.stepList.addEventListener("input", (event) => this.changeStep(event));
    this.stepList.addEventListener("change", (event) => this.changeStep(event));
    this.stepList.addEventListener("click", (event) => this.stepAction(event));
    this.addStepButton.addEventListener("click", () => {
      if (this.busy || !this.macro || this.macro.steps.length >= MAX_MACRO_STEPS) return;
      this.macro.steps.push(createBlankStep());
      this.renderSteps(this.macro.steps.length - 1);
      this.renderSummary();
      this.message(this.editMessage, "已添加动作，保存后才会写入 Flash。");
    });
    this.saveButton.addEventListener("click", () => this.save());
    this.restoreButton.addEventListener("click", () => this.restore());
    this.formatButton.addEventListener("click", () => this.formatStorage());
    this.renderColors();
    this.renderControls();
  }

  message(element, text, state = "") {
    element.textContent = text;
    element.dataset.state = state;
  }

  setRoute(route) {
    this.route = route;
    if (this.isConnected()) this.loadForRoute();
  }

  setConnection() {
    this.renderControls();
    if (this.isConnected()) {
      this.loadForRoute();
    } else {
      this.message(this.listMessage, "连接设备后读取宏槽位。");
      this.message(this.editMessage, "连接设备后读取宏内容。");
    }
  }

  loadForRoute() {
    if (this.busy) {
      this.pendingRouteLoad = true;
      return;
    }
    if (this.route === "macros") this.loadList();
    if (this.route === "macro-edit") this.loadDetail();
  }

  finishBusy() {
    this.busy = false;
    this.renderControls();
    if (this.pendingRouteLoad && this.isConnected()) {
      this.pendingRouteLoad = false;
      this.loadForRoute();
    }
  }

  async loadList() {
    if (!this.isConnected() || this.busy) return;
    this.busy = true;
    this.message(this.listMessage, "正在读取板载宏槽位…");
    this.renderControls();
    try {
      const response = await this.request("MACRO_LIST", "macro_list");
      this.summary = response.slots?.[0] ?? null;
      this.storage = response.storage;
      this.renderList();
      this.message(this.listMessage, "槽位 01 已同步。点击进入可逐步预览和微调。", "success");
    } catch (error) {
      this.message(this.listMessage, error.message || "无法读取宏槽位。", "error");
    } finally {
      this.finishBusy();
    }
  }

  async loadDetail() {
    if (!this.isConnected() || this.busy) return;
    this.busy = true;
    this.macro = null;
    this.stepList.innerHTML = "";
    this.message(this.editMessage, "正在读取板载宏内容…");
    this.renderControls();
    try {
      const response = await this.request("MACRO_GET", "macro");
      this.macro = normalizeMacro(response);
      const issue = validateMacro(this.macro);
      if (issue) throw new Error(`设备宏内容无效：${issue}`);
      this.renderEditor();
      this.message(this.editMessage,
        response.source === "flash" ? "已载入 Flash 自定义宏。" : "已载入固件内置宏；修改后可保存为 Flash 覆盖。",
        "success");
    } catch (error) {
      this.message(this.editMessage, error.message || "无法读取宏内容。", "error");
    } finally {
      this.finishBusy();
    }
  }

  renderList() {
    const summary = this.summary;
    if (!summary) return;
    document.querySelector('[data-testid="macro-source"]').textContent =
      summary.source === "flash" ? "Flash 自定义" : "固件内置";
    document.querySelector('[data-testid="macro-list-steps"]').textContent = summary.steps;
    document.querySelector('[data-testid="macro-list-duration"]').textContent =
      formatDuration(Number(summary.duration_ms) + Number(summary.loop_gap_ms));
    const color = MACRO_COLORS[Number(summary.color)] || MACRO_COLORS[0];
    document.querySelector('[data-testid="macro-list-color-name"]').textContent = color.name;
    document.querySelector('[data-testid="macro-list-color"]').style.background = color.css;
    this.formatButton.hidden = this.storage !== "mount-failed";
  }

  renderColors() {
    this.colorOptions.innerHTML = MACRO_COLORS.map((color, index) =>
      `<label><input type="radio" name="macro-color" value="${index}"><span><i style="--swatch:${color.css}"></i>${color.name}</span></label>`,
    ).join("");
  }

  renderEditor() {
    if (!this.macro) return;
    this.loopGapInput.value = this.macro.loopGapMs;
    const selected = this.colorOptions.querySelector(`input[value="${this.macro.color}"]`);
    if (selected) selected.checked = true;
    this.renderSummary();
    this.renderSteps();
  }

  renderSummary() {
    if (!this.macro) return;
    const duration = macroDurationMs(this.macro) + this.macro.loopGapMs;
    document.querySelector('[data-testid="macro-edit-summary"]').textContent =
      `${this.macro.steps.length} 个动作 · ${formatDuration(duration)} / 轮`;
    this.renderControls();
  }

  renderSteps(openIndex = -1) {
    if (!this.macro) return;
    this.stepList.innerHTML = this.macro.steps.map((step, index) => {
      const dpadOptions = DPAD_OPTIONS.map((option) =>
        `<option value="${option.value}" ${step.dpad === option.value ? "selected" : ""}>${option.name}</option>`,
      ).join("");
      const buttons = buttonOptions.map(([name, bit]) =>
        `<label><input type="checkbox" data-bit="${bit}" ${(step.buttons & (1 << bit)) ? "checked" : ""}>${name}</label>`,
      ).join("");
      const axisFields = ["leftX", "leftY", "rightX", "rightY"]
        .map((field) => `<label><span>${{ leftX: "左 X", leftY: "左 Y", rightX: "右 X", rightY: "右 Y" }[field]}</span><input type="number" min="0" max="255" step="1" data-field="${field}" value="${step[field]}"></label>`)
        .join("");
      return `<details class="macro-step" data-index="${index}" ${index === openIndex ? "open" : ""}>
        <summary><b>#${String(index + 1).padStart(2, "0")}</b><span data-step-description>${describeStep(step)}</span><strong data-step-duration>${step.durationMs} ms</strong></summary>
        <div class="macro-step-body">
          <div class="macro-step-fields"><label class="duration-field"><span>保持时间 (ms)</span><input type="number" min="10" max="600000" step="10" data-field="durationMs" value="${step.durationMs}"></label><label><span>方向键</span><select data-field="dpad">${dpadOptions}</select></label>${axisFields}</div>
          <div class="macro-step-buttons"><strong>按住的按键</strong><div class="macro-button-options">${buttons}</div></div>
          <div class="macro-step-actions"><button class="macro-mini-button" type="button" data-action="up" ${index === 0 ? "disabled" : ""}>↑ 上移</button><button class="macro-mini-button" type="button" data-action="down" ${index === this.macro.steps.length - 1 ? "disabled" : ""}>↓ 下移</button><button class="macro-mini-button" type="button" data-action="clone" ${this.macro.steps.length >= MAX_MACRO_STEPS ? "disabled" : ""}>＋ 复制</button><button class="macro-mini-button danger" type="button" data-action="delete" ${this.macro.steps.length === 1 ? "disabled" : ""}>删除</button></div>
        </div></details>`;
    }).join("");
  }

  changeStep(event) {
    if (this.busy || !this.macro) return;
    const row = event.target.closest(".macro-step");
    if (!row) return;
    const step = this.macro.steps[Number(row.dataset.index)];
    if (!step) return;
    if (event.target.dataset.bit !== undefined) {
      const bit = Number(event.target.dataset.bit);
      step.buttons = event.target.checked
        ? step.buttons | (1 << bit) : step.buttons & ~(1 << bit);
    } else if (event.target.dataset.field) {
      step[event.target.dataset.field] = Number(event.target.value);
    }
    row.querySelector("[data-step-description]").textContent = describeStep(step);
    row.querySelector("[data-step-duration]").textContent = `${step.durationMs} ms`;
    this.renderSummary();
    this.message(this.editMessage, "草稿已修改，保存后才会写入 Flash。");
  }

  stepAction(event) {
    if (this.busy || !this.macro) return;
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const row = button.closest(".macro-step");
    const index = Number(row.dataset.index);
    const action = button.dataset.action;
    if (action === "up" && index > 0) {
      [this.macro.steps[index - 1], this.macro.steps[index]] =
        [this.macro.steps[index], this.macro.steps[index - 1]];
      this.renderSteps(index - 1);
    } else if (action === "down" && index < this.macro.steps.length - 1) {
      [this.macro.steps[index + 1], this.macro.steps[index]] =
        [this.macro.steps[index], this.macro.steps[index + 1]];
      this.renderSteps(index + 1);
    } else if (action === "clone" && this.macro.steps.length < MAX_MACRO_STEPS) {
      this.macro.steps.splice(index + 1, 0, { ...this.macro.steps[index] });
      this.renderSteps(index + 1);
    } else if (action === "delete" && this.macro.steps.length > 1) {
      this.macro.steps.splice(index, 1);
      this.renderSteps(Math.min(index, this.macro.steps.length - 1));
    }
    this.renderSummary();
    this.message(this.editMessage, "动作顺序已修改，保存后才会写入 Flash。");
  }

  renderControls() {
    const disabled = !this.isConnected() || this.busy || this.isRunning();
    this.editFields.disabled = !this.isConnected() || this.busy || !this.macro;
    this.addStepButton.disabled = !this.isConnected() || this.busy || !this.macro ||
      this.macro.steps.length >= MAX_MACRO_STEPS;
    this.saveButton.disabled = disabled || !this.macro;
    this.restoreButton.disabled = disabled;
    this.formatButton.disabled = disabled;
    this.saveButton.textContent = this.busy ? "处理中…" : "保存到 Flash";
  }

  async save() {
    if (!this.isConnected() || this.busy || !this.macro) return;
    const snapshot = JSON.parse(JSON.stringify(this.macro));
    const issue = validateMacro(snapshot);
    if (issue) {
      this.message(this.editMessage, issue, "error");
      return;
    }
    if (this.isRunning()) {
      this.message(this.editMessage, "请先停止刷取，再保存宏。", "error");
      return;
    }
    this.busy = true;
    this.renderControls();
    let committed = false;
    try {
      await this.request(`MACRO_BEGIN ${snapshot.steps.length} ${snapshot.loopGapMs} ${snapshot.color}`, "ack");
      for (const [index, step] of snapshot.steps.entries()) {
        this.message(this.editMessage, `正在传输动作 ${index + 1}/${snapshot.steps.length}，请勿关闭页面…`);
        await this.request(`MACRO_STEP ${index} ${step.durationMs} ${step.buttons} ${step.dpad} ${step.leftX} ${step.leftY} ${step.rightX} ${step.rightY}`, "ack");
      }
      await this.request(`MACRO_COMMIT ${macroChecksum(snapshot)}`, "ack");
      committed = true;
      this.macro.source = "flash";
      const list = await this.request("MACRO_LIST", "macro_list");
      this.summary = list.slots?.[0] ?? null;
      this.storage = list.storage;
      this.renderList();
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, "已写入板载 Flash。下次上电仍会使用这一版宏和灯色。", "success");
    } catch (error) {
      this.message(this.editMessage,
        committed ? `宏已写入 Flash，但刷新摘要失败：${error.message}` :
          (error.message || "保存失败，原有宏仍保留。"),
        committed ? "success" : "error");
      if (!committed && this.isConnected()) {
        await this.request("MACRO_ABORT", "ack").catch(() => {});
      }
    } finally {
      this.finishBusy();
    }
  }

  async restore() {
    if (!this.isConnected() || this.busy || this.isRunning()) return;
    if (!window.confirm("恢复槽位 01 的固件内置宏？这会删除此槽位的 Flash 修改。")) return;
    this.busy = true;
    this.renderControls();
    try {
      await this.request("MACRO_RESTORE", "ack");
      const detail = await this.request("MACRO_GET", "macro");
      this.macro = normalizeMacro(detail);
      this.renderEditor();
      const list = await this.request("MACRO_LIST", "macro_list");
      this.summary = list.slots?.[0] ?? null;
      this.storage = list.storage;
      this.renderList();
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, "已恢复固件内置宏。", "success");
    } catch (error) {
      this.message(this.editMessage, error.message || "恢复失败。", "error");
    } finally {
      this.finishBusy();
    }
  }

  async formatStorage() {
    if (!this.isConnected() || this.busy || this.storage !== "mount-failed") return;
    if (!window.confirm("初始化会格式化整个宏 SPIFFS 分区，删除其中的所有旧宏数据。确定继续？")) return;
    this.busy = true;
    this.renderControls();
    try {
      await this.request("MACRO_STORAGE_FORMAT", "ack");
      const list = await this.request("MACRO_LIST", "macro_list");
      this.summary = list.slots?.[0] ?? null;
      this.storage = list.storage;
      this.renderList();
      this.message(this.listMessage, "宏存储已初始化。现在可以进入编辑并保存。", "success");
    } catch (error) {
      this.message(this.listMessage, error.message || "初始化失败。", "error");
    } finally {
      this.finishBusy();
    }
  }
}
