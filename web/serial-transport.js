import { DEVICE_BAUD_RATE, parseDeviceLine } from "./protocol.js";
import { macroChecksum } from "./macro-editor.js";
import { MOCK_BUILTIN_STEPS } from "./mock-macro.js";

// The page served by the ESP32 uses the same commands as the USB-UART link.
// HTTP works in mobile browsers, where Web Serial is generally unavailable.
export class HttpTransport {
  constructor({ onLine }) {
    this.onLine = onLine;
    this.connected = false;
    this.writeChain = Promise.resolve();
    this.abortController = null;
  }

  static isSupported() {
    return typeof fetch === "function";
  }

  async connect() {
    this.abortController = new AbortController();
    this.connected = true;
  }

  send(command) {
    const write = async () => {
      if (!this.connected) {
        throw new Error("设备网页尚未连接");
      }
      const response = await fetch(`/api/command?command=${encodeURIComponent(command)}`, {
        method: "POST",
        cache: "no-store",
        signal: this.abortController.signal,
      });
      const line = (await response.text()).trim();
      if (!response.ok || line.startsWith("ERR")) {
        throw new Error(parseDeviceLine(line)?.message || line || `设备返回 HTTP ${response.status}`);
      }
      if (line) {
        this.onLine(line);
      }
    };
    const result = this.writeChain.then(write, write);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async disconnect() {
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
  }
}

export class SerialTransport {
  constructor({ onLine, onDisconnect }) {
    this.onLine = onLine;
    this.onDisconnect = onDisconnect;
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.writeChain = Promise.resolve();
    this.connected = false;
    this.intentionalClose = false;
  }

  static isSupported() {
    return "serial" in navigator;
  }

  async connect() {
    if (!SerialTransport.isSupported()) {
      throw new Error("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。");
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: DEVICE_BAUD_RATE, bufferSize: 4096 });
    try {
      // Keep both active-low modem-control lines deasserted. DTR/RTS drive
      // the ESP32-S3 auto-reset circuit on many DevKit boards, and leaving
      // both high also avoids a line-state change when the port is closed.
      await this.port.setSignals({
        dataTerminalReady: false,
        requestToSend: false,
      });
    } catch {
      // Some USB-UART drivers do not expose modem control lines. The data
      // channel still works, and avoiding a hard failure is safer here.
    }
    this.intentionalClose = false;
    this.connected = true;
    this.readTask = this.readLoop();
  }

  send(command) {
    const write = async () => {
      if (!this.connected || !this.port?.writable) {
        throw new Error("串口尚未连接");
      }
      const writer = this.port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(`${command}\n`));
      } finally {
        writer.releaseLock();
      }
    };
    const result = this.writeChain.then(write, write);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async disconnect() {
    if (!this.port) {
      return;
    }
    this.intentionalClose = true;
    this.connected = false;

    await this.writeChain.catch(() => {});
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // The physical port may already be gone.
      }
    }
    if (this.readTask) {
      try {
        await this.readTask;
      } catch {
        // readLoop reports unexpected failures through onDisconnect.
      }
    }
    try {
      await this.port.close();
    } finally {
      this.port = null;
      this.readTask = null;
      this.intentionalClose = false;
    }
  }

  async readLoop() {
    let buffered = "";
    const decoder = new TextDecoder();
    try {
      while (this.connected && this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (this.connected) {
            const { value, done } = await this.reader.read();
            if (done) {
              break;
            }
            buffered += decoder.decode(value, { stream: true });
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) {
                this.onLine(line);
              }
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      if (!this.intentionalClose && this.connected) {
        this.connected = false;
        this.onDisconnect(error);
      }
      return;
    }

    if (!this.intentionalClose && this.connected) {
      this.connected = false;
      this.onDisconnect(new Error("串口数据流已经断开"));
    }
  }
}

