import { describe, expect, it } from "vitest";
import {
  htmlApiErrorMessage,
  isHtmlResponseError,
  rejectHtmlApiResponse,
} from "../html-api-response";

describe("htmlApiErrorMessage", () => {
  it("detects an IAP / SPA HTML page that tRPC would otherwise JSON.parse", () => {
    expect(
      htmlApiErrorMessage(200, "text/html; charset=utf-8", "<html><head></head></html>"),
    ).toMatch(/sign-in session|reload/i);
    expect(
      htmlApiErrorMessage(401, "text/html", " <html><head><title>Sign in</title>"),
    ).toMatch(/sign-in session|reload/i);
  });

  it("calls out size and gateway failures instead of a JSON parse error", () => {
    expect(
      htmlApiErrorMessage(413, "text/html", "<html><head><title>413"),
    ).toMatch(/too large/i);
    expect(
      htmlApiErrorMessage(504, "text/html", "<html><head><title>504"),
    ).toMatch(/timed out|crashed/i);
  });

  it("ignores real JSON API bodies", () => {
    expect(
      htmlApiErrorMessage(500, "application/json", '{"error":{"message":"nope"}}'),
    ).toBeNull();
    expect(htmlApiErrorMessage(200, "application/json", '{"result":{}}')).toBeNull();
  });
});

describe("isHtmlResponseError", () => {
  it("matches the SyntaxError browsers throw when JSON.parse hits HTML", () => {
    const err = new SyntaxError(
      `Unexpected token '<', "<html><hea"... is not valid JSON`,
    );
    expect(isHtmlResponseError(err)).toBe(true);
    expect(isHtmlResponseError(new Error("Failed to fetch"))).toBe(false);
  });
});

describe("rejectHtmlApiResponse", () => {
  it("throws a readable error and leaves a JSON body readable by tRPC", async () => {
    const html = new Response("<html><head></head>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(rejectHtmlApiResponse(html)).rejects.toThrow(/sign-in session|reload/i);

    const json = new Response('{"result":{"data":true}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const passed = await rejectHtmlApiResponse(json);
    await expect(passed.json()).resolves.toEqual({ result: { data: true } });
  });
});
