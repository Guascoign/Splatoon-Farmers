const hexText = (value) => [...new TextEncoder().encode(value)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const duration = (ms) => {
  const seconds = Math.floor(Number(ms || 0) / 1000);
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
};

export class SettingsPage {
  constructor({ request, isConnected, slots, tasks, macroPage, taskPage, onImported = () => {} }) {
    this.request = request;
    this.isConnected = isConnected;
    this.slots = slots;
    this.tasks = tasks;
    this.macroPage = macroPage;
    this.taskPage = taskPage;
    this.onImported = onImported;
    this.message = document.querySelector('[data-testid="settings-message"]');
    this.form = document.querySelector('[data-testid="settings-form"]');
    this.stats = document.querySelector('[data-testid="settings-stats"]');
    this.brightness = this.form.querySelector('[name="brightness"]');
    this.brightnessValue = this.form.querySelector('[data-testid="brightness-value"]');
    this.brightness.addEventListener("input", () => {
      this.brightnessValue.textContent = `${Math.round(Number(this.brightness.value) / 255 * 100)}%`;
    });
    this.form.addEventListener("submit", (event) => { event.preventDefault(); this.save(); });
    document.querySelector('[data-testid="refresh-stats"]').addEventListener("click", () => this.load());
    document.querySelector('[data-testid="export-all-config"]').addEventListener("click", () => this.exportAll());
    document.querySelector('[data-testid="import-all-config"]').addEventListener("click", () => document.querySelector('[data-testid="all-config-file"]').click());
    document.querySelector('[data-testid="all-config-file"]').addEventListener("change", () => this.importAll());
    document.querySelector('[data-testid="share-import"]').addEventListener("click", () => this.importShare());
    document.querySelector('[data-testid="share-api-url"]').value = localStorage.getItem("splatoonFarmers.shareApi") || "";
  }

  async load() {
    if (!this.isConnected()) return;
    try {
      const settings = await this.request("SETTINGS_GET", "settings");
      const stats = await this.request("STATS_GET", "stats");
      this.form.elements.wifi.checked = Boolean(settings.wifi_enabled);
      this.form.elements.ssid.value = settings.wifi_ssid || "";
      this.form.elements.password.value = "";
      this.form.elements.open.checked = !settings.password_set;
      this.form.elements.brightness.value = settings.led_brightness;
      this.brightness.dispatchEvent(new Event("input"));
      document.querySelector('[data-testid="firmware-version"]').textContent =
        `${settings.version || "V1.0"} · ${settings.firmware} · ${settings.serial_baud} baud`;
      const slotCycles = Array.isArray(stats.slot_cycles)
        ? stats.slot_cycles.map((cycles, slot) => [slot, cycles])
        : Object.entries(stats.slot_cycles || {});
      const taskCycles = Array.isArray(stats.task_cycles)
        ? stats.task_cycles.map((cycles, id) => [id, cycles])
        : Object.entries(stats.task_cycles || {});
      const slotCycleById = new Map(slotCycles.map(([slot, cycles]) => [Number(slot), Number(cycles)]));
      for (const item of this.slots()) {
        const id = Number(item.slot);
        if (Number.isInteger(id) && id >= 0 && !slotCycleById.has(id)) slotCycleById.set(id, 0);
      }
      const taskCycleById = new Map(taskCycles.map(([id, cycles]) => [Number(id), Number(cycles)]));
      for (const item of this.tasks()) {
        const id = Number(item.id);
        if (Number.isInteger(id) && id >= 0 && !taskCycleById.has(id)) taskCycleById.set(id, 0);
      }
      const slotRows = [...slotCycleById]
        .map(([slot, cycles]) => {
          const summary = this.slots().find((item) => Number(item.slot) === Number(slot));
          return `<li>槽位 ${String(Number(slot) + 1).padStart(2, "0")} · ${escapeHtml(summary?.name || "空槽位")}<b>${cycles} 次</b></li>`;
        }).join("");
      const taskRows = [...taskCycleById]
        .map(([id, cycles]) => {
          const task = this.tasks().find((item) => Number(item.id) === Number(id));
          return `<li>任务 ${String(Number(id) + 1).padStart(2, "0")} · ${escapeHtml(task?.name || "未命名")}<b>${cycles} 轮</b></li>`;
        }).join("");
      const recentSummary = this.slots().find((item) => Number(item.slot) === Number(stats.recent_slot));
      const recentSlot = Number(stats.recent_slot) >= 0 ?
        recentSummary?.name || `槽位 ${Number(stats.recent_slot) + 1}` : "暂无";
      this.stats.innerHTML = `<div class="stats-highlights"><div><span>累计自动运行</span><strong>${duration(stats.total_run_ms)}</strong></div><div><span>最近运行的宏</span><strong>${escapeHtml(recentSlot)}</strong></div></div><h3>各宏运行次数</h3><ul>${slotRows}</ul><h3>任务列表完成轮数</h3><ul>${taskRows}</ul>`;
      this.message.textContent = "设置和统计已从设备读取。";
    } catch (error) {
      this.message.textContent = error.message;
    }
  }

  async save() {
    if (!this.isConnected()) return;
    const form = this.form.elements;
    const ssid = form.ssid.value.trim();
    const password = form.password.value;
    if (!ssid || new TextEncoder().encode(ssid).length > 32) {
      this.message.textContent = "WiFi 名称须为 1–32 字节。";
      return;
    }
    const passwordBytes = new TextEncoder().encode(password).length;
    if (!form.open.checked && password && (passwordBytes < 8 || passwordBytes > 63)) {
      this.message.textContent = "WiFi 密码须为 8–63 个字符；留空则保留现有密码。";
      return;
    }
    const command = `SETTINGS_SET ${form.wifi.checked ? 1 : 0} ${Number(form.brightness.value)} ${hexText(ssid)} ${password ? hexText(password) : "-"} ${form.open.checked ? 1 : 0}`;
    try {
      await this.request(command, "ack");
      form.password.value = "";
      this.message.textContent = "设备设置已保存。WiFi 名称、密码或开关改变后，请重新连接热点。";
      if (!form.wifi.checked) this.message.textContent += " WiFi 关闭后需通过电脑串口重新开启。";
    } catch (error) {
      this.message.textContent = error.message;
    }
  }

  async importShare() {
    const idInput = document.querySelector('[data-testid="share-id-input"]');
    const apiInput = document.querySelector('[data-testid="share-api-url"]');
    const id = idInput.value.trim();
    if (!id || !this.isConnected()) return;
    const base = apiInput.value.trim() || `${window.location.origin}/api/share`;
    localStorage.setItem("splatoonFarmers.shareApi", apiInput.value.trim());
    try {
      this.message.textContent = "正在读取分享宏 JSON…";
      const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`分享服务返回 HTTP ${response.status}。`);
      const data = await response.json();
      if (data?.json && typeof data.json === "object") Object.assign(data, data.json);
      if (this.macroPage.storageTotal &&
          this.macroPage.storageUsed >= this.macroPage.storageTotal * 0.9) {
        throw new Error("板载 Flash 已达到 90% 使用率，请先删除一个槽位。");
      }
      const firstEmpty = this.macroPage.getNextSlot();
      if (!Number.isInteger(firstEmpty) || firstEmpty < 0) throw new Error("没有可用的槽位。");
      this.macroPage.applyImportedJson(data, firstEmpty);
      if (window.confirm(`分享宏已读取，是否立即保存到槽位 ${firstEmpty + 1}？`)) {
        await this.macroPage.save();
        this.message.textContent = `分享宏已更新到槽位 ${firstEmpty + 1}。`;
      } else {
        this.message.textContent = `分享宏已载入草稿，将覆盖槽位 ${firstEmpty + 1}；请在宏编辑页确认后保存。`;
      }
    } catch (error) {
      this.message.textContent = error.message || "分享宏读取失败。";
    }
  }

  async exportAll() {
    if (!this.isConnected() || this.macroPage.busy || this.taskPage.busy) return;
    try {
      this.message.textContent = "正在读取完整配置…";
      const settings = await this.request("SETTINGS_GET", "settings");
      const tasks = await this.request("TASK_LIST", "task_list");
      const macros = [];
      for (const summary of this.macroPage.summaries) {
        if (summary.source === "empty") continue;
        const macro = normalizeMacro(await this.request(`MACRO_GET ${summary.slot}`, "macro"));
        const item = { slot: Number(summary.slot), macro };
        macros.push(item);
      }
      const data = { format: "splatoon-farmers-config", version: 1, settings,
        tasks: tasks.tasks, macros };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `splatoon-farmers-config-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message.textContent = "完整配置已导出。";
    } catch (error) { this.message.textContent = error.message || "完整配置导出失败。"; }
  }

  async importAll() {
    const file = document.querySelector('[data-testid="all-config-file"]').files?.[0];
    document.querySelector('[data-testid="all-config-file"]').value = "";
    if (!file || !this.isConnected()) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== "splatoon-farmers-config" || data.version !== 1 ||
          !Array.isArray(data.macros) || !Array.isArray(data.tasks)) throw new Error("不是完整配置 JSON。 ");
      if (!window.confirm("导入会覆盖现有宏槽位、任务列表和设备设置，确定继续吗？")) return;
      this.message.textContent = "正在清理旧配置…";
      for (const summary of this.macroPage.summaries) {
        const slot = Number(summary.slot);
        if (Number.isInteger(slot) && slot >= 0) {
          await this.request(`MACRO_DELETE ${slot}`, "ack").catch(() => {});
        }
      }
      for (const task of this.taskPage.tasks) {
        const id = Number(task.id);
        if (Number.isInteger(id) && id >= 0) {
          await this.request(`TASK_DELETE ${id}`, "ack").catch(() => {});
        }
      }
      for (const item of data.macros) {
        const slot = Number(item.slot);
        const macro = normalizeMacro(item.macro);
        const issue = validateMacro(macro);
        if (slot < 0 || !Number.isInteger(slot) || issue) throw new Error(`槽位 ${slot + 1} 宏无效：${issue || "槽位错误"}`);
        await this.writeMacro(slot, macro);
      }
      for (const task of data.tasks.filter((item) => item.exists && item.entries?.length)) {
        const name = task.name;
        const nameHex = [...new TextEncoder().encode(name)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        await this.request(`TASK_SAVE ${Number(task.id)} ${nameHex} ${task.entries.length} ${task.entries.map(([slot, repeats]) => `${slot}:${repeats}`).join(",")} ${Math.floor(Date.now() / 1000)}`, "ack");
      }
      if (data.settings) await this.applyImportedSettings(data.settings);
      await this.onImported();
      this.message.textContent = "完整配置已导入，宏、任务和设置均已恢复。";
    } catch (error) { this.message.textContent = error.message || "完整配置导入失败。"; }
  }

  async writeMacro(slot, macro) {
    await this.request(`MACRO_BEGIN ${slot} ${macro.steps.length} ${macro.loopGapMs} ${macro.color} ${Math.floor(Date.now() / 1000)}`, "ack");
    const nameHex = [...new TextEncoder().encode(macro.name)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await this.request(`MACRO_NAME ${nameHex}`, "ack");
    for (const [index, step] of macro.steps.entries()) {
      await this.request(`MACRO_STEP ${index} ${step.durationMs} ${step.buttons} ${step.dpad} ${step.leftX} ${step.leftY} ${step.rightX} ${step.rightY}`, "ack");
    }
    await this.request(`MACRO_COMMIT ${macroChecksum(macro)}`, "ack");
  }

  async applyImportedSettings(settings) {
    const ssidHex = [...new TextEncoder().encode(settings.wifi_ssid || "ESP32-S3-Switch")].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const passwordHex = settings.password_hex || "-";
    await this.request(`SETTINGS_SET ${settings.wifi_enabled ? 1 : 0} ${Number(settings.led_brightness) || 36} ${ssidHex} ${passwordHex} ${settings.password_set ? 0 : 1}`, "ack");
  }
}
import { macroChecksum, normalizeMacro, validateMacro } from "./macro-editor.js";