export class MockSerialTransport {
  constructor({ onLine, onDisconnect }) {
    this.onLine = onLine;
    this.onDisconnect = onDisconnect;
    this.connected = false;
    this.state = "idle";
    this.phase = "idle";
    this.step = 0;
    this.cycle = 0;
    this.lastReport = null;
    // Keep a demo routine in mock mode so the console remains usable without a
    // board. The real firmware has no built-in slot; this simulated record is
    // only test/demo data and does not impose a slot-count limit.
    this.slots = [{ slot: 0, name: "素材远征", source: "builtin",
      steps: MOCK_BUILTIN_STEPS.map((step) => [...step]), gap: 2585, color: 0,
      updated_at: 0, share_id: "" }];
    this.activeSlot = 0;
    this.staged = null;
    this.tasks = [];
    this.settings = { wifi_enabled: true, wifi_ssid: "ESP32-S3-Switch", password_set: false, led_brightness: 36 };
    this.slotCycles = [];
    this.taskCycles = [];
    this.activeTask = -1;
    this.runStartedAt = 0;
    this.pauseStartedAt = 0;
    this.pausedDurationMs = 0;
  }

  static isSupported() {
    return true;
  }

  async connect() {
    this.connected = true;
  }

  slotForId(slot) {
    return this.slots.find((item) => Number(item.slot) === Number(slot)) || null;
  }

  taskForId(id) {
    return this.tasks.find((item) => Number(item.id) === Number(id)) || null;
  }

  nextId(items, key) {
    const used = new Set(items.map((item) => Number(item[key]))
      .filter((value) => Number.isInteger(value) && value >= 0));
    let value = 0;
    while (used.has(value)) value += 1;
    return value;
  }

