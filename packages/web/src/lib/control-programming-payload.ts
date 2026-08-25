/**
 * Build the `control.recordProgramming` input from a station programming
 * round.
 *
 * SI stations report battery voltage in **volts** as a float
 * (`(raw * 5) / 65536`), while the API stores
 * `control_units.battery_voltage_mv` and validates an integer millivolt
 * range. Converting here keeps the boundary in one place, the same way
 * `toOfflineCardReadPayload` owns the seconds → deciseconds conversion
 * for card readouts.
 */

/** Below this the station needs a battery change before it goes out. */
export const LOW_BATTERY_VOLTS = 2.5;

interface RecordProgrammingStation {
  serialNo: number;
  firmwareVersion: string;
  modelId: number;
  modelName: string;
  srrEnabled: boolean;
}

export interface RecordProgrammingInput {
  controlId: number;
  stationSerial: number;
  programmedCode: number;
  batteryVoltageMv?: number;
  batteryLow?: boolean;
  firmwareVersion: string;
  modelId: number;
  modelName: string;
  memoryCleared: boolean;
  srrCfg: boolean;
}

export function toRecordProgrammingInput({
  controlId,
  programmedCode,
  batteryVoltage,
  stationInfo,
}: {
  controlId: number;
  programmedCode: number;
  /** Station reading in volts. */
  batteryVoltage: number;
  stationInfo: RecordProgrammingStation;
}): RecordProgrammingInput {
  // A station that reports 0 (or garbage) has no usable reading; sending
  // it would fail the API's plausibility range and lose the whole record.
  const hasReading = Number.isFinite(batteryVoltage) && batteryVoltage > 0;

  return {
    controlId,
    stationSerial: stationInfo.serialNo,
    programmedCode,
    ...(hasReading
      ? {
          batteryVoltageMv: Math.round(batteryVoltage * 1000),
          batteryLow: batteryVoltage < LOW_BATTERY_VOLTS,
        }
      : {}),
    firmwareVersion: stationInfo.firmwareVersion,
    modelId: stationInfo.modelId,
    modelName: stationInfo.modelName,
    memoryCleared: true,
    srrCfg: stationInfo.srrEnabled,
  };
}
