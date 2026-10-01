#pragma once

#include <stddef.h>
#include <stdint.h>
#include <vector>

#include "MacroEngine.h"

namespace farmers {

constexpr size_t kMaxSlotNameBytes = 48;
constexpr uint32_t kMinSlotStepMs = 10;
constexpr uint32_t kMaxSlotStepMs = 600000;
constexpr uint32_t kMaxSlotLoopGapMs = 600000;
constexpr uint8_t kSlotColorCount = 6;

struct SlotMacro {
  // Macro steps are stored in a variable-length record. The vector is sized
  // when a record is loaded or staged; remaining Flash/heap is the practical
  // limit rather than a compile-time step count.
  std::vector<MacroStep> steps;
  uint32_t loopGapMs = 0;
  uint8_t color = 0;
  char name[kMaxSlotNameBytes + 1] = {};
  uint32_t updatedAt = 0;
  uint64_t shareId = 0;
};

struct SlotStorageSummary {
  uint32_t slot = 0;
  bool hasMacro = false;
  size_t usedBytes = 0;
  uint32_t updatedAt = 0;
  uint64_t shareId = 0;
};

bool isSlotMacroValid(const SlotMacro& macro);
uint32_t slotMacroDurationMs(const SlotMacro& macro);
uint32_t slotMacroChecksum(const SlotMacro& macro);

// Each slot has a primary and backup file. Mounting never formats the
// partition.
class MacroSlotStorage {
 public:
  bool begin();
  bool ready() const;
  bool load(uint32_t slot, SlotMacro* macro) const;
  bool save(uint32_t slot, const SlotMacro& macro);
  bool restore(uint32_t slot);
  size_t slotUsedBytes(uint32_t slot) const;
  bool summarize(std::vector<SlotStorageSummary>* slots) const;
  uint32_t nextSlot() const;
  size_t usedBytes() const;
  size_t totalBytes() const;
  bool load(SlotMacro* macro) const { return load(0, macro); }
  bool save(const SlotMacro& macro) { return save(0, macro); }
  bool restore() { return restore(0); }
  bool initializeEmptyStorage();

 private:
  bool readFile(const char* path, SlotMacro* macro) const;
  bool ready_ = false;
};

}  // namespace farmers
