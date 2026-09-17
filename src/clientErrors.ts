export const CLIENT_SERVER_ERROR_MESSAGE =
  'Our server is currently experiencing a problem. Please try again.';

export const CLIENT_SERVER_ERROR_CODE = 'SERVER_UNAVAILABLE';

export function clientServerError(statusCode = 503): Error & { code: string; statusCode: number } {
  const err = new Error(CLIENT_SERVER_ERROR_MESSAGE) as Error & { code: string; statusCode: number };
  err.code = CLIENT_SERVER_ERROR_CODE;
  err.statusCode = statusCode;
  return err;
}

export function isClientSafeErrorCode(code?: string): boolean {
  return [
    'AUTH_REQUIRED',
    'INVALID_PROJECT',
    'INVALID_CREDENTIALS',
    'BAD_REQUEST',
    'LIMIT_EXCEEDED',
    'SECURITY_VIOLATION',
    'IP_BLOCKED',
    'PAYLOAD_TOO_LARGE',
  ].includes(code || '');
}
