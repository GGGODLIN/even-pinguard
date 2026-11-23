const redacted = "[REDACTED]";

export function redactSecret(input: string, secrets: readonly string[]): string {
  const variants = secrets.filter((secret) => secret.length > 0)
    .flatMap((secret) => [secret, encodeURIComponent(secret)]);
  return variants.sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.replaceAll(secret, redacted), input)
    .replace(/bot\d+(?::|%3a)[A-Za-z0-9_-]+|\d{6,}(?::|%3a)[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{12,}/gi, redacted);
}

export function sanitizeError(error: unknown, secrets: readonly string[]): string {
  const message = typeof error === "string"
    ? error
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : "Unknown error";
  return redactSecret(message.replace(/https?:\/\/api\.telegram\.org\/bot[^\s"'<>]+/gi, redacted), secrets);
}
