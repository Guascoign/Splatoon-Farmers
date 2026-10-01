#pragma once

#include <stddef.h>
#include <stdint.h>

#include "ControllerReport.h"

namespace farmers {

struct MacroStep {
  uint32_t durationMs;
  ControllerReport report;
};

enum class MacroPhase : uint8_t {
  kIdle,
  kSteps,
  kLoopGap,
};

class MacroEngine {
 public:
  MacroEngine(const MacroStep* steps, size_t stepCount, uint32_t loopGapMs,
              bool repeat);

  void configure(const MacroStep* steps, size_t stepCount, uint32_t loopGapMs,
                 bool repeat);
  void start(uint32_t nowMs);
  void stop();
  bool pause(uint32_t nowMs);
  bool resume(uint32_t nowMs);
  void tick(uint32_t nowMs);

  bool running() const;
  bool paused() const;
  MacroPhase phase() const;
  size_t stepIndex() const;
  uint32_t cycleCount() const;
  const ControllerReport& report() const;
  bool consumeReportChanged();

 private:
  uint32_t phaseDurationMs() const;
  void advancePhase();
  void setReport(const ControllerReport& report);

  const MacroStep* steps_;
  size_t stepCount_;
  uint32_t loopGapMs_;
  bool repeat_;

  bool running_;
  bool paused_;
  MacroPhase phase_;
  size_t stepIndex_;
  uint32_t phaseStartedAtMs_;
  uint32_t pausedAtMs_;
  uint32_t cycleCount_;
  ControllerReport report_;
  bool reportChanged_;
};

}  // namespace farmers
