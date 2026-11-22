// A price as customers and owners read it: "₹2,500.00 each".
import { formatMoney, type Money } from "@bodhchakra/money";

export const PER: Record<string, string> = {
  job: "per job",
  hour: "per hour",
  unit: "each",
  sq_ft: "per sq ft",
  metre: "per metre",
  visit: "per visit",
};

export const formatPrice = (price: Money, unit: string) =>
  `${formatMoney(price)} ${PER[unit] ?? ""}`.trim();
