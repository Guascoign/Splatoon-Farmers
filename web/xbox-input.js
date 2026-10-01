import { BUTTON_BITS } from "./manual-input.js";
import { MAX_MACRO_STEPS, MAX_STEP_MS, MIN_STEP_MS } from "./macro-editor.js";

export const NEUTRAL_REPORT = Object.freeze({
  buttons: 0, dpad: 15, leftX: 128, leftY: 128, rightX: 128, rightY: 128,
});

export const XBOX_KEYS = Object.freeze([
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "VIEW", "MENU",
  "LS", "RS", "UP", "RIGHT", "DOWN", "LEFT", "GUIDE", "SHARE",
]);
export const SWITCH_KEYS = Object.freeze([
  "A", "B", "X", "Y", "L", "R", "ZL", "ZR", "MINUS", "PLUS",
  "L_STICK_PRESS", "R_STICK_PRESS", "DPAD_UP", "DPAD_RIGHT",
  "DPAD_DOWN", "DPAD_LEFT", "HOME", "CAPTURE",
]);
export const DEFAULT_BINDINGS = Object.freeze({
  A: "B", B: "A", X: "Y", Y: "X",
  LB: "L", RB: "R", LT: "ZL", RT: "ZR",
  VIEW: "MINUS", MENU: "PLUS", LS: "L_STICK_PRESS",
  RS: "R_STICK_PRESS", UP: "DPAD_UP", RIGHT: "DPAD_RIGHT",
  DOWN: "DPAD_DOWN", LEFT: "DPAD_LEFT",
  GUIDE: "HOME", SHARE: "CAPTURE",
});
export const DEFAULT_STICK_BINDINGS = Object.freeze({ left: "left", right: "right" });
const GAMEPAD_BUTTON_KEYS = Object.freeze([
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "VIEW", "MENU",
  "LS", "RS", "UP", "DOWN", "LEFT", "RIGHT", "GUIDE", "SHARE",
]);
const REPORT_FIELDS = Object.keys(NEUTRAL_REPORT);

export function normalizedBindings(raw) {
  const result = { ...DEFAULT_BINDINGS };
  for (const key of XBOX_KEYS) {
    if (raw && Object.hasOwn(raw, key) &&
        (raw[key] === null || SWITCH_KEYS.includes(raw[key]))) result[key] = raw[key];
  }
  return result;
}

export function normalizedStickBindings(raw) {
  const result = { ...DEFAULT_STICK_BINDINGS };
  for (const side of ["left", "right"]) {
    if (raw && Object.hasOwn(raw, side) &&
        (raw[side] === null || raw[side] === "left" || raw[side] === "right")) {
      result[side] = raw[side];
    }
  }
  if (result.left && result.left === result.right) return { ...DEFAULT_STICK_BINDINGS };
  return result;
}

export function xboxGamepads() {
  if (typeof navigator.getGamepads !== "function") return [];
  return [...(navigator.getGamepads() || [])].filter((pad) => pad?.connected &&
    pad.mapping === "standard" && /xbox|microsoft|045e|xinput/i.test(pad.id));
}

function pressed(button) {
  return Boolean(button?.pressed || Number(button?.value) >= 0.5);
}

function axisByte(value) {
  const number = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const magnitude = Math.abs(number);
  if (magnitude <= 0.16) return 128;
  const scaled = (magnitude - 0.16) / 0.84;
  // Four-byte increments suppress stick noise without losing useful travel.
  const raw = Math.round(127.5 + Math.sign(number) * scaled * 127.5);
  return Math.max(0, Math.min(255, Math.round(raw / 4) * 4));
}

export function xboxPressedKeys(pad) {
  return new Set(GAMEPAD_BUTTON_KEYS.filter((_, index) => pressed(pad.buttons[index])));
}

function dpadValue(controls) {
  const up = controls.has("DPAD_UP");
  const down = controls.has("DPAD_DOWN");
  const left = controls.has("DPAD_LEFT");
  const right = controls.has("DPAD_RIGHT");
  const vertical = up === down ? 0 : up ? -1 : 1;
  const horizontal = left === right ? 0 : left ? -1 : 1;
  const values = { "0,-1": 0, "1,-1": 1, "1,0": 2, "1,1": 3,
    "0,1": 4, "-1,1": 5, "-1,0": 6, "-1,-1": 7, "0,0": 15 };
  return values[`${horizontal},${vertical}`];
}

