/**
 * Mock Web Bluetooth with one SPORTident Reader BT, for Playwright E2E tests.
 *
 * Injected with page.addInitScript() before page code runs. Replaces
 * navigator.bluetooth with a fake whose single device, "Reader BT 500123",
 * speaks the Reader BT GATT protocol (docs/si-protocol/reader-bt.md):
 * it answers ReadDeviceInfo 0x010E, ReadAllSettings 0x010C, ReadAutosend
 * 0x0110 and the complete readout request 0x1103 (segmented with 0xA101,
 * as the real reader does above the MTU), notifies CardStateChange 0x1101
 * on insert/remove, and records the Feedback 0x1110 bytes the client writes.
 *
 * Usage from tests:
 *   await page.evaluate(() => window.__readerBtMock.insertCard(cardNo, punches, opts));
 *   await page.evaluate(() => window.__readerBtMock.getFeedback()); // [1] = OK
 *
 * Punch and start/finish times are seconds since midnight, as in
 * mock-webserial.ts; the mock converts them to the reader's ms since
 * Sunday 00:00 using today's weekday.
 */

export interface ReaderBtMockApi {
  insertCard(
    cardNumber: number,
    punches?: Array<{ controlCode: number; time: number }>,
    options?: {
      hasFinish?: boolean;
      ownerData?: { firstName?: string; lastName?: string; club?: string };
    },
  ): boolean;
  removeCard(): boolean;
  /** Feedback values written so far: 1 = OK, 2 = error */
  getFeedback(): number[];
  /** Link loss: GATT disconnects; the reader advertises again on the next insert */
  simulateDisconnect(): void;
  isConnected(): boolean;
  /** Number of gatt.connect() calls that succeeded */
  connectCount(): number;
  /** Battery level reported (and notified when connected) */
  setBattery(percent: number): void;
  reset(): void;
}

