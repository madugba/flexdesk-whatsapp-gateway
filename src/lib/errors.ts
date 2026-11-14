export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export const errors = {
  notReady: () => new GatewayError('not_ready', 'The gateway is starting up. Try again shortly.', 503, 5),
  sessionNotFound: () => new GatewayError('session_not_found', 'No such session.', 404),
  sessionNotOpen: (status: string) =>
    new GatewayError('session_not_open', `The WhatsApp session is not connected (status: ${status}).`, 409),
  capacity: () => new GatewayError('capacity', 'This gateway is at its session limit.', 409),
  invalidRecipient: () =>
    new GatewayError('invalid_recipient', 'Recipient must be a phone number in international digits or a chat id from a webhook.', 422),
  outsideReplyWindow: () =>
    new GatewayError('outside_reply_window', 'This person has not messaged within the reply window, so they cannot be messaged.', 422),
  queueFull: () => new GatewayError('queue_full', 'Too many messages are waiting to be sent for this session.', 429, 10),
  rateLimited: () => new GatewayError('rate_limited', 'This session reached its hourly sending limit.', 429, 300),
  duplicateInFlight: () => new GatewayError('duplicate_in_flight', 'A message with this idempotency key is still being sent.', 409, 2),
  sendFailed: () => new GatewayError('send_failed', 'WhatsApp did not accept the message.', 502),
};
