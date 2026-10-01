import { BUTTON_BITS } from "./manual-input.js";

export const MAX_MACRO_NAME_BYTES = 48;
export const MIN_STEP_MS = 10;
export const MAX_STEP_MS = 600000;
export const MAX_LOOP_GAP_MS = 600000;

export const MACRO_COLORS = Object.freeze([
  { name: "紫色", css: "#ae48ff" },
  { name: "蓝色", css: "#2d73ff" },
  { name: "青色", css: "#00dcd7" },
  { name: "橙色", css: "#ff7d00" },
  { name: "粉色", css: "#ff4196" },
  { name: "白色", css: "#f5f5f5" },
]);

export const DPAD_OPTIONS = Object.freeze([
  { value: 15, name: "居中" },
  { value: 0, name: "上" },
  { value: 1, name: "右上" },
  { value: 2, name: "右" },
  { value: 3, name: "右下" },
  { value: 4, name: "下" },
  { value: 5, name: "左下" },
  { value: 6, name: "左" },
  { value: 7, name: "左上" },
]);

export function createBlankStep() {
  return { durationMs: 100, buttons: 0, dpad: 15,
    leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
}

export function normalizeMacro(message) {
  const steps = Array.isArray(message?.steps) ? message.steps : [];
  return {
    source: message.source === "flash" ? "flash" : "empty",
    name: String(message.name ?? "素材远征"),
    loopGapMs: Number(message.loop_gap_ms ?? message.loopGapMs ?? 0),
    color: Number(message.color ?? 0),
    updatedAt: Number(message.updated_at ?? message.updatedAt ?? 0),
    shareId: String(message.share_id ?? message.shareId ?? ""),
    steps: steps.map((values) => {
      if (Array.isArray(values)) {
        const [durationMs, buttons, dpad, leftX, leftY, rightX, rightY] = values;
        return { durationMs: Number(durationMs), buttons: Number(buttons),
          dpad: Number(dpad), leftX: Number(leftX), leftY: Number(leftY),
          rightX: Number(rightX), rightY: Number(rightY) };
      }
      return { ...createBlankStep(), ...values };
    }),
  };
}

export function macroDurationMs(macro) {
  return macro.steps.reduce((total, step) => total + step.durationMs, 0);
}

export function validateMacro(macro) {
  const name = String(macro.name ?? "").trim();
  if (!name || new TextEncoder().encode(name).length > MAX_MACRO_NAME_BYTES ||
      /[\u0000-\u001f\u007f]/.test(name)) {
    return "宏名称不能为空，且最多 48 字节（约 16 个汉字）。";
  }
  if (!Array.isArray(macro.steps) || macro.steps.length < 1) {
    return "宏至少需要包含一个动作。";
  }
  if (!Number.isInteger(macro.loopGapMs) || macro.loopGapMs < 0 ||
      macro.loopGapMs > MAX_LOOP_GAP_MS) {
    return "循环间隔应为 0–600000 毫秒。";
  }
  if (!Number.isInteger(macro.color) || macro.color < 0 ||
      macro.color >= MACRO_COLORS.length) {
    return "请选择灯光颜色。";
  }
  for (const [index, step] of macro.steps.entries()) {
    const values = [step.durationMs, step.buttons, step.dpad, step.leftX,
      step.leftY, step.rightX, step.rightY];
    if (values.some((value) => !Number.isInteger(value)) ||
        step.durationMs < MIN_STEP_MS || step.durationMs > MAX_STEP_MS ||
        step.buttons < 0 || step.buttons > 0x3fff ||
        (step.dpad > 7 && step.dpad !== 15) || step.dpad < 0 ||
        [step.leftX, step.leftY, step.rightX, step.rightY].some(
          (value) => value < 0 || value > 255)) {
      return `第 ${index + 1} 步存在无效数值：保持时间 10–600000 ms，轴值 0–255。`;
    }
  }
  return "";
}

function checksumByte(checksum, value) {
  return Math.imul(checksum ^ (value & 0xff), 16777619) >>> 0;
}

function checksum16(checksum, value) {
  return checksumByte(checksumByte(checksum, value), value >>> 8);
}

function checksum32(checksum, value) {
  return checksum16(checksum16(checksum, value), value >>> 16);
}

// Must match firmware/src/MacroSlotStorage.cpp field and byte order.
export function macroChecksum(macro) {
  // The wire/storage format uses a 32-bit step count so records can grow
  // until Flash/heap space is exhausted instead of wrapping at 65535 steps.
  let checksum = checksum32(2166136261, macro.steps.length);
  checksum = checksum32(checksum, macro.loopGapMs);
  checksum = checksumByte(checksum, macro.color);
  for (const step of macro.steps) {
    checksum = checksum32(checksum, step.durationMs);
    checksum = checksum16(checksum, step.buttons);
    checksum = checksumByte(checksum, step.dpad);
    checksum = checksumByte(checksum, step.leftX);
    checksum = checksumByte(checksum, step.leftY);
    checksum = checksumByte(checksum, step.rightX);
    checksum = checksumByte(checksum, step.rightY);
  }
  return checksum;
}

export function describeStep(step) {
  const buttons = Object.entries(BUTTON_BITS)
    .filter(([, bit]) => (step.buttons & (1 << bit)) !== 0)
    .map(([name]) => name);
  const dpad = DPAD_OPTIONS.find((item) => item.value === step.dpad);
  if (step.dpad !== 15) buttons.push(`方向 ${dpad?.name ?? step.dpad}`);
  if (step.leftX !== 128 || step.leftY !== 128) buttons.push("左摇杆");
  if (step.rightX !== 128 || step.rightY !== 128) buttons.push("右摇杆");
  return buttons.length ? buttons.join(" + ") : "中立等待";
}
