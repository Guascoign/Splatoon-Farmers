import { DEVICE_BAUD_RATE, parseDeviceLine } from "./protocol.js";
import { MACRO_SLOT_COUNT, MAX_SLOT_IMAGE_BYTES, macroChecksum } from "./macro-editor.js";
import { imageChecksum } from "./slot-image.js";
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
    this.slots = Array.from({ length: MACRO_SLOT_COUNT }, (_, slot) => slot === 0
      ? { name: "素材远征", source: "builtin", steps: MOCK_BUILTIN_STEPS.map((step) => [...step]),
        gap: 2585, color: 0, image: null }
      : { name: "", source: "empty", steps: [], gap: 0, color: 0, image: null });
    this.activeSlot = 0;
    this.staged = null;
    this.imageStaged = null;
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
    if (/^START(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      if (!this.slots[slot] || this.slots[slot].source === "empty") {
        this.onLine("ERR macro-empty");
      } else {
        this.activeSlot = slot;
        this.state = "running";
        this.phase = "steps";
        this.step = 1;
        this.emit("status");
      }
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
      const slots = this.slots.map((item, slot) => {
        const imageBytes = item.image ? item.image.length + 14 : 0;
        const macroBytes = item.source === "flash" ? 20 +
          new TextEncoder().encode(item.name).length + item.steps.length * 11 : 0;
        return { slot, name: item.name, source: item.source,
          steps: item.steps.length,
          duration_ms: item.steps.reduce((total, step) => total + step[0], 0),
          loop_gap_ms: item.gap, color: item.color,
          used_bytes: macroBytes + imageBytes, image_bytes: imageBytes,
          image_size: item.image?.length || 0 };
      });
      this.onLine(JSON.stringify({ type: "macro_list", ok: true, storage: "ready",
        used_bytes: slots.reduce((total, slot) => total + slot.used_bytes, 0),
        total_bytes: 3538944, slots }));
    } else if (/^MACRO_GET(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      const item = this.slots[slot];
      if (!item || item.source === "empty") this.onLine("ERR macro-empty");
      else this.onLine(JSON.stringify({ type: "macro", ok: true, slot,
        name: item.name, source: item.source, loop_gap_ms: item.gap,
        color: item.color, steps: item.steps }));
    } else if (command === "MACRO_ABORT") {
      this.staged = null;
      this.onLine("OK");
    } else if (/^MACRO_RESTORE(?: \d+)?$/.test(command)) {
      const slot = Number(command.split(" ")[1] ?? 0);
      if (!this.slots[slot]) this.onLine("ERR invalid-slot");
      else {
        const image = this.slots[slot].image;
        this.slots[slot] = slot === 0
          ? { name: "素材远征", source: "builtin",
            steps: MOCK_BUILTIN_STEPS.map((step) => [...step]), gap: 2585,
            color: 0, image }
          : { name: "", source: "empty", steps: [], gap: 0, color: 0, image };
        this.onLine("OK");
      }
    } else if (command === "MACRO_STORAGE_FORMAT") {
      this.onLine("ERR storage-already-ready");
    } else if (command.startsWith("MACRO_BEGIN ")) {
      const values = command.split(" ").slice(1).map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isInteger(value)) ||
          values[0] < 0 || values[0] >= MACRO_SLOT_COUNT ||
          values[1] < 1 || values[1] > 128 ||
          values[2] < 0 || values[2] > 600000 || values[3] < 0 || values[3] > 5) {
        this.onLine("ERR invalid-macro-begin");
      } else {
        this.staged = { slot: values[0], steps: Array(values[1]).fill(null),
          loopGapMs: values[2], color: values[3], name: `宏槽位 ${String(values[0] + 1).padStart(2, "0")}` };
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
          this.slots[this.staged.slot] = { name: this.staged.name, source: "flash",
            steps: this.staged.steps.map((step) => [...step]),
            gap: this.staged.loopGapMs, color: this.staged.color,
            image: this.slots[this.staged.slot].image };
          this.staged = null;
          this.onLine("OK");
        }
      }
    } else if (/^SLOT_IMAGE_INFO \d+$/.test(command)) {
      const slot = Number(command.split(" ")[1]);
      const image = this.slots[slot]?.image;
      if (!this.slots[slot]) this.onLine("ERR invalid-slot");
      else this.onLine(JSON.stringify({ type: "slot_image_info", ok: true,
        slot, exists: Boolean(image), bytes: image?.length || 0 }));
    } else if (/^SLOT_IMAGE_READ \d+ \d+$/.test(command)) {
      const [, slotRaw, offsetRaw] = command.split(" ");
      const image = this.slots[Number(slotRaw)]?.image;
      const offset = Number(offsetRaw);
      if (!image || offset >= image.length) this.onLine("ERR image-read-failed");
      else this.onLine(JSON.stringify({ type: "slot_image_chunk", ok: true, offset,
        data: [...image.subarray(offset, offset + 80)]
          .map((byte) => byte.toString(16).padStart(2, "0")).join("") }));
    } else if (command.startsWith("SLOT_IMAGE_BEGIN ")) {
      const values = command.split(" ").slice(1).map(Number);
      if (values.length !== 3 || !this.slots[values[0]] ||
          values[1] < 1 || values[1] > MAX_SLOT_IMAGE_BYTES ||
          values.some((value) => !Number.isInteger(value)))
        this.onLine("ERR invalid-image-begin");
      else {
        this.imageStaged = { slot: values[0], bytes: values[1],
          checksum: values[2], data: [] };
        this.onLine("OK");
      }
    } else if (command.startsWith("SLOT_IMAGE_CHUNK ")) {
      const hex = command.slice(17);
      if (!this.imageStaged || !/^(?:[0-9a-f]{2}){1,96}$/i.test(hex) ||
          this.imageStaged.data.length + hex.length / 2 > this.imageStaged.bytes)
        this.onLine("ERR invalid-image-chunk");
      else {
        this.imageStaged.data.push(...hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
        this.onLine("OK");
      }
    } else if (command === "SLOT_IMAGE_COMMIT") {
      const staged = this.imageStaged;
      if (!staged || staged.data.length !== staged.bytes ||
          imageChecksum(staged.data) !== staged.checksum)
        this.onLine("ERR image-commit-failed");
      else {
        this.slots[staged.slot].image = new Uint8Array(staged.data);
        this.imageStaged = null;
        this.onLine("OK");
      }
    } else if (command === "SLOT_IMAGE_ABORT") {
      this.imageStaged = null;
      this.onLine("OK");
    } else if (/^SLOT_IMAGE_DELETE \d+$/.test(command)) {
      const slot = Number(command.split(" ")[1]);
      if (!this.slots[slot]) this.onLine("ERR invalid-slot");
      else {
        this.slots[slot].image = null;
        this.onLine("OK");
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
    const macro = this.slots[this.activeSlot];
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
      }),
    );
  }
}
