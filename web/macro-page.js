import { BUTTON_BITS } from "./manual-input.js";
import { formatDuration } from "./protocol.js";
import {
  createBlankStep, describeStep, DPAD_OPTIONS, MACRO_COLORS,
  macroChecksum, macroDurationMs, normalizeMacro,
  validateMacro,
} from "./macro-editor.js";

const buttonOptions = Object.entries(BUTTON_BITS);
const slotLabel = (slot) => String(slot + 1).padStart(2, "0");
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
const formatUpdatedAt = (seconds) => Number(seconds) > 0
  ? new Date(Number(seconds) * 1000).toLocaleString("zh-CN", { hour12: false }) : "未记录";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const hexName = (name) => [...new TextEncoder().encode(name)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

export class MacroPage {
  constructor({ request, isConnected, isRunning, refreshStatus, onSlots = () => {} }) {
    this.request = request;
    this.isConnected = isConnected;
    this.isRunning = isRunning;
    this.refreshStatus = refreshStatus;
    this.onSlots = onSlots;
    this.route = "home";
    this.busy = false;
    this.pendingRouteLoad = false;
    this.macro = null;
    this.summary = null;
    this.summaries = [];
    this.slotsLoaded = false;
    this.nextSlot = 0;
    this.selectedSlot = 0;
    this.storageUsed = 0;
    this.storageTotal = 0;
    this.storage = "unknown";
    this.draftKind = null;

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
    this.discardButton = document.querySelector('[data-testid="macro-discard-recording"]');
    this.slotList = document.querySelector('[data-testid="macro-slot-list"]');
    this.storageLabel = document.querySelector('[data-testid="macro-storage-label"]');
    this.storageProgress = document.querySelector('[data-testid="macro-storage-progress"]');
    this.nameInput = document.querySelector('[data-testid="macro-name"]');
    this.targetSelect = document.querySelector('[data-testid="macro-target-slot"]');
    this.importSelect = document.querySelector('[data-testid="macro-import-slot"]');
    this.importButton = document.querySelector('[data-testid="macro-import-json"]');
    this.importFile = document.querySelector('[data-testid="macro-import-file"]');
    this.exportButton = document.querySelector('[data-testid="macro-export-json"]');

    this.populateSlotChoices();
    this.nameInput.addEventListener("input", () => {
      if (!this.macro || this.busy) return;
      this.macro.name = this.nameInput.value;
      this.message(this.editMessage, "名称已修改，保存后会写入对应槽位。");
    });
    this.targetSelect.addEventListener("change", () => {
      this.renderControls();
      this.message(this.editMessage, `将保存到槽位 ${slotLabel(Number(this.targetSelect.value))}。`);
    });

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
      if (this.busy || !this.macro) return;
      this.macro.steps.push(createBlankStep());
      this.renderSteps(this.macro.steps.length - 1);
      this.renderSummary();
      this.message(this.editMessage, "已添加动作，保存后才会写入 Flash。");
    });
    this.saveButton.addEventListener("click", () => this.save());
    this.restoreButton.addEventListener("click", () => this.restore());
    this.formatButton.addEventListener("click", () => this.formatStorage());
    this.discardButton.addEventListener("click", () => this.discardRecording());
    this.importButton.addEventListener("click", () => this.importFile.click());
    this.importFile.addEventListener("change", () => this.importJsonFile());
    this.exportButton.addEventListener("click", () => this.exportJson());
    this.slotList.addEventListener("click", (event) => this.slotAction(event));
    this.renderColors();
    this.renderControls();
  }

  message(element, text, state = "") {
    element.textContent = text;
    element.dataset.state = state;
  }

  summaryForSlot(slot) {
    const id = Number(slot);
    return this.summaries.find((summary) => Number(summary?.slot) === id) || null;
  }

  getNextSlot() {
    const advertised = this.nextSlot;
    if (Number.isInteger(advertised) && advertised >= 0 && !this.summaryForSlot(advertised)) return advertised;
    const used = new Set(this.summaries.map((summary) => Number(summary?.slot))
      .filter((slot) => Number.isInteger(slot) && slot >= 0));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    return slot;
  }

  applyListResponse(response) {
    if (!Array.isArray(response?.slots)) throw new Error("设备返回的槽位列表无效。");
    this.summaries = response.slots
      .filter((summary) => Number.isInteger(Number(summary?.slot)) && Number(summary.slot) >= 0)
      .map((summary) => ({ ...summary, slot: Number(summary.slot) }));
    const rawNextSlot = response.next_slot ?? response.nextSlot;
    const advertised = rawNextSlot === null || rawNextSlot === undefined ? null : Number(rawNextSlot);
    this.nextSlot = Number.isInteger(advertised) && advertised >= 0 ? advertised : null;
    this.slotsLoaded = true;
    this.summary = this.summaryForSlot(this.selectedSlot);
    this.storage = response.storage;
    this.storageUsed = Number(response.used_bytes) || 0;
    this.storageTotal = Number(response.total_bytes) || 0;
  }

  setRoute(route, slot = this.selectedSlot) {
    this.route = route;
    if (route === "macro-edit" && Number.isInteger(slot) &&
        slot >= 0) this.selectedSlot = slot;
    if (this.isConnected()) this.loadForRoute();
  }

  setConnection() {
    this.renderControls();
    if (this.isConnected()) {
      this.loadForRoute();
    } else {
      this.slotsLoaded = false;
      this.message(this.listMessage, "连接设备后读取宏槽位。");
      this.message(this.editMessage, this.draftKind
        ? "草稿仍在此页；重新连接设备后可以保存。"
        : "连接设备后读取宏内容。");
    }
  }

  loadForRoute() {
    if (this.busy) {
      this.pendingRouteLoad = true;
      return;
    }
    if (this.route === "macros") this.loadList();
    if (this.route === "macro-edit") {
      if (this.draftKind) {
        this.renderEditor();
        this.message(this.editMessage,
          "正在预览草稿。可取名、微调并选择保存槽位。", "success");
      } else this.loadDetail();
    }
  }

  importRecording(steps) {
    this.draftKind = "recording";
    this.selectedSlot = this.getNextSlot();
    this.macro = {
      source: "recording",
      name: `录制宏 ${slotLabel(this.selectedSlot)}`,
      loopGapMs: 1000,
      color: 0,
      steps: steps.map((step) => ({ ...step })),
    };
    this.renderEditor();
    this.message(this.editMessage,
      `已录制 ${steps.length} 步。请取名、选槽位并保存。`, "success");
  }

  discardRecording() {
    if (!this.draftKind) return;
    this.draftKind = null;
    this.macro = null;
    this.stepList.innerHTML = "";
    this.renderControls();
    if (this.isConnected()) this.loadDetail();
    else this.message(this.editMessage, "录制草稿已放弃，连接设备后读取板载宏。");
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
      this.applyListResponse(response);
      this.storage = response.storage;
      this.storageUsed = Number(response.used_bytes) || 0;
      this.storageTotal = Number(response.total_bytes) || 0;
      this.renderList();
      this.onSlots(this.summaries);
      this.message(this.listMessage, "板载槽位已同步。点击进入可预览和微调。", "success");
      return true;
    } catch (error) {
      this.slotsLoaded = false;
      this.message(this.listMessage, error.message || "无法读取宏槽位。", "error");
      return false;
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
      if (!this.summaries.length) await this.refreshListSnapshot();
      const response = await this.request(`MACRO_GET ${this.selectedSlot}`, "macro");
      this.macro = normalizeMacro(response);
      const issue = validateMacro(this.macro);
      if (issue) throw new Error(`设备宏内容无效：${issue}`);
      this.renderEditor();
      this.message(this.editMessage,
        response.source === "flash" ? "已载入 Flash 自定义宏。" : "这是空槽位，可编辑后保存。",
        "success");
    } catch (error) {
      if (!this.summaryForSlot(this.selectedSlot) || this.summaryForSlot(this.selectedSlot)?.source === "empty") {
        this.macro = { source: "empty", name: `宏槽位 ${slotLabel(this.selectedSlot)}`,
          loopGapMs: 1000, color: 0, steps: [createBlankStep()] };
        this.renderEditor();
        this.message(this.editMessage, "这是空槽位。可编辑动作并保存。", "success");
      } else {
        this.message(this.editMessage, error.message || "无法读取宏内容。", "error");
      }
    } finally {
      this.finishBusy();
    }
  }

  renderList() {
    const percent = this.storageTotal ?
      Math.min(100, Math.round(this.storageUsed / this.storageTotal * 100)) : 0;
    this.storageProgress.value = percent;
    this.storageLabel.textContent = this.storageTotal
      ? `${formatBytes(this.storageUsed)} / ${formatBytes(this.storageTotal)} · ${percent}%`
      : "存储尚未就绪";
    const visible = this.summaries.filter((summary) => summary.source !== "empty");
    const cards = visible.map((summary) => {
      const slot = Number(summary.slot);
      const color = MACRO_COLORS[Number(summary.color)] || MACRO_COLORS[0];
      const source = summary.source === "flash" ? "自定义" : "空槽位";
      const duration = Number(summary.duration_ms) + Number(summary.loop_gap_ms);
      const shareId = summary.share_id || summary.shareId || "未生成";
      return `<article class="macro-slot-card" data-source="${escapeHtml(summary.source)}">
        <div class="macro-slot-id"><small>SLOT</small><strong>${slotLabel(slot)}</strong><em>${source}</em></div>
        <div class="macro-slot-main"><p class="eyebrow">CUSTOM MACRO</p><h2>${escapeHtml(summary.name || `宏槽位 ${slotLabel(slot)}`)}</h2><small class="macro-slot-usage">占用 ${formatBytes(Number(summary.used_bytes) || 0)}</small><small class="macro-slot-meta">更新：${formatUpdatedAt(summary.updated_at)} · 分享 ID：${escapeHtml(shareId)}</small></div>
        <div class="macro-slot-facts"><div><small>动作</small><strong>${Number(summary.steps) || 0}</strong></div><div><small>单轮</small><strong>${formatDuration(duration)}</strong></div><div><small>灯色</small><strong><i class="macro-color-dot" style="background:${color.css}"></i>${color.name}</strong></div></div>
        <div class="macro-slot-actions"><a class="button button-primary macro-enter" href="#/macros/${slot + 1}">进入编辑 →</a><button type="button" data-slot-action="export" data-slot="${slot}">导出 JSON</button><button class="macro-danger" type="button" data-slot-action="remove-slot" data-slot="${slot}">删除</button></div>
      </article>`;
    }).join("");
    const firstEmpty = this.getNextSlot();
    const newCard = Number.isInteger(firstEmpty) && percent < 90
      ? `<article class="macro-slot-card macro-slot-empty-card"><div><p class="eyebrow">EMPTY CAPACITY</p><h2>新建宏槽位</h2><p>当前存储占用 ${percent}%，可继续创建宏。</p></div><a class="button button-primary macro-enter" href="#/macros/${Number(firstEmpty) + 1}">创建宏 →</a></article>` : "";
    this.slotList.innerHTML = cards || `<p class="macro-empty-state">还没有保存的宏。${newCard ? "点击下方创建第一个宏。" : "请先释放 Flash 空间。"}</p>`;
    this.slotList.insertAdjacentHTML("beforeend", newCard);
    this.populateSlotChoices();
    this.formatButton.hidden = this.storage !== "mount-failed";
  }

  populateSlotChoices() {
    const occupied = this.summaries.filter((summary) => summary.source !== "empty");
    const capacityAvailable = !this.storageTotal || this.storageUsed < this.storageTotal * 0.9;
    const firstEmpty = capacityAvailable ? { slot: this.getNextSlot(), source: "empty" } : null;
    const choices = [...occupied, firstEmpty];
    if (!firstEmpty) choices.pop();
    for (const select of [this.targetSelect, this.importSelect]) {
      const selected = select.value;
      select.replaceChildren(...choices.map((summary) => {
        const slot = Number(summary.slot);
        const label = summary.source === "empty" ? `新建宏（槽位 ${slotLabel(slot)}）` :
          `${summary.name || "未命名宏"}（槽位 ${slotLabel(slot)}）`;
        return new Option(label, String(slot));
      }));
      select.value = choices.some((summary) => String(summary.slot) === selected)
        ? selected : String(firstEmpty?.slot ?? occupied[0]?.slot ?? 0);
    }
  }

  renderColors() {
    this.colorOptions.innerHTML = MACRO_COLORS.map((color, index) =>
      `<label><input type="radio" name="macro-color" value="${index}"><span><i style="--swatch:${color.css}"></i>${color.name}</span></label>`,
    ).join("");
  }

  renderEditor() {
    if (!this.macro) return;
    this.nameInput.value = this.macro.name;
    this.targetSelect.value = String(this.selectedSlot);
    document.querySelector('[data-testid="macro-edit-slot-label"]').textContent =
      `SLOT ${slotLabel(this.selectedSlot)} / STEP EDITOR`;
    this.loopGapInput.value = this.macro.loopGapMs;
    const selected = this.colorOptions.querySelector(`input[value="${this.macro.color}"]`);
    if (selected) selected.checked = true;
    this.renderSummary();
    this.renderSteps();
    this.renderControls();
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
          <div class="macro-step-actions"><button class="macro-mini-button" type="button" data-action="up" ${index === 0 ? "disabled" : ""}>↑ 上移</button><button class="macro-mini-button" type="button" data-action="down" ${index === this.macro.steps.length - 1 ? "disabled" : ""}>↓ 下移</button><button class="macro-mini-button" type="button" data-action="clone">＋ 复制</button><button class="macro-mini-button danger" type="button" data-action="delete" ${this.macro.steps.length === 1 ? "disabled" : ""}>删除</button></div>
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
    } else if (action === "clone") {
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
    this.editFields.disabled = (!this.isConnected() && !this.draftKind) ||
      this.busy || !this.macro;
    this.addStepButton.disabled = (!this.isConnected() && !this.draftKind) ||
      this.busy || !this.macro;
    this.saveButton.disabled = disabled || !this.macro;
    this.restoreButton.disabled = disabled || Boolean(this.draftKind);
    this.restoreButton.textContent = "清空此槽宏";
    this.formatButton.disabled = disabled;
    this.discardButton.hidden = !this.draftKind;
    this.discardButton.disabled = this.busy;
    const targetSlot = Number(this.targetSelect.value);
    const targetName = this.summaryForSlot(targetSlot)?.name || "空槽位";
    this.saveButton.textContent = this.busy ? "处理中…" :
      `保存到 ${targetName}（槽位 ${slotLabel(targetSlot)}）`;
    this.importButton.disabled = this.busy;
    this.exportButton.disabled = this.busy || !this.macro || this.isRunning();
    for (const button of this.slotList.querySelectorAll("button[data-slot-action]")) {
      const action = button.dataset.slotAction;
      const summary = this.summaryForSlot(Number(button.dataset.slot));
      button.disabled = this.busy || !this.isConnected() || this.isRunning() ||
        (action === "export" && (!summary || summary.source === "empty")) ||
        (action === "remove-slot" && summary?.source === "empty");
    }
  }

  async save() {
    if (!this.isConnected() || this.busy || !this.macro) return;
    const snapshot = JSON.parse(JSON.stringify(this.macro));
    snapshot.name = this.nameInput.value.trim();
    const targetSlot = Number(this.targetSelect.value);
    const issue = validateMacro(snapshot);
    if (issue) {
      this.message(this.editMessage, issue, "error");
      return;
    }
    if (this.isRunning()) {
      this.message(this.editMessage, "请先停止刷取，再保存宏。", "error");
      return;
    }
    if (!Number.isInteger(targetSlot) || targetSlot < 0) {
      this.message(this.editMessage, "请选择有效槽位。", "error");
      return;
    }
    if (!this.slotsLoaded) {
      try { await this.refreshListSnapshot(); }
      catch (error) {
        this.message(this.editMessage,
          `无法确认目标槽位是否为空：${error.message || "请重新连接设备"}`, "error");
        return;
      }
    }
    const existingTarget = this.summaryForSlot(targetSlot);
    if ((targetSlot !== this.selectedSlot || this.draftKind) && existingTarget &&
        existingTarget.source !== "empty" &&
        !window.confirm(`槽位 ${slotLabel(targetSlot)} 已有宏。确定覆盖吗？`)) return;
    this.busy = true;
    this.renderControls();
    let committed = false;
    try {
      await this.request(`MACRO_BEGIN ${targetSlot} ${snapshot.steps.length} ${snapshot.loopGapMs} ${snapshot.color} ${Math.floor(Date.now() / 1000)}`, "ack");
      await this.request(`MACRO_NAME ${hexName(snapshot.name)}`, "ack");
      for (const [index, step] of snapshot.steps.entries()) {
        this.message(this.editMessage, `正在传输动作 ${index + 1}/${snapshot.steps.length}，请勿关闭页面…`);
        await this.request(`MACRO_STEP ${index} ${step.durationMs} ${step.buttons} ${step.dpad} ${step.leftX} ${step.leftY} ${step.rightX} ${step.rightY}`, "ack");
      }
      await this.request(`MACRO_COMMIT ${macroChecksum(snapshot)}`, "ack");
      committed = true;
      this.draftKind = null;
      this.macro.source = "flash";
      this.macro.name = snapshot.name;
      this.selectedSlot = targetSlot;
      const list = await this.request("MACRO_LIST", "macro_list");
      this.applyListResponse(list);
      this.renderList();
      this.onSlots(this.summaries);
      this.renderEditor();
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, `已保存到槽位 ${slotLabel(targetSlot)}；宏和名称会在重启后保留。`, "success");
      window.location.hash = `#/macros/${targetSlot + 1}`;
    } catch (error) {
      this.message(this.editMessage,
        committed ? `宏已写入槽位，但列表刷新失败：${error.message}。重新连接后可读取，请勿重复保存。` :
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
    const slot = this.selectedSlot;
    if (!window.confirm(`清空槽位 ${slotLabel(slot)} 的宏？`)) return;
    this.busy = true;
    this.renderControls();
    let restored = false;
    try {
      await this.request(`MACRO_RESTORE ${slot}`, "ack");
      restored = true;
      this.draftKind = null;
      const list = await this.request("MACRO_LIST", "macro_list");
      this.applyListResponse(list);
      this.renderList();
      this.onSlots(this.summaries);
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, "已清空此槽宏。", "success");
    } catch (error) {
      this.message(this.editMessage, error.message || "恢复失败。", "error");
    } finally {
      this.finishBusy();
      if (restored && this.isConnected()) this.loadDetail();
    }
  }

  async refreshListSnapshot() {
    const list = await this.request("MACRO_LIST", "macro_list");
    this.applyListResponse(list);
    this.renderList();
    this.onSlots(this.summaries);
  }

  async slotAction(event) {
    const button = event.target.closest("[data-slot-action]");
    if (!button || this.busy) return;
    const slot = Number(button.dataset.slot);
    if (!Number.isInteger(slot) || slot < 0) return;
    if (button.dataset.slotAction === "export") {
      await this.exportSlotJson(slot);
    } else if (button.dataset.slotAction === "remove-slot") {
      if (!this.isConnected() || this.isRunning() ||
          !window.confirm(`删除槽位 ${slotLabel(slot)} 的宏？此操作无法撤销。`)) return;
      this.busy = true;
      this.renderControls();
      try {
        await this.deleteSlot(slot);
        await this.refreshListSnapshot();
        await this.refreshStatus().catch(() => {});
        this.message(this.listMessage, `槽位 ${slotLabel(slot)} 的宏已删除。`, "success");
      } catch (error) {
        this.message(this.listMessage, error.message || "删除宏失败。", "error");
      } finally { this.finishBusy(); }
    }
  }

  async deleteSlot(slot) {
    try {
      await this.request(`MACRO_DELETE ${slot}`, "ack");
    } catch (error) {
      // Older firmware uses MACRO_RESTORE for deletion.
      if (error?.message !== "设备拒绝了这条指令") throw error;
      await this.request(`MACRO_RESTORE ${slot}`, "ack");
    }
  }

  applyImportedJson(parsed, targetSlot = null) {
    if (parsed?.format !== "splatoon-farmers-macro" || parsed.version !== 1)
      throw new Error("不是本项目导出的宏 JSON 格式。");
    const macro = normalizeMacro(parsed);
    const issue = validateMacro(macro);
    if (issue) throw new Error(issue);
    this.macro = macro;
    this.macro.source = "import";
    this.draftKind = "import";
    const firstEmpty = this.getNextSlot();
    this.selectedSlot = Number.isInteger(targetSlot) ? targetSlot :
      Number(this.importSelect.value || firstEmpty || 0);
    this.renderEditor();
    this.message(this.editMessage, "JSON 已导入草稿。请核对名称、动作和目标槽位后保存。", "success");
    window.location.hash = `#/macros/${this.selectedSlot + 1}`;
  }

  async importJsonFile() {
    const file = this.importFile.files?.[0];
    this.importFile.value = "";
    if (!file) return;
    try {
      if (file.size > 8_000_000) throw new Error("JSON 文件超过支持的大小。");
      this.applyImportedJson(JSON.parse(await file.text()));
    } catch (error) {
      this.message(this.listMessage, error.message || "无法导入 JSON。", "error");
    }
  }

  async exportJson() {
    if (!this.macro || this.busy) return;
    const macro = JSON.parse(JSON.stringify(this.macro));
    macro.name = this.nameInput.value.trim();
    const issue = validateMacro(macro);
    if (issue) return this.message(this.editMessage, issue, "error");
    this.downloadMacroJson(macro);
    this.message(this.editMessage, "宏 JSON 已导出。", "success");
  }

  downloadMacroJson(macro) {
    const data = {
      format: "splatoon-farmers-macro", version: 1,
      name: macro.name, loopGapMs: macro.loopGapMs, color: macro.color,
      updatedAt: macro.updatedAt || Math.floor(Date.now() / 1000),
      shareId: macro.shareId || "", steps: macro.steps,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)],
      { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${macro.name.replace(/[<>:"/\\|?*]/g, "_") || "macro"}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async exportSlotJson(slot) {
    if (!this.isConnected() || this.busy || this.isRunning() ||
        this.summaryForSlot(slot)?.source === "empty") return;
    this.busy = true;
    this.renderControls();
    try {
      this.message(this.listMessage, `正在读取槽位 ${slotLabel(slot)} 的动作…`);
      const macro = normalizeMacro(await this.request(`MACRO_GET ${slot}`, "macro"));
      const issue = validateMacro(macro);
      if (issue) throw new Error(issue);
      this.downloadMacroJson(macro);
      this.message(this.listMessage,
        `槽位 ${slotLabel(slot)} 的动作已导出。`, "success");
    } catch (error) {
      this.message(this.listMessage, error.message || "导出失败。", "error");
    } finally { this.finishBusy(); }
  }

  async formatStorage() {
    if (!this.isConnected() || this.busy || this.storage !== "mount-failed") return;
    if (!window.confirm("初始化会格式化整个宏 SPIFFS 分区，删除其中的所有旧宏数据。确定继续？")) return;
    this.busy = true;
    this.renderControls();
    try {
      await this.request("MACRO_STORAGE_FORMAT", "ack");
      const list = await this.request("MACRO_LIST", "macro_list");
      this.applyListResponse(list);
      this.renderList();
      this.onSlots(this.summaries);
      this.message(this.listMessage, "宏存储已初始化。现在可以进入编辑并保存。", "success");
    } catch (error) {
      this.message(this.listMessage, error.message || "初始化失败。", "error");
    } finally {
      this.finishBusy();
    }
  }
}