export function xboxToReport(pad, bindings = DEFAULT_BINDINGS,
                             stickBindings = DEFAULT_STICK_BINDINGS) {
  let buttons = 0;
  const controls = new Set();
  for (const source of xboxPressedKeys(pad)) {
    const target = bindings[source];
    if (target) controls.add(target);
  }
  for (const control of controls) {
    if (Object.hasOwn(BUTTON_BITS, control)) buttons |= 1 << BUTTON_BITS[control];
  }
  const report = { ...NEUTRAL_REPORT, buttons, dpad: dpadValue(controls) };
  for (const source of ["left", "right"]) {
    const target = stickBindings[source];
    if (target !== "left" && target !== "right") continue;
    const offset = source === "left" ? 0 : 2;
    report[`${target}X`] = axisByte(pad.axes[offset]);
    report[`${target}Y`] = axisByte(pad.axes[offset + 1]);
  }
  return report;
}

export function reportsEqual(left, right) {
  return REPORT_FIELDS.every((field) => left?.[field] === right?.[field]);
}

export function digitalChanged(left, right) {
  return left?.buttons !== right?.buttons || left?.dpad !== right?.dpad;
}

export function axisDifference(left, right) {
  return Math.max(...["leftX", "leftY", "rightX", "rightY"]
    .map((field) => Math.abs((left?.[field] ?? 128) - (right?.[field] ?? 128))));
}

function axisActive(report) {
  return ["leftX", "leftY", "rightX", "rightY"]
    .some((field) => report[field] !== 128);
}

export function reportCommand(report) {
  return `G ${report.buttons} ${report.dpad} ${report.leftX} ${report.leftY} ${report.rightX} ${report.rightY}`;
}

export function describeReport(report) {
  const buttons = Object.entries(BUTTON_BITS)
    .filter(([, bit]) => (report.buttons & (1 << bit)) !== 0)
    .map(([name]) => name);
  if (report.dpad !== 15) buttons.push("方向键");
  if (report.leftX !== 128 || report.leftY !== 128) buttons.push("左摇杆");
  if (report.rightX !== 128 || report.rightY !== 128) buttons.push("右摇杆");
  return buttons.length ? buttons.join(" + ") : "中立";
}

export class XboxRecorder {
  constructor() { this.reset(); }

  reset() {
    this.active = false;
    this.steps = [];
    this.current = { ...NEUTRAL_REPORT };
    this.startedAt = 0;
    this.since = 0;
    this.hasAction = false;
    this.sampleIntervalMs = 220;
  }

  start(report, now, sampleIntervalMs = 220) {
    this.reset();
    this.active = true;
    this.current = { ...report };
    this.startedAt = now;
    this.since = now;
    this.hasAction = !reportsEqual(report, NEUTRAL_REPORT);
    this.sampleIntervalMs = Math.max(80, Math.min(350, Number(sampleIntervalMs) || 220));
  }

  appendUntil(now) {
    let duration = Math.max(MIN_STEP_MS, Math.round(now - this.since));
    while (duration > 0) {
      if (this.steps.length >= MAX_MACRO_STEPS) return false;
      const part = Math.min(MAX_STEP_MS, duration);
      this.steps.push({ durationMs: part, ...this.current });
      duration -= part;
    }
    this.since = now;
    return true;
  }

  record(report, now, force = false) {
    if (!this.active || reportsEqual(report, this.current)) return true;
    const digitalEdge = digitalChanged(report, this.current);
    const stickStartedOrStopped = axisActive(report) !== axisActive(this.current);
    if (!digitalEdge && !stickStartedOrStopped &&
        (axisDifference(report, this.current) < 20 ||
         (!force && now - this.since < this.sampleIntervalMs))) return true;
    // Reserve one final step for the state currently held by the controller.
    if (this.steps.length >= MAX_MACRO_STEPS - 1) return false;
    if (!this.appendUntil(now) || this.steps.length >= MAX_MACRO_STEPS) return false;
    this.current = { ...report };
    this.hasAction ||= !reportsEqual(report, NEUTRAL_REPORT);
    return true;
  }

  finish(now) {
    if (!this.active) return null;
    this.appendUntil(now);
    this.active = false;
    return this.hasAction ? this.steps.map((step) => ({ ...step })) : null;
  }
}
