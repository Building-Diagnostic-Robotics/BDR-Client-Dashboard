import { z } from "zod";

// Run before constructing shared schemas: Zod's eval capability probe is caught,
// but still produces CSP violations in browsers. Server parsing keeps its defaults.
if (typeof window !== "undefined") z.config({ jitless: true });

export { z };
