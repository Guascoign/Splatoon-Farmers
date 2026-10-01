#include "MacroSlotStorage.h"

#include <Arduino.h>
#include <SPIFFS.h>

namespace farmers {
namespace {

constexpr char kSlotFile[] = "/material-farm-slot-1.bin";
constexpr char kTempFile[] = "/material-farm-slot-1.tmp";
constexpr char kBackupFile[] = "/material-farm-slot-1.bak";
constexpr uint32_t kFileMagic = 0x314d4653u;
constexpr uint16_t kFileVersion = 1;
constexpr uint32_t kChecksumOffset = 2166136261u;
constexpr uint32_t kChecksumPrime = 16777619u;

#pragma pack(push, 1)
struct StoredHeader {
  uint32_t magic;
  uint16_t version;
  uint16_t stepCount;
  uint32_t loopGapMs;
  uint8_t color;
  uint8_t reserved[3];
  uint32_t checksum;
};

struct StoredStep {
  uint32_t durationMs;
  uint16_t buttons;
  uint8_t dpad;
  uint8_t leftX;
  uint8_t leftY;
  uint8_t rightX;
  uint8_t rightY;
};
#pragma pack(pop)

static_assert(sizeof(StoredHeader) == 20, "Unexpected slot header size");
static_assert(sizeof(StoredStep) == 11, "Unexpected slot step size");

uint32_t checksumByte(uint32_t checksum, uint8_t value) {
  return (checksum ^ value) * kChecksumPrime;
}

uint32_t checksum16(uint32_t checksum, uint16_t value) {
  checksum = checksumByte(checksum, static_cast<uint8_t>(value));
  return checksumByte(checksum, static_cast<uint8_t>(value >> 8));
}

uint32_t checksum32(uint32_t checksum, uint32_t value) {
  checksum = checksum16(checksum, static_cast<uint16_t>(value));
  return checksum16(checksum, static_cast<uint16_t>(value >> 16));
}

uint32_t checksumFor(const SlotMacro& macro) {
  uint32_t checksum = checksum16(kChecksumOffset, macro.stepCount);
  checksum = checksum32(checksum, macro.loopGapMs);
  checksum = checksumByte(checksum, macro.color);
  for (size_t index = 0; index < macro.stepCount; ++index) {
    const MacroStep& step = macro.steps[index];
    checksum = checksum32(checksum, step.durationMs);
    checksum = checksum16(checksum, step.report.buttons);
    checksum = checksumByte(checksum, step.report.dpad);
    checksum = checksumByte(checksum, step.report.leftX);
    checksum = checksumByte(checksum, step.report.leftY);
    checksum = checksumByte(checksum, step.report.rightX);
    checksum = checksumByte(checksum, step.report.rightY);
  }
  return checksum;
}

StoredStep storedStep(const MacroStep& step) {
  return {step.durationMs, step.report.buttons, step.report.dpad,
          step.report.leftX, step.report.leftY, step.report.rightX,
          step.report.rightY};
}

}  // namespace

bool isSlotMacroValid(const SlotMacro& macro) {
  if (macro.stepCount == 0 || macro.stepCount > kMaxSlotSteps ||
      macro.loopGapMs > kMaxSlotLoopGapMs || macro.color >= kSlotColorCount) {
    return false;
  }
  for (size_t index = 0; index < macro.stepCount; ++index) {
    const MacroStep& step = macro.steps[index];
    if (step.durationMs < kMinSlotStepMs ||
        step.durationMs > kMaxSlotStepMs ||
        (step.report.buttons & ~0x3fffu) != 0 ||
        (step.report.dpad > 7 && step.report.dpad != kDpadCentered)) {
      return false;
    }
  }
  return true;
}

uint32_t slotMacroChecksum(const SlotMacro& macro) {
  return checksumFor(macro);
}

uint32_t slotMacroDurationMs(const SlotMacro& macro) {
  uint32_t total = 0;
  for (size_t index = 0; index < macro.stepCount; ++index) {
    total += macro.steps[index].durationMs;
  }
  return total;
}

bool MacroSlotStorage::begin() {
  ready_ = SPIFFS.begin(false);
  return ready_;
}

bool MacroSlotStorage::ready() const { return ready_; }

bool MacroSlotStorage::readFile(const char* path, SlotMacro* macro) const {
  if (!ready_ || macro == nullptr) return false;
  File file = SPIFFS.open(path, FILE_READ);
  if (!file) return false;
  StoredHeader header{};
  const bool validHeader =
      file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) ==
          sizeof(header) &&
      header.magic == kFileMagic && header.version == kFileVersion &&
      header.stepCount > 0 && header.stepCount <= kMaxSlotSteps &&
      file.size() == sizeof(header) + header.stepCount * sizeof(StoredStep);
  if (!validHeader) return false;

