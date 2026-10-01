import { BUTTON_BITS } from "./manual-input.js";
import { formatDuration } from "./protocol.js";
import {
  createBlankStep, describeStep, DPAD_OPTIONS, MACRO_COLORS,
  MACRO_SLOT_COUNT, macroChecksum, macroDurationMs, MAX_MACRO_STEPS, normalizeMacro,
  validateMacro,
} from "./macro-editor.js";
import {
  base64ToImageBytes, bytesToBase64, downloadSlotImage, prepareImage,
  uploadSlotImage,
} from "./slot-image.js";

const buttonOptions = Object.entries(BUTTON_BITS);
const slotLabel = (slot) => String(slot + 1).padStart(2, "0");
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
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
    this.selectedSlot = 0;
    this.storageUsed = 0;
    this.storageTotal = 0;
    this.storage = "unknown";
    this.draftKind = null;
    this.pendingImageBytes = null;
    this.imageDeleted = false;
    this.imageSourceSlot = null;
    this.imageUrl = null;
    this.modalUrl = null;

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
    this.listImageFile = document.querySelector('[data-testid="macro-list-image-file"]');
    this.editImageFile = document.querySelector('[data-testid="macro-edit-image-file"]');
    this.editImage = document.querySelector('[data-testid="macro-edit-image"]');
    this.imageModal = document.querySelector('[data-testid="macro-image-modal"]');
    this.modalImage = document.querySelector('[data-testid="macro-image-modal-image"]');
    this.pendingListImageSlot = null;

    for (let slot = 0; slot < MACRO_SLOT_COUNT; ++slot) {
      this.targetSelect.add(new Option(`槽位 ${slotLabel(slot)}`, String(slot)));
      this.importSelect.add(new Option(`槽位 ${slotLabel(slot)}`, String(slot)));
    }
    this.nameInput.addEventListener("input", () => {
      if (!this.macro || this.busy) return;
      this.macro.name = this.nameInput.value;
      this.message(this.editMessage, "名称已修改，保存后会写入对应槽位。");
    });
    this.targetSelect.addEventListener("change", () => {
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
      if (this.busy || !this.macro || this.macro.steps.length >= MAX_MACRO_STEPS) return;
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
    this.listImageFile.addEventListener("change", () => this.uploadListImage());
    document.querySelector('[data-testid="macro-edit-image-upload"]').addEventListener("click", () => this.editImageFile.click());
    this.editImageFile.addEventListener("change", () => this.chooseEditorImage());
    document.querySelector('[data-testid="macro-edit-image-view"]').addEventListener("click", () =>
      this.viewImage(this.pendingImageBytes ? Number(this.targetSelect.value) :
        this.imageSourceSlot ?? Number(this.targetSelect.value)));
    document.querySelector('[data-testid="macro-edit-image-remove"]').addEventListener("click", () => this.removeEditorImage());
    document.querySelector('[data-testid="macro-image-modal-close"]').addEventListener("click", () => this.closeImageModal());
    this.imageModal.addEventListener("click", (event) => {
      if (event.target === this.imageModal) this.closeImageModal();
    });
    this.renderColors();
    this.renderControls();
  }

  message(element, text, state = "") {
    element.textContent = text;
    element.dataset.state = state;
  }

  setRoute(route, slot = this.selectedSlot) {
    this.route = route;
    if (route === "macro-edit" && Number.isInteger(slot) &&
        slot >= 0 && slot < MACRO_SLOT_COUNT) this.selectedSlot = slot;
    if (this.isConnected()) this.loadForRoute();
  }

  setConnection() {
    this.renderControls();
    if (this.isConnected()) {
      this.loadForRoute();
    } else {
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
    this.selectedSlot = this.summaries.findIndex((item) => item?.source === "empty");
    if (this.selectedSlot < 0) this.selectedSlot = 0;
    this.pendingImageBytes = null;
    this.imageDeleted = false;
    this.imageSourceSlot = null;
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
    this.pendingImageBytes = null;
    this.imageDeleted = false;
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
      this.summaries = response.slots ?? [];
      this.summary = this.summaries[this.selectedSlot] ?? null;
      this.storage = response.storage;
      this.storageUsed = Number(response.used_bytes) || 0;
      this.storageTotal = Number(response.total_bytes) || 0;
      this.renderList();
      this.onSlots(this.summaries);
      this.message(this.listMessage, "板载槽位已同步。点击进入可预览和微调。", "success");
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
      if (!this.summaries.length) await this.refreshListSnapshot();
      const response = await this.request(`MACRO_GET ${this.selectedSlot}`, "macro");
      this.macro = normalizeMacro(response);
      const issue = validateMacro(this.macro);
      if (issue) throw new Error(`设备宏内容无效：${issue}`);
      this.imageSourceSlot = this.selectedSlot;
      this.pendingImageBytes = null;
      this.imageDeleted = false;
      this.renderEditor();
      this.message(this.editMessage,
        response.source === "flash" ? "已载入 Flash 自定义宏。" : "已载入固件内置宏；修改后可保存为 Flash 覆盖。",
        "success");
    } catch (error) {
      if (this.summaries[this.selectedSlot]?.source === "empty") {
        this.macro = { source: "empty", name: `宏槽位 ${slotLabel(this.selectedSlot)}`,
          loopGapMs: 1000, color: 0, steps: [createBlankStep()] };
        this.imageSourceSlot = this.selectedSlot;
        this.pendingImageBytes = null;
        this.imageDeleted = false;
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
    this.slotList.innerHTML = this.summaries.map((summary) => {
      const slot = Number(summary.slot);
      const color = MACRO_COLORS[Number(summary.color)] || MACRO_COLORS[0];
      const source = summary.source === "flash" ? "Flash 自定义" :
        summary.source === "builtin" ? "固件内置" : "空槽位";
      const duration = Number(summary.duration_ms) + Number(summary.loop_gap_ms);
      const imageSize = Number(summary.image_size) || 0;
      return `<article class="macro-slot-card" data-source="${escapeHtml(summary.source)}">
        <div class="macro-slot-id"><small>SLOT</small><strong>${slotLabel(slot)}</strong></div>
        <div class="macro-slot-main"><p class="eyebrow">${slot === 0 ? "MATERIAL RAID" : "CUSTOM MACRO"}</p><h2>${escapeHtml(summary.name || `空槽位 ${slotLabel(slot)}`)}</h2><span>${source}</span><small class="macro-slot-usage">占用 ${formatBytes(Number(summary.used_bytes) || 0)} · 配装图 ${formatBytes(Number(summary.image_bytes) || 0)}</small></div>
        <div class="macro-slot-facts"><div><small>动作</small><strong>${Number(summary.steps) || 0}</strong></div><div><small>单轮</small><strong>${formatDuration(duration)}</strong></div><div><small>灯色</small><strong><i class="macro-color-dot" style="background:${color.css}"></i>${color.name}</strong></div></div>
        <div class="macro-slot-actions"><a class="button button-primary macro-enter" href="#/macros/${slot + 1}">${summary.source === "empty" ? "创建宏 →" : "进入编辑 →"}</a><button type="button" data-slot-action="view" data-slot="${slot}" ${imageSize ? "" : "disabled"}>查看配装图</button><button type="button" data-slot-action="upload" data-slot="${slot}">上传配装图</button><button type="button" data-slot-action="delete" data-slot="${slot}" ${imageSize ? "" : "disabled"}>删除配装图</button></div>
      </article>`;
    }).join("");
    for (const select of [this.targetSelect, this.importSelect]) {
      const selected = select.value;
      for (const option of select.options) {
        const slot = Number(option.value);
        option.textContent = `槽位 ${slotLabel(slot)} · ${this.summaries[slot]?.name || "空"}`;
      }
      select.value = selected;
    }
    this.formatButton.hidden = this.storage !== "mount-failed";
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
    this.renderEditorImage();
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
    this.editFields.disabled = (!this.isConnected() && !this.draftKind) ||
      this.busy || !this.macro;
    this.addStepButton.disabled = (!this.isConnected() && !this.draftKind) ||
      this.busy || !this.macro ||
      this.macro.steps.length >= MAX_MACRO_STEPS;
    this.saveButton.disabled = disabled || !this.macro;
    this.restoreButton.disabled = disabled || Boolean(this.draftKind);
    this.restoreButton.textContent = this.selectedSlot === 0 ? "恢复内置" : "清空此槽宏";
    this.formatButton.disabled = disabled;
    this.discardButton.hidden = !this.draftKind;
    this.discardButton.disabled = this.busy;
    this.saveButton.textContent = this.busy ? "处理中…" : "保存到槽位";
    this.importButton.disabled = this.busy;
    this.exportButton.disabled = this.busy || !this.macro || this.isRunning();
    document.querySelector('[data-testid="macro-edit-image-upload"]').disabled = this.busy || !this.macro || this.isRunning();
    const imageSlot = this.imageSourceSlot ?? Number(this.targetSelect.value);
    const imageAvailable = !this.imageDeleted && Boolean(this.pendingImageBytes ||
      this.summaries[imageSlot]?.image_size);
    document.querySelector('[data-testid="macro-edit-image-remove"]').disabled = this.busy || this.isRunning() || !imageAvailable;
    document.querySelector('[data-testid="macro-edit-image-view"]').disabled = this.busy || this.isRunning() || !imageAvailable;
    for (const button of this.slotList.querySelectorAll("button[data-slot-action]")) {
      button.disabled = this.busy || !this.isConnected() || this.isRunning() ||
        (button.dataset.slotAction !== "upload" &&
         !this.summaries[Number(button.dataset.slot)]?.image_size);
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
    if (!Number.isInteger(targetSlot) || targetSlot < 0 ||
        targetSlot >= MACRO_SLOT_COUNT) {
      this.message(this.editMessage, "请选择有效槽位。", "error");
      return;
    }
    if ((targetSlot !== this.selectedSlot || this.draftKind) &&
        this.summaries[targetSlot]?.source !== "empty" &&
        !window.confirm(`槽位 ${slotLabel(targetSlot)} 已有宏。确定覆盖吗？`)) return;
    this.busy = true;
    this.renderControls();
    let committed = false;
    try {
      await this.request(`MACRO_BEGIN ${targetSlot} ${snapshot.steps.length} ${snapshot.loopGapMs} ${snapshot.color}`, "ack");
      await this.request(`MACRO_NAME ${hexName(snapshot.name)}`, "ack");
      for (const [index, step] of snapshot.steps.entries()) {
        this.message(this.editMessage, `正在传输动作 ${index + 1}/${snapshot.steps.length}，请勿关闭页面…`);
        await this.request(`MACRO_STEP ${index} ${step.durationMs} ${step.buttons} ${step.dpad} ${step.leftX} ${step.leftY} ${step.rightX} ${step.rightY}`, "ack");
      }
      await this.request(`MACRO_COMMIT ${macroChecksum(snapshot)}`, "ack");
      committed = true;
      if (this.pendingImageBytes) {
        await uploadSlotImage(this.request, targetSlot, this.pendingImageBytes,
          (sent, total) => this.message(this.editMessage,
            `正在写入配装图片 ${Math.round(sent / total * 100)}%…`));
      } else if (this.imageDeleted) {
        await this.request(`SLOT_IMAGE_DELETE ${targetSlot}`, "ack");
      } else if (targetSlot !== this.imageSourceSlot &&
                 this.summaries[this.imageSourceSlot]?.image_size) {
        const image = await downloadSlotImage(this.request, this.imageSourceSlot,
          (received, total) => this.message(this.editMessage,
            `正在复制配装图 ${Math.round(received / total * 100)}%…`));
        if (image) await uploadSlotImage(this.request, targetSlot, image);
      }
      this.draftKind = null;
      this.macro.source = "flash";
      this.macro.name = snapshot.name;
      this.selectedSlot = targetSlot;
      this.imageSourceSlot = targetSlot;
      this.pendingImageBytes = null;
      this.imageDeleted = false;
      const list = await this.request("MACRO_LIST", "macro_list");
      this.summaries = list.slots ?? [];
      this.summary = this.summaries[this.selectedSlot] ?? null;
      this.storage = list.storage;
      this.storageUsed = Number(list.used_bytes) || 0;
      this.storageTotal = Number(list.total_bytes) || 0;
      this.renderList();
      this.onSlots(this.summaries);
      this.renderEditor();
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, `已保存到槽位 ${slotLabel(targetSlot)}；宏、名称和配装图会在重启后保留。`, "success");
      window.location.hash = `#/macros/${targetSlot + 1}`;
    } catch (error) {
      this.message(this.editMessage,
        committed ? `宏已写入槽位，但图片或摘要更新失败：${error.message}` :
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
    if (!window.confirm(slot === 0
      ? "恢复槽位 01 的固件内置宏？这会删除此槽位的 Flash 宏修改；配装图保留。"
      : `清空槽位 ${slotLabel(slot)} 的宏？配装图保留。`)) return;
    this.busy = true;
    this.renderControls();
    let restored = false;
    try {
      await this.request(`MACRO_RESTORE ${slot}`, "ack");
      restored = true;
      this.draftKind = null;
      const list = await this.request("MACRO_LIST", "macro_list");
      this.summaries = list.slots ?? [];
      this.summary = this.summaries[slot] ?? null;
      this.storage = list.storage;
      this.storageUsed = Number(list.used_bytes) || 0;
      this.storageTotal = Number(list.total_bytes) || 0;
      this.renderList();
      this.onSlots(this.summaries);
      await this.refreshStatus().catch(() => {});
      this.message(this.editMessage, slot === 0 ? "已恢复固件内置宏。" : "已清空此槽宏。", "success");
    } catch (error) {
      this.message(this.editMessage, error.message || "恢复失败。", "error");
    } finally {
      this.finishBusy();
      if (restored && this.isConnected()) this.loadDetail();
    }
  }

  async refreshListSnapshot() {
    const list = await this.request("MACRO_LIST", "macro_list");
    this.summaries = list.slots ?? [];
    this.summary = this.summaries[this.selectedSlot] ?? null;
    this.storage = list.storage;
    this.storageUsed = Number(list.used_bytes) || 0;
    this.storageTotal = Number(list.total_bytes) || 0;
    this.renderList();
    this.onSlots(this.summaries);
  }

  renderEditorImage() {
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = null;
    this.editImage.hidden = true;
    this.editImage.removeAttribute("src");
    if (this.pendingImageBytes) this.showEditorImage(this.pendingImageBytes);
    this.renderControls();
  }

  showEditorImage(bytes) {
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    this.editImage.src = this.imageUrl;
    this.editImage.hidden = false;
  }

  async slotAction(event) {
    const button = event.target.closest("[data-slot-action]");
    if (!button || this.busy) return;
    const slot = Number(button.dataset.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MACRO_SLOT_COUNT) return;
    if (button.dataset.slotAction === "view") {
      await this.viewImage(slot);
    } else if (button.dataset.slotAction === "upload") {
      this.pendingListImageSlot = slot;
      this.listImageFile.click();
    } else if (button.dataset.slotAction === "delete") {
      if (!this.isConnected() || this.isRunning() ||
          !window.confirm(`删除槽位 ${slotLabel(slot)} 的配装图片？`)) return;
      this.busy = true;
      this.renderControls();
      try {
        await this.request(`SLOT_IMAGE_DELETE ${slot}`, "ack");
        await this.refreshListSnapshot();
        this.message(this.listMessage, `槽位 ${slotLabel(slot)} 的配装图片已删除。`, "success");
      } catch (error) {
        this.message(this.listMessage, error.message, "error");
      } finally { this.finishBusy(); }
    }
  }

  async uploadListImage() {
    const file = this.listImageFile.files?.[0];
    const slot = this.pendingListImageSlot;
    this.listImageFile.value = "";
    if (!file || slot === null || this.busy || !this.isConnected() ||
        this.isRunning()) return;
    this.busy = true;
    this.renderControls();
    try {
      const bytes = await prepareImage(file);
      await uploadSlotImage(this.request, slot, bytes, (sent, total) =>
        this.message(this.listMessage,
          `正在写入槽位 ${slotLabel(slot)} 配装图 ${Math.round(sent / total * 100)}%…`));
      await this.refreshListSnapshot();
      this.message(this.listMessage, `配装图已保存到槽位 ${slotLabel(slot)}。`, "success");
    } catch (error) {
      this.message(this.listMessage, error.message || "图片上传失败。", "error");
    } finally {
      this.pendingListImageSlot = null;
      this.finishBusy();
    }
  }

  async chooseEditorImage() {
    const file = this.editImageFile.files?.[0];
    this.editImageFile.value = "";
    if (!file || this.busy || !this.macro) return;
    try {
      this.pendingImageBytes = await prepareImage(file);
      this.imageDeleted = false;
      this.showEditorImage(this.pendingImageBytes);
      this.message(this.editMessage,
        `配装图已加入草稿（${formatBytes(this.pendingImageBytes.length)}），保存到槽位后写入 Flash。`, "success");
      this.renderControls();
    } catch (error) {
      this.message(this.editMessage, error.message, "error");
    }
  }

  removeEditorImage() {
    if (this.busy) return;
    this.pendingImageBytes = null;
    this.imageDeleted = true;
    this.renderEditorImage();
    this.message(this.editMessage, "配装图已从草稿移除，保存到槽位后才会删除板载图片。");
  }

  async viewImage(slot) {
    if (this.busy) return;
    let bytes = this.pendingImageBytes && slot === Number(this.targetSelect.value)
      ? this.pendingImageBytes : null;
    if (!bytes) {
      if (!this.isConnected()) {
        this.message(this.route === "macros" ? this.listMessage : this.editMessage,
          "请先连接设备，再读取板载配装图。", "error");
        return;
      }
      this.busy = true;
      this.renderControls();
      try {
        bytes = await downloadSlotImage(this.request, slot, (received, total) =>
          this.message(this.route === "macros" ? this.listMessage : this.editMessage,
            `正在读取配装图 ${Math.round(received / total * 100)}%…`));
      }
      catch (error) {
        this.message(this.route === "macros" ? this.listMessage : this.editMessage,
          error.message, "error");
        return;
      } finally { this.finishBusy(); }
    }
    if (!bytes) return;
    if (this.modalUrl) URL.revokeObjectURL(this.modalUrl);
    this.modalUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    this.modalImage.src = this.modalUrl;
    document.querySelector('[data-testid="macro-image-modal-title"]').textContent =
      `槽位 ${slotLabel(slot)} · 配装图`;
    this.imageModal.hidden = false;
    if (this.route === "macro-edit" && slot === Number(this.targetSelect.value))
      this.showEditorImage(bytes);
  }

  closeImageModal() {
    this.imageModal.hidden = true;
    this.modalImage.removeAttribute("src");
    if (this.modalUrl) URL.revokeObjectURL(this.modalUrl);
    this.modalUrl = null;
  }

  async importJsonFile() {
    const file = this.importFile.files?.[0];
    this.importFile.value = "";
    if (!file) return;
    try {
      if (file.size > 200000) throw new Error("JSON 文件过大，请使用本页导出的宏文件。");
      const parsed = JSON.parse(await file.text());
      if (parsed?.format !== "splatoon-farmers-macro" || parsed.version !== 1)
        throw new Error("不是本项目导出的宏 JSON 格式。");
      const macro = normalizeMacro(parsed);
      const issue = validateMacro(macro);
      if (issue) throw new Error(issue);
      const image = parsed.loadoutImage;
      if (image && image.mime !== "image/jpeg")
        throw new Error("JSON 中的配装图片格式必须是 JPEG。");
      this.pendingImageBytes = image ? base64ToImageBytes(image.base64) : null;
      this.imageDeleted = !image;
      this.imageSourceSlot = null;
      this.macro = macro;
      this.macro.source = "import";
      this.draftKind = "import";
      this.selectedSlot = Number(this.importSelect.value);
      this.renderEditor();
      this.message(this.editMessage, "JSON 已导入草稿。请核对名称、动作、配装图和目标槽位后保存。", "success");
      window.location.hash = `#/macros/${this.selectedSlot + 1}`;
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
    this.busy = true;
    this.renderControls();
    try {
      let image = this.pendingImageBytes;
      if (!image && !this.imageDeleted && this.imageSourceSlot !== null &&
          this.summaries[this.imageSourceSlot]?.image_size) {
        image = await downloadSlotImage(this.request, this.imageSourceSlot,
          (received, total) => this.message(this.editMessage,
            `正在导出配装图 ${Math.round(received / total * 100)}%…`));
      }
      const data = {
        format: "splatoon-farmers-macro", version: 1,
        name: macro.name, loopGapMs: macro.loopGapMs, color: macro.color,
        steps: macro.steps,
      };
      if (image) data.loadoutImage = { mime: "image/jpeg", base64: bytesToBase64(image) };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${macro.name.replace(/[<>:"/\\|?*]/g, "_") || "macro"}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message(this.editMessage, "JSON 已导出；配装图已包含在文件中。", "success");
    } catch (error) {
      this.message(this.editMessage, error.message || "导出失败。", "error");
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
      this.summaries = list.slots ?? [];
      this.summary = this.summaries[this.selectedSlot] ?? null;
      this.storage = list.storage;
      this.storageUsed = Number(list.used_bytes) || 0;
      this.storageTotal = Number(list.total_bytes) || 0;
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
