#pragma once

#include <Preferences.h>
#include <stddef.h>
#include <stdint.h>
#include <vector>

namespace farmers {

struct TaskEntry {
  uint32_t slot = 0;
  uint32_t repeats = 1;
};

// Task records are variable length. The vector is serialized to its own
// SPIFFS file, so creating a task is limited by remaining board storage rather
// than a compile-time entry count.
struct TaskList {
  uint32_t id = 0;
  uint8_t version = 2;
  char name[49] = {};
  std::vector<TaskEntry> entries;
  uint32_t updatedAt = 0;
  uint64_t shareId = 0;
};

struct DeviceSettings {
  uint8_t version = 1;
  uint8_t wifiEnabled = 1;
  uint8_t brightness = 36;
  char ssid[33] = "ESP32-S3-Switch";
  char password[64] = {};
};

struct SlotCycleStat {
  uint32_t slot = 0;
  uint64_t cycles = 0;
};

struct TaskCycleStat {
  uint32_t task = 0;
  uint32_t cycles = 0;
};

struct RunStats {
  uint8_t version = 2;
  uint32_t recentSlot = UINT32_MAX;
  uint32_t recentTask = UINT32_MAX;
  uint64_t totalRunMs = 0;
  std::vector<SlotCycleStat> slotCycles;
  std::vector<TaskCycleStat> taskCycles;
};

bool validTaskList(const TaskList& task);
bool validSettings(const DeviceSettings& settings);

class BoardState {
 public:
  bool begin();
  const DeviceSettings& settings() const { return settings_; }
  const RunStats& stats() const { return stats_; }
  bool saveSettings(const DeviceSettings& settings);
  bool loadTask(uint32_t index, TaskList* task);
  bool saveTask(uint32_t index, const TaskList& task);
  bool deleteTask(uint32_t index);
  bool listTasks(std::vector<TaskList>* tasks);
  uint32_t nextTask() const;
  void addRuntime(uint32_t milliseconds) { stats_.totalRunMs += milliseconds; }
  void recordSlotCycle(uint32_t slot);
  void recordTaskCycle(uint32_t task);
  void setRecentSlot(uint32_t slot) { stats_.recentSlot = slot; }
  void setRecentTask(uint32_t task) { stats_.recentTask = task; }
  bool persistStats();

 private:
  bool readTaskFile(const char* path, uint32_t id, TaskList* task) const;
  bool loadStatsFile();
  size_t taskUsedBytes(uint32_t id) const;
  bool filesystemReady_ = false;
  bool legacyTasksChecked_ = false;
  Preferences preferences_;
  bool ready_ = false;
  DeviceSettings settings_{};
  RunStats stats_{};
};

}  // namespace farmers
