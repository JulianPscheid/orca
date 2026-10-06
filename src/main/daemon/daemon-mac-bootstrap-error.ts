export class MacLaunchdBootstrapError extends Error {
  constructor(
    message: string,
    readonly disposition: 'not-submitted' | 'rejected' | 'unverifiable',
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
