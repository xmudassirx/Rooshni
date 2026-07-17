import { redirect } from "next/navigation";

// Post-signin landing is the Dashboard (founder review, 17 Jul 2026 —
// /enquiries here was mockup residue).
export default function HomePage() {
  redirect("/dashboard");
}
