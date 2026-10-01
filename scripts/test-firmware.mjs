import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "splatoon-farmers-"));
const executable = join(directory, process.platform === "win32" ? "macro-test.exe" : "macro-test");
const sources = [
  "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
  "-I", "firmware/include", "firmware/src/MacroEngine.cpp",
  "tests/firmware/test_macro_engine.cpp", "-o", executable,
];

try {
  const compile = spawnSync("c++", sources, { stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    const run = spawnSync(executable, [], { stdio: "inherit" });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
