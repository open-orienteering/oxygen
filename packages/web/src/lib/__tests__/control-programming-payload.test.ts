/**
 * The station programming payload builder is the volts → millivolts
 * boundary. `control.recordProgramming` stores
 * `control_units.battery_voltage_mv` and validates an integer, while SI
 * hardware reports volts as a float — sending the raw reading made the
 * mutation fail input validation, so nothing was ever persisted.
 */

import { describe, expect, it } from "vitest";
import { toRecordProgrammingInput } from "../control-programming-payload";

const stationInfo = {
  serialNo: 412_345,
  firmwareVersion: "5.93",
  modelId: 105,
  modelName: "BS11-BL",
  srrEnabled: true,
};

describe("toRecordProgrammingInput", () => {
  it("converts the station's volts reading to integer millivolts", () => {
    const input = toRecordProgrammingInput({
      controlId: 82,
      programmedCode: 82,
      batteryVoltage: 3.2137,
      stationInfo,
    });
    expect(input.batteryVoltageMv).toBe(3214);
    expect(Number.isInteger(input.batteryVoltageMv)).toBe(true);
  });

  it("omits the voltage when the station reported no usable reading", () => {
    for (const batteryVoltage of [0, Number.NaN]) {
      const input = toRecordProgrammingInput({
        controlId: 82,
        programmedCode: 82,
        batteryVoltage,
        stationInfo,
      });
      expect(input.batteryVoltageMv).toBeUndefined();
      expect(input.batteryLow).toBeUndefined();
    }
  });

  it("flags a low battery below the 2.5 V service threshold", () => {
    expect(
      toRecordProgrammingInput({
        controlId: 82,
        programmedCode: 82,
        batteryVoltage: 2.42,
        stationInfo,
      }).batteryLow,
    ).toBe(true);
    expect(
      toRecordProgrammingInput({
        controlId: 82,
        programmedCode: 82,
        batteryVoltage: 2.62,
        stationInfo,
      }).batteryLow,
    ).toBe(false);
  });

  it("carries the station identity the Controls list renders", () => {
    const input = toRecordProgrammingInput({
      controlId: 82,
      programmedCode: 100,
      batteryVoltage: 3.0,
      stationInfo,
    });
    expect(input).toMatchObject({
      controlId: 82,
      stationSerial: 412_345,
      programmedCode: 100,
      firmwareVersion: "5.93",
      modelId: 105,
      modelName: "BS11-BL",
      srrCfg: true,
      memoryCleared: true,
    });
  });
});
