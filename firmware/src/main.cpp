#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>

#include <stdio.h>
#include <string.h>

#include "ControllerReport.h"
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

constexpr uint32_t kControlBaudRate = 115200;
constexpr char kFirmwareVersion[] = "SplatoonFarmers/1.4.0";
constexpr uint32_t kGamepadStreamTimeoutMs = 800;
constexpr char kWifiApSsid[] = "ESP32-S3-Switch";
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
farmers::MacroSlotStorage SlotStorage;
farmers::SlotMacro SavedSlot{};
farmers::SlotMacro UploadSlot{};
farmers::SlotMacro ReadSlot{};
uint8_t ActiveSlot = 0;
uint8_t UploadTargetSlot = 0;
bool SlotOverridden = false;
bool UploadActive = false;
bool UploadStepReceived[farmers::kMaxSlotSteps] = {};
farmers::MacroEngine Macro(
    farmers::kMaterialFarmMacro, farmers::kMaterialFarmStepCount,
    farmers::kMaterialFarmLoopGapMs, true);

char LineBuffer[256];
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

size_t activeStepCount() {
  return SlotOverridden ? SavedSlot.stepCount :
         ActiveSlot == 0 ? farmers::kMaterialFarmStepCount : 0;
}

uint32_t activeDurationMs() {
  return SlotOverridden ? farmers::slotMacroDurationMs(SavedSlot) :
         ActiveSlot == 0 ? farmers::kMaterialFarmDurationMs : 0;
}

uint32_t activeLoopGapMs() {
  return SlotOverridden ? SavedSlot.loopGapMs :
         ActiveSlot == 0 ? farmers::kMaterialFarmLoopGapMs : 0;
}

uint8_t activeColor() { return SlotOverridden ? SavedSlot.color : 0; }

void useBuiltinMacro() {
  GamepadStreamActive = false;
  ActiveSlot = 0;
  SlotOverridden = false;
  Macro.configure(farmers::kMaterialFarmMacro,
                  farmers::kMaterialFarmStepCount,
                  farmers::kMaterialFarmLoopGapMs, true);
}

bool selectMacroSlot(uint8_t slot) {
  if (slot >= farmers::kMacroSlotCount) return false;
  if (SlotStorage.load(slot, &SavedSlot)) {
    ActiveSlot = slot;
    SlotOverridden = true;
    Macro.configure(SavedSlot.steps, SavedSlot.stepCount,
                    SavedSlot.loopGapMs, true);
    return true;
  }
  if (slot == 0) {
    useBuiltinMacro();
    return true;
  }
  return false;
}

String jsonName(const char* name) {
  String escaped;
  for (const char* cursor = name; *cursor != '\0'; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') escaped += '\\';
    escaped += *cursor;
  }
  return escaped;
}

void defaultUploadName(uint8_t slot) {
  if (slot == 0) {
    memcpy(UploadSlot.name, "素材远征", sizeof("素材远征"));
  } else {
    snprintf(UploadSlot.name, sizeof(UploadSlot.name), "宏槽位 %02u",
             static_cast<unsigned>(slot + 1));
  }
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
  char response[512];
  snprintf(response, sizeof(response),
      "{\"type\":\"%s\",\"ok\":true,\"firmware\":\"%s\","
      "\"routine\":\"material-farm\",\"embedded\":true,\"state\":\"%s\","
      "\"phase\":\"%s\",\"step\":%u,\"steps\":%u,\"cycle\":%lu,"
      "\"duration_ms\":%lu,\"loop_gap_ms\":%lu,\"cycle_ms\":%lu,"
      "\"wifi\":%s,\"wifi_ssid\":\"%s\",\"wifi_ip\":\"192.168.9.1\","
      "\"slot\":%u,\"source\":\"%s\",\"color\":%u,\"macro_storage\":\"%s\"}",
      type, kFirmwareVersion, Macro.running() ? "running" : "idle",
      phaseName(Macro.phase()), static_cast<unsigned int>(visibleStep),
      static_cast<unsigned int>(activeStepCount()),
      static_cast<unsigned long>(Macro.cycleCount()),
      static_cast<unsigned long>(activeDurationMs()),
      static_cast<unsigned long>(activeLoopGapMs()),
      static_cast<unsigned long>(activeDurationMs() + activeLoopGapMs()),
      WifiConsoleActive ? "true" : "false", kWifiApSsid,
      static_cast<unsigned>(ActiveSlot),
      SlotOverridden ? "flash" : ActiveSlot == 0 ? "builtin" : "empty",
      static_cast<unsigned>(activeColor()),
      SlotStorage.ready() ? "ready" : "mount-failed");
  return String(response);
}