  SlotMacro candidate{};
  candidate.stepCount = header.stepCount;
  candidate.loopGapMs = header.loopGapMs;
  candidate.color = header.color;
  for (size_t index = 0; index < candidate.stepCount; ++index) {
    StoredStep stored{};
    if (file.readBytes(reinterpret_cast<char*>(&stored), sizeof(stored)) !=
        sizeof(stored)) {
      return false;
    }
    candidate.steps[index] =
        {stored.durationMs,
         {stored.buttons, stored.dpad, stored.leftX, stored.leftY,
          stored.rightX, stored.rightY}};
  }
  if (!isSlotMacroValid(candidate) || checksumFor(candidate) != header.checksum) {
    return false;
  }
  *macro = candidate;
  return true;
}

bool MacroSlotStorage::load(SlotMacro* macro) const {
  return readFile(kSlotFile, macro) || readFile(kBackupFile, macro);
}

bool MacroSlotStorage::save(const SlotMacro& macro) {
  if (!ready_ || !isSlotMacroValid(macro)) return false;
  SPIFFS.remove(kTempFile);
  File file = SPIFFS.open(kTempFile, FILE_WRITE);
  if (!file) return false;
  const StoredHeader header{kFileMagic, kFileVersion, macro.stepCount,
                            macro.loopGapMs, macro.color, {0, 0, 0},
                            checksumFor(macro)};
  bool success = file.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) == sizeof(header);
  for (size_t index = 0; success && index < macro.stepCount; ++index) {
    const StoredStep step = storedStep(macro.steps[index]);
    success = file.write(reinterpret_cast<const uint8_t*>(&step),
                         sizeof(step)) == sizeof(step);
  }
  file.flush();
  file.close();
  SlotMacro verified{};
  if (!success || !readFile(kTempFile, &verified)) {
    SPIFFS.remove(kTempFile);
    return false;
  }

  SlotMacro previous{};
  if (readFile(kSlotFile, &previous)) {
    SPIFFS.remove(kBackupFile);
    if (!SPIFFS.rename(kSlotFile, kBackupFile)) return false;
  } else if (SPIFFS.exists(kSlotFile)) {
    SPIFFS.remove(kSlotFile);
  }
  if (!SPIFFS.rename(kTempFile, kSlotFile) ||
      !readFile(kSlotFile, &verified)) {
    SPIFFS.remove(kSlotFile);
    if (SPIFFS.exists(kBackupFile)) SPIFFS.rename(kBackupFile, kSlotFile);
    return false;
  }
  return true;
}

bool MacroSlotStorage::restore() {
  if (!ready_) return false;
  bool success = true;
  if (SPIFFS.exists(kSlotFile)) success &= SPIFFS.remove(kSlotFile);
  if (SPIFFS.exists(kBackupFile)) success &= SPIFFS.remove(kBackupFile);
  if (SPIFFS.exists(kTempFile)) success &= SPIFFS.remove(kTempFile);
  return success;
}

bool MacroSlotStorage::initializeEmptyStorage() {
  if (ready_) return false;
  if (!SPIFFS.format()) return false;
  ready_ = SPIFFS.begin(false);
  return ready_;
}

}  // namespace farmers
