const BASE_URL = "https://fifaworldcup26.hospitality.fifa.com";

const PRODUCT_CODE = "26FWC";
const PRODUCT_TYPE_SINGLE_MATCH = 5;
const PRODUCT_TYPE_CODE_SINGLE_MATCH = "SM";
const DEFAULT_QUANTITY = 1;

const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  referer: `${BASE_URL}/us/en/choose-matches`,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36"
};

export async function fetchSingleMatchInventory({ signal } = {}) {
  const url = new URL("/next-api/matches-all", BASE_URL);
  url.searchParams.set("productCode", PRODUCT_CODE);
  url.searchParams.set("productType", String(PRODUCT_TYPE_SINGLE_MATCH));

  const response = await fetch(url, {
    signal,
    headers: DEFAULT_HEADERS
  });

  return parseJsonResponse(response);
}

export async function fetchSingleMatchLounges(performanceId, { quantity = 1, signal } = {}) {
  const url = new URL("/next-api/lounges", BASE_URL);
  url.searchParams.set("productCode", PRODUCT_CODE);
  url.searchParams.set("productTypeCode", PRODUCT_TYPE_CODE_SINGLE_MATCH);
  url.searchParams.set("quantity", String(quantity));
  url.searchParams.set("performanceId", String(performanceId));

  const response = await fetch(url, {
    signal,
    headers: DEFAULT_HEADERS
  });

  return parseJsonResponse(response);
}

export async function createSingleMatchCart({ performanceId, option, quantity = DEFAULT_QUANTITY, partnerId = "", signal } = {}) {
  if (!performanceId) throw new Error("Missing performanceId for cart creation");
  if (!option) throw new Error("Missing hospitality option for cart creation");

  const response = await fetch(new URL("/next-api/orders", BASE_URL), {
    method: "POST",
    signal,
    headers: {
      ...DEFAULT_HEADERS,
      "content-type": "application/json",
      "country-tag": "us",
      "language-tag": "en"
    },
    body: JSON.stringify({
      ProductType: PRODUCT_TYPE_SINGLE_MATCH,
      ProductCode: PRODUCT_CODE,
      OrderId: 0,
      PartnerId: partnerId,
      SelectedQuantity: quantity,
      PackageSelectionData: {
        SeatCategoryId: option.seatCategoryId,
        AudienceSubCategoryId: option.audSubCategoryId,
        InstitutionSeatCategoryId: option.institutionSeatCatId,
        PackageLineId: 0,
        PerformanceId: performanceId
      }
    })
  });

  return parseCartResponse(response);
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`FIFA API returned ${response.status}: ${body.slice(0, 300)}`);
  }

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from FIFA API, got ${contentType || "unknown content type"}`);
  }

  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : parsed.data || [];
}

async function parseCartResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from FIFA cart API, got ${contentType || "unknown content type"}`);
  }

  const parsed = JSON.parse(body);

  if (!response.ok || parsed?.Code) {
    const message = parsed?.Message || parsed?.error || body.slice(0, 300);
    throw new Error(`FIFA cart API returned ${response.status}: ${message}`);
  }

  if (!parsed?.CheckoutRedirectUrl) {
    throw new Error("FIFA cart API did not return CheckoutRedirectUrl");
  }

  return parsed;
}

export function normalizeMatchNumber(value) {
  if (!value) return undefined;
  const raw = String(value).trim().toUpperCase();
  return raw.startsWith("M") ? Number(raw.slice(1)) : Number(raw);
}

export function normalizeMatchNumbers(value) {
  if (!value) return undefined;

  const values = Array.isArray(value)
    ? value
    : String(value).split(",");

  const numbers = values
    .map(normalizeMatchNumber)
    .filter((number) => Number.isFinite(number));

  return numbers.length ? new Set(numbers) : undefined;
}

export function getAvailableOptions(match) {
  return (match.Prices || [])
    .flatMap((lounge) =>
      (lounge.PriceCategories || [])
        .filter((category) => category.IsAvailable === true)
        .map((category) => ({
          loungeId: lounge.Id,
          loungeName: lounge.Name,
          amount: Number(category.Amount),
          seatCategoryId: category.SeatCategoryId,
          audSubCategoryId: category.AudSubCategoryId,
          institutionSeatCatId: category.InstitutionSeatCatId
        }))
    )
    .sort((a, b) => a.amount - b.amount);
}

