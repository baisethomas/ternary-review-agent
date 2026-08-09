export class NonRetryableReviewError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableReviewError";
  }
}

export class ReviewLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Review lease lost for ${jobId}`);
    this.name = "ReviewLeaseLostError";
  }
}

export function isRetryableReviewError(error: unknown) {
  return !(error instanceof NonRetryableReviewError);
}

export function isRetryableHttpStatus(status: number) {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}
