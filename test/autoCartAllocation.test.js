import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { allocateAutoCarts, selectAutoCartWinners } from "../src/monitor.js";

const originalAutoCartMaxPerEvent = process.env.AUTO_CART_MAX_PER_EVENT;

beforeEach(() => {
  delete process.env.AUTO_CART_MAX_PER_EVENT;
});

after(() => {
  if (originalAutoCartMaxPerEvent == null) {
    delete process.env.AUTO_CART_MAX_PER_EVENT;
  } else {
    process.env.AUTO_CART_MAX_PER_EVENT = originalAutoCartMaxPerEvent;
  }
});

function candidate({
  chatId,
  priority = 0,
  firstSeenAt = "2026-01-01T00:00:00.000Z",
  match = "M86",
  sectionCode = "FIFA",
  quantity,
  availableQuantity
}) {
  return {
    chatId,
    chatState: {
      user: {
        priority,
        firstSeenAt
      }
    },
    subscription: {
      match,
      ...(quantity ? { quantity } : {})
    },
    summary: {
      match,
      selectedSectionCode: sectionCode,
      availableQuantity,
      cartOption: {
        sectionCode,
        sectionName: "FIFA Pavilion",
        amount: 5500
      }
    }
  };
}

function withAutoCartMaxPerEvent(value, callback) {
  const previous = process.env.AUTO_CART_MAX_PER_EVENT;
  if (value == null) {
    delete process.env.AUTO_CART_MAX_PER_EVENT;
  } else {
    process.env.AUTO_CART_MAX_PER_EVENT = value;
  }

  try {
    return callback();
  } finally {
    if (previous == null) {
      delete process.env.AUTO_CART_MAX_PER_EVENT;
    } else {
      process.env.AUTO_CART_MAX_PER_EVENT = previous;
    }
  }
}

test("selects the lowest positive priority number for a section", () => {
  const winners = selectAutoCartWinners([
    candidate({ chatId: "100", priority: 2 }),
    candidate({ chatId: "200", priority: 1 })
  ]);

  assert.equal(winners.length, 1);
  assert.equal(winners[0].key, "M86:FIFA");
  assert.equal(winners[0].winner.chatId, "200");
  assert.deepEqual(winners[0].winners.map((winner) => winner.chatId), ["200"]);
});

test("selects multiple users when AUTO_CART_MAX_PER_EVENT allows it", () => {
  withAutoCartMaxPerEvent("3", () => {
    const winners = selectAutoCartWinners([
      candidate({ chatId: "100", priority: 3 }),
      candidate({ chatId: "200", priority: 1 }),
      candidate({ chatId: "300", priority: 2 }),
      candidate({ chatId: "400", priority: 4 })
    ]);

    assert.equal(winners.length, 1);
    assert.deepEqual(winners[0].winners.map((winner) => winner.chatId), ["200", "300", "100"]);
  });
});

test("does not select more users than the available quantity", () => {
  withAutoCartMaxPerEvent("all", () => {
    const candidates = [
      candidate({ chatId: "100", priority: 1 }),
      candidate({ chatId: "200", priority: 2 }),
      candidate({ chatId: "300", priority: 3 })
    ];
    for (const current of candidates) current.summary.availableQuantity = 2;

    const winners = selectAutoCartWinners(candidates);

    assert.deepEqual(winners[0].winners.map((winner) => winner.chatId), ["100", "200"]);
  });
});

test("honors requested cart quantity for the top-priority user", () => {
  withAutoCartMaxPerEvent("all", () => {
    const winners = selectAutoCartWinners([
      candidate({ chatId: "100", priority: 1, quantity: 2, availableQuantity: 2 }),
      candidate({ chatId: "200", priority: 2, availableQuantity: 2 })
    ]);

    assert.deepEqual(winners[0].winners.map((winner) => [winner.chatId, winner.cartQuantity]), [
      ["100", 2]
    ]);
  });
});

test("allocates remaining quantity to the next priority user", () => {
  withAutoCartMaxPerEvent("all", () => {
    const winners = selectAutoCartWinners([
      candidate({ chatId: "100", priority: 1, quantity: 2, availableQuantity: 3 }),
      candidate({ chatId: "200", priority: 2, availableQuantity: 3 })
    ]);

    assert.deepEqual(winners[0].winners.map((winner) => [winner.chatId, winner.cartQuantity]), [
      ["100", 2],
      ["200", 1]
    ]);
  });
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

test("allocateAutoCarts reports empty assigned and failed sets when disabled", async () => {
  const result = await allocateAutoCarts({
    allocationCandidates: [candidate({ chatId: "100", priority: 1 })],
    nextState: {}
  });

  assert.deepEqual([...result.assignedKeys], []);
  assert.deepEqual([...result.failedAllocationKeys], []);
});
