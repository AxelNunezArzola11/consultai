import { notFound } from "next/navigation";
import { StyleGuideClient } from "./StyleGuideClient";

/**
 * /dev/ui — Design system style guide.
 *
 * GATED: only renders when DEMO_MODE=true.
 * Returns 404 in production if DEMO_MODE is not set.
 */
export default function StyleGuidePage() {
  if (process.env.DEMO_MODE !== "true") {
    notFound();
  }

  return <StyleGuideClient />;
}
