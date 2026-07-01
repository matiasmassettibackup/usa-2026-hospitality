import assert from "node:assert/strict";
import test from "node:test";
import { collectAvailabilityEventsForSummary } from "../src/monitor.js";

function summary({ availableOptions }) {
  return {
    match: "M86",
    teams: "Argentina vs Cabo Verde",
    venue: "Miami Stadium",
    city: "Miami Gardens",
    dayTime: "July 3 Friday, 6pm ET",
    availableOptions
  };
}

const suiteEssentials = {
  sectionCode: "SEPSTA",
  sectionName: "Suite Essentials",
  loungeTitle: "Suite Essentials",
  amount: 1600,
  availableQuantity: 12,
  canCreateCart: true
};

test("collects an event only when a section first becomes active", () => {
  const first = collectAvailabilityEventsForSummary(summary({
    availableOptions: [suiteEssentials]
  }), {}, "2026-07-01T00:00:00.000Z");

  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].match, "M86");
  assert.equal(first.events[0].sectionCode, "SEPSTA");

  const second = collectAvailabilityEventsForSummary(summary({
    availableOptions: [suiteEssentials]
  }), first.nextEvents, "2026-07-01T00:01:00.000Z");

  assert.equal(second.events.length, 0);
});

test("collects a new event after a section disappears and reappears", () => {
  const previousEvents = {
    "M86:SEPSTA": {
      active: false,
      sectionCode: "SEPSTA",
      lastMissingAt: "2026-07-01T00:01:00.000Z"
    }
  };

  const next = collectAvailabilityEventsForSummary(summary({
    availableOptions: [suiteEssentials]
  }), previousEvents, "2026-07-01T00:02:00.000Z");

  assert.equal(next.events.length, 1);
  assert.equal(next.nextEvents["M86:SEPSTA"].active, true);
});
