/**
 * WebUSB printer driver.
 *
 * Connects to an ESC/POS printer via the browser's WebUSB API.
 * Works with the CITIZEN CT-S310II in either of its two USB modes, plus
 * any printer that exposes a standard USB Printer Class interface (class 7).
 *
 * The CT-S310II has two memory-switch-selectable USB identities:
 *   - Printer Class (MSW5-3 ON): VID 0x1D90 / PID 0x2060, USB class 7.
 *     OS printer drivers (usblp on Linux, usbprint.sys on Windows) auto-bind
 *     and block WebUSB; per-platform workarounds are required.
 *   - Virtual COM   (MSW5-3 OFF): VID 0x1D90 / PID 0x0FFF, vendor-specific.
 *     No OS driver auto-binds, so WebUSB claims the interface directly.
 *     This is the recommended deployment mode.
 *
 * Requirements:
 *  - Chrome or Edge (WebUSB support)
 *  - Secure context (https:// or http://localhost)
 *
 * See docs/receipt-printer-setup.md for setup details and how to flip
 * the printer between modes.
 */

import type { PrinterDriver } from "../types.js";
import {
  buildReadMemorySwitch,
  buildFlashUsbMode,
  buildSelfTest,
  buildEnterUserMode,
  buildExitUserMode,
  parseMemorySwitchResponse,
  parseUsbModeFromSwitch5,
  CITIZEN_USB_MODE_SWITCH,
  type CitizenUsbMode,
} from "../escpos-config.js";

// CITIZEN CT-S310II USB identifiers
const CITIZEN_CT_S310II_VID = 0x1d90;
// Printer Class mode (MSW5-3 ON). OS printer drivers attach.
const CITIZEN_CT_S310II_PID_PRINTER = 0x2060;
// Virtual COM mode (MSW5-3 OFF). Vendor-specific class, no OS driver attaches.
const CITIZEN_CT_S310II_PID_VCOM = 0x0fff;

// USB Printer class code
const USB_PRINTER_CLASS = 7;

/** True if a USB device is a CITIZEN CT-S310II in either USB mode. */
function isCitizenCtS310II(device: USBDevice): boolean {
  return (
    device.vendorId === CITIZEN_CT_S310II_VID &&
    (device.productId === CITIZEN_CT_S310II_PID_PRINTER ||
      device.productId === CITIZEN_CT_S310II_PID_VCOM)
  );
}

export type WebUsbPrinterStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type CtS310IIUsbMode = CitizenUsbMode;

export interface PrinterIdentity {
  /** USB Vendor ID. */
  vendorId: number;
  /** USB Product ID. */
  productId: number;
  /** USB descriptor product string (e.g. "Thermal Printer"). */
  productName: string | null;
  /** USB descriptor serial string. */
  serialNumber: string | null;
  /**
   * The CT-S310II USB mode currently in use, or null if the device isn't a
   * recognised CT-S310II (in which case the mode concept doesn't apply).
   */
  ctS310IIMode: CtS310IIUsbMode | null;
}

export class WebUsbPrinterDriver extends EventTarget implements PrinterDriver {
  readonly name = "WebUSB";

  private device: USBDevice | null = null;
  private outEndpointNumber = 1;
  private inEndpointNumber: number | null = null;
  private _status: WebUsbPrinterStatus = "idle";

  get connected(): boolean {
    return this.device !== null && this._status === "connected";
  }

  get status(): WebUsbPrinterStatus {
    return this._status;
  }

  /** True if the connected device supports two-way communication. */
  get supportsRead(): boolean {
    return this.connected && this.inEndpointNumber !== null;
  }

  /** Identity of the currently connected device, or null if disconnected. */
  getIdentity(): PrinterIdentity | null {
    if (!this.device) return null;
    const { vendorId, productId, productName, serialNumber } = this.device;
    let ctS310IIMode: CtS310IIUsbMode | null = null;
    if (vendorId === CITIZEN_CT_S310II_VID) {
      if (productId === CITIZEN_CT_S310II_PID_VCOM) ctS310IIMode = "virtual-com";
      else if (productId === CITIZEN_CT_S310II_PID_PRINTER) ctS310IIMode = "printer-class";
    }
    return { vendorId, productId, productName, serialNumber, ctS310IIMode };
  }

