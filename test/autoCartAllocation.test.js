import assert from "node:assert/strict";
import test from "node:test";
import { selectAutoCartWinners } from "../src/monitor.js";

function candidate({ chatId, priority = 0, firstSeenAt = "2026-01-01T00:00:00.000Z", match = "M86", sectionCode = "FIFA" }) {
  return {
    chatId,
    chatState: {
      user: {
        priority,
        firstSeenAt
      }
    },
    summary: {
      match,
      selectedSectionCode: sectionCode,
      cartOption: {
        sectionCode,
        sectionName: "FIFA Pavilion",
        amount: 5500
      }
    }
  };
}

test("selects the lowest positive priority number for a section", () => {
  const winners = selectAutoCartWinners([
    candidate({ chatId: "100", priority: 2 }),
    candidate({ chatId: "200", priority: 1 })
  ]);

  assert.equal(winners.length, 1);
  assert.equal(winners[0].key, "M86:FIFA");
  assert.equal(winners[0].winner.chatId, "200");
});

test("treats priority 0 as unranked", () => {
  const winners = selectAutoCartWinners([
    candidate({ chatId: "100", priority: 0 }),
    candidate({ chatId: "200", priority: 6 })
  ]);

  assert.equal(winners[0].winner.chatId, "200");
});

test("uses firstSeenAt and chatId as stable tie-breakers", () => {
  const earlier = candidate({ chatId: "300", priority: 5, firstSeenAt: "2026-01-01T00:00:00.000Z" });
  const later = candidate({ chatId: "200", priority: 5, firstSeenAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(selectAutoCartWinners([later, earlier])[0].winner.chatId, "300");

  const tiedA = candidate({ chatId: "300", priority: 5 });
  const tiedB = candidate({ chatId: "200", priority: 5 });
  assert.equal(selectAutoCartWinners([tiedA, tiedB])[0].winner.chatId, "200");
});

test("groups candidates by match and concrete section", () => {
  const winners = selectAutoCartWinners([
    candidate({ chatId: "100", priority: 10, sectionCode: "FIFA" }),
    candidate({ chatId: "200", priority: 1, sectionCode: "TROPHY" })
  ]);

  assert.deepEqual(winners.map((winner) => winner.key).sort(), ["M86:FIFA", "M86:TROPHY"]);
});

test("skips sections that already have an active allocation", () => {
  const winners = selectAutoCartWinners([
    candidate({ chatId: "100", priority: 10, sectionCode: "FIFA" }),
    candidate({ chatId: "200", priority: 1, sectionCode: "TROPHY" })
  ], {
    "M86:FIFA": { active: true }
  });

  assert.deepEqual(winners.map((winner) => winner.key), ["M86:TROPHY"]);
});
