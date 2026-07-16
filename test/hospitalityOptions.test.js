import assert from "node:assert/strict";
import test from "node:test";
import { getHospitalityOptions } from "../src/fifaHospitality.js";

const lounges = [
  {
    id: "pitchside",
    title: "Pitchside Lounge",
    seatingSections: [
      {
        Code: "PITCH-A",
        Name: "Pitchside Premium",
        StartingPrice: 9000,
        IsAvailable: true,
        AvailableQuantity: 2,
        SeatCategoryId: 1,
        AudienceSubCategoryId: 2,
        InstitutionSeatCategoryId: 3
      },
      {
        Code: "PITCH-B",
        Name: "Pitchside Entry",
        StartingPrice: 7000,
        IsAvailable: false,
        AvailableQuantity: 0,
        SeatCategoryId: 4,
        AudienceSubCategoryId: 5,
        InstitutionSeatCategoryId: 6
      }
    ]
  },
  {
    id: "fifa",
    title: "FIFA Pavilion",
    seatingSections: [
      {
        Code: "FIFA-A",
        Name: "FIFA Pavilion",
        StartingPrice: 5500,
        IsAvailable: true,
        AvailableQuantity: 1,
        SeatCategoryId: 7,
        AudienceSubCategoryId: 8,
        InstitutionSeatCategoryId: 9
      }
    ]
  }
];

test("cheapestPerCategory returns only the cheapest seating section in each lounge", () => {
  const options = getHospitalityOptions(lounges, { cheapestPerCategory: true });

  assert.deepEqual(options.map((option) => option.sectionCode), ["FIFA-A", "PITCH-B"]);
});

test("allSections still returns every seating section", () => {
  const options = getHospitalityOptions(lounges, { allSections: true });

  assert.deepEqual(options.map((option) => option.sectionCode), ["FIFA-A", "PITCH-B", "PITCH-A"]);
});

test("maxPriceUsd limits selected seating sections", () => {
  const options = getHospitalityOptions(lounges, { allSections: true, maxPriceUsd: 6999 });

  assert.deepEqual(options.map((option) => option.sectionCode), ["FIFA-A"]);
});
