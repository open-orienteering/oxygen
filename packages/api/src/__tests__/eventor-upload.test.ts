import AdmZip from "adm-zip";
import { access, unlink } from "fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  meosStatusToIof,
  uploadResults,
  uploadStartList,
  type ResultForUpload,
} from "../eventor.js";

const EVENT_DATE = "2026-08-23";

/** Path the upload used to dump its generated XML to. */
const DEBUG_ARTIFACT = "/tmp/eventor-resultlist.xml";

interface Captured {
  url: string;
  apiKey: string | undefined;
  body: Buffer;
}

/**
 * Stub `fetch` and record what the uploader sent. The Eventor client calls
 * bare `fetch`, so stubbing the global observes the request without network
 * access.
 */
function captureUploads(status = 200, responseBody = "OK"): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        apiKey: headers.ApiKey,
        body: Buffer.from(init?.body as Uint8Array),
      });
      return new Response(responseBody, { status });
    }),
  );
  return calls;
}

/** Read a single named entry out of the uploaded ZIP. */
function unzip(body: Buffer, entryName: string): string {
  const entry = new AdmZip(body)
    .getEntries()
    .find((e) => e.entryName === entryName);
  if (!entry) throw new Error(`no ${entryName} in uploaded zip`);
  return entry.getData().toString("utf-8");
}

function runner(overrides: Partial<ResultForUpload> = {}): ResultForUpload {
  return {
    personExtId: "555",
    name: "Doe, Jane",
    className: "H21",
    classExtId: "101",
    clubName: "Test OK",
    clubExtId: "77",
    cardNo: 8123456,
    startTime: 324600, // 09:01:00
    finishTime: 330600, // 09:11:00
    status: 1,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Eventor uploads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a zipped IOF 3.0 ResultList to import/resultlist", async () => {
    const calls = captureUploads();

    await uploadResults("secret", "12345", "Test Event", EVENT_DATE, [runner()]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://eventor.orientering.se/api/import/resultlist",
    );
    expect(calls[0].apiKey).toBe("secret");

    const xml = unzip(calls[0].body, "resultlist.xml");
    expect(xml).toContain('<ResultList xmlns=');
    expect(xml).toContain('iofVersion="3.0"');
    expect(xml).toContain(`<StartTime>${EVENT_DATE}T09:01:00</StartTime>`);
  });

  it("posts a zipped IOF 3.0 StartList to import/startlist", async () => {
    const calls = captureUploads();

    await uploadStartList("secret", "12345", "Test Event", EVENT_DATE, [
      runner(),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://eventor.orientering.se/api/import/startlist",
    );

    const xml = unzip(calls[0].body, "startlist.xml");
    expect(xml).toContain("<StartList");
    expect(xml).toContain(`<StartTime>${EVENT_DATE}T09:01:00</StartTime>`);
    expect(xml).toContain("<ControlCard>8123456</ControlCard>");
  });

  it("targets the test host when the event is linked to Test-Eventor", async () => {
    const calls = captureUploads();

    await uploadStartList(
      "secret",
      "12345",
      "Test Event",
      EVENT_DATE,
      [runner()],
      "test",
    );

    expect(calls[0].url).toBe(
      "https://eventor-sweden-test.orientering.se/api/import/startlist",
    );
  });

  it("leaves no generated XML behind on disk", async () => {
    if (await exists(DEBUG_ARTIFACT)) await unlink(DEBUG_ARTIFACT);
    captureUploads();

    await uploadResults("secret", "12345", "Test Event", EVENT_DATE, [runner()]);

    expect(await exists(DEBUG_ARTIFACT)).toBe(false);
  });

  it("names the rejected endpoint when Eventor refuses the upload", async () => {
    captureUploads(400, "Must be exactly one event class");

    await expect(
      uploadResults("secret", "12345", "Test Event", EVENT_DATE, [runner()]),
    ).rejects.toThrow(
      /import\/resultlist.*400.*Must be exactly one event class/s,
    );
  });
});

describe("meosStatusToIof (RES-21)", () => {
  it("reports a runner without a result as Inactive, Active or Finished", () => {
    expect(meosStatusToIof(0, false, false)).toBe("Inactive");
    expect(meosStatusToIof(0, false, true)).toBe("Active");
    expect(meosStatusToIof(0, true, true)).toBe("Finished");
    expect(meosStatusToIof(0, true, false)).toBe("Finished");
  });

  it("keeps the fixed statuses", () => {
    expect(meosStatusToIof(1, true)).toBe("OK");
    expect(meosStatusToIof(3, true)).toBe("MissingPunch");
    expect(meosStatusToIof(15, true)).toBe("NotCompeting");
    expect(meosStatusToIof(15, false)).toBe("NotCompeting");
    expect(meosStatusToIof(20, false)).toBe("DidNotStart");
  });
});

describe("result upload status for unfinished runners (RES-21)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads runners in the forest as Active and not yet started as Inactive, never DidNotStart or OK", async () => {
    const calls = captureUploads();
    await uploadResults("secret", "12345", "Test Event", EVENT_DATE, [
      runner({ name: "Forest, Fia", status: 0, finishTime: undefined, started: true }),
      runner({ name: "Later, Lo", status: 0, finishTime: undefined, started: false }),
      runner({ name: "Done, Dan", status: 0, started: true }),
    ]);
    const xml = unzip(calls[0].body, "resultlist.xml");
    const results = xml.split("<PersonResult>").slice(1);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("<Status>Active</Status>");
    expect(results[1]).toContain("<Status>Inactive</Status>");
    expect(results[2]).toContain("<Status>Finished</Status>");
    for (const r of results) {
      expect(r).not.toContain("<Time>");
      expect(r).not.toContain("<Position>");
    }
    expect(xml).not.toContain("DidNotStart");
  });
});
