import crypto from 'crypto';

export function signMessage(message: any, secret: string | null): string {
  if (!secret) throw new Error("No terminal secret configured for signing");
  const json = JSON.stringify(message);
  return crypto.createHmac('sha256', secret).update(json).digest('base64');
}

export function verifyMessage(message: any, secret: string | null, signature: string): boolean {
  // No secret → cannot verify → treat as invalid signature
  if (!secret) return false;
  const expected = signMessage(message, secret);
  return expected === signature;
}