String macroListResponse() {
  farmers::SlotStorageSummary summaries[farmers::kMacroSlotCount] = {};
  const bool scanned = SlotStorage.summarize(summaries,
                                             farmers::kMacroSlotCount);
  String response;
  response.reserve(3200);
  response += "{\"type\":\"macro_list\",\"ok\":true,\"storage\":\"";
  response += SlotStorage.ready() ? "ready" : "mount-failed";
  response += "\",\"used_bytes\":";
  response += static_cast<unsigned long>(SlotStorage.usedBytes());
  response += ",\"total_bytes\":";
  response += static_cast<unsigned long>(SlotStorage.totalBytes());
  response += ",\"slots\":[";
  for (uint8_t slot = 0; slot < farmers::kMacroSlotCount; ++slot) {
    const bool flash = (!scanned || summaries[slot].hasMacro) &&
                       SlotStorage.load(slot, &ReadSlot);
    if (slot > 0) response += ',';
    response += "{\"slot\":";
    response += slot;
    response += ",\"name\":\"";
    response += jsonName(flash ? ReadSlot.name : slot == 0 ? "素材远征" : "");
    response += "\",\"source\":\"";
    response += flash ? "flash" : slot == 0 ? "builtin" : "empty";
    response += "\",\"steps\":";
    response += flash ? ReadSlot.stepCount :
        slot == 0 ? farmers::kMaterialFarmStepCount : 0;
    response += ",\"duration_ms\":";
    response += flash ? farmers::slotMacroDurationMs(ReadSlot) :
        slot == 0 ? farmers::kMaterialFarmDurationMs : 0;
    response += ",\"loop_gap_ms\":";
    response += flash ? ReadSlot.loopGapMs :
        slot == 0 ? farmers::kMaterialFarmLoopGapMs : 0;
    response += ",\"color\":";
    response += flash ? ReadSlot.color : 0;
    response += ",\"used_bytes\":";
    response += static_cast<unsigned long>(scanned ? summaries[slot].usedBytes :
                                            SlotStorage.slotUsedBytes(slot));
    response += ",\"image_bytes\":";
    response += static_cast<unsigned long>(scanned ? summaries[slot].imageBytes :
                                            SlotStorage.slotImageUsedBytes(slot));
    uint32_t imageSize = scanned ? summaries[slot].imageSize : 0;
    if (!scanned) SlotStorage.imageInfo(slot, &imageSize);
    response += ",\"image_size\":";
    response += static_cast<unsigned long>(imageSize);
    response += '}';
  }
  response += "]}";
  return response;
}

