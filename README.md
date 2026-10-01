# Splatoon Farmers

> [!WARNING]
> This is not a plug-and-play project. Before running the automated routine,
> you must first beat the game, manually farm enough materials and crystals, and
> use them to complete the required initial gear setup. The script assumes that setup
> has already been finished and will not perform it for you.

An unofficial ESP32-S3 wired controller and browser console for material
farming in [Splatoon Raiders](https://www.nintendo.com/us/store/products/splatoon-raiders-switch-2/).
It is intentionally small: connect the board, open the page, and start the
board-resident routine.

![](./images/banner.png)

Check this video for tutorial: [Bilibili](https://www.bilibili.com/video/BV12P3J6hE4h/)

Required gears described in this video: [Bilibili](https://www.bilibili.com/video/BV1Hp3G6KEfs/)

## What it does

- Emulates a wired Nintendo Switch controller over the ESP32-S3 native USB port.
- Supports macros with a variable number of actions; the practical limit is
  remaining SPIFFS space and runtime heap, not a fixed step count.
- Starts its own `ESP32-S3-Switch` Wi-Fi hotspot by default and serves the
  control page at <http://192.168.9.1> without a computer or internet. The
  hotspot can be disabled or renamed in device settings.
- Continues a running loop if the browser, Wi-Fi, or USB-UART connection drops.
  The console can pause a board routine, resume from the same action and
  remaining delay, or stop it and release all controller inputs.
- Starts, stops, and reports progress through Wi-Fi HTTP or Web Serial.
- Exposes user-created macro slots backed by the board's SPIFFS. Empty slots are hidden and a new slot is offered while the shared macro/task Flash usage stays below 90%; there is no fixed slot-count limit. Saved Flash versions take priority on the next boot.
- Uses the onboard GPIO48 WS2812 to show startup, connection, running macro,
  and controller output states.
- Provides every digital button, D-pad direction, and two draggable analog
  sticks for mouse, touch, and keyboard input on the separate control page.
- On the desktop Web Serial recording page, maps a Windows-paired Xbox Wireless
  or PS5 DualSense controller to the Switch report and records live play into a named draft.
- Stores task lists in the same board Flash quota. Each list can contain as many
  macro entries as the remaining storage and command buffer allow, with per-slot
  repeat counts, and loops independently on the board. There is no fixed task-list
  or eight-entry limit.
- Saves Wi-Fi mode, hotspot credentials, and RGB brightness in NVS; run statistics use a variable-length Flash record so full IDs remain visible.
- Stores macros and task lists in board Flash. Image upload and storage are not supported.

The browser sends only high-level `START`, `PAUSE`, `RESUME`, `STOP`, and status commands during
automatic operation. Timing is owned by the microcontroller, so normal serial
jitter cannot break a sequence halfway through.

## Hardware

The recommended board is an `ESP32-S3-DevKitC-1` with separate native USB and
USB-UART connectors.

| Link | Board connection | Purpose |
| --- | --- | --- |
| Native USB | GPIO19 D- / GPIO20 D+ | Wired controller to the Switch dock |
| Wi-Fi AP | ESP32-S3 radio | Phone browser at `http://192.168.9.1` |
| USB-UART | UART0 through the onboard bridge | Optional browser control from the computer |

Both links can stay connected at the same time. See the
[ESP32-S3-DevKitC-1 user guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html)
for connector placement.

If the board exposes only native USB, connect an external USB-UART adapter:

- GPIO43 / TX0 to adapter RX
- GPIO44 / RX0 to adapter TX
- GND to GND

Do not connect the adapter VCC when the board is already powered from the
Switch. For the strongest protection against host-side reset signals, use only
TX, RX, and GND.

## Build and flash

Install Python 3 and [PlatformIO Core](https://docs.platformio.org/en/latest/core/index.html):

```bash
python3 -m pip install platformio==6.1.19
pio run
```

The default environment targets `ESP32-S3-DevKitC-1-N8`, Arduino-ESP32 2.0.17, and
pins [`switch_ESP32`](https://github.com/esp32beans/switch_ESP32) to a known
working commit. For an ESP32-S3-N16R8 board, use `pio run -e material-farm-n16r8`
and add `-e material-farm-n16r8` to the upload command. The build embeds the
current files under `web/` in firmware Flash. Flash through the board's
USB-UART connector:

```bash
pio run -t upload --upload-port /dev/cu.usbserial-XXXX
```

Use a port such as `COM8` on Windows or `/dev/ttyUSB0` on Linux. After flashing:

1. Connect native USB to the Nintendo Switch dock.
2. On the phone, join the open `ESP32-S3-Switch` Wi-Fi network. Its local
   address is `192.168.9.1`; the phone may say this network has no internet.
3. Open <http://192.168.9.1> in the phone browser. The page connects to the
   board automatically. No local server or Web Serial support is required.

For optional computer control, connect USB-UART and start the local WebUI:

```bash
npm run serve
```

Open <http://localhost:4173> in desktop Chrome or Edge. Web Serial requires a
secure context, so opening `web/index.html` directly is not supported.

## Use

1. On the phone, wait for the board to connect automatically. On a computer,
   select **连接手柄** and choose the DevKitC-1 USB-UART port.
2. Wait for **已连接 · 待命**.
3. Choose a nonempty slot and select **开始刷取**. That slot restarts at step 1
   and loops until stopped.
4. Select **停止** to immediately send a neutral controller report.

### Edit board macros

Open **宏设置** from the top navigation on the onboard page or the desktop
Web Serial page. The slot cards show each user macro's source, action count,
cycle duration, light color, and Flash usage. The bar above them shows total
SPIFFS usage. Open a slot to inspect every action and adjust held buttons,
D-pad, sticks, duration, loop gap, and one of six fixed running colors. Steps
can be added, copied, reordered, or deleted. Name the macro, choose its target
slot, and select **保存到槽位**. Saving is disabled while a routine runs.

**导出 JSON** saves a macro's actions and settings. **宏设置 → 导入 JSON** opens
an unsaved draft for the chosen slot. **设置 → 一键导出全部配置** includes macros,
tasks, and device settings.

User macros use `/material-farm-slot-N.bin` in SPIFFS with a backup record. Each saved macro and task carries an update timestamp and a device-unique share ID.
Older slot files remain readable and are upgraded when saved. **删除** removes the user macro. Firmware never
formats SPIFFS on boot. If mounting fails, no macro can run until storage is
repaired; **初始化宏存储** is offered only in that case and explicitly warns
that formatting erases the entire SPIFFS partition, including data from other
firmware previously used on the board.

### Xbox Wireless or PS5 DualSense on the desktop page

Pair an Xbox Wireless or PS5 DualSense controller with Windows, open the local page in desktop Chrome or
Edge, connect the board's USB-UART port, and press a controller button so the
browser exposes it through the Gamepad API. This requires firmware 1.3.0 or
newer. **开始直通** sends its current buttons,
D-pad, triggers, and sticks to the Switch output; leaving the page, losing focus,
disconnecting the controller, or selecting **停止直通** sends a neutral report when
the serial link remains available. Gamepad reports include a heartbeat; if it
stops for 800 ms, firmware releases the Switch controls. Browser input requires
the computer and page to stay connected. It does not pair the controller
directly to the ESP32-S3.

The left input and right Switch diagrams preview the bindings and live analog
stick positions. Click a key or stick circle on the left, then its destination
on the right to change it. The default follows physical positions: Xbox A →
Switch B, B → A, X → Y, Y → X. Analog sticks can also be swapped or unbound;
L3/R3 stick presses are clickable in the center of each stick and light up when
pressed. The browser switches between separate Xbox and PS5 profiles when the
selected controller changes. Browser-local storage keeps the binding maps on
this PC; both profiles can be exported or imported as JSON.
The Xbox/Home and Share/Capture buttons depend on what the browser exposes.

While pass-through is active, select **开始录制** and play. A held stick position
is merged into one step, while stick motion is sampled at the chosen interval
(80, 220, or 350 ms). **结束录制并预览**
releases the Switch output and opens the recorded steps as an unsaved draft.
You can name it, choose any available slot, and adjust each step, loop gap,
and LED color before selecting **保存到槽位**. A macro can contain as many steps as
the available board storage and runtime memory allow;
the existing Flash macro is untouched until you save.

The status LED is red briefly after power-on. It blinks yellow while no phone
is associated and no active serial command stream is present, then stays yellow
while a phone is connected to the hotspot or the desktop page is polling over
serial. During a run it blinks in the slot's selected color. An active HID
report briefly flashes green. The light uses GPIO48, as on the N16R8 board.

Losing Wi-Fi or USB-UART does not stop an already running routine. Reconnect and
stop it, reset the board, or remove power when you need to end it.

### Task lists and device settings

**任务列表** are saved as individual records in board Flash. Empty records are
hidden, and a new record is offered while the shared Flash quota is below 90%.
Each plan has a name and as many entries as the remaining storage and transport
buffer can hold; each entry names a macro slot and a repeat count from 1 to 9999.
There is no fixed limit of 32 plans or eight entries per plan. From the console, choose a single macro loop or a task list loop. The
console displays both the current macro action and the current task entry,
repeat, completed list loops, and elapsed run time. The task continues without
the browser. Empty macro slots cannot start a task.

**设置** controls whether the board starts its Wi-Fi hotspot, the hotspot name
and password, and RGB LED brightness. The same page shows product version
`V1.0`, total automatic run time, macro and task cycle counts, and the most
recent macro. Turning Wi-Fi off requires a USB-UART connection to turn it back
on. Statistics are saved when a run stops and periodically during long runs.

### Manual controls

The **网页控制** page stops the automatic routine before sending a raw controller
report. Buttons support hold, multi-key combinations, mouse, multitouch, and
keyboard. Its two virtual analog sticks support pointer and touch dragging and
return to center on release. Losing focus or hiding the tab releases all
browser-held inputs.

| Controller | Keyboard | Controller | Keyboard |
| --- | --- | --- | --- |
| X / Y / B / A | I / J / K / L | D-pad | Arrow keys |
| L / R | Q / E | ZL / ZR | 1 / 3 |
| L3 / R3 | Z / X | − / + | − / = |
| Capture / Home | C / H | | |

If USB-UART is physically unplugged while a button is held, the browser cannot
send the final neutral report. Reset the board to release that last state.

## Serial protocol

The USB-UART control link is `921600 baud`, ASCII, one command per line. The
onboard page sends the same commands with `POST /api/command?command=...` and
receives a single response. Both control paths act on the same macro state.
Some USB-UART bridges briefly reset the board when a browser opens the port;
the desktop page waits for startup and retries `HELLO` before showing a
connection error.

| Command | Behavior |
| --- | --- |
| `HELLO` / `INFO` | Return firmware, routine metadata, and current state as JSON |
| `START slot` | Select a saved user slot by ID and run it in a board-resident loop from step 1 |
| `PAUSE` / `RESUME` | Pause a board macro or task with neutral controller output, then continue from the same action and remaining delay |
| `STOP` | Stop, including from a paused routine, and send a fully neutral controller report |
| `STATUS` | Return phase, step, cycle count, and timing |
| `PING` | Return `PONG` |
| `R buttons dpad lx ly rx ry` | Stop the routine and send one complete HID report |
| `G buttons dpad lx ly rx ry` | Stream a Gamepad API report; release to neutral after 800 ms without another `G` |
| `MACRO_LIST` / `MACRO_GET slot` | Read all occupied slot summaries and storage usage (plus the next available ID), or one complete macro |
| `MACRO_BEGIN slot count gap color updatedAt` | Start a staged upload for one slot and record its update time |
| `MACRO_NAME hex` | Set UTF-8 slot name, encoded as hexadecimal bytes (up to 48 bytes) |
| `MACRO_STEP index duration buttons dpad lx ly rx ry` | Set one staged action |
| `MACRO_COMMIT checksum` / `MACRO_ABORT` | Validate and save, or cancel a staged upload |
| `MACRO_RESTORE slot` | Clear that slot's user macro |
| `MACRO_DELETE slot` | Delete that slot's user macro |
| `TASK_LIST` / `TASK_SAVE id nameHex count slot:times,... updatedAt` / `TASK_DELETE id` | Read, save, or remove persistent task lists by ID; the list response includes only occupied records and the next available ID |
| `TASK_START id` | Start a board-resident loop of the selected task list |
| `SETTINGS_GET` / `SETTINGS_SET wifi brightness ssidHex passwordHexOrDash open` | Read or save Wi-Fi and RGB settings |
| `STATS_GET` | Read total automatic run time, per-slot cycle counts, task loops, and recent slot; cycle maps are keyed by the full slot/task ID |
| `MACRO_STORAGE_FORMAT` | Explicitly format SPIFFS only after a mount failure |

The WebUI displays product version `V1.0`.

The raw report command keeps the firmware useful for future computer-loaded
routines without changing the board protocol.

## Development

```bash
npm test
pio run
```

The test suite covers:

- Embedded step count, duration, action boundaries, and compact Flash size
- Loop-gap boundaries, stop neutralization, and `millis()` wraparound
- Status parsing and the simulated serial transport
- All 14 button bits, cardinal/diagonal D-pad input, keyboard mapping, and
  multi-source press/release behavior

Project layout:

- `firmware/include/MaterialFarmMacro.h` — board-resident routine
- `firmware/src/MacroEngine.cpp` — non-blocking loop engine
- `firmware/src/MacroSlotStorage.cpp` — checked SPIFFS macro slots
- `firmware/src/BoardState.cpp` — SPIFFS task records, NVS device settings, and run statistics
- `firmware/src/StatusLed.cpp` — nonblocking GPIO48 RGB status light
- `firmware/src/main.cpp` — USB HID, serial/HTTP protocol, Wi-Fi, and main loop
- `scripts/embed_web_assets.py` — compresses and embeds the web page at build time
- `web/` — dependency-free phone HTTP and desktop Web Serial console, macro editor
- `tests/` — host-side firmware and browser-logic tests

## License and disclaimer

This project is released under the
[GNU General Public License v3.0](./LICENSE). Third-party attribution is in
[NOTICE.md](./NOTICE.md).

This is an unofficial fan project and is not affiliated with, endorsed by, or
sponsored by Nintendo. Splatoon, Splatoon Raiders, Nintendo Switch, and related
names and marks belong to their respective owners. Use automation responsibly;
the project is intended for offline, single-player material farming.

## Credits

Thanks to [我的茕茕孑立](https://space.bilibili.com/35615481) for the original game controller macro.
