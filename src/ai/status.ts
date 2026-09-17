let quotaExceeded = false;
let lastErrorTimestamp = 0;
let errorDetail = '';

export function isAiQuotaExceeded(): boolean {
  // Reset after 1 minute if it's been silent, or keep if recent
  if (quotaExceeded && Date.now() - lastErrorTimestamp > 60000) {
    quotaExceeded = false;
  }
  return quotaExceeded;
}

export function setAiQuotaExceeded(exceeded: boolean, detail: string = '') {
  quotaExceeded = exceeded;
  if (exceeded) {
    lastErrorTimestamp = Date.now();
    errorDetail = detail;
  } else {
    lastErrorTimestamp = 0;
    errorDetail = '';
  }
}

export function getAiQuotaErrorDetail(): string {
  return errorDetail;
}

export function handleAiError(error: any) {
  const errMsg = error?.message || String(error);
  if (
    errMsg.toLowerCase().includes('quota') || 
    errMsg.toLowerCase().includes('limit') || 
    errMsg.toLowerCase().includes('resource_exhausted') ||
    errMsg.toLowerCase().includes('429')
  ) {
    console.warn('[AI Status Tracker] Detected AI Quota/Rate Limit Exceeded:', errMsg);
    setAiQuotaExceeded(true, errMsg);
  }
}
