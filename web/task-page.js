const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const hexText = (value) => [...new TextEncoder().encode(value)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

export class TaskPage {
  constructor({ request, isConnected, isRunning, onTasks = () => {} }) {
    this.request = request;
    this.isConnected = isConnected;
    this.isRunning = isRunning;
    this.onTasks = onTasks;
    this.tasks = [];
    this.nextTask = 0;
    this.slots = [];
    this.storageUsed = 0;
    this.storageTotal = 0;
    this.busy = false;
    this.dataRevision = 0;
    this.list = document.querySelector('[data-testid="task-list"]');
    this.message = document.querySelector('[data-testid="task-message"]');
    this.list.addEventListener("click", (event) => this.action(event));
    this.list.addEventListener("input", (event) => this.rememberDraft(event));
    this.list.addEventListener("change", (event) => this.rememberDraft(event));
    this.render();
  }

  setSlots(slots) {
    this.slots = slots;
    this.render();
  }

  setStorage(used, total) {
    this.storageUsed = Number(used) || 0;
    this.storageTotal = Number(total) || 0;
    this.render();
  }

  async loadList() {
    if (!this.isConnected()) return false;
    const revision = this.dataRevision;
    try {
      const response = await this.request("TASK_LIST", "task_list");
      if (!Array.isArray(response?.tasks)) throw new Error("设备返回的任务列表无效。");
      if (revision !== this.dataRevision) return true;
      const savedTasks = response.tasks
        .filter((task) => Number.isInteger(Number(task?.id)) && Number(task.id) >= 0)
        .map((task) => ({ ...task, id: Number(task.id), exists: task.exists !== false,
          entries: Array.isArray(task.entries) ? task.entries : [] }));
      // A background refresh must not discard a new task while its form is
      // being edited. A saved record from the board always takes precedence.
      const drafts = this.tasks.filter((task) => task.exists === false &&
        !savedTasks.some((saved) => saved.id === task.id));
      this.tasks = [...savedTasks, ...drafts];
      const rawNextTask = response.next_task ?? response.nextTask;
      const advertised = rawNextTask === null || rawNextTask === undefined ? null : Number(rawNextTask);
      this.nextTask = Number.isInteger(advertised) && advertised >= 0 ? advertised : null;
      this.message.textContent = this.slots.some((slot) => slot?.source !== "empty")
        ? "任务列表已从板载 Flash 读取。每个任务可以组合多个宏槽位。"
        : "任务列表已读取。请先在宏设置中创建或导入宏，再保存任务。";
      this.render();
      this.onTasks(savedTasks);
      return true;
    } catch (error) {
      if (revision !== this.dataRevision) return true;
      this.message.textContent = error.message;
      return false;
    }
  }

  taskForId(id) {
    const taskId = Number(id);
    return this.tasks.find((task) => Number(task?.id) === taskId) || null;
  }

  getNextTask() {
    const draft = this.tasks.find((task) => task?.exists === false &&
      Number.isInteger(Number(task.id)) && Number(task.id) >= 0);
    if (draft) return Number(draft.id);
    if (Number.isInteger(this.nextTask) && this.nextTask >= 0 &&
        !this.tasks.some((task) => task?.exists !== false && Number(task.id) === this.nextTask)) {
      return this.nextTask;
    }
    const used = new Set(this.tasks.filter((task) => task?.exists !== false)
      .map((task) => Number(task?.id))
      .filter((id) => Number.isInteger(id) && id >= 0));
    let id = 0;
    while (used.has(id)) id += 1;
    return id;
  }

  updateTask(task) {
    const id = Number(task.id);
    const index = this.tasks.findIndex((item) => Number(item.id) === id);
    if (index < 0) this.tasks = [...this.tasks, task];
    else this.tasks[index] = task;
  }

  setConnection() {
    if (!this.isConnected()) this.message.textContent = "连接设备后读取任务列表。";
    this.render();
  }

  render() {
    const visible = this.tasks.filter((task) => task.exists);
    const nextTask = this.getNextTask();
    const capacityAvailable = !this.storageTotal || this.storageUsed < this.storageTotal * 0.9;
    const firstEmpty = capacityAvailable
      ? (this.tasks.find((task) => Number(task.id) === nextTask && !task.exists) ||
        { id: nextTask, exists: false, name: "", entries: [] })
      : null;
    const renderTask = (task) => {
      const entries = (Array.isArray(task.entries) && task.entries.length) ? task.entries : [[this.slots.find((slot) => slot?.source !== "empty")?.slot ?? 0, 1]];
      const availableSlots = this.slots.filter((summary) => summary?.source !== "empty");
      const options = availableSlots.map((summary) => {
        const slot = Number(summary.slot);
        return `<option value="${slot}">${String(slot + 1).padStart(2, "0")} · ${escapeHtml(summary.name || "未命名宏")}</option>`;
      }).join("");
      const shareId = task.share_id || task.shareId || "未生成";
      return `<article class="task-card" data-task="${task.id}">
        <div class="task-card-head"><span class="task-number">TASK ${String(task.id + 1).padStart(2, "0")}</span><strong>${task.exists ? escapeHtml(task.name) : "新任务列表"}</strong><small>更新：${task.updated_at ? new Date(Number(task.updated_at) * 1000).toLocaleString("zh-CN", { hour12: false }) : "未记录"} · 分享 ID：${escapeHtml(shareId)}</small></div>
        <label class="task-name">任务名称<input maxlength="48" data-task-name value="${escapeHtml(task.name || `任务 ${task.id + 1}`)}" ${this.busy ? "disabled" : ""}></label>
        <div class="task-entries">${entries.map(([slot, repeats], index) => `<div class="task-entry" data-entry="${index}"><span>${index + 1}.</span><select data-entry-slot ${availableSlots.length ? "" : "disabled"}>${options}</select><span>执行</span><input type="number" min="1" max="9999" value="${repeats}" data-entry-repeats><span>次</span><button type="button" data-task-action="remove-entry" aria-label="移除步骤">×</button></div>`).join("")}</div>
        ${availableSlots.length ? "" : '<p class="task-empty-hint">先在宏设置中创建或导入一个宏，才能添加任务步骤。</p>'}
        <div class="task-actions"><button type="button" data-task-action="add-entry" ${!availableSlots.length ? "disabled" : ""}>＋ 添加槽位</button><button type="button" data-task-action="save" ${!this.isConnected() || this.busy || this.isRunning() || !availableSlots.length ? "disabled" : ""}>保存任务</button><button type="button" data-task-action="delete" ${!task.exists || !this.isConnected() || this.busy || this.isRunning() ? "disabled" : ""}>删除任务</button></div>
      </article>`;
    };
    this.list.innerHTML = visible.map(renderTask).join("") +
      (firstEmpty ? renderTask(firstEmpty) : "");
    for (const card of this.list.querySelectorAll("[data-task]")) {
      const task = this.taskForId(Number(card.dataset.task)) || firstEmpty;
      card.querySelectorAll("[data-entry-slot]").forEach((select, index) => {
        select.value = String((task.entries[index] || [this.slots.find((slot) => slot?.source !== "empty")?.slot ?? 0])[0]);
      });
    }
  }

  readCard(card) {
    const name = card.querySelector("[data-task-name]").value.trim();
    const entries = [...card.querySelectorAll("[data-entry]")].map((row) =>
      [Number(row.querySelector("[data-entry-slot]").value),
        Number(row.querySelector("[data-entry-repeats]").value)]);
    return { name, entries };
  }

  rememberDraft(event) {
    const card = event.target.closest("[data-task]");
    if (!card) return;
    const id = Number(card.dataset.task);
    const task = this.taskForId(id) || { id, exists: false, name: "", entries: [] };
    this.updateTask({ ...task, ...this.readCard(card) });
  }

  async action(event) {
    const button = event.target.closest("[data-task-action]");
    if (!button || this.busy) return;
    const card = button.closest("[data-task]");
    const id = Number(card.dataset.task);
    const type = button.dataset.taskAction;
    if (type === "add-entry" || type === "remove-entry") {
      const draft = this.readCard(card);
      if (type === "add-entry") draft.entries.push([this.slots.find((slot) => slot?.source !== "empty")?.slot ?? 0, 1]);
      if (type === "remove-entry") draft.entries.splice(Number(button.closest("[data-entry]").dataset.entry), 1);
      const task = this.taskForId(id) || { id, exists: false, name: "", entries: [] };
      this.updateTask({ ...task, ...draft });
      this.render();
      return;
    }
    if (!this.isConnected() || this.isRunning()) return;
    const draft = this.readCard(card);
    const task = this.taskForId(id) || { id, exists: false, name: "", entries: [] };
    this.updateTask({ ...task, ...draft });
    this.busy = true;
    this.render();
    try {
      if (type === "delete") {
        await this.request(`TASK_DELETE ${id}`, "ack");
        this.dataRevision += 1;
        this.tasks = this.tasks.filter((item) => Number(item.id) !== id);
      } else {
        const { name, entries } = draft;
        const bytes = new TextEncoder().encode(name);
        if (!name || bytes.length > 48 || !entries.length ||
            entries.some(([slot, repeats]) => !Number.isInteger(slot) || slot < 0 ||
              !Number.isInteger(repeats) || repeats < 1 || repeats > 9999)) {
          throw new Error("请输入任务名称，并为每一步设置槽位和 1–9999 次执行次数。");
        }
        if (entries.some(([slot]) => !this.slots.some((summary) =>
          Number(summary?.slot) === slot && summary.source !== "empty"))) {
          throw new Error("任务引用了空宏槽位，请先保存对应宏。");
        }
        await this.request(`TASK_SAVE ${id} ${hexText(name)} ${entries.length} ${entries.map((entry) => entry.join(":")).join(",")} ${Math.floor(Date.now() / 1000)}`, "ack");
        this.dataRevision += 1;
        this.updateTask({ ...task, ...draft, exists: true,
          updated_at: Math.floor(Date.now() / 1000) });
      }
      const refreshed = await this.loadList();
      this.message.textContent = refreshed
        ? (type === "delete" ? "任务已删除。" : "任务已保存到板载 Flash。")
        : (type === "delete" ? "任务已删除；列表暂未刷新，请稍后重新读取。"
          : "任务已保存到板载 Flash；列表暂未刷新，请稍后重新读取。");
    } catch (error) {
      this.message.textContent = type === "save" && /超时/.test(error.message)
        ? "保存结果未确认：设备响应超时。请先刷新任务列表，再决定是否重试。"
        : error.message;
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
