#pragma once

#include <stddef.h>
#include <stdint.h>

#include "MacroEngine.h"

namespace farmers {

constexpr size_t kMaxSlotSteps = 128;
constexpr uint8_t kMacroSlotCount = 12;
constexpr size_t kMaxSlotNameBytes = 48;
constexpr uint32_t kMaxSlotImageBytes = 65536;
constexpr uint32_t kMinSlotStepMs = 10;
constexpr uint32_t kMaxSlotStepMs = 600000;
constexpr uint32_t kMaxSlotLoopGapMs = 600000;
constexpr uint8_t kSlotColorCount = 6;

struct SlotMacro {
  MacroStep steps[kMaxSlotSteps];
  uint16_t stepCount = 0;
  uint32_t loopGapMs = 0;
  uint8_t color = 0;
  char name[kMaxSlotNameBytes + 1] = {};
};

struct SlotStorageSummary {
  bool hasMacro = false;
  size_t usedBytes = 0;
  size_t imageBytes = 0;
  uint32_t imageSize = 0;
};

bool isSlotMacroValid(const SlotMacro& macro);
uint32_t slotMacroDurationMs(const SlotMacro& macro);
uint32_t slotMacroChecksum(const SlotMacro& macro);

// Each slot has a primary and backup file. Slot 0 also has the compiled
// routine as its fallback. Mounting never formats the partition.
class MacroSlotStorage {
 public:
  bool begin();
  bool ready() const;
  bool load(uint8_t slot, SlotMacro* macro) const;
  bool save(uint8_t slot, const SlotMacro& macro);
  bool restore(uint8_t slot);
  bool imageInfo(uint8_t slot, uint32_t* bytes) const;
  bool beginImage(uint8_t slot, uint32_t bytes, uint32_t checksum);
  bool appendImageHex(const char* hex);
  bool commitImage();
  void abortImage();
  bool readImageChunk(uint8_t slot, uint32_t offset, char* hex,
                      size_t hexCapacity, size_t* bytesRead) const;
  bool removeImage(uint8_t slot);
  size_t slotUsedBytes(uint8_t slot) const;
  size_t slotImageUsedBytes(uint8_t slot) const;
  bool summarize(SlotStorageSummary* slots, size_t count) const;
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