  async send(command) {
    if (!this.connected) {
      throw new Error("模拟串口尚未连接");
    }
    if (/^START(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      const macro = this.slotForId(slot);
      if (!macro || macro.source === "empty") {
        this.onLine("ERR macro-empty");
      } else {
        this.activeSlot = slot;
        this.activeTask = -1;
        this.state = "running";
        this.phase = "steps";
        this.step = 1;
        this.cycle = 0;
        this.runStartedAt = Date.now();
        this.pauseStartedAt = 0;
        this.pausedDurationMs = 0;
        this.emit("status");
      }
    } else if (command === "TASK_LIST") {
      this.onLine(JSON.stringify({ type: "task_list", ok: true, tasks: this.tasks,
        next_task: this.nextId(this.tasks, "id") }));
    } else if (/^TASK_SAVE /.test(command)) {
      const match = /^TASK_SAVE (\d+) ([0-9a-f]+) (\d+) ([\d:,]+)(?: (\d+))?$/i.exec(command);
      if (!match || !Number.isInteger(Number(match[1])) || Number(match[1]) < 0) this.onLine("ERR invalid-task");
      else {
        const id = Number(match[1]);
        const bytes = Uint8Array.from(match[2].match(/../g), (pair) => parseInt(pair, 16));
        const entries = match[4].split(",").map((pair) => pair.split(":").map(Number));
        const task = { id, exists: true,
          name: new TextDecoder().decode(bytes), entries,
          updated_at: Number(match[5]) || Math.floor(Date.now() / 1000),
          share_id: `${Date.now()}-${id}` };
        const index = this.tasks.findIndex((item) => Number(item.id) === id);
        if (index < 0) this.tasks.push(task); else this.tasks[index] = task;
        this.onLine("OK");
      }
    } else if (/^TASK_DELETE \d+$/.test(command)) {
      const id = Number(command.split(" ")[1]);
      const index = this.tasks.findIndex((item) => Number(item.id) === id);
      if (index < 0) this.onLine("ERR invalid-task");
      else { this.tasks.splice(index, 1); this.onLine("OK"); }
    } else if (/^TASK_START \d+$/.test(command)) {
      const id = Number(command.split(" ")[1]);
      const task = this.taskForId(id);
      if (!task?.exists) this.onLine("ERR invalid-task");
      else {
        this.activeTask = id;
        this.activeSlot = task.entries[0][0];
        this.state = "running";
        this.phase = "steps";
        this.step = 1;
        this.cycle = 0;
        this.runStartedAt = Date.now();
        this.pauseStartedAt = 0;
        this.pausedDurationMs = 0;
        this.emit("status");
      }
    } else if (command === "SETTINGS_GET") {
      this.onLine(JSON.stringify({ type: "settings", ok: true, version: "V1.0",
        firmware: "SplatoonFarmers/mock", serial_baud: DEVICE_BAUD_RATE, ...this.settings }));
    } else if (/^SETTINGS_SET /.test(command)) {
      const parts = command.split(" ");
      if (parts.length !== 6) this.onLine("ERR invalid-settings");
      else {
        const bytes = Uint8Array.from(parts[3].match(/../g), (pair) => parseInt(pair, 16));
        this.settings.wifi_enabled = parts[1] === "1";
        this.settings.led_brightness = Number(parts[2]);
        this.settings.wifi_ssid = new TextDecoder().decode(bytes);
        this.settings.password_set = parts[5] === "1" ? false : parts[4] !== "-" || this.settings.password_set;
        this.onLine("OK");
      }
    } else if (command === "STATS_GET") {
      this.onLine(JSON.stringify({ type: "stats", ok: true, total_run_ms: 0,
        recent_slot: -1, recent_task: -1, slot_cycles: this.slotCycles,
        task_cycles: this.taskCycles }));
    } else if (command === "PAUSE") {
      if (this.state === "running") {
        this.pauseStartedAt = Date.now();
        this.state = "paused";
      }
      this.emit("status");
    } else if (command === "RESUME") {
      if (this.state === "paused") {
        this.pausedDurationMs += Date.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
        this.state = "running";
      }
      this.emit("status");
    } else if (command === "STOP") {
      this.state = "idle";
      this.phase = "idle";
      this.step = 0;
      this.activeTask = -1;
      this.pauseStartedAt = 0;
      this.pausedDurationMs = 0;
      this.emit("status");
    } else if (command === "HELLO" || command === "INFO") {
      this.emit("info");
    } else if (command === "STATUS") {
      this.emit("status");
    } else if (command === "PING") {
      this.onLine("PONG");
    } else if (command === "MACRO_LIST") {
      const slots = this.slots.map((item) => {
        const macroBytes = item.source === "flash" ? 20 +
          new TextEncoder().encode(item.name).length + item.steps.length * 11 : 0;
        return { slot: Number(item.slot), name: item.name, source: item.source,
          steps: item.steps.length,
          duration_ms: item.steps.reduce((total, step) => total + step[0], 0),
          loop_gap_ms: item.gap, color: item.color,
          used_bytes: macroBytes,
          updated_at: item.updated_at || 0, share_id: item.share_id || "" };
      });
      this.onLine(JSON.stringify({ type: "macro_list", ok: true, storage: "ready",
        used_bytes: slots.reduce((total, slot) => total + slot.used_bytes, 0),
        total_bytes: 3538944, next_slot: this.nextId(this.slots, "slot"), slots }));
    } else if (/^MACRO_GET(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      const item = this.slotForId(slot);
      if (!item || item.source === "empty") this.onLine("ERR macro-empty");
      else this.onLine(JSON.stringify({ type: "macro", ok: true, slot,
        name: item.name, source: item.source, loop_gap_ms: item.gap,
        color: item.color, updated_at: item.updated_at || 0, share_id: item.share_id || "",
        steps: item.steps }));
    } else if (command === "MACRO_ABORT") {
      this.staged = null;
      this.onLine("OK");
    } else if (/^MACRO_RESTORE(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      const index = this.slots.findIndex((item) => Number(item.slot) === slot);
      if (index < 0) this.onLine("ERR invalid-slot");
      else {
        this.slots.splice(index, 1);
        this.onLine("OK");
      }
    } else if (/^MACRO_DELETE \d+$/.test(command)) {
      const slot = Number(command.split(" ")[1]);
      const index = this.slots.findIndex((item) => Number(item.slot) === slot);
      if (index < 0) this.onLine("ERR invalid-slot");
      else {
        this.slots.splice(index, 1);
        this.onLine("OK");
      }
    } else if (command === "MACRO_STORAGE_FORMAT") {
      this.onLine("ERR storage-already-ready");
    } else if (command.startsWith("MACRO_BEGIN ")) {
      const values = command.split(" ").slice(1).map(Number);
      if ((values.length !== 4 && values.length !== 5) || values.some((value) => !Number.isSafeInteger(value)) ||
           values[0] < 0 ||
          values[1] < 1 || values[1] > Number.MAX_SAFE_INTEGER ||
          values[2] < 0 || values[2] > 600000 || values[3] < 0 || values[3] > 5) {
        this.onLine("ERR invalid-macro-begin");
      } else {
        // Keep the expected count separate from the received steps so the
        // mock does not allocate a giant sparse array merely because a
        // protocol client advertises a large macro. The real board applies
        // the same heap check when it stages the vector.
        this.staged = { slot: values[0], stepCount: values[1], stepMap: new Map(),
          loopGapMs: values[2], color: values[3], updated_at: values[4] || Math.floor(Date.now() / 1000),
          share_id: `${Date.now()}-${values[0]}`, name: `宏槽位 ${String(values[0] + 1).padStart(2, "0")}` };
        this.onLine("OK");
      }
    } else if (command.startsWith("MACRO_NAME ")) {
      if (!this.staged || !/^(?:[0-9a-f]{2}){1,48}$/i.test(command.slice(11))) {
        this.onLine("ERR invalid-macro-name");
      } else {
        const values = command.slice(11).match(/.{2}/g).map((pair) => parseInt(pair, 16));
        this.staged.name = new TextDecoder().decode(new Uint8Array(values));
        this.onLine("OK");
      }
    } else if (command.startsWith("MACRO_STEP ")) {
      const values = command.split(" ").slice(1).map(Number);
      if (!this.staged || values.length !== 8 || values.some((value) => !Number.isInteger(value)) ||
           values[0] < 0 || values[0] >= this.staged.stepCount) {
        this.onLine("ERR invalid-macro-step");
      } else {
        this.staged.stepMap.set(values[0], values.slice(1));
        this.onLine("OK");
      }
    } else if (command.startsWith("MACRO_COMMIT ")) {
      if (!this.staged || this.staged.stepMap.size !== this.staged.stepCount) {
        this.onLine("ERR missing-macro-step");
      } else {
        const stagedSteps = Array.from({ length: this.staged.stepCount }, (_, index) =>
          this.staged.stepMap.get(index));
        const macro = { ...this.staged, steps: stagedSteps.map(
          ([durationMs, buttons, dpad, leftX, leftY, rightX, rightY]) =>
            ({ durationMs, buttons, dpad, leftX, leftY, rightX, rightY }),
        ) };
        if (macroChecksum(macro) !== Number(command.split(" ")[1])) {
          this.onLine("ERR macro-checksum");
        } else {
          const macro = { slot: this.staged.slot, name: this.staged.name, source: "flash",
             steps: stagedSteps.map((step) => [...step]),
            gap: this.staged.loopGapMs, color: this.staged.color,
            updated_at: this.staged.updated_at,
            share_id: this.staged.share_id };
          const index = this.slots.findIndex((item) => Number(item.slot) === this.staged.slot);
          if (index < 0) this.slots.push(macro); else this.slots[index] = macro;
          this.staged = null;
          this.onLine("OK");
        }
      }
    } else if (/^[RG] \d+ \d+ \d+ \d+ \d+ \d+$/.test(command)) {
      this.state = "idle";
      this.phase = "idle";
      this.step = 0;
      this.lastReport = command;
      this.onLine("OK");
    } else {
      this.onLine("ERR");
    }
  }

  async disconnect() {
    this.connected = false;
  }

  runElapsedMs() {
    if (this.state === "idle") return 0;
    const now = this.state === "paused" ? this.pauseStartedAt : Date.now();
    return Math.max(0, now - this.runStartedAt - this.pausedDurationMs);
  }

  emit(type) {
    const macro = this.slotForId(this.activeSlot) ||
      { source: "empty", steps: [], gap: 0, color: 0 };
    const activeTask = this.taskForId(this.activeTask);
    const duration = macro.steps.reduce((total, step) => total + step[0], 0);
    this.onLine(
      JSON.stringify({
        type,
        ok: true,
        firmware: "SplatoonFarmers/mock",
        routine: "material-farm",
        embedded: true,
        state: this.state,
        phase: this.phase,
        step: this.step,
        steps: macro.steps.length,
        cycle: this.cycle,
        duration_ms: duration,
        loop_gap_ms: macro.gap,
        cycle_ms: duration + macro.gap,
        slot: this.activeSlot,
        source: macro.source,
        color: macro.color,
        macro_storage: "ready",
        mode: this.activeTask >= 0 ? "task" : "macro",
        task: this.activeTask,
        task_entry: this.activeTask >= 0 ? 1 : 0,
        task_entries: this.activeTask >= 0 ? activeTask?.entries?.length || 0 : 0,
        task_repeat: this.activeTask >= 0 ? 1 : 0,
        task_repeats: this.activeTask >= 0 ? activeTask?.entries?.[0]?.[1] || 0 : 0,
        task_loop: 0,
        run_ms: this.runElapsedMs(),
        product_version: "V1.0",
      }),
    );
  }
}
