// Vitest-only replacement for Next.js' `server-only` marker.
//
// Production modules continue to import the real package, which makes Next
// reject accidental Client Component imports. Vitest runs server composition
// in-process, so this intentionally has no runtime behavior.
export {};
