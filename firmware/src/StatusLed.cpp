#include "StatusLed.h"

#include <Arduino.h>
#include <esp32-hal-rgb-led.h>

namespace farmers {
namespace {

constexpr uint8_t kLedPin = 48;
constexpr uint32_t kStartupRedMs = 850;
constexpr uint32_t kOutputPulseMs = 100;

struct Color {
  uint8_t red;
  uint8_t green;
  uint8_t blue;
};

// Same fixed choices shown in the macro editor, in the same order.
constexpr Color kMacroColors[] = {
    {174, 72, 255},  // purple
    {45, 115, 255},  // blue
    {0, 220, 215},   // cyan
    {255, 125, 0},   // orange
    {255, 65, 150},  // pink
    {245, 245, 245}, // white
};

bool before(uint32_t nowMs, uint32_t deadlineMs) {
  return static_cast<int32_t>(nowMs - deadlineMs) < 0;
}

}  // namespace

void StatusLed::show(uint8_t red, uint8_t green, uint8_t blue) {
  red = static_cast<uint8_t>((static_cast<uint16_t>(red) * brightness_ + 127u) / 255u);
  green = static_cast<uint8_t>((static_cast<uint16_t>(green) * brightness_ + 127u) / 255u);
  blue = static_cast<uint8_t>((static_cast<uint16_t>(blue) * brightness_ + 127u) / 255u);
  if (red == lastRed_ && green == lastGreen_ && blue == lastBlue_) return;
  lastRed_ = red;
  lastGreen_ = green;
  lastBlue_ = blue;
  neopixelWrite(kLedPin, red, green, blue);
}

void StatusLed::setBrightness(uint8_t brightness) {
  brightness_ = brightness;
  lastRed_ = lastGreen_ = lastBlue_ = 0xff;
}

void StatusLed::begin() {
  startedAtMs_ = millis();
  stateStartedAtMs_ = startedAtMs_;
  pinMode(kLedPin, OUTPUT);
  show(255, 0, 0);
}

void StatusLed::notifyOutput() {
  outputUntilMs_ = millis() + kOutputPulseMs;
}

void StatusLed::update(uint32_t nowMs, bool running, bool controlConnected,
                       uint8_t paletteIndex) {
  if (running != wasRunning_ || controlConnected != wasConnected_) {
    stateStartedAtMs_ = nowMs;
    wasRunning_ = running;
    wasConnected_ = controlConnected;
  }
  if (static_cast<uint32_t>(nowMs - startedAtMs_) < kStartupRedMs) {
    show(255, 0, 0);
    return;
  }
  if (before(nowMs, outputUntilMs_)) {
    show(0, 255, 40);
    return;
  }
  if (running) {
    const Color& color = kMacroColors[paletteIndex < 6 ? paletteIndex : 0];
    const bool lit = (nowMs - stateStartedAtMs_) % 600 < 300;
    show(lit ? color.red : 0, lit ? color.green : 0,
         lit ? color.blue : 0);
    return;
  }
  if (controlConnected) {
    show(255, 210, 0);
    return;
  }
  const bool lit = (nowMs - stateStartedAtMs_) % 700 < 330;
  show(lit ? 255 : 0, lit ? 210 : 0, 0);
}

}  // namespace farmers
