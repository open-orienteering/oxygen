# Receipt Printer Setup

Oxygen supports printing finish result tickets via WebUSB directly from the browser.
This works regardless of where the API server runs (local, cloud, etc.) since
printing is handled entirely in the browser.

## Supported Printers

Any ESC/POS-compatible USB thermal printer is supported. Tested with:

- **CITIZEN CT-S310II** (VID `0x1D90`) — 80 mm paper

Other ESC/POS printers (Epson TM series, Star TSP series, etc.) will appear in the
device picker via the generic USB Printer class filter.

## Browser Requirements

- **Chrome or Edge** (Firefox does not support WebUSB)
- **Secure context** — the app must be served from `http://localhost` or `https://`

## Two operating modes (CT-S310II)

The CT-S310II can be configured to present itself on USB in either of two modes,
selected by memory switch **MSW5-3**. The choice has large implications for how
much per-laptop setup is needed:

| Mode | USB identity | OS driver behaviour | Per-laptop setup |
|------|--------------|---------------------|------------------|
| **Virtual COM** (recommended) | VID `0x1D90` / PID `0x0FFF`, vendor-specific class | No OS driver auto-binds | None |
| Printer Class (default from factory) | VID `0x1D90` / PID `0x2060`, USB Printer class 7 | `usblp` (Linux) / `usbprint.sys` + vendor driver (Windows) auto-binds and blocks WebUSB | Required on Linux and Windows |

In Virtual COM mode the printer enumerates as a different USB device entirely
(different PID and a vendor-specific interface class), so neither the Linux
`usblp` driver nor the Windows CITIZEN/`usbprint.sys` drivers recognise it —
they don't bind, the interface stays free, and Chrome's WebUSB can claim it
directly. This makes it the right choice for competitions where laptops are
borrowed from other clubs and arrive with the standard CITIZEN driver
pre-installed.

The printer is shipped from the factory in Printer Class mode. Flipping a
printer to Virtual COM is a one-time operation done via the printer's own
FEED button menu — see below. The change is reversible by the same procedure,
which matters for borrowed equipment that needs to be returned in its original
state.

## Virtual COM mode (recommended)

### Step 1 — Flip the printer to Virtual COM mode (once per printer)

Done from the printer's Individual Setting Mode using the FEED button. The
procedure is taken from Citizen's CT-S310II User Manual, pages 41–43.

1. Load paper. **Open the paper cover.**
2. Hold the FEED button and turn the power on. Keep holding while it boots,
   then release.
3. **Press FEED exactly twice**, then **close the cover.** The printer prints
   "Memory SW (1)" with its current settings — you are now in Individual
   Setting Mode.
   - 0 presses before closing → hex dump mode (wrong).
   - 3 presses before closing → quick setting mode (wrong).
4. **Short-press FEED** to advance the cursor: SW(1) → SW(2) → … → SW(10) →
   "Save To Memory" → SW(1) → … Stop when **"Memory SW (5)"** is printed.
5. **Long-press FEED for at least 2 seconds** to enter SW5. The first function
   in SW5 (Buzzer) is printed.
6. Short-press FEED to cycle through the SW5 functions (Buzzer → Line Pitch →
   **USB Mode** → …). Stop when **"USB Mode"** is printed.
7. Long-press FEED ≥2 s to enter the value editor. The current value is
   printed; the ERROR LED lights to indicate edit mode.
8. Short-press FEED to cycle through values: Printer Class → **Virtual COM** →
   (back). Stop when "Virtual COM" is printed.
9. Long-press FEED ≥2 s to commit. The next function in SW5 is printed.
10. Open the cover, then close it. The changed setting is printed and you
    return to the SW selection level.
11. Short-press FEED until **"Save To Memory"** is printed.
12. Long-press FEED ≥2 s to save. The printer prints a final summary and
    exits setup mode.
13. **Power-cycle the printer** so it re-enumerates with the new USB class.

If anything goes wrong, the on-printer setup mode is OS-independent and can
always be used to recover — re-enter Individual Setting Mode and either set
USB Mode back to Printer Class, or use "Memory switch initialization" (open
the cover at "Save To Memory" and long-press) to reset every switch to
factory defaults.

### Step 2 — Linux (one-time per laptop)

Linux requires a one-line udev rule so that the logged-in user has raw USB
access to the device. No driver-unbinding is needed — nothing has bound.

Create `/etc/udev/rules.d/50-citizen-thermal.rules`:

```
# Grant the logged-in user access to the CITIZEN CT-S310II in Virtual COM mode.
# No driver auto-binds to PID 0x0FFF (it's a vendor-specific class), so
# WebUSB can claim it directly once the user has uaccess.
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="0fff", MODE="0666", TAG+="uaccess"
```

Apply the rule and replug the printer:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### Step 3 — Windows

