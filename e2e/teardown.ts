// Runs once the journeys are done, while their servers still answer: the data they left must
// still hold together.

import { brokenRules } from "./seed.ts";

export default async function teardown() {
  const broken = await brokenRules();
  if (broken.length > 0) {
    throw new Error(`the journeys left the data broken:\n${JSON.stringify(broken, null, 2)}`);
  }
}
