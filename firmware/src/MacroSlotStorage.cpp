#include "MacroSlotStorage.h"

#include <Arduino.h>
#include <SPIFFS.h>
#include <stdio.h>
#include <string.h>

namespace farmers {
namespace {

constexpr uint32_t kFileMagic = 0x314d4653u;
constexpr uint16_t kFileVersion = 2;
constexpr uint32_t kImageMagic = 0x474d4953u;
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

struct ImageHeader {
  uint32_t magic;
  uint16_t version;
  uint32_t bytes;
  uint32_t checksum;
};
#pragma pack(pop)

static_assert(sizeof(StoredHeader) == 20, "Unexpected slot header size");
static_assert(sizeof(StoredStep) == 11, "Unexpected slot step size");
static_assert(sizeof(ImageHeader) == 14, "Unexpected image header size");

File ImageUploadFile;
bool ImageUploadActive = false;
uint8_t ImageUploadSlot = 0;
uint32_t ImageUploadExpectedBytes = 0;
uint32_t ImageUploadChecksum = 0;
uint32_t ImageUploadReceived = 0;
uint32_t ImageUploadCurrentChecksum = kChecksumOffset;

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

bool slotPath(uint8_t slot, const char* extension, char* path, size_t size) {
  if (slot >= kMacroSlotCount) return false;
  return snprintf(path, size, "/material-farm-slot-%u.%s",
                  static_cast<unsigned>(slot + 1), extension) > 0;
}

size_t fileSizeIfPresent(const char* path) {
  File file = SPIFFS.open(path, FILE_READ);
  return file ? file.size() : 0;
}

}  // namespace

bool isSlotMacroValid(const SlotMacro& macro) {
  const size_t length = nameLength(macro.name);
  if (macro.stepCount == 0 || macro.stepCount > kMaxSlotSteps ||
      macro.loopGapMs > kMaxSlotLoopGapMs || macro.color >= kSlotColorCount ||
      length == 0 || length > kMaxSlotNameBytes) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    const uint8_t byte = static_cast<uint8_t>(macro.name[index]);
    if (byte < 0x20 || byte == 0x7f) return false;
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
      header.magic == kFileMagic &&
      (header.version == 1 || header.version == kFileVersion) &&
      header.stepCount > 0 && header.stepCount <= kMaxSlotSteps;
  if (!validHeader) return false;

  const size_t storedNameLength = header.version == 1 ? 0 : header.reserved[0];
  if ((header.version == kFileVersion &&
       (storedNameLength == 0 || storedNameLength > kMaxSlotNameBytes)) ||
      file.size() != sizeof(header) + storedNameLength +
                         header.stepCount * sizeof(StoredStep)) return false;

  SlotMacro candidate{};
  candidate.stepCount = header.stepCount;
  candidate.loopGapMs = header.loopGapMs;
  candidate.color = header.color;
  if (header.version == 1) {
    memcpy(candidate.name, "素材远征", sizeof("素材远征"));
  } else {
    if (file.readBytes(candidate.name, storedNameLength) != storedNameLength)
      return false;
    candidate.name[storedNameLength] = '\0';
  }
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
  const uint32_t expected = header.version == 1
      ? checksumFor(candidate) : fileChecksumFor(candidate);
  if (!isSlotMacroValid(candidate) || expected != header.checksum) {
    return false;
  }
  *macro = candidate;
  return true;
}

bool MacroSlotStorage::load(uint8_t slot, SlotMacro* macro) const {
  char primary[40] = {}, backup[40] = {};
  if (!slotPath(slot, "bin", primary, sizeof(primary)) ||
      !slotPath(slot, "bak", backup, sizeof(backup))) return false;
  return readFile(primary, macro) || readFile(backup, macro);
}

bool MacroSlotStorage::save(uint8_t slot, const SlotMacro& macro) {
  if (!ready_ || slot >= kMacroSlotCount || !isSlotMacroValid(macro)) return false;
  char primary[40] = {}, backup[40] = {}, temporary[40] = {};
  slotPath(slot, "bin", primary, sizeof(primary));
  slotPath(slot, "bak", backup, sizeof(backup));
  slotPath(slot, "tmp", temporary, sizeof(temporary));
  SPIFFS.remove(temporary);
  File file = SPIFFS.open(temporary, FILE_WRITE);
  if (!file) return false;
  const size_t storedNameLength = nameLength(macro.name);
  const StoredHeader header{kFileMagic, kFileVersion, macro.stepCount,
                            macro.loopGapMs, macro.color,
                            {static_cast<uint8_t>(storedNameLength), 0, 0},
                            fileChecksumFor(macro)};
  bool success = file.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) == sizeof(header);
  success = success && file.write(reinterpret_cast<const uint8_t*>(macro.name),
                                  storedNameLength) == storedNameLength;
  for (size_t index = 0; success && index < macro.stepCount; ++index) {
    const StoredStep step = storedStep(macro.steps[index]);
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

bool MacroSlotStorage::restore(uint8_t slot) {
  if (!ready_ || slot >= kMacroSlotCount) return false;
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

bool MacroSlotStorage::imageInfo(uint8_t slot, uint32_t* bytes) const {
  if (!ready_ || slot >= kMacroSlotCount || bytes == nullptr) return false;
  for (const char* extension : {"img", "ibk"}) {
    char path[40] = {};
    slotPath(slot, extension, path, sizeof(path));
    File file = SPIFFS.open(path, FILE_READ);
    if (!file) continue;
    ImageHeader header{};
    if (file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) ==
            sizeof(header) && header.magic == kImageMagic &&
        header.version == 1 && header.bytes > 0 &&
        header.bytes <= kMaxSlotImageBytes &&
        file.size() == sizeof(header) + header.bytes) {
      *bytes = header.bytes;
      return true;
    }
  }
  return false;
}

bool MacroSlotStorage::beginImage(uint8_t slot, uint32_t bytes,
                                  uint32_t checksum) {
  if (!ready_ || slot >= kMacroSlotCount || bytes == 0 ||
      bytes > kMaxSlotImageBytes) return false;
  if (ImageUploadActive) abortImage();
  char path[40] = {};
  slotPath(slot, "itmp", path, sizeof(path));
  SPIFFS.remove(path);
  ImageUploadFile = SPIFFS.open(path, FILE_WRITE);
  if (!ImageUploadFile) return false;
  const ImageHeader header{kImageMagic, 1, bytes, checksum};
  if (ImageUploadFile.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) != sizeof(header)) {
    ImageUploadFile.close();
    SPIFFS.remove(path);
    return false;
  }
  ImageUploadActive = true;
  ImageUploadSlot = slot;
  ImageUploadExpectedBytes = bytes;
  ImageUploadChecksum = checksum;
  ImageUploadReceived = 0;
  ImageUploadCurrentChecksum = kChecksumOffset;
  return true;
}

bool MacroSlotStorage::appendImageHex(const char* hex) {
  if (!ImageUploadActive || hex == nullptr) return false;
  const size_t length = strlen(hex);
  if (length == 0 || length > 192 || length % 2 != 0 ||
      ImageUploadReceived + length / 2 > ImageUploadExpectedBytes) return false;
  uint8_t decoded[96] = {};
  for (size_t index = 0; index < length / 2; ++index) {
    const int high = hexNibble(hex[index * 2]);
    const int low = hexNibble(hex[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    decoded[index] = static_cast<uint8_t>((high << 4) | low);
  }
  if (ImageUploadFile.write(decoded, length / 2) != length / 2) return false;
  for (size_t index = 0; index < length / 2; ++index)
    ImageUploadCurrentChecksum = checksumByte(ImageUploadCurrentChecksum,
                                               decoded[index]);
  ImageUploadReceived += length / 2;
  return true;
}

void MacroSlotStorage::abortImage() {
  if (!ImageUploadActive) return;
  ImageUploadFile.close();
  char path[40] = {};
  slotPath(ImageUploadSlot, "itmp", path, sizeof(path));
  SPIFFS.remove(path);
  ImageUploadActive = false;
}

bool MacroSlotStorage::commitImage() {
  if (!ImageUploadActive || ImageUploadReceived != ImageUploadExpectedBytes ||
      ImageUploadCurrentChecksum != ImageUploadChecksum) return false;
  const uint8_t slot = ImageUploadSlot;
  ImageUploadFile.flush();
  ImageUploadFile.close();
  ImageUploadActive = false;
  char primary[40] = {}, backup[40] = {}, temporary[40] = {};
  slotPath(slot, "img", primary, sizeof(primary));
  slotPath(slot, "ibk", backup, sizeof(backup));
  slotPath(slot, "itmp", temporary, sizeof(temporary));
  File verified = SPIFFS.open(temporary, FILE_READ);
  ImageHeader header{};
  if (!verified || verified.readBytes(reinterpret_cast<char*>(&header),
                                     sizeof(header)) != sizeof(header) ||
      header.magic != kImageMagic || header.version != 1 ||
      header.bytes != ImageUploadExpectedBytes ||
      header.checksum != ImageUploadChecksum ||
      verified.size() != sizeof(header) + header.bytes) {
    SPIFFS.remove(temporary);
    return false;
  }
  uint32_t checksum = kChecksumOffset;
  while (verified.available()) checksum = checksumByte(checksum, verified.read());
  verified.close();
  if (checksum != ImageUploadChecksum) {
    SPIFFS.remove(temporary);
    return false;
  }
  if (SPIFFS.exists(primary)) {
    SPIFFS.remove(backup);
    if (!SPIFFS.rename(primary, backup)) return false;
  }
  if (!SPIFFS.rename(temporary, primary)) {
    if (SPIFFS.exists(backup)) SPIFFS.rename(backup, primary);
    return false;
  }
  return true;
}

bool MacroSlotStorage::readImageChunk(uint8_t slot, uint32_t offset, char* hex,
                                      size_t hexCapacity,
                                      size_t* bytesRead) const {
  uint32_t bytes = 0;
  if (!imageInfo(slot, &bytes) || offset >= bytes || hex == nullptr ||
      bytesRead == nullptr || hexCapacity < 3) return false;
  char path[40] = {};
  slotPath(slot, "img", path, sizeof(path));
  File file = SPIFFS.open(path, FILE_READ);
  ImageHeader header{};
  if (!file || file.readBytes(reinterpret_cast<char*>(&header),
                               sizeof(header)) != sizeof(header) ||
      header.magic != kImageMagic || header.version != 1 ||
      header.bytes != bytes || file.size() != sizeof(header) + bytes) {
    slotPath(slot, "ibk", path, sizeof(path));
    file = SPIFFS.open(path, FILE_READ);
  }
  if (!file || !file.seek(sizeof(ImageHeader) + offset)) return false;
  const size_t amount = min(static_cast<size_t>(bytes - offset),
                            min(static_cast<size_t>(96), (hexCapacity - 1) / 2));
  constexpr char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < amount; ++index) {
    const int byte = file.read();
    if (byte < 0) return false;
    hex[index * 2] = digits[byte >> 4];
    hex[index * 2 + 1] = digits[byte & 15];
  }
  hex[amount * 2] = '\0';
  *bytesRead = amount;
  return true;
}

bool MacroSlotStorage::removeImage(uint8_t slot) {
  if (!ready_ || slot >= kMacroSlotCount || ImageUploadActive) return false;
  bool success = true;
  for (const char* extension : {"img", "ibk", "itmp"}) {
    char path[40] = {};
    slotPath(slot, extension, path, sizeof(path));
    if (SPIFFS.exists(path)) success &= SPIFFS.remove(path);
  }
  return success;
}

size_t MacroSlotStorage::slotImageUsedBytes(uint8_t slot) const {
  if (!ready_ || slot >= kMacroSlotCount) return 0;
  size_t bytes = 0;
  for (const char* extension : {"img", "ibk", "itmp"}) {
    char path[40] = {};
    slotPath(slot, extension, path, sizeof(path));
    bytes += fileSizeIfPresent(path);
  }
  return bytes;
}

size_t MacroSlotStorage::slotUsedBytes(uint8_t slot) const {
  if (!ready_ || slot >= kMacroSlotCount) return 0;
  size_t bytes = slotImageUsedBytes(slot);
  for (const char* extension : {"bin", "bak", "tmp"}) {
    char path[40] = {};
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
