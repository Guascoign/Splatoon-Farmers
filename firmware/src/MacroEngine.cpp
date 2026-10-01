#include "MacroEngine.h"

namespace farmers {

MacroEngine::MacroEngine(const MacroStep* steps, size_t stepCount,
                         uint32_t loopGapMs, bool repeat)
    : steps_(steps),
      stepCount_(stepCount),
      loopGapMs_(loopGapMs),
      repeat_(repeat),
      running_(false),
      phase_(MacroPhase::kIdle),
      stepIndex_(0),
      phaseStartedAtMs_(0),
      cycleCount_(0),
      report_(kNeutralReport),
      reportChanged_(false) {}

void MacroEngine::configure(const MacroStep* steps, size_t stepCount,
                            uint32_t loopGapMs, bool repeat) {
  stop();
  steps_ = steps;
  stepCount_ = stepCount;
  loopGapMs_ = loopGapMs;
  repeat_ = repeat;
}

void MacroEngine::start(uint32_t nowMs) {
  cycleCount_ = 0;
  stepIndex_ = 0;
  phaseStartedAtMs_ = nowMs;

  if (steps_ == nullptr || stepCount_ == 0) {
    running_ = false;
    phase_ = MacroPhase::kIdle;
    setReport(kNeutralReport);
    return;
  }

  running_ = true;
  phase_ = MacroPhase::kSteps;
  setReport(steps_[0].report);
  // A START must always produce a fresh HID report, even if the first step is
  // neutral or matches the previous manual report.
  reportChanged_ = true;
}

void MacroEngine::stop() {
  running_ = false;
  phase_ = MacroPhase::kIdle;
  stepIndex_ = 0;
  setReport(kNeutralReport);
  // Likewise, STOP always sends a neutral report to release every control.
  reportChanged_ = true;
}

void MacroEngine::tick(uint32_t nowMs) {
  if (!running_) {
    return;
  }

  // A Wi-Fi request can stall one loop iteration. Advance only one phase per
  // tick so a delayed loop cannot skip a short button press without sending
  // its HID report.
  if (static_cast<uint32_t>(nowMs - phaseStartedAtMs_) >= phaseDurationMs()) {
    phaseStartedAtMs_ = nowMs;
    advancePhase();
  }
}

bool MacroEngine::running() const { return running_; }

MacroPhase MacroEngine::phase() const { return phase_; }

size_t MacroEngine::stepIndex() const { return stepIndex_; }

uint32_t MacroEngine::cycleCount() const { return cycleCount_; }

const ControllerReport& MacroEngine::report() const { return report_; }

bool MacroEngine::consumeReportChanged() {
  const bool changed = reportChanged_;
  reportChanged_ = false;
  return changed;
}

uint32_t MacroEngine::phaseDurationMs() const {
  if (phase_ == MacroPhase::kSteps) {
    return steps_[stepIndex_].durationMs;
  }
  if (phase_ == MacroPhase::kLoopGap) {
    return loopGapMs_;
  }
  return 1;
}

void MacroEngine::advancePhase() {
  if (phase_ == MacroPhase::kLoopGap) {
    phase_ = MacroPhase::kSteps;
    stepIndex_ = 0;
    setReport(steps_[0].report);
    return;
  }

  if (stepIndex_ + 1 < stepCount_) {
    ++stepIndex_;
    setReport(steps_[stepIndex_].report);
    return;
  }

  ++cycleCount_;
  if (!repeat_) {
    running_ = false;
    phase_ = MacroPhase::kIdle;
    stepIndex_ = 0;
    setReport(kNeutralReport);
    return;
  }

  if (loopGapMs_ > 0) {
    phase_ = MacroPhase::kLoopGap;
    stepIndex_ = 0;
    setReport(kNeutralReport);
    return;
  }

  phase_ = MacroPhase::kSteps;
  stepIndex_ = 0;
  setReport(steps_[0].report);
}

void MacroEngine::setReport(const ControllerReport& report) {
  if (report_ != report) {
    report_ = report;
    reportChanged_ = true;
  }
}

}  // namespace farmers
