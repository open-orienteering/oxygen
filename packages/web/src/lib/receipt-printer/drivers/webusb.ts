/**
 * WebUSB printer driver.
 *
 * Connects to an ESC/POS printer via the browser's WebUSB API.
 * Works with the CITIZEN CT-S310II (VID 0x1D90 / PID 0x2060) and any
 * printer that exposes a standard USB Printer Class interface (class code 7).
 *
 * Requirements:
 *  - Chrome or Edge (WebUSB support)
 *  - Secure context (https:// or http://localhost)
 *
 * Linux note:
 *  The kernel loads the `usblp` driver automatically for USB printers, which
 *  prevents WebUSB from claiming the interface.
 *  See docs/receipt-printer-setup.md for the full setup instructions.
 *
 *  Short version — create /etc/udev/rules.d/50-citizen-thermal.rules:
 *
 *    SUBSYSTEM=="usb", ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", MODE="0666", TAG+="uaccess"
 *    ACTION=="bind", SUBSYSTEM=="usb", DRIVER=="usblp", \
 *      ATTRS{idVendor}=="1d90", ATTRS{idProduct}=="2060", \
 *      RUN+="/bin/sh -c 'echo -n %k > /sys/bus/usb/drivers/usblp/unbind'"
 *
 *  Then: sudo udevadm control --reload-rules && sudo udevadm trigger
 *  Replug the printer. This only affects this specific printer model.
 */

import type { PrinterDriver } from "../types.js";

// CITIZEN CT-S310II USB identifiers
const CITIZEN_CT_S310II_VID = 0x1d90;
const CITIZEN_CT_S310II_PID = 0x2060;

// USB Printer class code
const USB_PRINTER_CLASS = 7;

export type WebUsbPrinterStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export class WebUsbPrinterDriver extends EventTarget implements PrinterDriver {
  readonly name = "WebUSB";

  private device: USBDevice | null = null;
  private outEndpointNumber = 1;
  private _status: WebUsbPrinterStatus = "idle";

  get connected(): boolean {
    return this.device !== null && this._status === "connected";
  }

  get status(): WebUsbPrinterStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    if (!navigator.usb) {
      throw new Error("WebUSB is not supported in this browser (requires Chrome or Edge)");
    }

    this._status = "connecting";

    const device = await navigator.usb.requestDevice({
      filters: [
        // Prefer the specific CITIZEN CT-S310II
        { vendorId: CITIZEN_CT_S310II_VID, productId: CITIZEN_CT_S310II_PID },
        // Also accept any USB Printer Class device (generic ESC/POS)
        { classCode: USB_PRINTER_CLASS },
      ],
    });

    await device.open();

    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // Find the printer interface (class 7) — usually interface 0
    const iface = device.configuration!.interfaces.find(
      (i) =>
        i.alternates[0]?.interfaceClass === USB_PRINTER_CLASS ||
        i.interfaceNumber === 0,
    );
    if (!iface) {
      await device.close();
      this._status = "error";
      throw new Error("No printer interface found on USB device");
    }

    // claimInterface detaches the kernel usblp driver on Linux automatically
    await device.claimInterface(iface.interfaceNumber);

    // Find the bulk OUT endpoint (direction: "out")
    const outEndpoint = iface.alternates[0]?.endpoints.find(
      (e) => e.direction === "out",
    );
    if (!outEndpoint) {
      await device.close();
      this._status = "error";
      throw new Error("No bulk OUT endpoint found on printer interface");
    }
    this.outEndpointNumber = outEndpoint.endpointNumber;

    this.device = device;
    this._status = "connected";
    this.dispatchEvent(new Event("printer:connected"));
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      try {
        await this.device.close();
      } catch {
        // Ignore errors during close (device may have been unplugged)
      }
      this.device = null;
      this._status = "idle";
      this.dispatchEvent(new Event("printer:disconnected"));
    }
  }

  async sendBytes(data: Uint8Array): Promise<void> {
    if (!this.device) throw new Error("Printer not connected");
    // transferOut handles USB packet splitting internally
    const result = await this.device.transferOut(this.outEndpointNumber, data);
    if (result.status !== "ok") {
      throw new Error(`USB transfer failed with status: ${result.status}`);
    }
  }
}

/** True if WebUSB is available in the current browser/context. */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}
