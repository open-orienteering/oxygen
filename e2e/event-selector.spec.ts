import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    /** Set by the iOS permission stub below — counts real prompts shown. */
    __iosPromptCount?: number;
  }
}

test.describe("Event selector", () => {
  test("groups seed events under Past and filters by search", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByTestId("event-group-past")).toBeVisible();
    await expect(page.getByTestId("event-group-past").getByText("My example tävling")).toBeVisible();
    await expect(page.getByTestId("event-type-filter")).toBeVisible();

    await page.getByTestId("event-search").fill("example");
    await expect(page.getByText("My example tävling").first()).toBeVisible();
    await expect(page.getByText("itest_multirace")).toHaveCount(0);

    await page.getByTestId("event-search").fill("zzzz-no-such-event");
    await expect(page.getByText("No events match the current search.")).toBeVisible();
    await page.getByTestId("clear-event-filters").click();
    await expect(page.getByText("My example tävling").first()).toBeVisible();
  });

  test("event row keeps event type and creator visible on mobile", async ({ page }) => {
    // Owner attribution comes from the creator's grant, so the row has to
    // be one we made ourselves — the seed events have no owning user.
    const uniqueName = `E2E Row Layout ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await page.goto("/");
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.locator("li", { hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 10000 });

    const owner = row.getByTestId("event-owner");
    await expect(owner).toBeVisible();
    // On a phone only the bare name is shown; "Created by" is desktop-only.
    // (useInnerText so the display:none desktop span is not counted.)
    await expect(owner).not.toContainText("Created by", { useInnerText: true });
    const ownerName = (await owner.innerText()).trim();
    expect(ownerName.length).toBeGreaterThan(0);
    const eventType = row.getByTestId("event-type");
    await expect(eventType).toHaveText("Competition");
    await expect(row.getByText(/E2E_Row_Layout/)).toHaveCount(0);
    const typeBox = (await eventType.boundingBox())!;
    const ownerBox = (await owner.boundingBox())!;

    // Same line: their vertical centres coincide within a pixel or two.
    const slugMid = typeBox.y + typeBox.height / 2;
    const ownerMid = ownerBox.y + ownerBox.height / 2;
    expect(Math.abs(slugMid - ownerMid)).toBeLessThan(4);
    // Creator is pushed to the right rather than jammed against the type.
    expect(ownerBox.x).toBeGreaterThan(typeBox.x + typeBox.width);

    // Widen back out: the full attribution returns.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(owner).toHaveText(`Created by ${ownerName}`, { useInnerText: true });

    // Clean up.
    const createdRow = page.locator("li", { hasText: uniqueName });
    await createdRow.hover();
    await createdRow.getByTestId("event-delete").click();
    await page.getByTestId("delete-event-confirm").click();
    await expect(createdRow).toHaveCount(0);
  });

  test("phone layout: no tagline, filters fit the screen, chrome lives in the footer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({
      timeout: 10000,
    });

    // The "Select an event to manage" tagline is desktop-only.
    await expect(page.getByText("Select an event to manage")).toBeHidden();

    // The type select used to keep its widest option's intrinsic width and
    // run off the right edge; now every filter control sits inside the
    // viewport.
    for (const id of ["event-search", "event-type-filter", "event-mine-filter"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box, id).not.toBeNull();
      expect(box.x, `${id} left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${id} right edge`).toBeLessThanOrEqual(390);
    }

    // Signed-in user and language switcher moved from the header to the
    // footer, below the action buttons.
    const footer = page.getByTestId("selector-footer");
    await expect(footer.getByTestId("user-chip")).toBeVisible();
    await expect(footer.getByRole("button", { name: /English|Svenska/ })).toBeVisible();
    const footerBox = (await footer.boundingBox())!;
    const logoBox = (await page.getByTestId("oxygen-logo").boundingBox())!;
    expect(footerBox.y).toBeGreaterThan(logoBox.y + logoBox.height);
    const settingsBox = (await page.getByTestId("settings-link").boundingBox())!;
    expect(footerBox.y).toBeGreaterThan(settingsBox.y + settingsBox.height);

    // The tagline comes back on a desktop viewport.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText("Select an event to manage")).toBeVisible();
  });

  test("delete button is always visible on a touch device", async ({ browser }) => {
    // Desktop Chromium reports (hover: hover), so the icon is hover-revealed
    // there; a touch context flips the media query and the icon must be
    // visible without any hover at all.
    const touch = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-forwarded-email": "e2e-admin@oxygen.test" },
    });
    try {
      const page = await touch.newPage();
      await page.goto("/");
      const row = page.locator("li", { hasText: "My example tävling" }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      const del = row.getByTestId("event-delete");
      await expect(del).toBeVisible();
      const opacity = await del.evaluate((el) => getComputedStyle(el).opacity);
      expect(Number(opacity)).toBe(1);
      const box = (await del.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    } finally {
      await touch.close();
    }
  });

  test("delete button stays hover-revealed on a mouse device", async ({ page }) => {
    await page.goto("/");
    const row = page.locator("li", { hasText: "My example tävling" }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    const del = row.getByTestId("event-delete");
    expect(Number(await del.evaluate((el) => getComputedStyle(el).opacity))).toBe(0);
    await row.hover();
    await expect
      .poll(async () => Number(await del.evaluate((el) => getComputedStyle(el).opacity)))
      .toBe(1);
  });

  test("My events keeps only events the signed-in user administers", async ({ page }) => {
    // Seed events have no owning user; one we create is auto-granted to us.
    const uniqueName = `E2E Mine ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("My example tävling").first()).toBeVisible();

    const mine = page.getByTestId("event-mine-filter");
    await expect(mine).toHaveAttribute("aria-pressed", "false");
    await mine.click();
    await expect(mine).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(uniqueName).first()).toBeVisible();
    await expect(page.getByText("My example tävling")).toHaveCount(0);

    // Composes with search; "Clear filters" resets the toggle too.
    await page.getByTestId("event-search").fill("example");
    await expect(page.getByText("No events match the current search.")).toBeVisible();
    await page.getByTestId("clear-event-filters").click();
    await expect(mine).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("My example tävling").first()).toBeVisible();

    // Clean up.
    const createdRow = page.locator("li", { hasText: uniqueName });
    await createdRow.hover();
    await createdRow.getByTestId("event-delete").click();
    await page.getByTestId("delete-event-confirm").click();
    await expect(createdRow).toHaveCount(0);
  });

  test("manifest provides authenticated install metadata and PNG icons", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "crossorigin",
      "use-credentials",
    );
    const manifestResponse = await request.get("/manifest.webmanifest");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/pwa-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/pwa-512.png", sizes: "512x512" }),
      ]),
    );
    await expect((await request.get("/pwa-192.png")).ok()).toBeTruthy();
    await expect((await request.get("/pwa-512.png")).ok()).toBeTruthy();
    await expect((await request.get("/apple-touch-icon.png")).ok()).toBeTruthy();

    // The favicon is the compass-rose mark, not the bare flag it used to be.
    const favicon = await request.get("/favicon.svg");
    expect(favicon.ok()).toBeTruthy();
    expect(await favicon.text()).toContain("Compass rose");
  });

  test("landing page shows the compass logo and turns the needle to a live heading", async ({
    page,
  }) => {
    await page.goto("/");
    const logo = page.getByTestId("oxygen-logo");
    await expect(logo).toBeVisible();
    // The old text badge is gone.
    await expect(page.getByText("O2", { exact: true })).toHaveCount(0);

    // Desktop Chromium needs no permission prompt, so the live wrapper is
    // rendered and listening; with no sensor the needle rests at north.
    const live = page.getByTestId("oxygen-logo-live");
    await expect(live).toBeVisible();
    const needle = page.getByTestId("oxygen-logo-needle");
    await expect(needle).toHaveAttribute("data-angle", "0");

    // Fake a device pointing east: alpha is counter-clockwise from north,
    // so alpha 270 ⇒ heading 90 ⇒ the needle swings 90° counter-clockwise.
    await page.evaluate(() => {
      window.dispatchEvent(
        new DeviceOrientationEvent("deviceorientationabsolute", {
          alpha: 270,
          beta: 0,
          gamma: 0,
          absolute: true,
        }),
      );
    });
    await expect(live).toHaveAttribute("data-heading", "90");
    await expect(needle).toHaveAttribute("data-angle", "-90");

    // Crossing the 0/360 seam takes the short way round (continuous angle).
    await page.evaluate(() => {
      window.dispatchEvent(
        new DeviceOrientationEvent("deviceorientationabsolute", {
          alpha: 10, // heading 350
          beta: 0,
          gamma: 0,
          absolute: true,
        }),
      );
    });
    await expect(live).toHaveAttribute("data-heading", "350");
    await expect(needle).toHaveAttribute("data-angle", "10");

    // A relative (non-absolute) reading must be ignored.
    await page.evaluate(() => {
      window.dispatchEvent(
        new DeviceOrientationEvent("deviceorientationabsolute", {
          alpha: 180,
          beta: 0,
          gamma: 0,
          absolute: false,
        }),
      );
    });
    await expect(live).toHaveAttribute("data-heading", "350");
  });

  test("iOS motion permission is asked once and restored on later starts", async ({ page }) => {
    // Chromium needs no permission, so stand in for iOS by bolting a
    // requestPermission() onto DeviceOrientationEvent. It mimics WebKit: an
    // existing grant resolves silently, otherwise the call needs a user
    // gesture to prompt and rejects without one. Transient activation is
    // tracked with our own listener rather than navigator.userActivation,
    // which stays active across a Playwright reload and would let the
    // gesture-less probe through. The grant itself lives in sessionStorage
    // so it survives a reload the way iOS remembers it per origin.
    const GRANT = "ios-compass-granted";
    const installIosStub = (revoked = false) => `
      (() => {
        const revoked = ${String(revoked)};
        if (revoked) sessionStorage.removeItem(${JSON.stringify(GRANT)});
        let gestureAt = 0;
        const mark = () => { gestureAt = Date.now(); };
        addEventListener("pointerdown", mark, true);
        addEventListener("click", mark, true);
        window.__iosPromptCount = 0;
        window.DeviceOrientationEvent.requestPermission = () => {
          if (sessionStorage.getItem(${JSON.stringify(GRANT)})) return Promise.resolve("granted");
          if (Date.now() - gestureAt > 1000) {
            return Promise.reject(new DOMException("needs a user gesture", "NotAllowedError"));
          }
          window.__iosPromptCount++;
          sessionStorage.setItem(${JSON.stringify(GRANT)}, "1");
          return Promise.resolve("granted");
        };
      })();
    `;

    await page.addInitScript(installIosStub());
    await page.goto("/");

    // First visit: nothing remembered, so the logo is a tap target and the
    // sensor stays shut.
    const enable = page.getByTestId("oxygen-logo-enable-compass");
    await expect(enable).toBeVisible();
    await expect(page.getByTestId("oxygen-logo-live")).toHaveCount(0);

    await enable.click();
    const live = page.getByTestId("oxygen-logo-live");
    await expect(live).toHaveAttribute("data-permission", "granted");
    expect(await page.evaluate(() => window.__iosPromptCount)).toBe(1);
    expect(
      await page.evaluate(() => localStorage.getItem("oxygen.compass.granted")),
    ).toBe("1");

    // Restart the app: the remembered grant is restored without a tap and
    // without a second prompt.
    await page.reload();
    await expect(page.getByTestId("oxygen-logo-live")).toHaveAttribute(
      "data-permission",
      "granted",
    );
    await expect(page.getByTestId("oxygen-logo-enable-compass")).toHaveCount(0);
    expect(await page.evaluate(() => window.__iosPromptCount)).toBe(0);

    // The needle is live straight away, no interaction needed.
    await page.evaluate(() => {
      window.dispatchEvent(
        new DeviceOrientationEvent("deviceorientationabsolute", {
          alpha: 270,
          beta: 0,
          gamma: 0,
          absolute: true,
        }),
      );
    });
    await expect(page.getByTestId("oxygen-logo-needle")).toHaveAttribute("data-angle", "-90");

    // If iOS has since revoked the grant the gesture-less probe rejects, so
    // the tap target comes back and the stale memo is dropped.
    await page.addInitScript(installIosStub(true));
    await page.reload();
    await expect(page.getByTestId("oxygen-logo-enable-compass")).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("oxygen.compass.granted")),
    ).toBeNull();
  });

  test("create form has no advanced MySQL fields and can open an event", async ({
    page,
  }) => {
    const uniqueName = `E2E Selector ${Date.now()}`;
    const dbName = uniqueName.replace(/[^a-zA-Z0-9]/g, "_");

    await page.goto("/");
    await expect(page.getByRole("button", { name: /New Event/ })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: /New Event/ }).click();
    await expect(page.getByRole("heading", { name: "New Event" })).toBeVisible();
    await expect(page.getByText("Show advanced options")).toHaveCount(0);
    await expect(page.getByTestId("event-advanced-toggle")).toHaveCount(0);

    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByTestId("new-event-type").selectOption("club_training");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(uniqueName)).toBeVisible();

    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("event-group-upcoming").getByText(uniqueName)).toBeVisible();
    await expect(
      page.locator("li", { hasText: uniqueName }).getByTestId("event-type"),
    ).toHaveText("Club training");

    await page.goto(`/${dbName}/event`);
    await expect(page.getByTestId("event-type-editor")).toBeVisible();
    await page.getByTestId("event-type-select").selectOption("weekly_course");
    await page.getByTestId("event-type-save").click();
    await expect(page.getByText("Event type saved.")).toBeVisible();

    await page.goto("/");
    await page.getByTestId("event-type-filter").selectOption("weekly_course");
    await expect(page.getByText(uniqueName).first()).toBeVisible();
    await expect(
      page.locator("li", { hasText: uniqueName }).getByTestId("event-type"),
    ).toHaveText("Weekly course");

    const createdRow = page.locator("li", { hasText: uniqueName });
    await createdRow.getByTestId("event-delete").click();
    await page.getByTestId("delete-event-confirm").click();
    await expect(createdRow).toHaveCount(0);
  });
});
