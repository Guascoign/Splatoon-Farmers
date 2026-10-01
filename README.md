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
- Keeps the complete 48-step, `63.595 s` loop in firmware Flash.
- Starts its own `ESP32-S3-Switch` Wi-Fi hotspot on every boot and serves the
  control page at <http://192.168.9.1> without a computer or internet.
- Continues a running loop if the browser, Wi-Fi, or USB-UART connection drops.
- Starts, stops, and reports progress through Wi-Fi HTTP or Web Serial.
- Exposes one editable macro slot. The compiled 48-step routine is the fallback;
  a saved Flash version takes priority on the next boot.
- Uses the onboard GPIO48 WS2812 to show startup, connection, running macro,
  and controller output states.
- Provides every digital controller button and D-pad direction for mouse,
  touch, and keyboard input.
- On the desktop Web Serial page, maps a Windows-paired Xbox Wireless Controller
  to the Switch report and records live play into a slot 01 draft.
- Leaves both analog sticks centered during manual input.

The browser sends only high-level `START`, `STOP`, and status commands during
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
3. Select **开始刷取**. The routine restarts at step 1 and loops until stopped.
4. Select **停止** to immediately send a neutral controller report.

### Edit the board macro

Open **宏设置** from the top navigation on the onboard page or the desktop
Web Serial page. Slot 01 shows the active source, action count, cycle duration,
and light color. Open it to inspect every action and adjust held buttons,
D-pad, sticks, duration, loop gap, and one of six fixed running colors. Steps
can be added, copied, reordered, or deleted. **保存到 Flash** uploads the full
macro transaction with a checksum; saving is disabled while the routine runs.

The Flash override is stored as `/material-farm-slot-1.bin` in SPIFFS with a
backup record. **恢复内置** removes this override and returns to the compiled
48-step routine. Firmware never formats SPIFFS on boot. If mounting fails,
the built-in routine still runs; **初始化宏存储** is offered only in that case
and explicitly warns that formatting erases the entire SPIFFS partition,
including data from other firmware previously used on the board.

### Xbox Wireless Controller on the desktop page

Pair the Xbox controller with Windows, open the local page in desktop Chrome or
Edge, connect the board's USB-UART port, and press a controller button so the
browser exposes it through the Gamepad API. This requires firmware 1.3.0 or
newer. **开始直通** sends its current buttons,
D-pad, triggers, and sticks to the Switch output; leaving the page, losing focus,
disconnecting the controller, or selecting **停止直通** sends a neutral report when
the serial link remains available. Gamepad reports include a heartbeat; if it
stops for 800 ms, firmware releases the Switch controls. Browser input requires
the computer and page to stay connected. It does not pair the controller
directly to the ESP32-S3.

The left Xbox and right Switch diagrams preview the bindings and live analog
stick positions. Click a key or stick circle on the left, then its destination
on the right to change it. The default follows physical positions: Xbox A →
Switch B, B → A, X → Y, Y → X. Analog sticks can also be swapped or unbound;
L3/R3 stick presses are separate buttons. Browser-local storage keeps the
binding map on this PC.
The Xbox/Home and Share/Capture buttons depend on what the browser exposes.

While pass-through is active, select **开始录制** and play. A held stick position
is merged into one step, while stick motion is sampled at the chosen interval
(80, 220, or 350 ms). **结束录制并预览**
releases the Switch output and opens the recorded steps as an unsaved draft in
slot 01. You can adjust each step, loop gap, and LED color there, then select
**保存到 Flash** to replace the slot override. Recording is limited to 128 steps;
the existing Flash macro is untouched until you save.

The status LED is red briefly after power-on. It blinks yellow while no phone
is associated and no active serial command stream is present, then stays yellow
while a phone is connected to the hotspot or the desktop page is polling over
serial. During a run it blinks in the slot's selected color. An active HID
report briefly flashes green. The light uses GPIO48, as on the N16R8 board.

Losing Wi-Fi or USB-UART does not stop an already running routine. Reconnect and
stop it, reset the board, or remove power when you need to end it.

### Manual controls

Manual input stops the automatic routine before sending a raw controller
report. Buttons support hold, multi-key combinations, mouse, multitouch, and
keyboard. Losing focus or hiding the tab releases all browser-held inputs.

| Controller | Keyboard | Controller | Keyboard |
| --- | --- | --- | --- |
| X / Y / B / A | I / J / K / L | D-pad | Arrow keys |
| L / R | Q / E | ZL / ZR | 1 / 3 |
| L3 / R3 | Z / X | − / + | − / = |
| Capture / Home | C / H | | |

If USB-UART is physically unplugged while a button is held, the browser cannot
send the final neutral report. Reset the board to release that last state.

## Serial protocol

The USB-UART control link is `115200 baud`, ASCII, one command per line. The
onboard page sends the same commands with `POST /api/command?command=...` and
receives a single response. Both control paths act on the same macro state.

| Command | Behavior |
| --- | --- |
| `HELLO` / `INFO` | Return firmware, routine metadata, and current state as JSON |
| `START` | Restart the board-resident routine from step 1 |
| `STOP` | Stop and send a fully neutral controller report |
| `STATUS` | Return phase, step, cycle count, and timing |
| `PING` | Return `PONG` |
| `R buttons dpad lx ly rx ry` | Stop the routine and send one complete HID report |
| `G buttons dpad lx ly rx ry` | Stream a Gamepad API report; release to neutral after 800 ms without another `G` |
| `MACRO_LIST` / `MACRO_GET` | Read the single slot summary or complete action list |
| `MACRO_BEGIN count gap color` | Start a staged upload for slot 01 |
| `MACRO_STEP index duration buttons dpad lx ly rx ry` | Set one staged action |
| `MACRO_COMMIT checksum` / `MACRO_ABORT` | Validate and save, or cancel a staged upload |
| `MACRO_RESTORE` | Remove only this slot's Flash override |
| `MACRO_STORAGE_FORMAT` | Explicitly format SPIFFS only after a mount failure |

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
- `firmware/src/MacroSlotStorage.cpp` — one-slot checked SPIFFS override
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