export function getMockWebBluetoothScript(): string {
  return `
(function() {
  var RBT = function(s) { return "bd51" + s + "-6aec-4628-a146-f3e95bc49e62"; };
  var UUID = {
    settings: RBT("0001"), readSettings: RBT("0002"), writeSettings: RBT("0003"),
    card: RBT("0011"), cardState: RBT("0012"), cardData: RBT("0013"),
    sessions: RBT("0031"),
    battery: "0000180f-0000-1000-8000-00805f9b34fb",
    batteryLevel: "00002a19-0000-1000-8000-00805f9b34fb",
  };
  var MTU_PAYLOAD = 180;

  function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
  function msg(id, payload) { return new Uint8Array([].concat(u16(id), u16(payload.length), payload)); }
  function latin1(s) { return Array.from(s, function(c) { return c.charCodeAt(0) & 0xff; }); }

  function segments(m) {
    if (m.length <= MTU_PAYLOAD) return [m];
    var out = [];
    for (var off = 0; off < m.length; off += MTU_PAYLOAD) {
      var part = Array.from(m.slice(off, off + MTU_PAYLOAD));
      var first = off === 0, last = off + MTU_PAYLOAD >= m.length;
      var p = first ? [0x01].concat(u32(m.length), part) : [last ? 0x02 : 0x00].concat(part);
      out.push(msg(0xA101, p));
    }
    return out;
  }

  function weekMs(secondsOfDay) {
    return (new Date().getDay() * 86400 + secondsOfDay) * 1000;
  }

  function family(cardNumber) {
    if (cardNumber >= 8000000 && cardNumber < 9000000) return 15;
    if (cardNumber >= 2000000 && cardNumber < 3000000) return 2;
    if (cardNumber >= 1000000 && cardNumber < 2000000) return 1;
    if (cardNumber >= 4000000 && cardNumber < 5000000) return 4;
    return 0;
  }

  function cardMessage(c) {
    var punches = [];
    function push(type, code, sec) { punches.push([0, type].concat(u16(code), u32(weekMs(sec)))); }
    push(2, 0, 36000);                                 // check 10:00:00
    if (c.punches.length > 0 || c.hasFinish) push(3, 0, 36300); // start 10:05:00
    c.punches.forEach(function(p) { push(7, p.controlCode, p.time); });
    if (c.hasFinish) push(5, 0, 38700);                // finish 10:45:00
    var fam = family(c.cardNumber);
    var payload = [].concat(u32(c.cardNumber), [fam], u16(punches.length));
    punches.forEach(function(p) { payload = payload.concat(p); });
    if (fam === 15) {
      // SIAC production block: hw 3.1, sw 6.4, signals, clears, 3050 mV, battery 2024-03-15, made 2023-11
      payload = payload.concat([31, 64], u16(120), u16(45), u16(3050), [24, 3, 15], [23, 11]);
    }
    var o = c.ownerData || {};
    var owner = latin1([o.firstName || "", o.lastName || "", "", "", o.club || ""].join(";")).concat([0]);
    payload = payload.concat([1], owner);
    return msg(0x1103, payload);
  }

  // ── State ──
  var state;
  function freshState() {
    return { connected: false, advertising: false, card: null, feedback: [], connects: 0, battery: 87 };
  }
  state = freshState();

  function Char(uuid) {
    var t = new EventTarget();
    t.uuid = uuid;
    t.value = null;
    t.notifying = false;
    t.startNotifications = function() { if (!state.connected) return Promise.reject(new Error("GATT Server is disconnected")); t.notifying = true; return Promise.resolve(t); };
    t.stopNotifications = function() { t.notifying = false; return Promise.resolve(t); };
    t.readValue = function() {
      if (!state.connected) return Promise.reject(new Error("GATT Server is disconnected"));
      if (uuid === UUID.batteryLevel) return Promise.resolve(new DataView(new Uint8Array([state.battery]).buffer));
      return Promise.resolve(t.value || new DataView(new ArrayBuffer(0)));
    };
    t.writeValueWithResponse = function(value) {
      if (!state.connected) return Promise.reject(new Error("GATT Server is disconnected"));
      var bytes = new Uint8Array(value.buffer ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value);
      setTimeout(function() { onWrite(uuid, bytes); }, 5);
      return Promise.resolve();
    };
    t.writeValue = t.writeValueWithResponse;
    t.notify = function(bytes) {
      if (!t.notifying || !state.connected) return;
      t.value = new DataView(bytes.buffer);
      t.dispatchEvent(new Event("characteristicvaluechanged"));
    };
    return t;
  }

  var chars = {};
  function freshChars() {
    [UUID.readSettings, UUID.writeSettings, UUID.cardState, UUID.cardData, UUID.batteryLevel].forEach(function(u) { chars[u] = Char(u); });
  }
  freshChars();

  function service(map) {
    return { getCharacteristic: function(u) { return map[u] ? Promise.resolve(chars[u]) : Promise.reject(new Error("NotFoundError: " + u)); } };
  }
  var services = {};
  services[UUID.settings] = service({ [UUID.readSettings]: 1, [UUID.writeSettings]: 1 });
  services[UUID.card] = service({ [UUID.cardState]: 1, [UUID.cardData]: 1 });
  services[UUID.sessions] = service({});
  services[UUID.battery] = service({ [UUID.batteryLevel]: 1 });

  function onWrite(uuid, bytes) {
    var id = bytes[0] | (bytes[1] << 8);
    if (uuid === UUID.readSettings) {
      if (id === 0x010E) {
        var sw = latin1("2.1.0").concat([0]);
        chars[UUID.readSettings].notify(msg(0x010E, [].concat(u32(500123), u16(0x00A7), [2, 1], u16(2025), [9, 30], u16(2025), [10, 1], sw)));
      } else if (id === 0x010C) {
        chars[UUID.readSettings].notify(msg(0x010C, [].concat(u16(1), [0x05])));
      } else if (id === 0x0110) {
        chars[UUID.readSettings].notify(msg(0x0110, [0]));
      }
    } else if (uuid === UUID.cardData) {
      if (id === 0x1103 && state.card) {
        segments(cardMessage(state.card)).forEach(function(s) { chars[UUID.cardData].notify(s); });
      } else if (id === 0x1110) {
        state.feedback.push(bytes[4]);
      }
    }
  }

  var device = new EventTarget();
  device.id = "mock-reader-bt-500123";
  device.name = "Reader BT 500123";
  device.watchingAdvertisements = false;
  device.watchAdvertisements = function(opts) {
    device.watchingAdvertisements = true;
    if (opts && opts.signal) opts.signal.addEventListener("abort", function() { device.watchingAdvertisements = false; });
    if (state.advertising) setTimeout(advertise, 10);
    return Promise.resolve();
  };
  device.forget = function() { setGranted(false); window.__readerBtForgotten = true; return Promise.resolve(); };

  function advertise() {
    if (device.watchingAdvertisements) device.dispatchEvent(new Event("advertisementreceived"));
  }

  function dropLink() {
    if (!state.connected) return;
    state.connected = false;
    Object.keys(chars).forEach(function(u) { chars[u].notifying = false; });
    device.dispatchEvent(new Event("gattserverdisconnected"));
  }

  device.gatt = {
    get connected() { return state.connected; },
    device: device,
    connect: function() {
      return new Promise(function(resolve) {
        setTimeout(function() {
          state.connected = true;
          state.advertising = false;
          state.connects++;
          resolve(device.gatt);
        }, 10);
      });
    },
    disconnect: function() { dropLink(); },
    getPrimaryService: function(u) {
      if (!state.connected) return Promise.reject(new Error("GATT Server is disconnected"));
      return services[u] ? Promise.resolve(services[u]) : Promise.reject(new Error("NotFoundError: " + u));
    },
  };

  // The browser's per-origin grant survives reloads; so does the mock's.
  var GRANT_KEY = "__readerBtMockGranted";
  var granted = (function() { try { return localStorage.getItem(GRANT_KEY) === "1"; } catch (e) { return false; } })();
  function setGranted(v) {
    granted = v;
    try { if (v) localStorage.setItem(GRANT_KEY, "1"); else localStorage.removeItem(GRANT_KEY); } catch (e) {}
  }
  var bluetooth = {
    requestDevice: function(options) {
      window.__readerBtLastRequest = options;
      setGranted(true);
      return Promise.resolve(device);
    },
    getDevices: function() { return Promise.resolve(granted ? [device] : []); },
    getAvailability: function() { return Promise.resolve(true); },
    addEventListener: function() {},
    removeEventListener: function() {},
  };

  Object.defineProperty(navigator, "bluetooth", { value: bluetooth, configurable: true });

  window.__readerBtMock = {
    insertCard: function(cardNumber, punches, options) {
      state.card = {
        cardNumber: cardNumber,
        punches: punches || [],
        hasFinish: !(options && options.hasFinish === false),
        ownerData: (options && options.ownerData) || null,
      };
      if (!state.connected) {
        // A card wakes a disconnected reader: it advertises for 20 s.
        state.advertising = true;
        advertise();
        return true;
      }
      chars[UUID.cardState].notify(msg(0x1101, [].concat(u32(cardNumber), [1], u16(1))));
      return true;
    },
    removeCard: function() {
      var cn = state.card ? state.card.cardNumber : 0;
      state.card = null;
      chars[UUID.cardState].notify(msg(0x1101, [].concat(u32(cn), [0], u16(1))));
      return true;
    },
    getFeedback: function() { return state.feedback.slice(); },
    simulateDisconnect: function() { dropLink(); },
    isConnected: function() { return state.connected; },
    connectCount: function() { return state.connects; },
    setBattery: function(p) {
      state.battery = p;
      chars[UUID.batteryLevel].notify(new Uint8Array([p]));
    },
    reset: function() { dropLink(); state = freshState(); },
  };
})();
`;
}
