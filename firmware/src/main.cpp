#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <utility>
#include <vector>

#include "ControllerReport.h"
#include "BoardState.h"
#include "EmbeddedWebAssets.h"
#include "MaterialFarmMacro.h"
#include "MacroEngine.h"
#include "MacroSlotStorage.h"
#include "StatusLed.h"
#include "switch_ESP32.h"

/*
 * Hardware topology:
 *   ESP32-S3 native USB (GPIO19 D-, GPIO20 D+) -> Nintendo Switch dock
 *   ESP32-S3 UART0 through the board's USB-UART bridge -> browser/PC
 *   ESP32-S3 Wi-Fi AP -> phone browser at http://192.168.9.1
 *
 * This deliberately uses a UART-backed serial port. The native USB peripheral
 * is reserved for switch_ESP32's Nintendo Switch HID device.
 */
#ifndef ATT_CONTROL_SERIAL
#define ATT_CONTROL_SERIAL Serial
#endif

namespace {

constexpr uint32_t kControlBaudRate = 921600;
constexpr char kFirmwareVersion[] = "SplatoonFarmers/1.6.0";
constexpr char kProductVersion[] = "V1.0";
constexpr uint32_t kGamepadStreamTimeoutMs = 800;
const IPAddress kWifiApAddress(192, 168, 9, 1);
const IPAddress kWifiApSubnet(255, 255, 255, 0);

WebServer WebConsole(80);
bool WifiConsoleActive = false;
bool SerialSeen = false;
uint32_t LastSerialCommandAtMs = 0;
bool GamepadStreamActive = false;
uint32_t LastGamepadStreamAtMs = 0;
farmers::ControllerReport LastGamepadStreamReport = farmers::kNeutralReport;

NSGamepad Gamepad;
farmers::StatusLed Led;
farmers::BoardState Board;
farmers::MacroSlotStorage SlotStorage;
std::vector<farmers::TaskList> TaskLists;
farmers::SlotMacro SavedSlot{};
farmers::SlotMacro UploadSlot{};
farmers::SlotMacro ReadSlot{};
uint32_t ActiveSlot = 0;
uint32_t UploadTargetSlot = 0;
bool SlotOverridden = false;
bool UploadActive = false;
std::vector<bool> UploadStepReceived;
bool TaskModeActive = false;
bool TaskPendingStart = false;
bool RoutinePaused = false;
size_t ActiveTaskIndex = 0;
uint32_t ActiveTaskId = UINT32_MAX;
size_t ActiveTaskEntry = 0;
uint32_t TaskEntryCompleted = 0;
uint32_t TaskLoopCount = 0;
uint32_t TaskNextStartAtMs = 0;
uint32_t LastObservedCycleCount = 0;
uint32_t RunStartedAtMs = 0;
uint32_t PauseStartedAtMs = 0;
uint32_t PausedDurationMs = 0;
uint32_t LastRuntimeTickMs = 0;
uint32_t LastStatsPersistAtMs = 0;
uint32_t ShareCounter = 0;
bool PendingWifiApply = false;
uint32_t WifiApplyAtMs = 0;
farmers::MacroEngine Macro(nullptr, 0, 0, true);

char LineBuffer[8192];
size_t LineLength = 0;
bool LineOverflow = false;

uint8_t clampAxis(unsigned long value) {
  return value > 255 ? 255 : static_cast<uint8_t>(value);
}

uint8_t normalizeDpad(unsigned long value) {
  if (value <= NSGAMEPAD_DPAD_UP_LEFT ||
      value == NSGAMEPAD_DPAD_CENTERED) {
    return static_cast<uint8_t>(value);
  }
  return NSGAMEPAD_DPAD_CENTERED;
}

void applyReport(const farmers::ControllerReport& report) {
  Gamepad.buttons(report.buttons & 0x3fff);
  Gamepad.dPad(normalizeDpad(report.dpad));
  Gamepad.leftXAxis(report.leftX);
  Gamepad.leftYAxis(report.leftY);
  Gamepad.rightXAxis(report.rightX);
  Gamepad.rightYAxis(report.rightY);
  Gamepad.write();
  if (report != farmers::kNeutralReport) {
    Led.notifyOutput();
  }
}

farmers::ControllerReport rawReport(unsigned long buttons, unsigned long dpad,
                                   unsigned long leftX, unsigned long leftY,
                                   unsigned long rightX, unsigned long rightY) {
  return {
      static_cast<uint16_t>(buttons & 0x3fff),
      normalizeDpad(dpad),
      clampAxis(leftX),
      clampAxis(leftY),
      clampAxis(rightX),
      clampAxis(rightY),
  };
}

void applyRawReport(unsigned long buttons, unsigned long dpad,
                    unsigned long leftX, unsigned long leftY,
                    unsigned long rightX, unsigned long rightY) {
  applyReport(rawReport(buttons, dpad, leftX, leftY, rightX, rightY));
}

const char* phaseName(farmers::MacroPhase phase) {
  switch (phase) {
    case farmers::MacroPhase::kSteps:
      return "steps";
    case farmers::MacroPhase::kLoopGap:
      return "gap";
    default:
      return "idle";
  }
}

size_t activeStepCount() { return SlotOverridden ? SavedSlot.steps.size() : 0; }

uint32_t activeDurationMs() {
  return SlotOverridden ? farmers::slotMacroDurationMs(SavedSlot) : 0;
}

uint32_t activeLoopGapMs() { return SlotOverridden ? SavedSlot.loopGapMs : 0; }

uint8_t activeColor() { return SlotOverridden ? SavedSlot.color : 0; }

bool routineRunning() { return Macro.running() || TaskModeActive; }

uint64_t newShareId(uint32_t scope, uint32_t updatedAt) {
  const uint64_t device = ESP.getEfuseMac();
  uint64_t value = device ^ (static_cast<uint64_t>(updatedAt) << 17) ^
                   (static_cast<uint64_t>(++ShareCounter) << 33) ^
                   (static_cast<uint64_t>(scope) << 7);
  if (value == 0) value = 1;
  return value;
}

void useBuiltinMacro(bool repeat = true) {
  GamepadStreamActive = false;
  ActiveSlot = 0;
  SlotOverridden = false;
  Macro.configure(nullptr, 0, 0, repeat);
}

void migrateStoredMetadata() {
  if (!SlotStorage.ready()) return;
  std::vector<farmers::SlotStorageSummary> summaries;
  if (!SlotStorage.summarize(&summaries)) return;
  for (const farmers::SlotStorageSummary& summary : summaries) {
    const uint32_t slot = summary.slot;
    farmers::SlotMacro macro{};
    if (!SlotStorage.load(slot, &macro)) continue;
    bool changed = false;
    if (macro.updatedAt == 0) {
      macro.updatedAt = millis() / 1000;
      changed = true;
    }
    if (macro.shareId == 0) {
      macro.shareId = newShareId(slot, macro.updatedAt);
      changed = true;
    }
    if (changed) SlotStorage.save(slot, macro);
  }
}

bool selectMacroSlot(uint32_t slot, bool repeat = true) {
  if (slot == UINT32_MAX || !SlotStorage.load(slot, &SavedSlot)) {
    useBuiltinMacro(repeat);
    return false;
  }
  ActiveSlot = slot;
  SlotOverridden = true;
  Macro.configure(SavedSlot.steps.data(), SavedSlot.steps.size(),
                  SavedSlot.loopGapMs, repeat);
  return true;
}

farmers::TaskList* activeTask() {
  return TaskModeActive && ActiveTaskIndex < TaskLists.size()
      ? &TaskLists[ActiveTaskIndex] : nullptr;
}

void stopRoutine() {
  const bool wasRunning = routineRunning();
  TaskModeActive = false;
  TaskPendingStart = false;
  RoutinePaused = false;
  PausedDurationMs = 0;
  Macro.stop();
  if (wasRunning) Board.persistStats();
}

bool pauseRoutine(uint32_t nowMs) {
  if (!routineRunning() || RoutinePaused) return false;
  Board.addRuntime(nowMs - LastRuntimeTickMs);
  LastRuntimeTickMs = nowMs;
  Macro.pause(nowMs);
  RoutinePaused = true;
  PauseStartedAtMs = nowMs;
  Board.persistStats();
  return true;
}

bool resumeRoutine(uint32_t nowMs) {
  if (!routineRunning() || !RoutinePaused) return false;
  const uint32_t pauseMs = nowMs - PauseStartedAtMs;
  PausedDurationMs += pauseMs;
  TaskNextStartAtMs += pauseMs;
  Macro.resume(nowMs);
  RoutinePaused = false;
  LastRuntimeTickMs = nowMs;
  return true;
}

bool startTaskEntry(uint32_t nowMs) {
  farmers::TaskList* task = activeTask();
  if (task == nullptr || ActiveTaskEntry >= task->entries.size()) return false;
  const farmers::TaskEntry& entry = task->entries[ActiveTaskEntry];
  if (!selectMacroSlot(entry.slot, false)) return false;
  Macro.start(nowMs);
  LastObservedCycleCount = 0;
  TaskPendingStart = false;
  Board.setRecentSlot(entry.slot);
  return true;
}

void tickRoutine(uint32_t nowMs) {
  if (RoutinePaused) {
    LastRuntimeTickMs = nowMs;
    return;
  }
  Macro.tick(nowMs);
  if (routineRunning() && Macro.cycleCount() > LastObservedCycleCount) {
    Board.recordSlotCycle(ActiveSlot);
    LastObservedCycleCount = Macro.cycleCount();
    if (TaskModeActive) {
      ++TaskEntryCompleted;
      farmers::TaskList* task = activeTask();
      if (task == nullptr || ActiveTaskEntry >= task->entries.size()) {
        stopRoutine();
        return;
      }
      if (TaskEntryCompleted >= task->entries[ActiveTaskEntry].repeats) {
        TaskEntryCompleted = 0;
        ++ActiveTaskEntry;
        if (ActiveTaskEntry >= task->entries.size()) {
          ActiveTaskEntry = 0;
          ++TaskLoopCount;
          Board.recordTaskCycle(ActiveTaskId);
        }
      }
      TaskPendingStart = true;
      TaskNextStartAtMs = nowMs + 10;
    }
  }
  if (TaskModeActive && TaskPendingStart && !Macro.running() &&
      static_cast<int32_t>(nowMs - TaskNextStartAtMs) >= 0 &&
      !startTaskEntry(nowMs)) stopRoutine();
  if (routineRunning()) Board.addRuntime(nowMs - LastRuntimeTickMs);
  LastRuntimeTickMs = nowMs;
  if (nowMs - LastStatsPersistAtMs >= 60000) {
    Board.persistStats();
    LastStatsPersistAtMs = nowMs;
  }
}

String jsonName(const char* name) {
  String escaped;
  for (const char* cursor = name; *cursor != '\0'; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') escaped += '\\';
    escaped += *cursor;
  }
  return escaped;
}

String hexText(const char* value) {
  constexpr char digits[] = "0123456789abcdef";
  String encoded;
  for (const uint8_t* cursor = reinterpret_cast<const uint8_t*>(value);
       *cursor != 0; ++cursor) {
    encoded += digits[*cursor >> 4];
    encoded += digits[*cursor & 0x0f];
  }
  return encoded;
}

void defaultUploadName(uint32_t slot) {
  snprintf(UploadSlot.name, sizeof(UploadSlot.name), "宏槽位 %lu",
           static_cast<unsigned long>(slot + 1));
}

int hexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

String stateResponse(const char* type) {
  const size_t visibleStep =
      Macro.phase() == farmers::MacroPhase::kSteps ? Macro.stepIndex() + 1 : 0;
  const uint32_t nowMs = millis();
  const uint32_t pausedMs = PausedDurationMs +
      (RoutinePaused ? nowMs - PauseStartedAtMs : 0);
  const uint32_t runMs = routineRunning()
      ? nowMs - RunStartedAtMs - pausedMs : 0;
  const String wifiSsid = jsonName(Board.settings().ssid);
  char response[512];
  snprintf(response, sizeof(response),
      "{\"type\":\"%s\",\"ok\":true,\"firmware\":\"%s\","
      "\"routine\":\"material-farm\",\"embedded\":true,\"state\":\"%s\","
      "\"phase\":\"%s\",\"step\":%u,\"steps\":%u,\"cycle\":%lu,"
      "\"duration_ms\":%lu,\"loop_gap_ms\":%lu,\"cycle_ms\":%lu,"
      "\"wifi\":%s,\"wifi_ssid\":\"%s\",\"wifi_ip\":\"192.168.9.1\","
      "\"slot\":%u,\"source\":\"%s\",\"color\":%u,\"macro_storage\":\"%s\"}",
      type, kFirmwareVersion, RoutinePaused ? "paused" :
          (routineRunning() ? "running" : "idle"),
      phaseName(Macro.phase()), static_cast<unsigned int>(visibleStep),
      static_cast<unsigned int>(activeStepCount()),
      static_cast<unsigned long>(Macro.cycleCount()),
      static_cast<unsigned long>(activeDurationMs()),
      static_cast<unsigned long>(activeLoopGapMs()),
      static_cast<unsigned long>(activeDurationMs() + activeLoopGapMs()),
      WifiConsoleActive ? "true" : "false", wifiSsid.c_str(),
      static_cast<unsigned>(ActiveSlot),
      SlotOverridden ? "flash" : "empty",
      static_cast<unsigned>(activeColor()),
      SlotStorage.ready() ? "ready" : "mount-failed");
  String result(response);
  if (result.endsWith("}")) result.remove(result.length() - 1);
  result += ",\"mode\":\"";
  result += TaskModeActive ? "task" : "macro";
  result += "\",\"task\":";
  if (TaskModeActive && activeTask() != nullptr)
    result += static_cast<unsigned long>(ActiveTaskId);
  else
    result += -1;
  result += ",\"task_entry\":";
  result += TaskModeActive ? static_cast<unsigned long>(ActiveTaskEntry + 1) : 0;
  result += ",\"task_entries\":";
  result += TaskModeActive && activeTask() != nullptr
      ? static_cast<unsigned long>(activeTask()->entries.size()) : 0;
  result += ",\"task_repeat\":";
  result += TaskModeActive ? static_cast<int>(TaskEntryCompleted + 1) : 0;
  result += ",\"task_repeats\":";
  result += TaskModeActive && activeTask() != nullptr &&
          ActiveTaskEntry < activeTask()->entries.size()
      ? static_cast<unsigned long>(activeTask()->entries[ActiveTaskEntry].repeats) : 0;
  result += ",\"task_loop\":";
  result += static_cast<unsigned long>(TaskLoopCount);
  result += ",\"run_ms\":";
  result += static_cast<unsigned long>(runMs);
  result += ",\"product_version\":\"";
  result += kProductVersion;
  result += "\"}";
  return result;
}

String macroListResponse() {
  std::vector<farmers::SlotStorageSummary> summaries;
  SlotStorage.summarize(&summaries);
  String response;
  response.reserve(3200);
  response += "{\"type\":\"macro_list\",\"ok\":true,\"storage\":\"";
  response += SlotStorage.ready() ? "ready" : "mount-failed";
  response += "\",\"used_bytes\":";
  response += static_cast<unsigned long>(SlotStorage.usedBytes());
  response += ",\"total_bytes\":";
  response += static_cast<unsigned long>(SlotStorage.totalBytes());
  response += ",\"slots\":[";
  bool first = true;
  uint32_t nextSlot = 0;
  for (const farmers::SlotStorageSummary& summary : summaries) {
    const uint32_t slot = summary.slot;
    if (slot == nextSlot && nextSlot != UINT32_MAX) ++nextSlot;
    const bool flash = summary.hasMacro && SlotStorage.load(slot, &ReadSlot);
    if (!first) response += ',';
    first = false;
    response += "{\"slot\":";
    response += static_cast<unsigned long>(slot);
    response += ",\"name\":\"";
    response += jsonName(flash ? ReadSlot.name : "");
    response += "\",\"source\":\"";
    response += flash ? "flash" : "empty";
    response += "\",\"steps\":";
    response += flash ? ReadSlot.steps.size() : 0;
    response += ",\"duration_ms\":";
    response += flash ? farmers::slotMacroDurationMs(ReadSlot) : 0;
    response += ",\"loop_gap_ms\":";
    response += flash ? ReadSlot.loopGapMs : 0;
    response += ",\"color\":";
    response += flash ? ReadSlot.color : 0;
    response += ",\"used_bytes\":";
    response += static_cast<unsigned long>(summary.usedBytes);
    response += ",\"updated_at\":";
    response += flash ? static_cast<unsigned long>(ReadSlot.updatedAt) : 0;
    response += ",\"share_id\":\"";
    response += flash ? static_cast<unsigned long long>(ReadSlot.shareId) : 0;
    response += "\"";
    response += '}';
  }
  response += "],\"next_slot\":";
  response += static_cast<unsigned long>(nextSlot);
  response += "}";
  return response;
}

String macroDetailResponse(uint32_t slot) {
  const bool flash = SlotStorage.load(slot, &ReadSlot);
  if (!flash) return "ERR macro-empty";
  const farmers::MacroStep* steps = ReadSlot.steps.data();
  const size_t count = ReadSlot.steps.size();
  String response;
  response.reserve(230 + count * 48);
  response += "{\"type\":\"macro\",\"ok\":true,\"slot\":";
  response += slot;
  response += ",\"name\":\"";
  response += jsonName(ReadSlot.name);
  response += "\",\"source\":\"flash\"";
  response += ",\"updated_at\":";
  response += static_cast<unsigned long>(ReadSlot.updatedAt);
  response += ",\"share_id\":\"";
  response += static_cast<unsigned long long>(ReadSlot.shareId);
  response += "\",\"loop_gap_ms\":";
  response += ReadSlot.loopGapMs;
  response += ",\"color\":";
  response += ReadSlot.color;
  response += ",\"steps\":[";
  for (size_t index = 0; index < count; ++index) {
    const farmers::MacroStep& step = steps[index];
    if (index > 0) response += ',';
    char entry[96];
    snprintf(entry, sizeof(entry), "[%lu,%u,%u,%u,%u,%u,%u]",
             static_cast<unsigned long>(step.durationMs),
             static_cast<unsigned>(step.report.buttons),
             static_cast<unsigned>(step.report.dpad),
             static_cast<unsigned>(step.report.leftX),
             static_cast<unsigned>(step.report.leftY),
             static_cast<unsigned>(step.report.rightX),
             static_cast<unsigned>(step.report.rightY));
    response += entry;
  }
  response += "]}";
  return response;
}

bool decodeHexText(const char* hex, char* output, size_t capacity) {
  if (hex == nullptr || output == nullptr || capacity == 0) return false;
  const size_t length = strlen(hex);
  if (length == 0 || length % 2 != 0 || length / 2 >= capacity) return false;
  for (size_t index = 0; index < length / 2; ++index) {
    const int high = hexNibble(hex[index * 2]);
    const int low = hexNibble(hex[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    const uint8_t byte = static_cast<uint8_t>((high << 4) | low);
    if (byte == 0 || byte < 0x20 || byte == 0x7f) return false;
    output[index] = static_cast<char>(byte);
  }
  output[length / 2] = '\0';
  return true;
}

String taskListResponse() {
  std::vector<farmers::TaskList> tasks;
  Board.listTasks(&tasks);
  uint32_t nextTask = 0;
  String response;
  response.reserve(2300);
  response += "{\"type\":\"task_list\",\"ok\":true,\"tasks\":[";
  for (size_t index = 0; index < tasks.size(); ++index) {
    const farmers::TaskList& task = tasks[index];
    if (task.id == nextTask && nextTask != UINT32_MAX) ++nextTask;
    if (index) response += ',';
    response += "{\"id\":";
    response += static_cast<unsigned long>(task.id);
    response += ",\"exists\":true";
    response += ",\"name\":\"";
    response += jsonName(task.name);
    response += "\",\"updated_at\":";
    response += static_cast<unsigned long>(task.updatedAt);
    response += ",\"share_id\":\"";
    response += static_cast<unsigned long long>(task.shareId);
    response += "\",\"entries\":[";
    for (size_t item = 0; item < task.entries.size(); ++item) {
      if (item) response += ',';
      response += "[";
      response += static_cast<unsigned long>(task.entries[item].slot);
      response += ',';
      response += static_cast<unsigned long>(task.entries[item].repeats);
      response += ']';
    }
    response += "]}";
  }
  response += "],\"next_task\":";
  response += static_cast<unsigned long>(nextTask);
  response += "}";
  return response;
}

String settingsResponse() {
  const farmers::DeviceSettings& settings = Board.settings();
  String response;
  response.reserve(260);
  response += "{\"type\":\"settings\",\"ok\":true,\"version\":\"";
  response += kProductVersion;
  response += "\",\"firmware\":\"";
  response += kFirmwareVersion;
  response += "\",\"serial_baud\":";
  response += kControlBaudRate;
  response += ",\"wifi_enabled\":";
  response += settings.wifiEnabled ? "true" : "false";
  response += ",\"wifi_ssid\":\"";
  response += jsonName(settings.ssid);
  response += "\",\"password_set\":";
  response += settings.password[0] ? "true" : "false";
  response += ",\"password_hex\":\"";
  response += hexText(settings.password);
  response += "\"";
  response += ",\"led_brightness\":";
  response += settings.brightness;
  response += '}';
  return response;
}

String statsResponse() {
  const farmers::RunStats& stats = Board.stats();
  String response;
  response.reserve(220 + stats.slotCycles.size() * 32 + stats.taskCycles.size() * 24);
  char number[32] = {};
  snprintf(number, sizeof(number), "%llu",
           static_cast<unsigned long long>(stats.totalRunMs));
  response += "{\"type\":\"stats\",\"ok\":true,\"total_run_ms\":";
  response += number;
  response += ",\"recent_slot\":";
  if (stats.recentSlot == UINT32_MAX) response += -1;
  else response += static_cast<unsigned long>(stats.recentSlot);
  response += ",\"recent_task\":";
  if (stats.recentTask == UINT32_MAX) response += -1;
  else response += static_cast<unsigned long>(stats.recentTask);
  response += ",\"slot_cycles\":{";
  for (size_t index = 0; index < stats.slotCycles.size(); ++index) {
    if (index) response += ',';
    response += '"';
    response += static_cast<unsigned long>(stats.slotCycles[index].slot);
    response += "\":";
    snprintf(number, sizeof(number), "%llu",
             static_cast<unsigned long long>(stats.slotCycles[index].cycles));
    response += number;
  }
  response += "},\"task_cycles\":{";
  for (size_t index = 0; index < stats.taskCycles.size(); ++index) {
    if (index) response += ',';
    response += '"';
    response += static_cast<unsigned long>(stats.taskCycles[index].task);
    response += "\":";
    response += static_cast<unsigned long>(stats.taskCycles[index].cycles);
  }
  response += "}}";
  return response;
}

void flushMacroReport() {
  if (Macro.consumeReportChanged()) {
    applyReport(Macro.report());
  }
}

String handleLine(char* line) {
  if (strcmp(line, "PING") == 0) {
    return "PONG";
  }
  if (strcmp(line, "HELLO") == 0 || strcmp(line, "INFO") == 0) {
    return stateResponse("info");
  }
  if (strcmp(line, "STATUS") == 0) {
    return stateResponse("status");
  }
  if (strcmp(line, "PAUSE") == 0) {
    if (pauseRoutine(millis())) flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "RESUME") == 0) {
    if (resumeRoutine(millis())) flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "TASK_LIST") == 0) return taskListResponse();
  if (strcmp(line, "SETTINGS_GET") == 0) return settingsResponse();
  if (strcmp(line, "STATS_GET") == 0) return statsResponse();
  if (strncmp(line, "SETTINGS_SET ", 13) == 0) {
    unsigned long wifi = 0, brightness = 0, open = 0;
    char ssidHex[65] = {}, passwordHex[127] = {}, extra = '\0';
    if (sscanf(line, "SETTINGS_SET %lu %lu %64s %126s %lu %c",
               &wifi, &brightness, ssidHex, passwordHex, &open, &extra) != 5 ||
        wifi > 1 || brightness > 255 || open > 1) return "ERR invalid-settings";
    farmers::DeviceSettings settings = Board.settings();
    settings.wifiEnabled = static_cast<uint8_t>(wifi);
    settings.brightness = static_cast<uint8_t>(brightness);
    memset(settings.ssid, 0, sizeof(settings.ssid));
    if (!decodeHexText(ssidHex, settings.ssid, sizeof(settings.ssid)))
      return "ERR invalid-settings";
    if (open) memset(settings.password, 0, sizeof(settings.password));
    else if (strcmp(passwordHex, "-") != 0) {
      memset(settings.password, 0, sizeof(settings.password));
      if (!decodeHexText(passwordHex, settings.password,
                         sizeof(settings.password))) return "ERR invalid-settings";
    }
    if (!Board.saveSettings(settings)) return "ERR settings-save-failed";
    Led.setBrightness(settings.brightness);
    PendingWifiApply = true;
    WifiApplyAtMs = millis() + 250;
    return "OK";
  }
  unsigned long taskIndex = 0;
  char taskTrailing = '\0';
  if (strncmp(line, "TASK_SAVE ", 10) == 0) {
    unsigned long count = 0, updatedAt = 0;
    char nameHex[97] = {};
    // The Arduino loop task has a small stack. Keep the large parser buffer
    // in static storage; serial and HTTP commands are both handled by loop().
    static char entriesText[7600];
    entriesText[0] = '\0';
    if (routineRunning() ||
        (sscanf(line, "TASK_SAVE %lu %96s %lu %7599s %lu %c", &taskIndex,
                nameHex, &count, entriesText, &updatedAt, &taskTrailing) != 5 &&
         sscanf(line, "TASK_SAVE %lu %96s %lu %7599s %c", &taskIndex,
                nameHex, &count, entriesText, &taskTrailing) != 4) ||
        taskIndex == ULONG_MAX || count == 0) return "ERR invalid-task";
    farmers::TaskList task{};
    task.id = static_cast<uint32_t>(taskIndex);
    if (!decodeHexText(nameHex, task.name, sizeof(task.name)))
      return "ERR invalid-task";
    task.updatedAt = updatedAt ? static_cast<uint32_t>(updatedAt) : millis() / 1000;
    task.shareId = newShareId(task.id, task.updatedAt);
    // A count larger than the command payload cannot describe a valid list.
    // This keeps malformed input from requesting an unbounded vector reserve;
    // valid task size remains bounded by the available Flash and heap.
    if (count > strlen(entriesText) / 3) return "ERR invalid-task";
    task.entries.reserve(count);
    char* context = nullptr;
    char* item = strtok_r(entriesText, ",", &context);
    for (size_t index = 0; index < count; ++index) {
      unsigned long slot = 0, repeats = 0;
      char extra = '\0';
      if (item == nullptr ||
          sscanf(item, "%lu:%lu%c", &slot, &repeats, &extra) != 2 ||
          slot == ULONG_MAX || repeats == 0 || repeats > 9999)
        return "ERR invalid-task";
      task.entries.push_back({static_cast<uint32_t>(slot),
                              static_cast<uint32_t>(repeats)});
      item = strtok_r(nullptr, ",", &context);
    }
    if (item != nullptr || !Board.saveTask(taskIndex, task))
      return "ERR task-save-failed";
    auto existing = std::find_if(TaskLists.begin(), TaskLists.end(),
                                 [taskIndex](const farmers::TaskList& item) {
                                   return item.id == taskIndex;
                                 });
    if (existing == TaskLists.end()) TaskLists.push_back(std::move(task));
    else *existing = std::move(task);
    return "OK";
  }
  if (sscanf(line, "TASK_DELETE %lu %c", &taskIndex,
             &taskTrailing) == 1) {
    if (taskIndex == ULONG_MAX) return "ERR invalid-task";
    if (TaskModeActive && ActiveTaskId == taskIndex) return "ERR macro-running";
    if (!Board.deleteTask(taskIndex)) return "ERR task-delete-failed";
    TaskLists.erase(std::remove_if(TaskLists.begin(), TaskLists.end(),
                                   [taskIndex](const farmers::TaskList& item) {
                                     return item.id == taskIndex;
                                   }),
                    TaskLists.end());
    return "OK";
  }
  if (sscanf(line, "TASK_START %lu %c", &taskIndex,
             &taskTrailing) == 1) {
    if (taskIndex == ULONG_MAX) return "ERR invalid-task";
    auto taskIt = std::find_if(TaskLists.begin(), TaskLists.end(),
                               [taskIndex](const farmers::TaskList& item) {
                                 return item.id == taskIndex;
                               });
    if (taskIt == TaskLists.end()) return "ERR invalid-task";
    const farmers::TaskList& task = *taskIt;
    for (const farmers::TaskEntry& entry : task.entries) {
      const uint32_t slot = entry.slot;
      if (!SlotStorage.load(slot, &ReadSlot))
        return "ERR macro-empty";
    }
    stopRoutine();
    GamepadStreamActive = false;
    TaskModeActive = true;
    ActiveTaskIndex = static_cast<size_t>(taskIt - TaskLists.begin());
    ActiveTaskId = taskIndex;
    ActiveTaskEntry = 0;
    TaskEntryCompleted = 0;
    TaskLoopCount = 0;
    const uint32_t nowMs = millis();
    RunStartedAtMs = LastRuntimeTickMs = nowMs;
    Board.setRecentTask(ActiveTaskId);
    if (!startTaskEntry(nowMs)) {
      stopRoutine();
      return "ERR macro-empty";
    }
    flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "MACRO_LIST") == 0) {
    return macroListResponse();
  }
  unsigned long selectedSlot = 0;
  char trailing = '\0';
  if (strncmp(line, "SLOT_IMAGE_", 11) == 0) return "ERR image-unsupported";
  if (sscanf(line, "MACRO_GET %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "MACRO_GET") == 0) {
    if (selectedSlot == ULONG_MAX) return "ERR invalid-slot";
    return macroDetailResponse(static_cast<uint32_t>(selectedSlot));
  }
  if (strcmp(line, "MACRO_ABORT") == 0) {
    UploadActive = false;
    UploadSlot = {};
    UploadStepReceived.clear();
    return "OK";
  }
  if (sscanf(line, "MACRO_RESTORE %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "MACRO_RESTORE") == 0) {
    if (routineRunning()) return "ERR macro-running";
    if (!SlotStorage.ready()) return "ERR storage-unavailable";
    if (selectedSlot == ULONG_MAX) return "ERR invalid-slot";
    if (!SlotStorage.restore(static_cast<uint32_t>(selectedSlot)))
      return "ERR restore-failed";
    if (ActiveSlot == selectedSlot) {
      if (selectedSlot == 0) useBuiltinMacro();
      else {
        SlotOverridden = false;
        Macro.configure(nullptr, 0, 0, true);
      }
    }
    flushMacroReport();
    return "OK";
  }
  if (sscanf(line, "MACRO_DELETE %lu %c", &selectedSlot, &trailing) == 1) {
    if (routineRunning()) return "ERR macro-running";
    if (!SlotStorage.ready()) return "ERR storage-unavailable";
    if (selectedSlot == ULONG_MAX) return "ERR invalid-slot";
    if (!SlotStorage.restore(static_cast<uint32_t>(selectedSlot)))
      return "ERR slot-delete-failed";
    if (ActiveSlot == selectedSlot) {
      if (selectedSlot == 0) useBuiltinMacro();
      else {
        SlotOverridden = false;
        Macro.configure(nullptr, 0, 0, true);
      }
    }
    flushMacroReport();
    return "OK";
  }
  if (strcmp(line, "MACRO_STORAGE_FORMAT") == 0) {
    if (routineRunning()) return "ERR macro-running";
    if (SlotStorage.ready()) return "ERR storage-already-ready";
    if (!SlotStorage.initializeEmptyStorage()) return "ERR storage-format-failed";
    useBuiltinMacro();
    flushMacroReport();
    return "OK";
  }
  unsigned long count = 0, gap = 0, color = 0, updatedAt = 0;
  if (strncmp(line, "MACRO_BEGIN ", 12) == 0) {
    if (routineRunning()) return "ERR macro-running";
    if (!SlotStorage.ready()) return "ERR storage-unavailable";
    const int parsed = sscanf(line, "MACRO_BEGIN %lu %lu %lu %lu %lu %c",
                              &selectedSlot, &count, &gap, &color,
                              &updatedAt, &trailing);
    // Only try the four-number legacy form when the current form did not
    // match. Parsing it unconditionally overwrote color with a character.
    const int legacyParsed = parsed == 5 ? 0 :
        sscanf(line, "MACRO_BEGIN %lu %lu %lu %lu %c",
               &selectedSlot, &count, &gap, &color, &trailing);
    const uint64_t requiredBytes = static_cast<uint64_t>(count) *
        (sizeof(farmers::MacroStep) + sizeof(bool));
    if ((parsed != 5 && legacyParsed != 4) ||
        selectedSlot == ULONG_MAX || count == 0 ||
        requiredBytes > ESP.getFreeHeap() ||
        gap > farmers::kMaxSlotLoopGapMs || color >= farmers::kSlotColorCount) {
      return "ERR invalid-macro-begin";
    }
    UploadSlot = {};
    UploadSlot.steps.resize(static_cast<size_t>(count));
    UploadSlot.loopGapMs = gap;
    UploadSlot.color = static_cast<uint8_t>(color);
    UploadSlot.updatedAt = updatedAt ? static_cast<uint32_t>(updatedAt) : millis() / 1000;
    UploadSlot.shareId = newShareId(static_cast<uint32_t>(selectedSlot), UploadSlot.updatedAt);
    UploadTargetSlot = static_cast<uint32_t>(selectedSlot);
    defaultUploadName(UploadTargetSlot);
    UploadStepReceived.assign(static_cast<size_t>(count), false);
    UploadActive = true;
    return "OK";
  }
  if (strncmp(line, "MACRO_NAME ", 11) == 0) {
    if (!UploadActive) return "ERR invalid-macro-name";
    const char* hex = line + 11;
    const size_t length = strlen(hex);
    if (length == 0 || length > farmers::kMaxSlotNameBytes * 2 ||
        length % 2 != 0) return "ERR invalid-macro-name";
    memset(UploadSlot.name, 0, sizeof(UploadSlot.name));
    for (size_t index = 0; index < length / 2; ++index) {
      const int high = hexNibble(hex[index * 2]);
      const int low = hexNibble(hex[index * 2 + 1]);
      if (high < 0 || low < 0) return "ERR invalid-macro-name";
      const uint8_t byte = static_cast<uint8_t>((high << 4) | low);
      if (byte < 0x20 || byte == 0x7f) return "ERR invalid-macro-name";
      UploadSlot.name[index] = static_cast<char>(byte);
    }
    return "OK";
  }
  if (strncmp(line, "MACRO_STEP ", 11) == 0) {
    unsigned long index = 0, duration = 0, buttons = 0, dpad = 0;
    unsigned long leftX = 0, leftY = 0, rightX = 0, rightY = 0;
    if (!UploadActive ||
        sscanf(line, "MACRO_STEP %lu %lu %lu %lu %lu %lu %lu %lu %c",
               &index, &duration, &buttons, &dpad, &leftX, &leftY,
               &rightX, &rightY, &trailing) != 8 ||
        index >= UploadSlot.steps.size() ||
        duration < farmers::kMinSlotStepMs ||
        duration > farmers::kMaxSlotStepMs || buttons > 0x3fff ||
        (dpad > 7 && dpad != farmers::kDpadCentered) || leftX > 255 ||
        leftY > 255 || rightX > 255 || rightY > 255) {
      return "ERR invalid-macro-step";
    }
    UploadSlot.steps[index] =
        {static_cast<uint32_t>(duration),
         {static_cast<uint16_t>(buttons), static_cast<uint8_t>(dpad),
          static_cast<uint8_t>(leftX), static_cast<uint8_t>(leftY),
          static_cast<uint8_t>(rightX), static_cast<uint8_t>(rightY)}};
    UploadStepReceived[index] = true;
    return "OK";
  }
  if (strncmp(line, "MACRO_COMMIT ", 13) == 0) {
    unsigned long checksum = 0;
    if (routineRunning()) return "ERR macro-running";
    if (!UploadActive ||
        sscanf(line, "MACRO_COMMIT %lu %c", &checksum, &trailing) != 1 ||
        checksum > 0xffffffffUL || !farmers::isSlotMacroValid(UploadSlot)) {
      return "ERR invalid-macro-commit";
    }
    for (size_t index = 0; index < UploadSlot.steps.size(); ++index) {
      if (!UploadStepReceived[index]) return "ERR missing-macro-step";
    }
    if (farmers::slotMacroChecksum(UploadSlot) != checksum) {
      return "ERR macro-checksum";
    }
    UploadActive = false;
    if (!SlotStorage.save(UploadTargetSlot, UploadSlot)) {
      UploadSlot = {};
      UploadStepReceived.clear();
      return "ERR macro-save-failed";
    }
    GamepadStreamActive = false;
    if (ActiveSlot == UploadTargetSlot) {
      SavedSlot = std::move(UploadSlot);
      SlotOverridden = true;
      Macro.configure(SavedSlot.steps.data(), SavedSlot.steps.size(),
                      SavedSlot.loopGapMs, true);
      flushMacroReport();
    } else {
      UploadSlot = {};
    }
    UploadStepReceived.clear();
    return "OK";
  }
  if (sscanf(line, "START %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "START") == 0) {
    UploadActive = false;
    GamepadStreamActive = false;
    stopRoutine();
    if (selectedSlot == ULONG_MAX ||
        !selectMacroSlot(static_cast<uint32_t>(selectedSlot)))
      return "ERR macro-empty";
    const uint32_t nowMs = millis();
    Macro.start(nowMs);
    RunStartedAtMs = LastRuntimeTickMs = nowMs;
    LastObservedCycleCount = 0;
    TaskLoopCount = 0;
    Board.setRecentSlot(static_cast<uint32_t>(selectedSlot));
    flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "STOP") == 0) {
    GamepadStreamActive = false;
    stopRoutine();
    flushMacroReport();
    return stateResponse("status");
  }

  char command[8] = {0};
  unsigned long buttons = 0;
  unsigned long dpad = NSGAMEPAD_DPAD_CENTERED;
  unsigned long leftX = farmers::kAxisCentered;
  unsigned long leftY = farmers::kAxisCentered;
  unsigned long rightX = farmers::kAxisCentered;
  unsigned long rightY = farmers::kAxisCentered;
  const int parsed =
      sscanf(line, "%7s %lu %lu %lu %lu %lu %lu", command, &buttons, &dpad,
             &leftX, &leftY, &rightX, &rightY);

  if (parsed == 7 && strcmp(command, "G") == 0) {
    const bool enteringStream = !GamepadStreamActive || routineRunning();
    if (enteringStream) {
      stopRoutine();
      Macro.consumeReportChanged();
    }
    GamepadStreamActive = true;
    LastGamepadStreamAtMs = millis();
    const farmers::ControllerReport report =
        rawReport(buttons, dpad, leftX, leftY, rightX, rightY);
    if (enteringStream || report != LastGamepadStreamReport) {
      applyReport(report);
      LastGamepadStreamReport = report;
    }
    return "OK";
  }
  if (parsed == 7 &&
      (strcmp(command, "R") == 0 || strcmp(command, "REPORT") == 0)) {
    // Raw reports power manual input and leave a fallback path for future
    // computer-loaded routines. Entering this mode stops the embedded routine.
    GamepadStreamActive = false;
    stopRoutine();
    Macro.consumeReportChanged();
    applyRawReport(buttons, dpad, leftX, leftY, rightX, rightY);
    return "OK";
  }

  return "ERR";
}

const EmbeddedWebAsset* embeddedWebAssetForPath(const String& path) {
  for (size_t index = 0; index < kEmbeddedWebAssetCount; ++index) {
    if (path == kEmbeddedWebAssets[index].path) {
      return &kEmbeddedWebAssets[index];
    }
  }
  return nullptr;
}

void serveEmbeddedWebAsset() {
  const String path = WebConsole.uri() == "/" ? "/index.html" : WebConsole.uri();
  const EmbeddedWebAsset* asset = embeddedWebAssetForPath(path);
  if (asset == nullptr) {
    WebConsole.send(404, "text/plain; charset=utf-8", "Not found");
    return;
  }
  WebConsole.sendHeader("Content-Encoding", "gzip");
  WebConsole.sendHeader("Vary", "Accept-Encoding");
  WebConsole.sendHeader("Cache-Control", "no-cache");
  WebConsole.send_P(200, asset->contentType,
                    reinterpret_cast<PGM_P>(asset->data), asset->size);
}

void handleWebCommand() {
  const String command = WebConsole.arg("command");
  if (command.isEmpty() || command.length() >= sizeof(LineBuffer) ||
      command.indexOf('\r') >= 0 || command.indexOf('\n') >= 0) {
    WebConsole.send(400, "text/plain; charset=utf-8", "ERR invalid-command");
    return;
  }
  // HTTP callbacks run inside loopTask, so an 8 KiB local buffer would
  // overflow its stack before handleLine() can send a response.
  static char line[sizeof(LineBuffer)];
  command.toCharArray(line, sizeof(line));
  const String response = handleLine(line);
  WebConsole.sendHeader("Cache-Control", "no-store");
  WebConsole.send(200, response.startsWith("{") ? "application/json" :
                        "text/plain; charset=utf-8", response);
}

void startWifiConsole() {
  if (!Board.settings().wifiEnabled) return;
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAPConfig(kWifiApAddress, kWifiApAddress, kWifiApSubnet) ||
      !WiFi.softAP(Board.settings().ssid,
                   Board.settings().password[0] ? Board.settings().password : nullptr)) {
    ATT_CONTROL_SERIAL.println("ERR wifi-start-failed");
    return;
  }
  WebConsole.begin();
  WifiConsoleActive = true;
  ATT_CONTROL_SERIAL.println("WIFI http://192.168.9.1");
}

void applyWifiSettings() {
  if (WifiConsoleActive) WebConsole.stop();
  WiFi.softAPdisconnect(true);
  WifiConsoleActive = false;
  if (Board.settings().wifiEnabled) startWifiConsole();
  else WiFi.mode(WIFI_OFF);
}

void readControlSerial() {
  while (ATT_CONTROL_SERIAL.available() > 0) {
    const char character = static_cast<char>(ATT_CONTROL_SERIAL.read());
    if (character == '\n' || character == '\r') {
      if (LineOverflow) {
        ATT_CONTROL_SERIAL.println("ERR");
      } else if (LineLength > 0) {
        LineBuffer[LineLength] = '\0';
        SerialSeen = true;
        LastSerialCommandAtMs = millis();
        ATT_CONTROL_SERIAL.println(handleLine(LineBuffer));
      }
      LineLength = 0;
      LineOverflow = false;
      continue;
    }

    if (LineOverflow) {
      continue;
    }
    if (LineLength < sizeof(LineBuffer) - 1) {
      LineBuffer[LineLength++] = character;
    } else {
      LineOverflow = true;
    }
  }
}

}  // namespace

