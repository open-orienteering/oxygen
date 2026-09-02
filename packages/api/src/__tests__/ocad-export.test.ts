import { describe, it, expect } from "vitest";
import {
  canDownloadClubLibraryMap,
  canDownloadEventMap,
} from "../ocad-export.js";

describe("canDownloadEventMap", () => {
  it("allows everything when auth is off", () => {
    expect(
      canDownloadEventMap({
        authEnabled: false,
        isAdmin: false,
        fromClubLibrary: true,
      }),
    ).toBe(true);
  });

  it("lets an event manager download a map the event uploaded itself", () => {
    expect(
      canDownloadEventMap({
        authEnabled: true,
        isAdmin: false,
        fromClubLibrary: false,
      }),
    ).toBe(true);
  });

  it("keeps a club-library copy behind instance admin", () => {
    expect(
      canDownloadEventMap({
        authEnabled: true,
        isAdmin: false,
        fromClubLibrary: true,
      }),
    ).toBe(false);
    expect(
      canDownloadEventMap({
        authEnabled: true,
        isAdmin: true,
        fromClubLibrary: true,
      }),
    ).toBe(true);
  });
});

describe("canDownloadClubLibraryMap", () => {
  it("allows everything when auth is off", () => {
    expect(
      canDownloadClubLibraryMap({
        authEnabled: false,
        isAdmin: false,
        isUploader: false,
      }),
    ).toBe(true);
  });

  it("matches the delete ACL: uploader or instance admin", () => {
    expect(
      canDownloadClubLibraryMap({
        authEnabled: true,
        isAdmin: false,
        isUploader: false,
      }),
    ).toBe(false);
    expect(
      canDownloadClubLibraryMap({
        authEnabled: true,
        isAdmin: false,
        isUploader: true,
      }),
    ).toBe(true);
    expect(
      canDownloadClubLibraryMap({
        authEnabled: true,
        isAdmin: true,
        isUploader: false,
      }),
    ).toBe(true);
  });
});
