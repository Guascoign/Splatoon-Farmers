#pragma once

#include <stdint.h>

namespace farmers {

// Nonblocking status light for the onboard GPIO48 WS2812.
class StatusLed {
 public:
  void begin();
  void setBrightness(uint8_t brightness);
  void notifyOutput();
  void update(uint32_t nowMs, bool running, bool controlConnected,
              uint8_t paletteIndex);

 private:
  void show(uint8_t red, uint8_t green, uint8_t blue);
  uint32_t startedAtMs_ = 0;
  uint32_t stateStartedAtMs_ = 0;
  uint32_t outputUntilMs_ = 0;
  bool wasRunning_ = false;
  bool wasConnected_ = false;
  uint8_t lastRed_ = 0xff;
  uint8_t lastGreen_ = 0xff;
  uint8_t lastBlue_ = 0xff;
  uint8_t brightness_ = 36;
};

}  // namespace farmers