  // ── USB disconnect watcher ────────────────────────────────
  //
  // Registered on navigator.usb after a successful connection so that
  // powering off or unplugging the printer immediately reflects in the UI.
  private onUsbDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) {
      this.device = null;
      this._status = "idle";
      this.dispatchEvent(new Event("printer:disconnected"));
    }
  };

  // ── Open the browser device picker and connect ────────────

  async connect(): Promise<void> {
    if (!navigator.usb) {
      throw new Error("WebUSB is not supported in this browser (requires Chrome or Edge)");
    }

    this._status = "connecting";

    const device = await navigator.usb.requestDevice({
      filters: [
        // CT-S310II in Virtual COM mode (recommended — no OS driver attaches)
        { vendorId: CITIZEN_CT_S310II_VID, productId: CITIZEN_CT_S310II_PID_VCOM },
        // CT-S310II in Printer Class mode
        { vendorId: CITIZEN_CT_S310II_VID, productId: CITIZEN_CT_S310II_PID_PRINTER },
        // Any USB Printer Class device (generic ESC/POS)
        { classCode: USB_PRINTER_CLASS },
      ],
    });

    await this.connectToDevice(device);
  }

  /**
   * Try to reconnect to a previously authorized printer without showing the
   * device picker. Returns true if a device was found and connected.
   * Mirrors SIReaderConnection.tryAutoReconnect().
   */
  async tryAutoConnect(): Promise<boolean> {
    if (!navigator.usb) return false;
    try {
      const devices = await navigator.usb.getDevices();
      // Prefer a CT-S310II (in either mode) over any other paired device.
      const device = devices.find(isCitizenCtS310II) ?? devices[0];
      if (!device) return false;
      await this.connectToDevice(device);
      return true;
    } catch {
      this._status = "idle";
      return false;
    }
  }

  /** Shared device setup used by both connect() and tryAutoConnect(). */
  private async connectToDevice(device: USBDevice): Promise<void> {
    await device.open();

    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // Find the printer interface. In Printer Class mode it's the class-7
    // interface (typically #0); in Virtual COM mode it's the first
    // vendor-specific bulk interface (also #0 on the CT-S310II).
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

    try {
      await device.claimInterface(iface.interfaceNumber);
    } catch (err) {
      await device.close();
      this._status = "error";
      // Driver-blocking errors only happen in Printer Class mode (PID 0x2060
      // on the CT-S310II); Virtual COM mode never has this problem because no
      // OS driver auto-binds. Recommend the mode flip as the primary fix.
      const isWindows = navigator.userAgent.includes("Windows");
      const hint = isWindows
        ? "On Windows, the CITIZEN printer driver is blocking access. The recommended fix is to switch the printer to Virtual COM mode via its FEED button menu (no per-laptop setup needed afterwards). As a fallback, Zadig (zadig.akeo.ie) can replace the driver with WinUSB. See docs/receipt-printer-setup.md."
        : "On Linux, the kernel's usblp driver is blocking access. The recommended fix is to switch the printer to Virtual COM mode via its FEED button menu (a simpler udev rule is then enough). As a fallback, install the udev rule that unbinds usblp. See docs/receipt-printer-setup.md.";
      throw new Error(
        `Could not claim the printer USB interface. ${hint}`,
        { cause: err },
      );
    }

    // Find the bulk OUT endpoint (required) and the bulk IN endpoint
    // (optional — used for status/configuration commands like reading
    // memory switches).
    const endpoints = iface.alternates[0]?.endpoints ?? [];
    const outEndpoint = endpoints.find(
      (e) => e.direction === "out" && e.type === "bulk",
    );
    if (!outEndpoint) {
      await device.close();
      this._status = "error";
      throw new Error("No bulk OUT endpoint found on printer interface");
    }
    this.outEndpointNumber = outEndpoint.endpointNumber;

    const inEndpoint = endpoints.find(
      (e) => e.direction === "in" && e.type === "bulk",
    );
    this.inEndpointNumber = inEndpoint?.endpointNumber ?? null;

    this.device = device;
    this._status = "connected";
    // Listen for physical disconnect (unplug / power-off)
    navigator.usb.addEventListener("disconnect", this.onUsbDisconnect);
    this.dispatchEvent(new Event("printer:connected"));
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      navigator.usb.removeEventListener("disconnect", this.onUsbDisconnect);
      try {
        await this.device.close();
      } catch {
        // Ignore errors during close (device may have been unplugged)
      }
      this.device = null;
      this.inEndpointNumber = null;
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

  /**
   * Read bytes from the bulk IN endpoint.
   *
   * `length` is the per-transfer buffer size passed to USB transferIn.
   * `atLeast` (optional) keeps reading additional short packets until that
   * many bytes have been accumulated. This is needed because the printer
   * may split its response across multiple USB short packets — for example
   * the CT-S310II answers GS ( E fn=4 with a 5-byte packet followed by a
   * 6-byte packet for the documented 11-byte total.
   *
   * `maxIterations` bounds the loop so a misbehaving device can't hang
   * the UI forever.
   */
  async readBytes(
    length: number,
    options?: { atLeast?: number; maxIterations?: number },
  ): Promise<Uint8Array> {
    if (!this.device) throw new Error("Printer not connected");
    if (this.inEndpointNumber === null) {
      throw new Error("Printer does not expose a bulk IN endpoint");
    }
    const target = options?.atLeast ?? 0;
    const maxIter = options?.maxIterations ?? 8;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < maxIter; i++) {
      const result = await this.device.transferIn(this.inEndpointNumber, length);
      if (result.status !== "ok") {
        throw new Error(`USB transfer-in failed with status: ${result.status}`);
      }
      const chunk = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= target) break;
    }
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  // ── ESC/POS configuration helpers ─────────────────────────

  /**
   * Read one memory switch (1-10). Returns the 8-bit value as a string of
   * '0' and '1' chars in MSB-first order (index 0 = bit 8).
   *
   * Sends "GS ( E fn 4" and reads the 11-byte response.
   */
  async readMemorySwitch(switchNumber: number): Promise<string> {
    await this.sendBytes(buildReadMemorySwitch(switchNumber));
    // Documented response is 11 bytes (header 2B + 8 ASCII bits + NUL).
    // The CT-S310II splits this across short packets, and may also have
    // leftover bytes in the IN buffer from background status polls or
    // previous interrupted reads. Keep pulling chunks until the parser
    // accepts the buffer (it scans for the 0x37 0x21 header anywhere in
    // the data and ignores leading garbage). Bounded so a non-responsive
    // firmware can't hang the dialog.
    if (this.inEndpointNumber === null) {
      throw new Error("Printer does not expose a bulk IN endpoint");
    }
    let buffer = new Uint8Array(0);
    const maxIterations = 16;
    for (let i = 0; i < maxIterations; i++) {
      const result = await this.device!.transferIn(this.inEndpointNumber, 64);
      if (result.status !== "ok") {
        throw new Error(`USB transfer-in failed with status: ${result.status}`);
      }
      const chunk = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      if (chunk.byteLength === 0) break;
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
      try {
        return parseMemorySwitchResponse(buffer);
      } catch {
        // Not enough valid data yet — pull another chunk.
      }
    }
    // Final attempt: let the parser throw with a hex dump for diagnosis.
    return parseMemorySwitchResponse(buffer);
  }

  /**
   * Read all 10 memory switches and return them keyed by switch number.
   * Convenient for displaying the full Change List in the UI.
   */
  async readAllMemorySwitches(): Promise<Record<number, string>> {
    const out: Record<number, string> = {};
    for (let n = 1; n <= 10; n++) {
      out[n] = await this.readMemorySwitch(n);
    }
    return out;
  }

  /**
   * Flip the CT-S310II's USB mode by setting MSW5-3.
   *
   * Wraps the write in the user-setting-mode envelope (fn=1 / fn=3 / fn=2)
   * because plain fn=3 is silently ignored on at least the 2014 CT-S310II
   * firmware. Small sleeps between commands give the printer time to
   * process each step (fn=1 puts the printer in a special offline state
   * which takes a moment to enter; fn=2 typically triggers a soft reset).
   *
   * The change requires a power cycle to take effect on the USB bus —
   * the printer re-enumerates with a new VID/PID after it reboots.
   */
  async flashUsbMode(mode: CitizenUsbMode): Promise<void> {
    await this.sendBytes(buildEnterUserMode());
    await sleep(300);
    await this.sendBytes(buildFlashUsbMode(mode));
    await sleep(200);
    await this.sendBytes(buildExitUserMode());
    await sleep(200);
  }

  /**
   * Read MSW5 and return the currently-active USB mode.
   * Differs from getIdentity().ctS310IIMode in that it asks the printer
   * directly rather than inferring from the USB descriptor — useful for
   * verifying a flash command landed correctly before power-cycling.
   */
  async readUsbMode(): Promise<CitizenUsbMode> {
    const sw5 = await this.readMemorySwitch(CITIZEN_USB_MODE_SWITCH);
    return parseUsbModeFromSwitch5(sw5);
  }

  /** Trigger the printer's built-in self-test print. */
  async printSelfTest(): Promise<void> {
    await this.sendBytes(buildSelfTest());
  }
}

/** True if WebUSB is available in the current browser/context. */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
