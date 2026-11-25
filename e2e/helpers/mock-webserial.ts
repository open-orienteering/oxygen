/**
 * Mock WebSerial API for Playwright E2E tests.
 *
 * This script is injected via page.addInitScript() before page code runs.
 * It replaces navigator.serial with a controllable fake implementation.
 *
 * Usage from tests:
 *   await page.evaluate(() => window.__siMock.insertCard(cardNumber, punches));
 *   await page.evaluate(() => window.__siMock.removeCard());
 */

// This is executed in the browser context via addInitScript
export function getMockWebSerialScript(): string {
  return `
(function() {
  // ── SI Protocol helpers (minimal subset for building frames) ──

  function calculateCRC(data) {
    if (!data || data.length < 2) return 0;
    let idx = 0;
    let crc = (data[idx] << 8) + data[idx + 1];
    idx += 2;
    if (data.length === 2) return crc;
    const count = data.length;
    for (let k = Math.floor(count / 2); k > 0; k--) {
      let value;
      if (k > 1) { value = (data[idx] << 8) + data[idx + 1]; idx += 2; }
      else { value = (count & 1) ? data[idx] << 8 : 0; }
      for (let j = 0; j < 16; j++) {
        if (crc & 0x8000) { crc = (crc << 1) & 0xFFFF; if (value & 0x8000) crc++; crc ^= 0x8005; }
        else { crc = (crc << 1) & 0xFFFF; if (value & 0x8000) crc++; }
        value = (value << 1) & 0xFFFF;
      }
    }
    return crc & 0xFFFF;
  }

  function buildFrame(cmd, data) {
    const len = data.length;
    const crcInput = new Uint8Array([cmd, len, ...data]);
    const crc = calculateCRC(crcInput);
    return new Uint8Array([
      0x02, cmd, len, ...data,
      (crc >> 8) & 0xFF, crc & 0xFF, 0x03
    ]);
  }

  // Series byte (block 0 offset 24, low nibble) per card number range.
  // 1=SI9, 2=SI8, 4=pCard, 15=SI10/SI11/SIAC (docs/si-protocol/card-layouts.md).
  function seriesOf(cardNumber) {
    if (isLargeCard(cardNumber)) return 0x0F;
    if (cardNumber >= 4000000 && cardNumber <= 4999999) return 0x04;
    if (cardNumber >= 1000000 && cardNumber <= 1999999) return 0x01;
    return 0x02;
  }

  function buildDetectionFrame(cardNumber) {
    // SI8+ detection (0xE8): station(2) + series(1) + cardNumber(3)
    const cn3 = (cardNumber >> 16) & 0xFF;
    const cn2 = (cardNumber >> 8) & 0xFF;
    const cn1 = cardNumber & 0xFF;
    return buildFrame(0xE8, [0x00, 0x7D, seriesOf(cardNumber), cn3, cn2, cn1]);
  }

  function buildCardRemovedFrame() {
    return buildFrame(0xE7, [0x00, 0x7D, 0x00, 0x00, 0x00, 0x00]);
  }

  // First punch slot (byte offset in the concatenated 256-byte image) and
  // capacity of the small card layouts. SI8 is 136 / 30 (captured), SI9 56 / 50
  // and pCard 176 / 20 (MeOS layout).
  function smallLayout(cardNumber) {
    const series = seriesOf(cardNumber);
    if (series === 0x01) return { first: 56, max: 50 };
    if (series === 0x04) return { first: 176, max: 20 };
    return { first: 136, max: 30 };
  }

  function buildReadoutBlock(cardNumber, punches, blockNum, hasFinish) {
    const block = new Uint8Array(128);
    // Fill with 0xEE (no-data sentinel) to properly mark unused areas
    block.fill(0xEE);

    const large = isLargeCard(cardNumber);

    if (!large) {
      // === SI8 / SI9 / pCard: two blocks, one 256-byte image ===
      const image = new Uint8Array(256);
      image.fill(0xEE);
      // Header and owner area (bytes 0-first punch) are zero, as on a real SI8
      for (let i = 0; i < smallLayout(cardNumber).first; i++) image[i] = 0;
      image[24] = seriesOf(cardNumber);
      image[25] = (cardNumber >> 16) & 0xFF;
      image[26] = (cardNumber >> 8) & 0xFF;
      image[27] = cardNumber & 0xFF;
      image[22] = punches.length;
      image[10] = (36000 >> 8) & 0xFF; // check 10:00:00
      image[11] = 36000 & 0xFF;
      if (punches.length > 0 || hasFinish) {
        image[14] = (36300 >> 8) & 0xFF; // start 10:05:00
        image[15] = 36300 & 0xFF;
      } else {
        image[14] = 0xEE;
        image[15] = 0xEE;
      }
      if (hasFinish) {
        image[18] = (38700 >> 8) & 0xFF; // finish 10:45:00
        image[19] = 38700 & 0xFF;
      } else {
        image[18] = 0xEE;
        image[19] = 0xEE;
      }
      const layout = smallLayout(cardNumber);
      for (let i = 0; i < Math.min(punches.length, layout.max); i++) {
        const p = punches[i];
        const off = layout.first + i * 4;
        image[off] = 0; // PTD
        image[off + 1] = p.controlCode;
        image[off + 2] = (p.time >> 8) & 0xFF;
        image[off + 3] = p.time & 0xFF;
      }
      return image.slice(blockNum * 128, blockNum * 128 + 128);
    }

    if (blockNum === 0) {
      // === Block 0: Header (same offsets for SI8 and SI10) ===
      // Clear first 32 bytes (header area)
      for (let i = 0; i < 32; i++) block[i] = 0;
      block[24] = seriesOf(cardNumber);
      // Card number at offsets 25-27
      block[25] = (cardNumber >> 16) & 0xFF;
      block[26] = (cardNumber >> 8) & 0xFF;
      block[27] = cardNumber & 0xFF;
      // Punch count at offset 22
      block[22] = punches.length;
      // Check time at offset 10-11 (10:00:00 = 36000s)
      block[10] = (36000 >> 8) & 0xFF;
      block[11] = 36000 & 0xFF;
      if (punches.length > 0 || hasFinish) {
        // Start time at offset 14-15 (10:05:00 = 36300s)
        block[14] = (36300 >> 8) & 0xFF;
        block[15] = 36300 & 0xFF;
      } else {
        block[14] = 0xEE;
        block[15] = 0xEE;
      }
      if (hasFinish) {
        // Finish time at offset 18-19 (10:45:00 = 38700s)
        block[18] = (38700 >> 8) & 0xFF;
        block[19] = 38700 & 0xFF;
      } else {
        block[18] = 0xEE;
        block[19] = 0xEE;
      }

      // SI10/SIAC: personal data starts at offset 32 (not punches)
      const personalBytes = buildPersonalDataBytes(currentOwnerData);
      for (let i = 0; i < Math.min(personalBytes.length, 96) && i + 32 < 128; i++) {
        block[32 + i] = personalBytes[i];
      }
      // Terminate personal data with 0xEE (already filled)
    } else if (blockNum >= 1 && blockNum <= 3) {
      // === SI10 Blocks 1-3: Personal data continuation ===
      // Personal data that overflows from block 0 offset 32 (96 bytes)
      const personalBytes = buildPersonalDataBytes(currentOwnerData);
      const block0PersonalLen = Math.min(personalBytes.length, 96);
      const remaining = personalBytes.slice(block0PersonalLen);
      const blockStart = (blockNum - 1) * 128;
      for (let i = 0; i < 128 && blockStart + i < remaining.length; i++) {
        block[i] = remaining[blockStart + i];
      }
    } else if (blockNum >= 4) {
      // === SI10 Blocks 4-7: Punches ===
      const punchBlockIdx = blockNum - 4; // 0-3
      const punchStart = punchBlockIdx * 32; // 32 punches per block
      for (let i = 0; i < 32 && punchStart + i < punches.length; i++) {
        const p = punches[punchStart + i];
        const off = i * 4;
        block[off] = 0; // PTD
        block[off + 1] = p.controlCode;
        block[off + 2] = (p.time >> 8) & 0xFF;
        block[off + 3] = p.time & 0xFF;
      }
    }
    return block;
  }

  function buildReadoutResponseFrame(blockData, blockNum) {
    // Station code (2 bytes) + block number (1 byte) + block data (128 bytes) = 131 bytes
    const data = new Uint8Array(131);
    data[0] = 0x00; data[1] = 0x7D; // station code
    data[2] = blockNum || 0; // block number
    data.set(blockData, 3);
    return buildFrame(0xEF, Array.from(data));
  }

  // ── Mock state ──

  let readController = null;
  let writtenData = [];
  let connected = false;
  let cardInserted = false;
  let currentCardNumber = 0;
  let currentPunches = [];
  let currentHasFinish = true;
  let currentOwnerData = null; // { firstName, lastName, club, ... }
  let pendingBlockRequests = [];

  // Check if a card number corresponds to an SI10/SI11/SIAC card
  function isLargeCard(cn) {
    return (cn >= 7000001 && cn <= 9999999) || (cn >= 14000001 && cn <= 16999999);
  }

  // Encode a string to CP850 bytes (simplified: ASCII + Scandinavian chars)
  function encodeCp850(str) {
    const cp850Map = {
      'å': 0x86, 'ä': 0x84, 'ö': 0x94, 'Å': 0x8F, 'Ä': 0x8E, 'Ö': 0x99,
      'æ': 0x91, 'Æ': 0x92, 'ø': 0x9B, 'Ø': 0x9D, 'ü': 0x81, 'Ü': 0x9A,
      'é': 0x82, 'É': 0x90, 'è': 0x8A, 'ê': 0x88, 'ë': 0x89,
      'á': 0xA0, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3, 'ñ': 0xA4, 'Ñ': 0xA5,
    };
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (cp850Map[ch] !== undefined) {
        bytes.push(cp850Map[ch]);
      } else {
        bytes.push(ch.charCodeAt(0) & 0xFF);
      }
    }
    return bytes;
  }

  // Build semicolon-separated personal data bytes for SI10/SIAC
  function buildPersonalDataBytes(ownerData) {
    if (!ownerData) return [];
    const fields = [
      ownerData.firstName || '',
      ownerData.lastName || '',
      ownerData.sex || '',
      ownerData.dateOfBirth || '',
      ownerData.club || '',
      ownerData.email || '',
      ownerData.phone || '',
      ownerData.city || '',
      ownerData.street || '',
      ownerData.postcode || '',
      ownerData.country || '',
    ];
    return encodeCp850(fields.join(';'));
  }

  function enqueueBytes(bytes) {
    if (readController) {
      readController.enqueue(new Uint8Array(bytes));
    }
  }

  // ── Mock Serial Port ──

  const mockPort = {
    getInfo: () => ({ usbVendorId: 0x10C4, usbProductId: 0xEA60 }),

    open: async (options) => {
      connected = true;
      writtenData = [];
    },

    close: async () => {
      connected = false;
      readController = null;
    },

    get readable() {
      if (!connected) return null;
      return new ReadableStream({
        start(controller) {
          readController = controller;
        },
        cancel() {
          readController = null;
        }
      });
    },

    get writable() {
      if (!connected) return null;
      return new WritableStream({
        write(chunk) {
          const bytes = new Uint8Array(chunk);
          writtenData.push(bytes);

          // Check if this is a read command (0xEF) and respond
          // Frame sent by client: WAKEUP + STX + CMD(0xEF) + LEN(1) + BLOCK_NUM + CRC(2) + ETX
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0xEF && cardInserted && i + 2 < bytes.length) {
              // LEN byte is at i+1, BLOCK_NUM at i+2
              const blockNum = bytes[i + 2];
              setTimeout(() => {
                const blockData = buildReadoutBlock(currentCardNumber, currentPunches, blockNum, currentHasFinish);
                const response = buildReadoutResponseFrame(blockData, blockNum);
                enqueueBytes(response);
              }, 10);
            }
          }
        }
      });
    }
  };

  // ── Mock navigator.serial ──

  const mockSerial = {
    requestPort: async (options) => {
      return mockPort;
    },

    getPorts: async () => {
      return connected ? [mockPort] : [];
    },

    addEventListener: (type, listener) => {
      // No-op for now
    },

    removeEventListener: (type, listener) => {
      // No-op for now
    }
  };

  // Install mock
  Object.defineProperty(navigator, 'serial', {
    value: mockSerial,
    writable: false,
    configurable: true
  });

  // ── Global test control API ──

  window.__siMock = {
    insertCard: function(cardNumber, punches, options) {
      cardInserted = true;
      currentCardNumber = cardNumber;
      currentPunches = punches || [];
      currentHasFinish = options && options.hasFinish === false ? false : true;
      currentOwnerData = (options && options.ownerData) || null;

      // Send detection frame
      const detFrame = buildDetectionFrame(cardNumber);
      enqueueBytes(detFrame);

      return true;
    },

    removeCard: function() {
      cardInserted = false;
      const frame = buildCardRemovedFrame();
      enqueueBytes(frame);
      return true;
    },

    isConnected: function() {
      return connected;
    },

    getWrittenData: function() {
      return writtenData;
    },

    reset: function() {
      connected = false;
      cardInserted = false;
      currentCardNumber = 0;
      currentPunches = [];
      currentHasFinish = true;
      currentOwnerData = null;
      writtenData = [];
      readController = null;
    }
  };
})();
`;
}
