export const CLUB_CONTROL_TYPES = ["normal", "srr"] as const;
export type ClubControlType = (typeof CLUB_CONTROL_TYPES)[number];

export interface SeriesAllocationEntry {
  code: number;
  type: ClubControlType;
  seriesId: string;
  seriesName: string;
  borrowed: boolean;
}

export interface ClubClassPreset {
  id: string;
  name: string;
  sex: "" | "M" | "F";
  lowAge: number;
  highAge: number;
  classType: string;
  noTiming: boolean;
  freeStart: boolean;
  allowQuickEntry: boolean;
  sortIndex: number;
  createdAt: string;
  updatedAt: string;
}
