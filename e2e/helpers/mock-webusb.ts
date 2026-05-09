/**
 * Mock WebUSB API for Playwright E2E tests.
 *
 * Injected via page.addInitScript() before page code runs. It replaces
 * navigator.usb with a controllable fake implementation that emulates a
 * CITIZEN CT-S310II in either Printer Class (PID 0x2060) or Virtual COM
 * (PID 0x0FFF) mode.
 *
 * Usage from tests:
 *   await page.evaluate(() => window.__usbMock.setMode("printer-class"));
 *   const sent = await page.evaluate(() => window.__usbMock.getWrittenBytes());
 *   await page.evaluate(() => window.__usbMock.simulateUnplug());
 *
 * The mock auto-pairs the fake device on first navigator.usb.getDevices()
 * call so PrinterContext's tryAutoConnect() picks it up immediately.
 */

export function getMockWebUsbScript(initialMode: "printer-class" | "virtual-com" = "printer-class"): string {
  return `
(function() {
  const PID_PRINTER = 0x2060;
  const PID_VCOM    = 0x0fff;
  const VID         = 0x1d90;

  let currentMode = ${JSON.stringify(initialMode)};
  let writtenChunks = [];
  // Memory switches as MSB-first bit strings (bit 8 first). SW5 = "00000100"
  // matches our slip from exploration: MSW5-3 ON = Printer Class.
  let memorySwitches = {
    1: "00000000",
    2: "00001011",
    3: "00000010",
    4: "10000100",
    5: "00000100",
    6: "00000100",
    7: "00000000",
    8: "00000000",
    9: "00000000",
    10: "00000000",
  };
  // Pending IN-endpoint reads: queue of Uint8Array responses.
  let pendingReads = [];
  let connected = false;
  let device = null;
  const listeners = { connect: [], disconnect: [] };

  function syncSwitch5ToMode() {
    // MSW5-3 (bit 3) lives at MSB-first index 5.
    const bits = memorySwitches[5].split("");
    bits[5] = currentMode === "virtual-com" ? "0" : "1";
    memorySwitches[5] = bits.join("");
  }

  function buildDevice() {
    return {
      vendorId: VID,
      productId: currentMode === "virtual-com" ? PID_VCOM : PID_PRINTER,
      deviceClass: 0,
      deviceSubclass: 0,
      deviceProtocol: 0,
      productName: "Thermal Printer",
      serialNumber: "00000000",
      manufacturerName: "CITIZEN",
      configuration: (function() {
        const alt = {
          alternateSetting: 0,
          interfaceClass: currentMode === "virtual-com" ? 0xff : 7,
          interfaceSubclass: currentMode === "virtual-com" ? 0xff : 1,
          interfaceProtocol: currentMode === "virtual-com" ? 0xff : 2,
          interfaceName: null,
          endpoints: [
            { endpointNumber: 1, direction: "in",  type: "bulk", packetSize: 64 },
            { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 64 },
          ],
        };
        return {
          configurationValue: 1,
          configurationName: null,
          interfaces: [{
            interfaceNumber: 0,
            claimed: false,
            alternate: alt,
            alternates: [alt],
          }],
        };
      })(),
      configurations: [],
      async open() { /* no-op */ },
      async close() { /* no-op */ },
      async selectConfiguration() { /* no-op */ },
      async claimInterface() { this.configuration.interfaces[0].claimed = true; },
      async releaseInterface() { this.configuration.interfaces[0].claimed = false; },
      async transferOut(_ep, data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        writtenChunks.push(new Uint8Array(bytes));
        // Detect commands and queue responses / mutate state.
        // GS ( E fn=4 (read memory switch): 1D 28 45 02 00 04 a
        if (bytes.length === 7 && bytes[0] === 0x1d && bytes[1] === 0x28 && bytes[2] === 0x45 && bytes[5] === 0x04) {
          const sw = bytes[6];
          const bits = memorySwitches[sw] || "00000000";
          const resp = new Uint8Array(11);
          resp[0] = 0x37;
          resp[1] = 0x21;
          for (let i = 0; i < 8; i++) resp[2 + i] = bits.charCodeAt(i);
          resp[10] = 0x00;
          // Push some leading garbage to mimic background status bytes
          // sitting in the IN buffer on a real CT-S310II. The driver must
          // skip past these and find the 0x37 0x21 header.
          pendingReads.push(new Uint8Array([0x31, 0x60, 0x31, 0x60]));
          // Then the real response, split across short packets (5+6) like
          // the real printer does.
          pendingReads.push(resp.slice(0, 5));
          pendingReads.push(resp.slice(5));
        }
        // GS ( E fn=3 (set memory switch): 1D 28 45 0A 00 03 a [8 bit chars]
        if (bytes.length === 15 && bytes[0] === 0x1d && bytes[1] === 0x28 && bytes[2] === 0x45 && bytes[5] === 0x03) {
          const sw = bytes[6];
          const oldBits = (memorySwitches[sw] || "00000000").split("");
          for (let i = 0; i < 8; i++) {
            const c = String.fromCharCode(bytes[7 + i]);
            if (c === "0" || c === "1") oldBits[i] = c;
            // "." leaves bit unchanged
          }
          memorySwitches[sw] = oldBits.join("");
          // If MSW5 changed, update currentMode accordingly (informational
          // only — re-enumeration happens on simulateUnplug + setMode).
        }
        return { bytesWritten: bytes.length, status: "ok" };
      },
      async transferIn(_ep, length) {
        const next = pendingReads.shift() ?? new Uint8Array(0);
        const slice = next.slice(0, length);
        const buf = new ArrayBuffer(slice.byteLength);
        new Uint8Array(buf).set(slice);
        return { data: new DataView(buf), status: "ok" };
      },
    };
  }

  syncSwitch5ToMode();
  device = buildDevice();
  connected = true;

  const usb = {
    async requestDevice() {
      return device;
    },
    async getDevices() {
      return connected ? [device] : [];
    },
    addEventListener(type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      const i = listeners[type].indexOf(fn);
      if (i >= 0) listeners[type].splice(i, 1);
    },
    dispatchEvent() { return true; },
  };

  // Replace navigator.usb. Chromium ships a native USB getter on the
  // Navigator prototype, so a plain defineProperty on the instance would
  // shadow it but the property descriptor must allow both reads and
  // (potentially) writes. Override the prototype getter as a belt-and-
  // suspenders measure.
  try {
    Object.defineProperty(navigator, "usb", { value: usb, writable: true, configurable: true });
  } catch (_) {
    // ignore — fall back to prototype override below
  }
  try {
    const proto = Object.getPrototypeOf(navigator);
    if (proto) {
      Object.defineProperty(proto, "usb", { get: () => usb, configurable: true });
    }
  } catch (_) {
    // ignore
  }

  window.__usbMock = {
    setMode(m) {
      currentMode = m;
      syncSwitch5ToMode();
      device = buildDevice();
    },
    getMode() { return currentMode; },
    getWrittenBytes() {
      return writtenChunks.map(c => Array.from(c));
    },
    getMemorySwitch(n) { return memorySwitches[n]; },
    setMemorySwitch(n, bits) { memorySwitches[n] = bits; if (n === 5) currentMode = bits[5] === "0" ? "virtual-com" : "printer-class"; },
    simulateUnplug() {
      const old = device;
      connected = false;
      device = null;
      listeners.disconnect.forEach(fn => fn({ device: old }));
    },
    simulatePlug() {
      device = buildDevice();
      connected = true;
      listeners.connect.forEach(fn => fn({ device: device }));
    },
    reset() {
      writtenChunks = [];
      pendingReads = [];
    },
  };
})();
`;
}
