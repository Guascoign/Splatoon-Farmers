#include "BoardState.h"

#include "MacroSlotStorage.h"

#include <Arduino.h>
#include <SPIFFS.h>
#include <algorithm>
#include <stdio.h>
#include <string.h>

namespace farmers {
namespace {

constexpr uint32_t kTaskFileMagic = 0x31544653u;
constexpr uint16_t kTaskFileVersion = 2;
// Only used to migrate records written by the old fixed 32-task NVS layout.
// New task records are discovered from SPIFFS and have no count limit.
constexpr uint32_t kLegacyTaskListCount = 32;
constexpr uint32_t kStatsFileMagic = 0x31534653u;
constexpr uint16_t kStatsFileVersion = 1;
constexpr char kStatsFile[] = "/material-farm-stats.bin";
constexpr char kStatsBackupFile[] = "/material-farm-stats.bak";
constexpr char kStatsTemporaryFile[] = "/material-farm-stats.tmp";

constexpr size_t kLegacyStatsSlotCount = 64;
constexpr size_t kLegacyStatsTaskCount = 32;

#pragma pack(push, 1)
struct TaskFileHeader {
  uint32_t magic;
  uint16_t version;
  uint16_t nameBytes;
  uint32_t entryCount;
  uint32_t updatedAt;
  uint64_t shareId;
};

struct TaskFileEntry {
  uint32_t slot;
  uint32_t repeats;
};

struct StatsFileHeader {
  uint32_t magic;
  uint16_t version;
  uint16_t reserved;
  uint32_t slotCount;
  uint32_t taskCount;
  uint64_t totalRunMs;
  uint32_t recentSlot;
  uint32_t recentTask;
};

struct StatsSlotEntry {
  uint32_t slot;
  uint64_t cycles;
};

struct StatsTaskEntry {
  uint32_t task;
  uint32_t cycles;
};

#pragma pack(pop)

struct LegacyTaskEntry {
  uint8_t slot;
  uint16_t repeats;
};

// Layout retained solely so an upgrade can read the previous NVS records.
// New TaskList records use the variable-length SPIFFS format above.
struct LegacyTaskList {
  uint8_t version = 1;
  char name[49] = {};
  uint8_t count = 0;
  LegacyTaskEntry entries[8] = {};
};

// The old statistics blob was bounded by the old slot/task counts. It is read
// once during upgrade and rewritten to the variable-length SPIFFS format.
struct LegacyRunStats {
  uint8_t version = 1;
  uint32_t recentSlot = UINT32_MAX;
  uint32_t recentTask = UINT32_MAX;
  uint64_t totalRunMs = 0;
  uint64_t slotCycles[kLegacyStatsSlotCount] = {};
  uint32_t taskCycles[kLegacyStatsTaskCount] = {};
};

static_assert(sizeof(TaskFileHeader) == 24, "Unexpected task file header size");
static_assert(sizeof(TaskFileEntry) == 8, "Unexpected task file entry size");
static_assert(sizeof(StatsFileHeader) == 32, "Unexpected stats header size");
static_assert(sizeof(StatsSlotEntry) == 12, "Unexpected stats slot size");
static_assert(sizeof(StatsTaskEntry) == 8, "Unexpected stats task size");

size_t boundedLength(const char* value, size_t limit) {
  size_t length = 0;
  while (length <= limit && value[length] != '\0') ++length;
  return length;
}

void taskPath(uint32_t id, const char* extension, char* path, size_t size) {
  snprintf(path, size, "/material-farm-task-%lu.%s",
           static_cast<unsigned long>(id), extension);
}

size_t fileSizeIfPresent(const char* path) {
  File file = SPIFFS.open(path, FILE_READ);
  return file ? file.size() : 0;
}

bool isTaskExtension(const char* extension) {
  return strcmp(extension, "bin") == 0 || strcmp(extension, "bak") == 0 ||
         strcmp(extension, "tmp") == 0;
}

}  // namespace

bool validTaskList(const TaskList& task) {
  const size_t nameBytes = boundedLength(task.name, 48);
  if (task.version != 2 || nameBytes == 0 || nameBytes > 48 ||
      task.entries.empty()) return false;
  for (size_t index = 0; index < nameBytes; ++index) {
    const uint8_t byte = static_cast<uint8_t>(task.name[index]);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  for (const TaskEntry& entry : task.entries) {
    if (entry.repeats == 0 || entry.repeats > 9999) return false;
  }
  return true;
}

bool validSettings(const DeviceSettings& settings) {
  const size_t ssidBytes = boundedLength(settings.ssid, 32);
  const size_t passwordBytes = boundedLength(settings.password, 63);
  for (size_t index = 0; index < ssidBytes && index <= 32; ++index) {
    const uint8_t byte = static_cast<uint8_t>(settings.ssid[index]);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return settings.version == 1 && settings.wifiEnabled <= 1 &&
         ssidBytes >= 1 && ssidBytes <= 32 &&
         (passwordBytes == 0 || (passwordBytes >= 8 && passwordBytes <= 63));
}

bool BoardState::begin() {
  ready_ = preferences_.begin("farmers", false);
  filesystemReady_ = SPIFFS.begin(false);
  if (!ready_) return false;
  legacyTasksChecked_ = preferences_.getBool("tasksMigrated", false);
  DeviceSettings storedSettings{};
  if (preferences_.getBytesLength("settings") == sizeof(storedSettings) &&
      preferences_.getBytes("settings", &storedSettings,
                            sizeof(storedSettings)) == sizeof(storedSettings) &&
      validSettings(storedSettings)) settings_ = storedSettings;
  stats_ = {};
  stats_.version = 2;
  if (!loadStatsFile()) {
    LegacyRunStats legacy{};
    if (preferences_.getBytesLength("stats") == sizeof(legacy) &&
        preferences_.getBytes("stats", &legacy, sizeof(legacy)) == sizeof(legacy) &&
        legacy.version == 1) {
      stats_.recentSlot = legacy.recentSlot;
      stats_.recentTask = legacy.recentTask;
      stats_.totalRunMs = legacy.totalRunMs;
      for (size_t index = 0; index < kLegacyStatsSlotCount; ++index) {
        if (legacy.slotCycles[index] != 0)
          stats_.slotCycles.push_back({static_cast<uint32_t>(index),
                                       legacy.slotCycles[index]});
      }
      for (size_t index = 0; index < kLegacyStatsTaskCount; ++index) {
        if (legacy.taskCycles[index] != 0)
          stats_.taskCycles.push_back({static_cast<uint32_t>(index),
                                       legacy.taskCycles[index]});
      }
      // The next normal persist migrates this bounded legacy blob to the
      // variable-length file. Keeping it until then is safe for power loss.
    }
  }
  return true;
}

bool BoardState::saveSettings(const DeviceSettings& settings) {
  if (!ready_ || !validSettings(settings) ||
      preferences_.putBytes("settings", &settings,
                            sizeof(settings)) != sizeof(settings)) return false;
  settings_ = settings;
  return true;
}

bool BoardState::loadStatsFile() {
  if (!filesystemReady_) return false;
  const char* paths[] = {kStatsFile, kStatsBackupFile};
  for (const char* path : paths) {
    File file = SPIFFS.open(path, FILE_READ);
    if (!file) continue;
    StatsFileHeader header{};
    const size_t fileBytes = file.size();
    const bool headerValid =
        file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) == sizeof(header) &&
        header.magic == kStatsFileMagic && header.version == kStatsFileVersion;
    size_t remaining = fileBytes >= sizeof(header) ? fileBytes - sizeof(header) : 0;
    bool sizeValid = headerValid && fileBytes >= sizeof(header) &&
                     header.slotCount <= remaining / sizeof(StatsSlotEntry);
    if (sizeValid) remaining -= static_cast<size_t>(header.slotCount) * sizeof(StatsSlotEntry);
    sizeValid = sizeValid && header.taskCount <= remaining / sizeof(StatsTaskEntry);
    if (sizeValid) remaining -= static_cast<size_t>(header.taskCount) * sizeof(StatsTaskEntry);
    sizeValid = sizeValid && remaining == 0;
    const uint64_t entries = static_cast<uint64_t>(header.slotCount) + header.taskCount;
    const bool memoryAvailable = entries <= ESP.getFreeHeap() /
        (sizeof(StatsSlotEntry) < sizeof(StatsTaskEntry) ? sizeof(StatsSlotEntry) : sizeof(StatsTaskEntry));
    if (!sizeValid || !memoryAvailable) {
      file.close();
      continue;
    }
    RunStats loaded{};
    loaded.version = 2;
    loaded.recentSlot = header.recentSlot;
    loaded.recentTask = header.recentTask;
    loaded.totalRunMs = header.totalRunMs;
    loaded.slotCycles.reserve(header.slotCount);
    loaded.taskCycles.reserve(header.taskCount);
    bool valid = true;
    for (uint32_t index = 0; index < header.slotCount && valid; ++index) {
      StatsSlotEntry entry{};
      valid = file.readBytes(reinterpret_cast<char*>(&entry), sizeof(entry)) == sizeof(entry);
      if (valid && entry.cycles != 0) loaded.slotCycles.push_back({entry.slot, entry.cycles});
    }
    for (uint32_t index = 0; index < header.taskCount && valid; ++index) {
      StatsTaskEntry entry{};
      valid = file.readBytes(reinterpret_cast<char*>(&entry), sizeof(entry)) == sizeof(entry);
      if (valid && entry.cycles != 0) loaded.taskCycles.push_back({entry.task, entry.cycles});
    }
    file.close();
    if (valid) {
      stats_ = std::move(loaded);
      return true;
    }
  }
  return false;
}

bool BoardState::readTaskFile(const char* path, uint32_t id, TaskList* task) const {
  if (!filesystemReady_ || path == nullptr || task == nullptr) return false;
  File file = SPIFFS.open(path, FILE_READ);
  if (!file) return false;
  TaskFileHeader header{};
  if (file.readBytes(reinterpret_cast<char*>(&header), sizeof(header)) != sizeof(header) ||
      header.magic != kTaskFileMagic || header.version != kTaskFileVersion ||
      header.nameBytes == 0 || header.nameBytes > 48 || header.entryCount == 0 ||
      file.size() != sizeof(header) + header.nameBytes +
          header.entryCount * sizeof(TaskFileEntry)) return false;
  // Task entries are variable length. Reject a record only when the current
  // free heap cannot hold its decoded vector; the storage format itself has no
  // compile-time entry-count ceiling.
  if (header.entryCount > ESP.getFreeHeap() / sizeof(TaskEntry)) return false;
  TaskList candidate{};
  candidate.id = id;
  candidate.version = 2;
  candidate.updatedAt = header.updatedAt;
  candidate.shareId = header.shareId;
  if (file.readBytes(candidate.name, header.nameBytes) != header.nameBytes) return false;
  candidate.name[header.nameBytes] = '\0';
  candidate.entries.reserve(header.entryCount);
  for (uint32_t index = 0; index < header.entryCount; ++index) {
    TaskFileEntry stored{};
    if (file.readBytes(reinterpret_cast<char*>(&stored), sizeof(stored)) != sizeof(stored))
      return false;
    candidate.entries.push_back({stored.slot, stored.repeats});
  }
  if (!validTaskList(candidate)) return false;
  *task = std::move(candidate);
  return true;
}

size_t BoardState::taskUsedBytes(uint32_t id) const {
  if (!filesystemReady_) return 0;
  size_t bytes = 0;
  for (const char* extension : {"bin", "bak", "tmp"}) {
    char path[64] = {};
    taskPath(id, extension, path, sizeof(path));
    bytes += fileSizeIfPresent(path);
  }
  return bytes;
}

bool BoardState::loadTask(uint32_t index, TaskList* task) {
  if (task == nullptr || index == UINT32_MAX) return false;
  char path[64] = {};
  taskPath(index, "bin", path, sizeof(path));
  if (readTaskFile(path, index, task)) return true;
  taskPath(index, "bak", path, sizeof(path));
  if (readTaskFile(path, index, task)) return true;

  // Migrate the previous fixed NVS records on first access. No formatting is
  // performed; a failed migration simply leaves the legacy record untouched.
  if (!ready_) return false;
  char key[16] = {};
  snprintf(key, sizeof(key), "task%lu", static_cast<unsigned long>(index));
  LegacyTaskList legacy{};
  if (preferences_.getBytesLength(key) != sizeof(legacy) ||
      preferences_.getBytes(key, &legacy, sizeof(legacy)) != sizeof(legacy) ||
      legacy.version != 1 || legacy.count == 0 || legacy.count > 8) return false;
  TaskList migrated{};
  migrated.id = index;
  migrated.version = 2;
  memcpy(migrated.name, legacy.name, sizeof(legacy.name));
  migrated.entries.reserve(legacy.count);
  for (uint8_t item = 0; item < legacy.count; ++item)
    migrated.entries.push_back({legacy.entries[item].slot,
                                legacy.entries[item].repeats});
  if (!validTaskList(migrated) || !saveTask(index, migrated)) return false;
  preferences_.remove(key);
  *task = std::move(migrated);
  return true;
}

bool BoardState::saveTask(uint32_t index, const TaskList& task) {
  if (!filesystemReady_ || index == UINT32_MAX || !validTaskList(task)) return false;
  const size_t nameBytes = boundedLength(task.name, 48);
  char primary[64] = {}, backup[64] = {}, temporary[64] = {};
  taskPath(index, "bin", primary, sizeof(primary));
  taskPath(index, "bak", backup, sizeof(backup));
  taskPath(index, "tmp", temporary, sizeof(temporary));
  SPIFFS.remove(temporary);
  File file = SPIFFS.open(temporary, FILE_WRITE);
  if (!file) return false;
  const TaskFileHeader header{kTaskFileMagic, kTaskFileVersion,
                              static_cast<uint16_t>(nameBytes),
                              static_cast<uint32_t>(task.entries.size()),
                              task.updatedAt, task.shareId};
  bool success = file.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) == sizeof(header);
  success = success && file.write(reinterpret_cast<const uint8_t*>(task.name),
                                  nameBytes) == nameBytes;
  for (const TaskEntry& entry : task.entries) {
    const TaskFileEntry stored{entry.slot, entry.repeats};
    success = success && file.write(reinterpret_cast<const uint8_t*>(&stored),
                                    sizeof(stored)) == sizeof(stored);
  }
  file.flush();
  file.close();
  TaskList verified{};
  const bool valid = success && readTaskFile(temporary, index, &verified);
  const size_t previousBytes = taskUsedBytes(index);
  const size_t projected = SPIFFS.usedBytes() >= previousBytes
      ? SPIFFS.usedBytes() - previousBytes + fileSizeIfPresent(temporary)
      : SPIFFS.usedBytes() + fileSizeIfPresent(temporary);
  if (!valid || projected > (SPIFFS.totalBytes() * 90) / 100) {
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

bool BoardState::deleteTask(uint32_t index) {
  if (!filesystemReady_ || index == UINT32_MAX) return false;
  bool success = true;
  for (const char* extension : {"bin", "bak", "tmp"}) {
    char path[64] = {};
    taskPath(index, extension, path, sizeof(path));
    if (SPIFFS.exists(path)) success &= SPIFFS.remove(path);
  }
  if (ready_) {
    char key[16] = {};
    snprintf(key, sizeof(key), "task%lu", static_cast<unsigned long>(index));
    if (preferences_.isKey(key)) success &= preferences_.remove(key);
  }
  return success;
}

bool BoardState::listTasks(std::vector<TaskList>* tasks) {
  if (!filesystemReady_ || tasks == nullptr) return false;
  tasks->clear();
  // Scan the old NVS layout once, then remember completion across boots.
  // Rechecking all 32 keys on every TASK_LIST made connection take many
  // seconds even after migration had finished.
  if (!legacyTasksChecked_ && ready_) {
    bool migratedAll = true;
    for (uint32_t index = 0; index < kLegacyTaskListCount; ++index) {
      char key[16] = {};
      snprintf(key, sizeof(key), "task%lu", static_cast<unsigned long>(index));
      if (!preferences_.isKey(key)) continue;
      TaskList migrated{};
      if (!loadTask(index, &migrated) ||
          (preferences_.isKey(key) && !preferences_.remove(key)))
        migratedAll = false;
    }
    legacyTasksChecked_ = true;
    if (migratedAll) preferences_.putBool("tasksMigrated", true);
  }
  std::vector<uint32_t> ids;
  File root = SPIFFS.open("/");
  if (!root) return false;
  File file = root.openNextFile();
  while (file) {
    unsigned long id = 0;
    char extension[8] = {};
    const char* name = file.name();
    if (name[0] == '/') ++name;
    if (sscanf(name, "material-farm-task-%lu.%7s", &id, extension) == 2 &&
        id != ULONG_MAX && isTaskExtension(extension)) {
      const uint32_t taskId = static_cast<uint32_t>(id);
      if (std::find(ids.begin(), ids.end(), taskId) == ids.end()) ids.push_back(taskId);
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  std::sort(ids.begin(), ids.end());
  for (uint32_t id : ids) {
    TaskList task{};
    if (loadTask(id, &task)) tasks->push_back(std::move(task));
  }
  return true;
}

uint32_t BoardState::nextTask() const {
  if (!filesystemReady_) return 0;
  std::vector<TaskList> tasks;
  BoardState* self = const_cast<BoardState*>(this);
  if (!self->listTasks(&tasks)) return 0;
  uint32_t candidate = 0;
  for (const TaskList& task : tasks) {
    if (task.id < candidate) continue;
    if (task.id > candidate) return candidate;
    if (candidate == UINT32_MAX) return UINT32_MAX;
    ++candidate;
  }
  return candidate;
}

void BoardState::recordSlotCycle(uint32_t slot) {
  auto found = std::find_if(stats_.slotCycles.begin(), stats_.slotCycles.end(),
                            [slot](const SlotCycleStat& entry) {
                              return entry.slot == slot;
                            });
  if (found == stats_.slotCycles.end()) stats_.slotCycles.push_back({slot, 1});
  else ++found->cycles;
}

void BoardState::recordTaskCycle(uint32_t task) {
  auto found = std::find_if(stats_.taskCycles.begin(), stats_.taskCycles.end(),
                            [task](const TaskCycleStat& entry) {
                              return entry.task == task;
                            });
  if (found == stats_.taskCycles.end()) stats_.taskCycles.push_back({task, 1});
  else ++found->cycles;
}

bool BoardState::persistStats() {
  if (!ready_ || !filesystemReady_) return false;
  char temporary[48] = {};
  snprintf(temporary, sizeof(temporary), "%s", kStatsTemporaryFile);
  SPIFFS.remove(temporary);
  File file = SPIFFS.open(temporary, FILE_WRITE);
  if (!file) return false;
  const StatsFileHeader header{
      kStatsFileMagic, kStatsFileVersion, 0,
      static_cast<uint32_t>(stats_.slotCycles.size()),
      static_cast<uint32_t>(stats_.taskCycles.size()), stats_.totalRunMs,
      stats_.recentSlot, stats_.recentTask};
  bool success = file.write(reinterpret_cast<const uint8_t*>(&header),
                            sizeof(header)) == sizeof(header);
  for (const SlotCycleStat& entry : stats_.slotCycles) {
    const StatsSlotEntry stored{entry.slot, entry.cycles};
    success = success && file.write(reinterpret_cast<const uint8_t*>(&stored),
                                    sizeof(stored)) == sizeof(stored);
  }
  for (const TaskCycleStat& entry : stats_.taskCycles) {
    const StatsTaskEntry stored{entry.task, entry.cycles};
    success = success && file.write(reinterpret_cast<const uint8_t*>(&stored),
                                    sizeof(stored)) == sizeof(stored);
  }
  file.flush();
  file.close();
  const size_t previous = fileSizeIfPresent(kStatsFile) +
                          fileSizeIfPresent(kStatsBackupFile) +
                          fileSizeIfPresent(kStatsTemporaryFile);
  const size_t replacement = fileSizeIfPresent(kStatsTemporaryFile);
  const size_t projected = SPIFFS.usedBytes() >= previous
      ? SPIFFS.usedBytes() - previous + replacement
      : SPIFFS.usedBytes() + replacement;
  if (!success || projected > (SPIFFS.totalBytes() * 90) / 100) {
    SPIFFS.remove(temporary);
    return false;
  }
  if (SPIFFS.exists(kStatsFile)) {
    SPIFFS.remove(kStatsBackupFile);
    if (!SPIFFS.rename(kStatsFile, kStatsBackupFile)) return false;
  }
  if (!SPIFFS.rename(temporary, kStatsFile)) {
    if (SPIFFS.exists(kStatsBackupFile)) SPIFFS.rename(kStatsBackupFile, kStatsFile);
    return false;
  }
  preferences_.remove("stats");
  return true;
}

}  // namespace farmers
