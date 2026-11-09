import { expect, test } from "@playwright/test";

/**
 * §4.4: against the built app + mock upstream — send an OpenAI chat
 * request, open /ui, see the row, open it, see four stage columns
 * with content.
 */
test("requests row opens the inspector with four stages", async ({
  page,
  request,
}) => {
  const res = await request.post("/v1/chat/completions", {
    data: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "smoke test hello" }],
    },
  });
  expect(res.ok()).toBeTruthy();

  // the usage store flushes on a 250 ms timer — give it a beat before
  // the SPA's first listRequests
  await page.waitForTimeout(600);

  await page.goto("/ui/");
  const row = page.locator("tbody tr", { hasText: "gpt-4o" }).first();
  await expect(row).toBeVisible();
  await row.click();

  // four stage columns, each with content
  for (const name of ["source", "canonical", "target", "response"]) {
    const stage = page.locator(".stage", { has: page.locator("h3", { hasText: name }) });
    await expect(stage).toBeVisible();
    await expect(stage.locator(".json-tree")).toContainText(/.+/);
  }
  // the source stage shows the sent model
  await expect(
    page.locator(".stage", { has: page.locator("h3", { hasText: "source" }) }),
  ).toContainText("gpt-4o");
});
