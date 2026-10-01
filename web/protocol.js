export const DEVICE_BAUD_RATE = 921600;

const DEVICE_ERRORS = Object.freeze({
  "macro-running": "请先停止刷取，再修改宏。",
  "storage-unavailable": "宏存储尚未就绪，请在宏列表页确认是否需要初始化。",
  "storage-already-ready": "宏存储已经可用，无需初始化。",
  "storage-format-failed": "宏存储初始化失败。",
  "invalid-macro-begin": "宏的动作数量、循环间隔或灯色无效。",
  "invalid-macro-step": "有动作数据无效，请检查数值范围。",
  "invalid-macro-commit": "宏提交信息无效。",
  "missing-macro-step": "宏传输不完整，请重试。",
  "macro-checksum": "宏校验失败，请重试保存。",
  "macro-save-failed": "写入 Flash 失败，原有宏仍保留。",
  "restore-failed": "清空槽位宏失败。",
  "invalid-slot": "槽位编号无效。",
  "macro-empty": "该槽位还没有宏。",
  "invalid-macro-name": "宏名称无效，请缩短名称或移除控制字符。",
  "invalid-task": "任务列表无效，或引用的宏槽位不可用。",
  "task-save-failed": "任务列表写入板载存储失败。",
  "task-delete-failed": "任务列表删除失败。",
  "invalid-settings": "设备设置无效，请检查名称、密码和亮度。",
  "settings-save-failed": "设备设置保存失败。",
  "slot-delete-failed": "槽位宏删除失败。",
});

export function parseDeviceLine(rawLine) {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }
  if (line === "PONG") {
    return { type: "pong", ok: true };
  }
  if (line === "OK") {
    return { type: "ack", ok: true };
  }
  if (line === "ERR" || line.startsWith("ERR ")) {
    const code = line.slice(4);
    return { type: "error", ok: false, message: line === "ERR" ? "设备拒绝了这条指令" : DEVICE_ERRORS[code] || code };
  }
  if (!line.startsWith("{")) {
    return { type: "unknown", ok: false, raw: line };
  }

  try {
    const message = JSON.parse(line);
    if (
      typeof message !== "object" ||
      message === null ||
      typeof message.type !== "string"
    ) {
      return { type: "unknown", ok: false, raw: line };
    }
    return message;
  } catch {
    return { type: "unknown", ok: false, raw: line };
  }
}

export function formatDuration(milliseconds) {
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${String(millis).padStart(3, "0")}`;
}
