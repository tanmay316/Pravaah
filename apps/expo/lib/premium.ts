/**
 * Premium plans. Prices here are display defaults only: on Google Play the store shows the
 * real, localised price at checkout, and the server grants Premium after verifying the purchase.
 */

export interface PremiumPlan {
  id: "monthly" | "yearly";
  /** Google Play subscription product ID; create the same IDs in Play Console. */
  productId: string;
  title: string;
  price: string;
  amountInr: number;
  period: string;
  note?: string;
}

export const PREMIUM_PLANS: PremiumPlan[] = [
  { id: "yearly", productId: "pravaah_premium_yearly", title: "Yearly", price: "₹1,999", amountInr: 1999, period: "per year", note: "Save 44%" },
  { id: "monthly", productId: "pravaah_premium_monthly", title: "Monthly", price: "₹299", amountInr: 299, period: "per month" },
];

export function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export const PREMIUM_FEATURES: { icon: string; title: string; detail: string }[] = [
  { icon: "mic-outline", title: "Daily AI voice coaching", detail: "Up to an hour of conversation practice every day" },
  { icon: "sparkles-outline", title: "Instant corrections", detail: "Every mistake fixed, explained in Hindi" },
  { icon: "calendar-outline", title: "Personal daily plan", detail: "Built from the mistakes you actually make" },
  { icon: "people-outline", title: "Real-life roleplays", detail: "Interviews, meetings, calls and travel" },
  { icon: "stats-chart-outline", title: "Speaking tests any day", detail: "Track your level as it improves" },
];

export const PLAN_COMPARISON: { feature: string; free: string; premium: string }[] = [
  { feature: "Lessons and quizzes", free: "Included", premium: "Included" },
  { feature: "Word review", free: "Included", premium: "Included" },
  { feature: "AI voice coach", free: "One 5-min demo", premium: "Daily" },
  { feature: "Personal daily plan", free: "—", premium: "Included" },
  { feature: "Speaking test", free: "Once a week", premium: "Daily" },
];

export class PurchaseUnavailableError extends Error {}

/**
 * Starts a Google Play subscription purchase. Billing ships with the Play Store build; until
 * then this reports that purchases are not available on this platform.
 */
export async function purchasePremium(_plan: PremiumPlan): Promise<void> {
  throw new PurchaseUnavailableError(
    "Premium purchases open with our Google Play release. We'll let you know as soon as it's live."
  );
}
