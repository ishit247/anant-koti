// A catalogue price as customers read it: "₹2,500.00 each". Rupees only until money (2.4) carries the currency.
const PER: Record<string, string> = {
  job: "per job",
  hour: "per hour",
  unit: "each",
  sq_ft: "per sq ft",
  metre: "per metre",
  visit: "per visit",
};

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export const formatPrice = (unitPriceMinor: number, unit: string) =>
  `${rupees.format(unitPriceMinor / 100)} ${PER[unit] ?? ""}`.trim();
