import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCoachPrompt } from "../server/prompt.js";

const cases = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8"),
);

for (const testCase of cases) {
  test(`builds useful guidance for ${testCase.name}`, () => {
    const result = buildCoachPrompt(testCase);
    const content = `${result.checklist.join("\n")}\n${result.prompt}`.toLowerCase();
    const missing = testCase.checks.filter((term) => !content.includes(term.toLowerCase()));

    assert.deepEqual(missing, [], `Missing guidance: ${missing.join(", ")}`);
    assert.ok(result.prompt.includes(testCase.observation));
    assert.ok(result.prompt.includes(testCase.map || "Not provided"));
  });
}

test("builds a screenshot-aware coaching prompt", () => {
  const result = buildCoachPrompt({
    game: "CS2",
    map: "Mirage",
    side: "CT",
    observation: "We are on an eco round.",
  });
  assert.match(result.prompt, /attached screenshot/i);
  assert.match(result.prompt, /eco rounds/i);
  assert.match(result.prompt, /under 100 words/i);
  assert.equal(result.game, "Counter-Strike 2");
});