Nothing to do. The CITIZEN printer driver is keyed to `1D90:2060` and will
not bind to a Virtual COM device (`1D90:0FFF`); `usbprint.sys` only binds USB
Printer class devices; `usbser.sys` only binds CDC devices. Citizen's
Virtual COM is vendor-specific, so none of them match. Chrome's WebUSB
claims the interface directly.

### Step 4 — macOS

Nothing to do. WebUSB works out of the box.

## Returning a borrowed printer

If you flipped a borrowed printer to Virtual COM during a competition, flip
it back to Printer Class before returning it so the lender's setup
(usually based on the CITIZEN driver) keeps working as before.

The procedure is identical to the Step 1 flip above, except that in step 8
you select **Printer Class** instead of Virtual COM. Then power-cycle the
printer.

## Printer Class mode (alternative / legacy)

Use this mode for printers that for some reason cannot be flipped to Virtual
COM (e.g. firmware too old, or different printer model). It requires
per-laptop setup on both Linux and Windows because OS printer drivers
auto-bind to USB Printer class devices and block WebUSB.

### Linux

Create `/etc/udev/rules.d/50-citizen-thermal.rules` with both the access rule
and an unbind rule that releases the kernel `usblp` driver from the device:

```
# Grant the logged-in user access to the CITIZEN CT-S310II in Printer Class mode.
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", MODE="0666", TAG+="uaccess"

# Immediately release the interface from the usblp kernel driver when it
# binds, so WebUSB can claim it. Targeted to this specific VID:PID — no
# effect on any other USB printer on the system.
ACTION=="bind", SUBSYSTEM=="usb", DRIVER=="usblp", \
  ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", \
  RUN+="/bin/sh -c 'echo -n %k > /sys/bus/usb/drivers/usblp/unbind'"
```

Apply and replug:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

> If you later want CUPS/system printing for this printer, remove the file
> and reload udev. The two approaches are mutually exclusive.

### Windows

Windows loads its own USB printer driver (`usbprint.sys`), and Citizen's
optional driver also binds to this device. To free the interface for
WebUSB, replace the active driver with **WinUSB** using Zadig.

1. Download [Zadig](https://zadig.akeo.ie/) (free, no installation).
2. Plug in the printer and run Zadig.
3. Menu bar → **Options → List All Devices**.
4. Select the printer (e.g. "CT-S310II" or "USB Printing Support").
5. In the **Driver** row pick **WinUSB** as the target.
6. Click **Replace Driver**.
7. Reload Oxygen and click **Connect Printer**.

> Replacing the driver hides the printer from Windows' built-in printing
> system (Notepad, Word, etc.). To restore it: Device Manager → find the
> printer under "Universal Serial Bus devices" → right-click → **Uninstall
> device** (tick "Delete the driver software") → replug. Windows
> reinstalls `usbprint.sys` automatically.
>
> If the printer can be flipped to Virtual COM, that route avoids needing
> Zadig entirely.

### macOS

No extra setup required.

## Using the Finish Station Printer

1. Open **More → Finish Station** in the competition view.
2. Click **Connect Printer** in the header — Chrome will show a device picker.
3. Select your printer and click **Connect**.
4. A receipt is automatically printed for each recorded finish.
5. Use the printer icon on any row in the Recent Finishers list to reprint.
6. After a page reload, the printer reconnects automatically if it was previously paired.

## Receipt Layout (42-char, ESC/POS)

```
==========================================
        Test Cup 2026             ← bold, printer-centered
          2026-03-04
==========================================
  Anna Svensson  H21              ← bold
  IFK Göteborg OK
==========================================
  Start: 10:00:00   Finish: 10:42:35
  OK  Time: 42:35  (5:01 min/km)  ← bold
==========================================
Nr.  Cod  Split      Time  Total  Pace
 1.   101   5:12  10:05:12   5:12  6:07
 2.   102   6:22  10:11:34  11:34 12:07
 3.   103   8:45  10:20:19  20:19  6:34
Fin        8:45  10:42:35  42:35     - ← bold
==========================================
  SIAC 8007045
  Battery: 2.98V   2024-02-12   OK
==========================================
  Position: 3/12                ← bold
  1  Kevin Hedström (Skogsl.)  24:00
  2  Anna Ek (IFK Göteborg OK) 42:00
  3  Anna Svensson (IFK Göteb.) 42:35
==========================================
   Oxygen - Lightweight orienteering
           open-orienteering.org
              10:42:36
[cut]
```

**Column positions (splits table):**

| Column | Width | Content |
|--------|-------|---------|
| Nr.    | 3     | Right-aligned control index + "." |
| Cod    | 4+1sp | Right-aligned control code |
| Split  | 6+1sp | Right-aligned split time (m:ss) |
| Time   | 8+2sp | Clock time HH:MM:SS (2-space margin) |
| Total  | 6+1sp | Right-aligned cumulative time |
| Pace   | 5+1sp | Right-aligned min/km pace |