export function getHospitalityOptions(lounges, { section, sectionCode, allSections = false } = {}) {
  const targetSection = section?.trim().toLowerCase();
  const targetCode = sectionCode?.trim().toUpperCase();

  return (lounges || [])
    .flatMap((lounge) =>
      (lounge.seatingSections || []).map((section) => ({
        loungeId: lounge.id,
        loungeTitle: lounge.title,
        sectionCode: section.Code,
        sectionName: section.Name,
        amount: Number(section.StartingPrice),
        isAvailable: section.IsAvailable === true && Number(section.AvailableQuantity || 0) > 0,
        availableQuantity: Number(section.AvailableQuantity || 0),
        seatCategoryId: section.SeatCategoryId,
        audSubCategoryId: section.AudienceSubCategoryId,
        institutionSeatCatId: section.InstitutionSeatCategoryId,
        canCreateCart: Boolean(
          section.SeatCategoryId &&
          section.AudienceSubCategoryId &&
          section.InstitutionSeatCategoryId
        )
      }))
    )
    .filter((option) => {
      if (allSections) return true;
      if (targetCode) return option.sectionCode?.toUpperCase() === targetCode;
      if (targetSection) return option.sectionName?.toLowerCase().includes(targetSection);
      return true;
    })
    .sort((a, b) => a.amount - b.amount);
}

export function summarizeMatch(match, { hospitalityOptions } = {}) {
  const allAvailableOptions = getAvailableOptions(match);
  const selectedOptions = hospitalityOptions || allAvailableOptions;
  const availableOptions = selectedOptions.filter((option) => option.isAvailable ?? true);
  const minOption = availableOptions[0];
  const cheapestSelectedOption = selectedOptions[0];

  return {
    match: `M${match.MatchNumber}`,
    matchNumber: Number(match.MatchNumber),
    performanceId: match.PerformanceId,
    teams: `${match.HostTeam?.ExternalName || "TBD"} vs ${match.OpposingTeam?.ExternalName || "TBD"}`,
    venueCode: match.Venue?.Code,
    venue: match.Venue?.Name,
    city: match.Venue?.Town,
    date: match.MatchDate,
    dayTime: match.MatchDayTime,
    isAvailable: availableOptions.length > 0,
    matchHasAnyAvailability: match.IsAvailable === true && allAvailableOptions.length > 0,
    rawIsAvailable: match.IsAvailable === true,
    isOffered: selectedOptions.length > 0,
    selectedOptionCount: selectedOptions.length,
    availableOptionCount: availableOptions.length,
    minAvailablePrice: minOption?.amount ?? null,
    cheapestSelectedPrice: cheapestSelectedOption?.amount ?? null,
    cheapestLounge: minOption?.loungeName || minOption?.sectionName || null,
    selectedSection: minOption?.sectionName || minOption?.loungeName || cheapestSelectedOption?.sectionName || cheapestSelectedOption?.loungeName || null,
    selectedSectionCode: minOption?.sectionCode || cheapestSelectedOption?.sectionCode || null,
    availableQuantity: minOption?.availableQuantity ?? null,
    cartOption: minOption?.canCreateCart ? minOption : null,
    availableOptions,
    selectedOptions
  };
}

export function filterMatches(matches, filters) {
  const targetMatchNumbers = normalizeMatchNumbers(filters.match);
  const targetVenue = filters.venue?.trim().toUpperCase();
  const targetTeam = filters.team?.trim().toLowerCase();

  return matches.filter((match) => {
    if (targetMatchNumbers && !targetMatchNumbers.has(Number(match.MatchNumber))) return false;
    if (targetVenue && match.Venue?.Code !== targetVenue) return false;

    if (targetTeam) {
      const home = match.HostTeam?.ExternalName?.toLowerCase() || "";
      const away = match.OpposingTeam?.ExternalName?.toLowerCase() || "";
      if (!home.includes(targetTeam) && !away.includes(targetTeam)) return false;
    }

    return true;
  });
}
