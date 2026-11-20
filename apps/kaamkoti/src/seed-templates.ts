// Trade templates loaded by the development seed.
import type { TradeTemplate } from "./trade-template.ts";

const GST = 1800;

export const seedTemplates: readonly TradeTemplate[] = [
  {
    key: "ac_repair",
    version: 1,
    body: {
      title: "AC and appliance repair",
      catalogue: [
        {
          key: "visit",
          name: "Inspection visit",
          unit: "visit",
          unitPriceMinor: 30_000,
          taxRateBp: GST,
        },
        {
          key: "service",
          name: "AC general service",
          unit: "unit",
          unitPriceMinor: 80_000,
          taxRateBp: GST,
        },
        {
          key: "deep_clean",
          name: "AC deep clean (jet wash)",
          unit: "unit",
          unitPriceMinor: 120_000,
          taxRateBp: GST,
        },
        {
          key: "gas_refill",
          name: "AC gas refill",
          unit: "unit",
          unitPriceMinor: 250_000,
          taxRateBp: GST,
        },
        {
          key: "gas_leak_fix",
          name: "Gas leak repair and refill",
          unit: "unit",
          unitPriceMinor: 400_000,
          taxRateBp: GST,
        },
        {
          key: "pcb_repair",
          name: "Control board (PCB) repair",
          unit: "unit",
          unitPriceMinor: 200_000,
          taxRateBp: GST,
        },
        {
          key: "capacitor",
          name: "Capacitor replacement",
          unit: "unit",
          unitPriceMinor: 60_000,
          taxRateBp: GST,
        },
        {
          key: "install_split",
          name: "Split AC installation",
          unit: "unit",
          unitPriceMinor: 350_000,
          taxRateBp: GST,
        },
        {
          key: "uninstall",
          name: "AC uninstallation",
          unit: "unit",
          unitPriceMinor: 150_000,
          taxRateBp: GST,
        },
        {
          key: "copper_pipe",
          name: "Copper piping",
          unit: "metre",
          unitPriceMinor: 65_000,
          taxRateBp: GST,
        },
        {
          key: "fridge_repair",
          name: "Refrigerator repair (labour)",
          unit: "job",
          unitPriceMinor: 50_000,
          taxRateBp: GST,
        },
        {
          key: "washer_repair",
          name: "Washing machine repair (labour)",
          unit: "job",
          unitPriceMinor: 50_000,
          taxRateBp: GST,
        },
      ],
      intake: [
        {
          key: "appliance",
          label: "Which appliance?",
          type: "choice",
          required: true,
          options: ["Split AC", "Window AC", "Refrigerator", "Washing machine"],
        },
        { key: "brand", label: "Brand and model, if you know it", type: "text", required: false },
        { key: "age_years", label: "Approximate age in years", type: "number", required: false },
        {
          key: "symptom",
          label: "What is happening?",
          type: "choice",
          required: true,
          options: [
            "Not cooling",
            "Not turning on",
            "Water leaking",
            "Strange noise",
            "Error code showing",
            "Needs installation or removal",
            "Routine service",
          ],
        },
        { key: "problem", label: "Anything else we should know?", type: "text", required: false },
        {
          key: "floor",
          label: "Floor number (for access)",
          type: "number",
          required: false,
        },
        {
          key: "photo",
          label: "Photo of the appliance or error code",
          type: "photo",
          required: false,
        },
      ],
      checklist: [
        { key: "power_off", label: "Power isolated before opening" },
        { key: "cause_found", label: "Cause of the fault found and explained to the customer" },
        { key: "filters_cleaned", label: "Filters and coils cleaned (AC)" },
        { key: "drain_checked", label: "Drain line clear, no leaks" },
        { key: "gas_pressure", label: "Gas pressure checked (AC)" },
        { key: "tested", label: "Tested running after repair" },
        { key: "site_clean", label: "Work area cleaned" },
      ],
      terms:
        "Quote is valid for 7 days. Parts replaced carry a 30-day warranty; labour carries 7 days. " +
        "The inspection visit fee is adjusted against the repair if you go ahead. " +
        "Any extra work found on site is quoted to you first. Payment is due on completion.",
    },
  },
];
