#include "MacroSlotStorage.h"

#include <Arduino.h>
#include <SPIFFS.h>
#include <algorithm>
#include <stdio.h>
#include <string.h>
#include <utility>

namespace farmers {
namespace {

constexpr uint32_t kFileMagic = 0x314d4653u;
constexpr uint16_t kFileVersion = 4;
constexpr uint32_t kChecksumOffset = 2166136261u;
constexpr uint32_t kChecksumPrime = 16777619u;

#pragma pack(push, 1)
struct StoredHeaderPrefixLegacy {
  uint32_t magic;
  uint16_t version;
  uint16_t stepCount;
  uint32_t loopGapMs;
  uint8_t color;
  uint8_t reserved[3];
  uint32_t checksum;
};

struct StoredHeaderPrefix {
  uint32_t magic;
  uint16_t version;
  uint32_t stepCount;
  uint32_t loopGapMs;
  uint8_t color;
  uint8_t reserved[3];
  uint32_t checksum;
};

struct StoredMetadata {
  uint32_t updatedAt;
  uint64_t shareId;
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

static_assert(sizeof(StoredHeaderPrefixLegacy) == 20, "Unexpected legacy slot header size");
static_assert(sizeof(StoredHeaderPrefix) == 22, "Unexpected slot header size");
static_assert(sizeof(StoredMetadata) == 12, "Unexpected slot metadata size");
static_assert(sizeof(StoredStep) == 11, "Unexpected slot step size");
uint32_t checksumByte(uint32_t checksum, uint8_t value) {
  return (checksum ^ value) * kChecksumPrime;
}

int hexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
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
  const uint32_t stepCount = static_cast<uint32_t>(macro.steps.size());
  uint32_t checksum = checksum32(kChecksumOffset, stepCount);
  checksum = checksum32(checksum, macro.loopGapMs);
  checksum = checksumByte(checksum, macro.color);
  for (const MacroStep& step : macro.steps) {
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

// Files written before the variable-length format used a 16-bit step count in
// the checksum. Keep this decoder path so existing macros remain readable.
uint32_t legacyChecksumFor(const SlotMacro& macro) {
  uint32_t checksum = checksum16(kChecksumOffset,
                                 static_cast<uint16_t>(macro.steps.size()));
  checksum = checksum32(checksum, macro.loopGapMs);
  checksum = checksumByte(checksum, macro.color);
  for (const MacroStep& step : macro.steps) {
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

size_t nameLength(const char* name) {
  size_t length = 0;
  while (length <= kMaxSlotNameBytes && name[length] != '\0') ++length;
  return length;
}

uint32_t fileChecksumFor(const SlotMacro& macro) {
  const size_t length = nameLength(macro.name);
  uint32_t checksum = checksumByte(checksumFor(macro), static_cast<uint8_t>(length));
  for (size_t index = 0; index < length; ++index) {
    checksum = checksumByte(checksum, static_cast<uint8_t>(macro.name[index]));
  }
  return checksum;
}

uint32_t legacyFileChecksumFor(const SlotMacro& macro) {
  const size_t length = nameLength(macro.name);
  uint32_t checksum = checksumByte(legacyChecksumFor(macro),
                                   static_cast<uint8_t>(length));
  for (size_t index = 0; index < length; ++index)
    checksum = checksumByte(checksum, static_cast<uint8_t>(macro.name[index]));
  return checksum;
}

bool slotPath(uint32_t slot, const char* extension, char* path, size_t size) {
  if (slot == UINT32_MAX) return false;
  return snprintf(path, size, "/material-farm-slot-%lu.%s",
                  static_cast<unsigned long>(slot + 1), extension) > 0;
}

size_t fileSizeIfPresent(const char* path) {
  File file = SPIFFS.open(path, FILE_READ);
  return file ? file.size() : 0;
}

}  // namespace

bool isSlotMacroValid(const SlotMacro& macro) {
  const size_t length = nameLength(macro.name);
  if (macro.steps.empty() || macro.steps.size() > UINT32_MAX ||
      macro.loopGapMs > kMaxSlotLoopGapMs || macro.color >= kSlotColorCount ||
      length == 0 || length > kMaxSlotNameBytes) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    const uint8_t byte = static_cast<uint8_t>(macro.name[index]);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  for (const MacroStep& step : macro.steps) {
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
  for (const MacroStep& step : macro.steps) {
    total += step.durationMs;
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
  uint32_t magic = 0;
  uint16_t version = 0;
  if (file.readBytes(reinterpret_cast<char*>(&magic), sizeof(magic)) != sizeof(magic) ||
      file.readBytes(reinterpret_cast<char*>(&version), sizeof(version)) != sizeof(version) ||
      magic != kFileMagic || version < 1 || version > kFileVersion) return false;

  uint32_t stepCount = 0;
  uint32_t loopGapMs = 0;
  uint8_t color = 0;
  uint8_t storedNameLength = 0;
  uint32_t storedChecksum = 0;
  size_t headerBytes = 0;
  if (version < 4) {
    if (!file.seek(0)) return false;
    StoredHeaderPrefixLegacy header{};
    if (file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) != sizeof(header))
      return false;
    stepCount = header.stepCount;
    loopGapMs = header.loopGapMs;
    color = header.color;
    storedNameLength = version == 1 ? 0 : header.reserved[0];
    storedChecksum = header.checksum;
    headerBytes = sizeof(header);
  } else {
    if (!file.seek(0)) return false;
    StoredHeaderPrefix header{};
    if (file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) != sizeof(header))
      return false;
    stepCount = header.stepCount;
    loopGapMs = header.loopGapMs;
    color = header.color;
    storedNameLength = header.reserved[0];
    storedChecksum = header.checksum;
    headerBytes = sizeof(header);
  }
  if (stepCount == 0 ||
      (version >= 2 && (storedNameLength == 0 ||
                        storedNameLength > kMaxSlotNameBytes))) return false;
  const size_t metadataBytes = version == 3 || version >= 4
      ? sizeof(StoredMetadata) : 0;
  const size_t fileBytes = file.size();
  const size_t fixedBytes = headerBytes + metadataBytes + storedNameLength;
  if (fileBytes < fixedBytes ||
      static_cast<uint64_t>(stepCount) * sizeof(StoredStep) !=
          fileBytes - fixedBytes ||
      static_cast<uint64_t>(stepCount) * sizeof(MacroStep) > ESP.getFreeHeap())
    return false;

  SlotMacro candidate{};
  candidate.steps.reserve(stepCount);
  candidate.loopGapMs = loopGapMs;
  candidate.color = color;
  if (version == 3 || version >= 4) {
    StoredMetadata metadata{};
    if (file.readBytes(reinterpret_cast<char*>(&metadata), sizeof(metadata)) != sizeof(metadata))
      return false;
    candidate.updatedAt = metadata.updatedAt;
    candidate.shareId = metadata.shareId;
  }
  if (version == 1) {
    memcpy(candidate.name, "素材远征", sizeof("素材远征"));
  } else {
    if (file.readBytes(candidate.name, storedNameLength) != storedNameLength)
      return false;
    candidate.name[storedNameLength] = '\0';
  }
  for (uint32_t index = 0; index < stepCount; ++index) {
    StoredStep stored{};
    if (file.readBytes(reinterpret_cast<char*>(&stored), sizeof(stored)) !=
        sizeof(stored)) {
      return false;
    }
    candidate.steps.push_back({stored.durationMs,
                               {stored.buttons, stored.dpad, stored.leftX,
                                stored.leftY, stored.rightX, stored.rightY}});
  }
  const uint32_t expected = version == 1
      ? legacyChecksumFor(candidate)
      : version < 4 ? legacyFileChecksumFor(candidate) : fileChecksumFor(candidate);
  if (!isSlotMacroValid(candidate) || expected != storedChecksum) {
    return false;
  }
  *macro = std::move(candidate);
  return true;
}

bool MacroSlotStorage::load(uint32_t slot, SlotMacro* macro) const {
  char primary[40] = {}, backup[40] = {};
  if (!slotPath(slot, "bin", primary, sizeof(primary)) ||
      !slotPath(slot, "bak", backup, sizeof(backup))) return false;
  return readFile(primary, macro) || readFile(backup, macro);
}

bool MacroSlotStorage::save(uint32_t slot, const SlotMacro& macro) {
  if (!ready_ || slot == UINT32_MAX || !isSlotMacroValid(macro)) return false;
  char primary[40] = {}, backup[40] = {}, temporary[40] = {};
  slotPath(slot, "bin", primary, sizeof(primary));
  slotPath(slot, "bak", backup, sizeof(backup));
  slotPath(slot, "tmp", temporary, sizeof(temporary));
  SPIFFS.remove(temporary);
  File file = SPIFFS.open(temporary, FILE_WRITE);
  if (!file) return false;
  const size_t storedNameLength = nameLength(macro.name);
  const StoredHeaderPrefix header{kFileMagic, kFileVersion,
                                  static_cast<uint32_t>(macro.steps.size()),
                                  macro.loopGapMs, macro.color,
                                  {static_cast<uint8_t>(storedNameLength), 0, 0},
                                  fileChecksumFor(macro)};
  const StoredMetadata metadata{macro.updatedAt, macro.shareId};
  bool success = file.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) == sizeof(header);
  success = success && file.write(reinterpret_cast<const uint8_t*>(&metadata),
                                  sizeof(metadata)) == sizeof(metadata);
  success = success && file.write(reinterpret_cast<const uint8_t*>(macro.name),
                                  storedNameLength) == storedNameLength;
  for (const MacroStep& macroStep : macro.steps) {
    if (!success) break;
    const StoredStep step = storedStep(macroStep);
    success = file.write(reinterpret_cast<const uint8_t*>(&step),
                         sizeof(step)) == sizeof(step);
  }
  file.flush();
  file.close();
  SlotMacro verified{};
  if (!success || !readFile(temporary, &verified)) {
    SPIFFS.remove(temporary);
    return false;
  }
  const size_t previousMacroBytes = fileSizeIfPresent(primary) +
      fileSizeIfPresent(backup);
  const size_t projectedBytes = SPIFFS.usedBytes() >= previousMacroBytes
      ? SPIFFS.usedBytes() - previousMacroBytes : SPIFFS.usedBytes();
  if (projectedBytes > (SPIFFS.totalBytes() * 90) / 100) {
    SPIFFS.remove(temporary);
    return false;
  }

  SlotMacro previous{};
  if (readFile(primary, &previous)) {
    SPIFFS.remove(backup);
    if (!SPIFFS.rename(primary, backup)) return false;
  } else if (SPIFFS.exists(primary)) {
    SPIFFS.remove(primary);
  }
  if (!SPIFFS.rename(temporary, primary) ||
      !readFile(primary, &verified)) {
    SPIFFS.remove(primary);
    if (SPIFFS.exists(backup)) SPIFFS.rename(backup, primary);
    return false;
  }
  return true;
}

bool MacroSlotStorage::restore(uint32_t slot) {
  if (!ready_ || slot == UINT32_MAX) return false;
  char primary[40] = {}, backup[40] = {}, temporary[40] = {};
  slotPath(slot, "bin", primary, sizeof(primary));
  slotPath(slot, "bak", backup, sizeof(backup));
  slotPath(slot, "tmp", temporary, sizeof(temporary));
  bool success = true;
  if (SPIFFS.exists(primary)) success &= SPIFFS.remove(primary);
  if (SPIFFS.exists(backup)) success &= SPIFFS.remove(backup);
  if (SPIFFS.exists(temporary)) success &= SPIFFS.remove(temporary);
  return success;
}

bool MacroSlotStorage::summarize(std::vector<SlotStorageSummary>* slots) const {
  if (!ready_ || slots == nullptr) return false;
  slots->clear();
  File root = SPIFFS.open("/");
  if (!root) return false;
  File file = root.openNextFile();
  while (file) {
    unsigned long slotNumber = 0;
    char extension[8] = {};
    const char* name = file.name();
    if (name[0] == '/') ++name;
    if (sscanf(name, "material-farm-slot-%lu.%7s", &slotNumber,
               extension) == 2 && slotNumber > 0 &&
        slotNumber <= static_cast<unsigned long>(UINT32_MAX) &&
        (strcmp(extension, "bin") == 0 ||
         strcmp(extension, "bak") == 0 ||
         strcmp(extension, "tmp") == 0)) {
      const uint32_t slot = static_cast<uint32_t>(slotNumber - 1);
      auto found = std::find_if(slots->begin(), slots->end(),
                                [slot](const SlotStorageSummary& item) {
                                  return item.slot == slot;
                                });
      if (found == slots->end()) {
        slots->push_back(SlotStorageSummary{});
        slots->back().slot = slot;
        found = slots->end() - 1;
      }
      SlotStorageSummary& summary = *found;
      const size_t bytes = file.size();
      const bool macro = strcmp(extension, "bin") == 0 ||
                         strcmp(extension, "bak") == 0 ||
                         strcmp(extension, "tmp") == 0;
      if (macro) summary.usedBytes += bytes;
      if (strcmp(extension, "bin") == 0 ||
          strcmp(extension, "bak") == 0) summary.hasMacro = true;
    }
    file.close();
    yield();
    file = root.openNextFile();
  }
  root.close();
  std::sort(slots->begin(), slots->end(),
            [](const SlotStorageSummary& left, const SlotStorageSummary& right) {
              return left.slot < right.slot;
            });
  return true;
}

uint32_t MacroSlotStorage::nextSlot() const {
  std::vector<SlotStorageSummary> slots;
  if (!summarize(&slots)) return 0;
  uint32_t candidate = 0;
  for (const SlotStorageSummary& summary : slots) {
    if (summary.slot < candidate) continue;
    if (summary.slot > candidate) return candidate;
    if (candidate == UINT32_MAX) return UINT32_MAX;
    ++candidate;
  }
  return candidate;
}

size_t MacroSlotStorage::slotUsedBytes(uint32_t slot) const {
  if (!ready_ || slot == UINT32_MAX) return 0;
  size_t bytes = 0;
  for (const char* extension : {"bin", "bak", "tmp"}) {
    char path[64] = {};
    slotPath(slot, extension, path, sizeof(path));
    bytes += fileSizeIfPresent(path);
  }
  return bytes;
}

size_t MacroSlotStorage::usedBytes() const {
  return ready_ ? SPIFFS.usedBytes() : 0;
}

size_t MacroSlotStorage::totalBytes() const {
  return ready_ ? SPIFFS.totalBytes() : 0;
}

bool MacroSlotStorage::initializeEmptyStorage() {
  if (ready_) return false;
  if (!SPIFFS.format()) return false;
  ready_ = SPIFFS.begin(false);
  return ready_;
}

}  // namespace farmers
