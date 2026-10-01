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
    await this.port.open({ baudRate: DEVICE_BAUD_RATE, bufferSize: 255 });
    try {
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
    try {
      while (this.connected && this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (this.connected) {
            const { value, done } = await this.reader.read();
            if (done) {
              break;
            }
            buffered += new TextDecoder().decode(value, { stream: true });
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
    this.macroSteps = MOCK_BUILTIN_STEPS.map((step) => [...step]);
    this.macroGap = 2585;
    this.macroColor = 0;
    this.macroSource = "builtin";
    this.staged = null;
  }

  static isSupported() {
    return true;
  }

  async connect() {
    this.connected = true;
  }

  async send(command) {
    if (!this.connected) {
      throw new Error("模拟串口尚未连接");
    }
    if (command === "START") {
      this.state = "running";
      this.phase = "steps";
      this.step = 1;
      this.emit("status");
    } else if (command === "STOP") {
      this.state = "idle";
      this.phase = "idle";
      this.step = 0;
      this.emit("status");
    } else if (command === "HELLO" || command === "INFO") {
      this.emit("info");
    } else if (command === "STATUS") {
      this.emit("status");
    } else if (command === "PING") {
      this.onLine("PONG");
    } else if (command === "MACRO_LIST") {
      const duration = this.macroSteps.reduce((total, step) => total + step[0], 0);
      this.onLine(JSON.stringify({ type: "macro_list", ok: true, storage: "ready",
        slots: [{ slot: 0, name: "素材远征", source: this.macroSource,
          steps: this.macroSteps.length, duration_ms: duration,
          loop_gap_ms: this.macroGap, color: this.macroColor }] }));
    } else if (command === "MACRO_GET") {
      this.onLine(JSON.stringify({ type: "macro", ok: true, slot: 0,
        source: this.macroSource, loop_gap_ms: this.macroGap,
        color: this.macroColor, steps: this.macroSteps }));
    } else if (command === "MACRO_ABORT") {
      this.staged = null;
      this.onLine("OK");
    } else if (command === "MACRO_RESTORE") {
      this.macroSteps = MOCK_BUILTIN_STEPS.map((step) => [...step]);
      this.macroGap = 2585;
      this.macroColor = 0;
      this.macroSource = "builtin";
      this.onLine("OK");
    } else if (command === "MACRO_STORAGE_FORMAT") {
      this.onLine("ERR storage-already-ready");
    } else if (command.startsWith("MACRO_BEGIN ")) {
      const values = command.split(" ").slice(1).map(Number);
      if (values.length !== 3 || values.some((value) => !Number.isInteger(value)) ||
          values[0] < 1 || values[0] > 128 || values[1] < 0 || values[1] > 600000 ||
          values[2] < 0 || values[2] > 5) {
        this.onLine("ERR invalid-macro-begin");
      } else {
        this.staged = { steps: Array(values[0]).fill(null), loopGapMs: values[1], color: values[2] };
        this.onLine("OK");
      }
    } else if (command.startsWith("MACRO_STEP ")) {
      const values = command.split(" ").slice(1).map(Number);
      if (!this.staged || values.length !== 8 || values.some((value) => !Number.isInteger(value)) ||
          values[0] < 0 || values[0] >= this.staged.steps.length) {
        this.onLine("ERR invalid-macro-step");
      } else {
        this.staged.steps[values[0]] = values.slice(1);
        this.onLine("OK");
      }
    } else if (command.startsWith("MACRO_COMMIT ")) {
      if (!this.staged || this.staged.steps.some((step) => !step)) {
        this.onLine("ERR missing-macro-step");
      } else {
        const macro = { ...this.staged, steps: this.staged.steps.map(
          ([durationMs, buttons, dpad, leftX, leftY, rightX, rightY]) =>
            ({ durationMs, buttons, dpad, leftX, leftY, rightX, rightY }),
        ) };
        if (macroChecksum(macro) !== Number(command.split(" ")[1])) {
          this.onLine("ERR macro-checksum");
        } else {
          this.macroSteps = this.staged.steps.map((step) => [...step]);
          this.macroGap = this.staged.loopGapMs;
          this.macroColor = this.staged.color;
          this.macroSource = "flash";
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

  emit(type) {
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
        steps: this.macroSteps.length,
        cycle: this.cycle,
        duration_ms: this.macroSteps.reduce((total, step) => total + step[0], 0),
        loop_gap_ms: this.macroGap,
        cycle_ms: this.macroSteps.reduce((total, step) => total + step[0], 0) + this.macroGap,
        source: this.macroSource,
        color: this.macroColor,
        macro_storage: "ready",
      }),
    );
  }
}
