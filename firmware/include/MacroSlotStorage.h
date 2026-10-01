#pragma once

#include <stddef.h>
#include <stdint.h>

#include "MacroEngine.h"

namespace farmers {

constexpr size_t kMaxSlotSteps = 128;
constexpr uint32_t kMinSlotStepMs = 10;
constexpr uint32_t kMaxSlotStepMs = 600000;
constexpr uint32_t kMaxSlotLoopGapMs = 600000;
constexpr uint8_t kSlotColorCount = 6;

struct SlotMacro {
  MacroStep steps[kMaxSlotSteps];
  uint16_t stepCount = 0;
  uint32_t loopGapMs = 0;
  uint8_t color = 0;
};

bool isSlotMacroValid(const SlotMacro& macro);
uint32_t slotMacroDurationMs(const SlotMacro& macro);
uint32_t slotMacroChecksum(const SlotMacro& macro);

// A single user override. The compiled 48-step routine remains available if
// mounting or reading Flash fails. Mounting never formats the partition.
class MacroSlotStorage {
 public:
  bool begin();
  bool ready() const;
  bool load(SlotMacro* macro) const;
  bool save(const SlotMacro& macro);
  bool restore();
  bool initializeEmptyStorage();

 private:
  bool readFile(const char* path, SlotMacro* macro) const;
  bool ready_ = false;
};

}  // namespace farmers