void setup() {
  ATT_CONTROL_SERIAL.setRxBufferSize(8192);
  ATT_CONTROL_SERIAL.begin(kControlBaudRate);
  Led.begin();
  Board.begin();
  Led.setBrightness(Board.settings().brightness);
  SlotStorage.begin();
  migrateStoredMetadata();
  Board.listTasks(&TaskLists);
  for (farmers::TaskList& task : TaskLists) {
    if (task.updatedAt == 0 || task.shareId == 0) {
      task.updatedAt = millis() / 1000;
      task.shareId = newShareId(task.id, task.updatedAt);
      Board.saveTask(task.id, task);
    }
  }
  if (SlotStorage.load(&SavedSlot)) {
    SlotOverridden = true;
    Macro.configure(SavedSlot.steps.data(), SavedSlot.steps.size(),
                    SavedSlot.loopGapMs, true);
  }
  Gamepad.begin();
  USB.begin();
  applyReport(farmers::kNeutralReport);
  WebConsole.on("/api/command", HTTP_POST, handleWebCommand);
  WebConsole.onNotFound(serveEmbeddedWebAsset);
  startWifiConsole();
  LastRuntimeTickMs = LastStatsPersistAtMs = millis();
}

void loop() {
  readControlSerial();
  const uint32_t nowMs = millis();
  tickRoutine(nowMs);
  flushMacroReport();
  Gamepad.loop();
  if (WifiConsoleActive) {
    WebConsole.handleClient();
  }
  if (PendingWifiApply && static_cast<int32_t>(nowMs - WifiApplyAtMs) >= 0) {
    PendingWifiApply = false;
    applyWifiSettings();
  }
  if (GamepadStreamActive &&
      static_cast<uint32_t>(nowMs - LastGamepadStreamAtMs) >
          kGamepadStreamTimeoutMs) {
    GamepadStreamActive = false;
    applyReport(farmers::kNeutralReport);
  }
  const bool connected =
      (WifiConsoleActive && WiFi.softAPgetStationNum() > 0) ||
      (SerialSeen && static_cast<uint32_t>(nowMs - LastSerialCommandAtMs) < 3500);
  Led.update(nowMs, routineRunning(), connected, activeColor());
}
