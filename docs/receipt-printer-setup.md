# Receipt Printer Setup

Oxygen supports printing finish result tickets via WebUSB directly from the browser.
This works regardless of where the API server runs (local, cloud, etc.) since
printing is handled entirely in the browser.

## Supported Printers

Any ESC/POS-compatible USB thermal printer is supported. Tested with:

- **CITIZEN CT-S310II** (VID `0x1D90` / PID `0x2060`) — 80 mm paper

Other ESC/POS printers (Epson TM series, Star TSP series, etc.) will appear in the
device picker via the generic USB Printer class filter.

## Browser Requirements

- **Chrome or Edge** (Firefox does not support WebUSB)
- **Secure context** — the app must be served from `http://localhost` or `https://`

## Linux Setup (one-time)

On Linux the kernel loads the `usblp` driver automatically when a USB printer is
plugged in, which blocks WebUSB from claiming the interface. The fix is a udev rule
that grants browser access and auto-releases the interface.

### Step 1 — Create udev rules file

Create `/etc/udev/rules.d/50-citizen-thermal.rules`:

```
# Grant user/browser access to the CITIZEN CT-S310II
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", MODE="0666", TAG+="uaccess"

# Immediately release the interface from the usblp kernel driver
# when it binds, so WebUSB can claim it. This does NOT affect any
# other USB printers on the system.
ACTION=="bind", SUBSYSTEM=="usb", DRIVER=="usblp", \
  ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", \
  RUN+="/bin/sh -c 'echo -n %k > /sys/bus/usb/drivers/usblp/unbind'"
```

### Step 2 — Apply the rules

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### Step 3 — Replug the printer

Unplug and replug the USB cable. The printer should no longer appear as
`/dev/usblpN` and will instead be claimable by Chrome via WebUSB.

> **Note:** If you later need CUPS/system printing for this printer, remove
> the rules file and reload udev. The two approaches are mutually exclusive.

## Windows Setup (one-time)

Windows loads its own USB printer driver (`usbprint.sys`) automatically when a
thermal printer is plugged in. This prevents WebUSB from claiming the interface —
the device picker will show the printer as "parkopplad" (paired) and connecting
will fail. The fix is to replace the Windows driver with **WinUSB** using Zadig.

### Step 1 — Download Zadig

Download [Zadig](https://zadig.akeo.ie/) (free, no installation needed).

### Step 2 — Replace the driver

1. Plug in the thermal printer.
2. Run Zadig.
3. In the menu bar, check **Options → List All Devices**.
4. Select the printer from the dropdown (e.g. "CT-S310II" or "USB Printing Support").
5. In the **Driver** row you will see the current driver on the left (e.g.
   `usbprint`) and the target driver on the right. Use the arrows to select
   **WinUSB** as the target.
6. Click **Replace Driver** and wait for it to finish.

### Step 3 — Reconnect in Chrome

Reload the Oxygen page and click **Connect Printer**. The printer should now
appear without "parkopplad" and connect successfully.

> **Note:** Replacing the driver means the printer will no longer be visible to
> Windows' built-in printing system (e.g. Notepad, Word). To restore the
> original driver, open **Device Manager**, find the printer under
> "Universal Serial Bus devices", right-click → **Uninstall device** (tick
> "Delete the driver software"), then replug the printer. Windows will
> reinstall `usbprint.sys` automatically.

## macOS

No extra setup required. WebUSB works out of the box on macOS.

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