String macroDetailResponse(uint8_t slot) {
  const bool flash = SlotStorage.load(slot, &ReadSlot);
  if (!flash && slot != 0) return "ERR macro-empty";
  const farmers::MacroStep* steps = flash
      ? ReadSlot.steps : farmers::kMaterialFarmMacro;
  const size_t count = flash ? ReadSlot.stepCount : farmers::kMaterialFarmStepCount;
  String response;
  response.reserve(210 + count * 48);
  response += "{\"type\":\"macro\",\"ok\":true,\"slot\":";
  response += slot;
  response += ",\"name\":\"";
  response += jsonName(flash ? ReadSlot.name : "素材远征");
  response += "\",\"source\":\"";
  response += flash ? "flash" : "builtin";
  response += "\",\"loop_gap_ms\":";
  response += flash ? ReadSlot.loopGapMs : farmers::kMaterialFarmLoopGapMs;
  response += ",\"color\":";
  response += flash ? ReadSlot.color : 0;
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
  if (strcmp(line, "MACRO_LIST") == 0) {
    return macroListResponse();
  }
  unsigned long selectedSlot = 0;
  char trailing = '\0';
  unsigned long imageOffset = 0;
  if (sscanf(line, "SLOT_IMAGE_INFO %lu %c", &selectedSlot,
             &trailing) == 1) {
    if (selectedSlot >= farmers::kMacroSlotCount) return "ERR invalid-slot";
    uint32_t bytes = 0;
    const bool exists = SlotStorage.imageInfo(selectedSlot, &bytes);
    char response[120];
    snprintf(response, sizeof(response),
             "{\"type\":\"slot_image_info\",\"ok\":true,\"slot\":%lu,\"exists\":%s,\"bytes\":%lu}",
             selectedSlot, exists ? "true" : "false",
             static_cast<unsigned long>(bytes));
    return String(response);
  }
  if (sscanf(line, "SLOT_IMAGE_READ %lu %lu %c", &selectedSlot,
             &imageOffset, &trailing) == 2) {
    if (selectedSlot >= farmers::kMacroSlotCount) return "ERR invalid-slot";
    char hex[161] = {};
    size_t bytesRead = 0;
    if (!SlotStorage.readImageChunk(selectedSlot, imageOffset, hex,
                                    sizeof(hex), &bytesRead))
      return "ERR image-read-failed";
    String response;
    response.reserve(250);
    response += "{\"type\":\"slot_image_chunk\",\"ok\":true,\"offset\":";
    response += imageOffset;
    response += ",\"data\":\"";
    response += hex;
    response += "\"}";
    return response;
  }
  if (strncmp(line, "SLOT_IMAGE_BEGIN ", 17) == 0) {
    unsigned long bytes = 0, checksum = 0;
    if (Macro.running()) return "ERR macro-running";
    if (sscanf(line, "SLOT_IMAGE_BEGIN %lu %lu %lu %c", &selectedSlot,
               &bytes, &checksum, &trailing) != 3 ||
        selectedSlot >= farmers::kMacroSlotCount || bytes == 0 ||
        bytes > farmers::kMaxSlotImageBytes || checksum > 0xffffffffUL)
      return "ERR invalid-image-begin";
    if (!SlotStorage.beginImage(selectedSlot, bytes, checksum))
      return "ERR image-upload-failed";
    return "OK";
  }
  if (strncmp(line, "SLOT_IMAGE_CHUNK ", 17) == 0) {
    return SlotStorage.appendImageHex(line + 17) ? "OK" : "ERR invalid-image-chunk";
  }
  if (strcmp(line, "SLOT_IMAGE_COMMIT") == 0) {
    return SlotStorage.commitImage() ? "OK" : "ERR image-commit-failed";
  }
  if (strcmp(line, "SLOT_IMAGE_ABORT") == 0) {
    SlotStorage.abortImage();
    return "OK";
  }
  if (sscanf(line, "SLOT_IMAGE_DELETE %lu %c", &selectedSlot,
             &trailing) == 1) {
    if (Macro.running()) return "ERR macro-running";
    if (selectedSlot >= farmers::kMacroSlotCount) return "ERR invalid-slot";
    return SlotStorage.removeImage(selectedSlot) ? "OK" : "ERR image-delete-failed";
  }
  if (sscanf(line, "MACRO_GET %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "MACRO_GET") == 0) {
    if (selectedSlot >= farmers::kMacroSlotCount) return "ERR invalid-slot";
    return macroDetailResponse(static_cast<uint8_t>(selectedSlot));
  }
  if (strcmp(line, "MACRO_ABORT") == 0) {
    UploadActive = false;
    return "OK";
  }
  if (sscanf(line, "MACRO_RESTORE %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "MACRO_RESTORE") == 0) {
    if (Macro.running()) return "ERR macro-running";
    if (!SlotStorage.ready()) return "ERR storage-unavailable";
    if (selectedSlot >= farmers::kMacroSlotCount) return "ERR invalid-slot";
    if (!SlotStorage.restore(static_cast<uint8_t>(selectedSlot)))
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
  if (strcmp(line, "MACRO_STORAGE_FORMAT") == 0) {
    if (Macro.running()) return "ERR macro-running";
    if (SlotStorage.ready()) return "ERR storage-already-ready";
    if (!SlotStorage.initializeEmptyStorage()) return "ERR storage-format-failed";
    useBuiltinMacro();
    flushMacroReport();
    return "OK";
  }
  unsigned long count = 0, gap = 0, color = 0;
  if (strncmp(line, "MACRO_BEGIN ", 12) == 0) {
    if (Macro.running()) return "ERR macro-running";
    if (!SlotStorage.ready()) return "ERR storage-unavailable";
    if (sscanf(line, "MACRO_BEGIN %lu %lu %lu %lu %c", &selectedSlot,
               &count, &gap, &color, &trailing) != 4 ||
        selectedSlot >= farmers::kMacroSlotCount ||
        count == 0 || count > farmers::kMaxSlotSteps ||
        gap > farmers::kMaxSlotLoopGapMs || color >= farmers::kSlotColorCount) {
      return "ERR invalid-macro-begin";
    }
    UploadSlot = {};
    UploadSlot.stepCount = static_cast<uint16_t>(count);
    UploadSlot.loopGapMs = gap;
    UploadSlot.color = static_cast<uint8_t>(color);
    UploadTargetSlot = static_cast<uint8_t>(selectedSlot);
    defaultUploadName(UploadTargetSlot);
    memset(UploadStepReceived, 0, sizeof(UploadStepReceived));
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
        index >= UploadSlot.stepCount ||
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
    if (Macro.running()) return "ERR macro-running";
    if (!UploadActive ||
        sscanf(line, "MACRO_COMMIT %lu %c", &checksum, &trailing) != 1 ||
        checksum > 0xffffffffUL || !farmers::isSlotMacroValid(UploadSlot)) {
      return "ERR invalid-macro-commit";
    }
    for (size_t index = 0; index < UploadSlot.stepCount; ++index) {
      if (!UploadStepReceived[index]) return "ERR missing-macro-step";
    }
    if (farmers::slotMacroChecksum(UploadSlot) != checksum) {
      return "ERR macro-checksum";
    }
    UploadActive = false;
    if (!SlotStorage.save(UploadTargetSlot, UploadSlot))
      return "ERR macro-save-failed";
    GamepadStreamActive = false;
    if (ActiveSlot == UploadTargetSlot) {
      SavedSlot = UploadSlot;
      SlotOverridden = true;
      Macro.configure(SavedSlot.steps, SavedSlot.stepCount,
                      SavedSlot.loopGapMs, true);
      flushMacroReport();
    }
    return "OK";
  }
  if (sscanf(line, "START %lu %c", &selectedSlot, &trailing) == 1 ||
      strcmp(line, "START") == 0) {
    UploadActive = false;
    SlotStorage.abortImage();
    GamepadStreamActive = false;
    if (selectedSlot >= farmers::kMacroSlotCount ||
        !selectMacroSlot(static_cast<uint8_t>(selectedSlot)))
      return "ERR macro-empty";
    Macro.start(millis());
    flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "STOP") == 0) {
    GamepadStreamActive = false;
    Macro.stop();
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
    const bool enteringStream = !GamepadStreamActive || Macro.running();
    if (enteringStream) {
      Macro.stop();
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
    Macro.stop();
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
  char line[sizeof(LineBuffer)] = {};
  command.toCharArray(line, sizeof(line));
  const String response = handleLine(line);
  WebConsole.sendHeader("Cache-Control", "no-store");
  WebConsole.send(200, response.startsWith("{") ? "application/json" :
                        "text/plain; charset=utf-8", response);
}

void startWifiConsole() {
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAPConfig(kWifiApAddress, kWifiApAddress, kWifiApSubnet) ||
      !WiFi.softAP(kWifiApSsid)) {
    ATT_CONTROL_SERIAL.println("ERR wifi-start-failed");
    return;
  }
  WebConsole.on("/api/command", HTTP_POST, handleWebCommand);
  WebConsole.onNotFound(serveEmbeddedWebAsset);
  WebConsole.begin();
  WifiConsoleActive = true;
  ATT_CONTROL_SERIAL.println("WIFI http://192.168.9.1");
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
  ATT_CONTROL_SERIAL.begin(kControlBaudRate);
  Led.begin();
  SlotStorage.begin();
  if (SlotStorage.load(&SavedSlot)) {
    SlotOverridden = true;
    Macro.configure(SavedSlot.steps, SavedSlot.stepCount,
                    SavedSlot.loopGapMs, true);
  }
  Gamepad.begin();
  USB.begin();
  applyReport(farmers::kNeutralReport);
  startWifiConsole();
}

void loop() {
  readControlSerial();
  Macro.tick(millis());
  flushMacroReport();
  Gamepad.loop();
  if (WifiConsoleActive) {
    WebConsole.handleClient();
  }
  const uint32_t nowMs = millis();
  if (GamepadStreamActive &&
      static_cast<uint32_t>(nowMs - LastGamepadStreamAtMs) >
          kGamepadStreamTimeoutMs) {
    GamepadStreamActive = false;
    applyReport(farmers::kNeutralReport);
  }
  const bool connected =
      (WifiConsoleActive && WiFi.softAPgetStationNum() > 0) ||
      (SerialSeen && static_cast<uint32_t>(nowMs - LastSerialCommandAtMs) < 3500);
  Led.update(nowMs, Macro.running(), connected, activeColor());
}
