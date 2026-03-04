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

## macOS / Windows

No extra setup required. WebUSB works out of the box on macOS and Windows.

## Using the Finish Station Printer

1. Open **More → Finish Station** in the competition view.
2. Click **Connect Printer** — Chrome will show a device picker.
3. Select your printer and click **Connect**.
4. Enable **Auto-print** to automatically print a ticket for each recorded finish.
5. Use the printer icon on any row in the Recent Finishers list to reprint.

## Receipt Layout

```
==========================================
          OXYGEN RESULTS
      Competition Name
      2026-03-04  10:42
==========================================
  Klass: H21
  Anna Svensson                      #42
  IFK Göteborg OK
==========================================
  Start:   10:00:00
  Mål:     10:42:35
  Tid:        42:35
  Plac: 3/12             Status: OK
==========================================
  MELLANTIDER
   1.  101     5:12     5:12
   2.  102     6:22    11:34
   3.  103     8:45    20:19
  Mål          42:35
==========================================
              10:42:36
==========================================
[cut]
```
