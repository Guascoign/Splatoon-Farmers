#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>

#include <stdio.h>
#include <string.h>

#include "ControllerReport.h"
#include "EmbeddedWebAssets.h"
#include "MaterialFarmMacro.h"
#include "MacroEngine.h"
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
constexpr char kFirmwareVersion[] = "SplatoonFarmers/1.1.0";
constexpr char kWifiApSsid[] = "ESP32-S3-Switch";
const IPAddress kWifiApAddress(192, 168, 9, 1);
const IPAddress kWifiApSubnet(255, 255, 255, 0);

WebServer WebConsole(80);
bool WifiConsoleActive = false;

NSGamepad Gamepad;
farmers::MacroEngine Macro(
    farmers::kMaterialFarmMacro, farmers::kMaterialFarmStepCount,
    farmers::kMaterialFarmLoopGapMs, true);

char LineBuffer[128];
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
}

void applyRawReport(unsigned long buttons, unsigned long dpad,
                    unsigned long leftX, unsigned long leftY,
                    unsigned long rightX, unsigned long rightY) {
  const farmers::ControllerReport report{
      static_cast<uint16_t>(buttons & 0x3fff),
      normalizeDpad(dpad),
      clampAxis(leftX),
      clampAxis(leftY),
      clampAxis(rightX),
      clampAxis(rightY),
  };
  applyReport(report);
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

String stateResponse(const char* type) {
  const size_t visibleStep =
      Macro.phase() == farmers::MacroPhase::kSteps ? Macro.stepIndex() + 1 : 0;
  char response[384];
  snprintf(response, sizeof(response),
      "{\"type\":\"%s\",\"ok\":true,\"firmware\":\"%s\","
      "\"routine\":\"material-farm\",\"embedded\":true,\"state\":\"%s\","
      "\"phase\":\"%s\",\"step\":%u,\"steps\":%u,\"cycle\":%lu,"
      "\"duration_ms\":%lu,\"loop_gap_ms\":%lu,\"cycle_ms\":%lu,"
      "\"wifi\":%s,\"wifi_ssid\":\"%s\",\"wifi_ip\":\"192.168.9.1\"}",
      type, kFirmwareVersion, Macro.running() ? "running" : "idle",
      phaseName(Macro.phase()), static_cast<unsigned int>(visibleStep),
      static_cast<unsigned int>(farmers::kMaterialFarmStepCount),
      static_cast<unsigned long>(Macro.cycleCount()),
      static_cast<unsigned long>(farmers::kMaterialFarmDurationMs),
      static_cast<unsigned long>(farmers::kMaterialFarmLoopGapMs),
      static_cast<unsigned long>(farmers::kMaterialFarmCycleMs),
      WifiConsoleActive ? "true" : "false", kWifiApSsid);
  return String(response);
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
  if (strcmp(line, "START") == 0) {
    Macro.start(millis());
    flushMacroReport();
    return stateResponse("status");
  }
  if (strcmp(line, "STOP") == 0) {
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

  if (parsed == 7 &&
      (strcmp(command, "R") == 0 || strcmp(command, "REPORT") == 0)) {
    // Raw reports power manual input and leave a fallback path for future
    // computer-loaded routines. Entering this mode stops the embedded routine.
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
}
