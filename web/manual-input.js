export const BUTTON_BITS = Object.freeze({
  Y: 0,
  B: 1,
  A: 2,
  X: 3,
  L: 4,
  R: 5,
  ZL: 6,
  ZR: 7,
  MINUS: 8,
  PLUS: 9,
  L_STICK_PRESS: 10,
  R_STICK_PRESS: 11,
  HOME: 12,
  CAPTURE: 13,
});

export const DPAD_CONTROLS = Object.freeze([
  "DPAD_UP",
  "DPAD_RIGHT",
  "DPAD_DOWN",
  "DPAD_LEFT",
]);

export const ALL_CONTROLS = Object.freeze([
  ...Object.keys(BUTTON_BITS),
  ...DPAD_CONTROLS,
]);

const VALID_CONTROLS = new Set(ALL_CONTROLS);

// Physical-key codes are layout-independent. IJKL mirrors the Switch face
// diamond; arrows drive the D-pad.
export const KEYBOARD_BINDINGS = Object.freeze({
  KeyJ: "Y",
  KeyK: "B",
  KeyL: "A",
  KeyI: "X",
  KeyQ: "L",
  KeyE: "R",
  Digit1: "ZL",
  Digit3: "ZR",
  Minus: "MINUS",
  Equal: "PLUS",
  KeyZ: "L_STICK_PRESS",
  KeyX: "R_STICK_PRESS",
  KeyH: "HOME",
  KeyC: "CAPTURE",
  ArrowUp: "DPAD_UP",
  ArrowRight: "DPAD_RIGHT",
  ArrowDown: "DPAD_DOWN",
  ArrowLeft: "DPAD_LEFT",
});

export function dpadValue(activeControls) {
  const active = new Set(activeControls);
  const up = active.has("DPAD_UP");
  const right = active.has("DPAD_RIGHT");
  const down = active.has("DPAD_DOWN");
  const left = active.has("DPAD_LEFT");

  const vertical = up === down ? 0 : up ? -1 : 1;
  const horizontal = left === right ? 0 : left ? -1 : 1;
  const values = new Map([
    ["0,-1", 0],
    ["1,-1", 1],
    ["1,0", 2],
    ["1,1", 3],
    ["0,1", 4],
    ["-1,1", 5],
    ["-1,0", 6],
    ["-1,-1", 7],
    ["0,0", 15],
  ]);
  return values.get(`${horizontal},${vertical}`) ?? 15;
}

export function buildManualReport(activeControls, axes = {}) {
  const active = new Set(activeControls);
  let buttons = 0;
  for (const [control, bit] of Object.entries(BUTTON_BITS)) {
    if (active.has(control)) {
      buttons |= 1 << bit;
    }
  }

  const report = {
    buttons,
    dpad: dpadValue(active),
    leftX: axes.leftX ?? 128,
    leftY: axes.leftY ?? 128,
    rightX: axes.rightX ?? 128,
    rightY: axes.rightY ?? 128,
  };
  return {
    ...report,
    command: `R ${report.buttons} ${report.dpad} ${report.leftX} ${report.leftY} ${report.rightX} ${report.rightY}`,
  };
}

export class ManualInputState {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.sourceControls = new Map();
    this.controlCounts = new Map();
  }

  press(source, control) {
    if (!source || !VALID_CONTROLS.has(control)) {
      return false;
    }

    const previousControl = this.sourceControls.get(source);
    if (previousControl === control) {
      return false;
    }

    let activeSetChanged = false;
    if (previousControl) {
      activeSetChanged = this.decrement(previousControl) || activeSetChanged;
    }

    this.sourceControls.set(source, control);
    const previousCount = this.controlCounts.get(control) || 0;
    this.controlCounts.set(control, previousCount + 1);
    activeSetChanged = previousCount === 0 || activeSetChanged;
    if (activeSetChanged) {
      this.notify();
    }
    return activeSetChanged;
  }

  release(source) {
    const control = this.sourceControls.get(source);
    if (!control) {
      return false;
    }
    this.sourceControls.delete(source);
    const activeSetChanged = this.decrement(control);
    if (activeSetChanged) {
      this.notify();
    }
    return activeSetChanged;
  }

  clear() {
    if (this.sourceControls.size === 0 && this.controlCounts.size === 0) {
      return false;
    }
    const activeSetChanged = this.controlCounts.size > 0;
    this.sourceControls.clear();
    this.controlCounts.clear();
    if (activeSetChanged) {
      this.notify();
    }
    return activeSetChanged;
  }

  activeControls() {
    return new Set(this.controlCounts.keys());
  }

  isPressed(control) {
    return this.controlCounts.has(control);
  }

  hasSource(source) {
    return this.sourceControls.has(source);
  }

  decrement(control) {
    const nextCount = (this.controlCounts.get(control) || 0) - 1;
    if (nextCount <= 0) {
      this.controlCounts.delete(control);
      return true;
    }
    this.controlCounts.set(control, nextCount);
    return false;
  }

  notify() {
    this.onChange(this.activeControls());
  }
}
